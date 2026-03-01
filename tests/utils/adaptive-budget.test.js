const {
  calculateThinkingBudget,
  calculateCompilationBudget,
} = require('../../src/utils/adaptive-budget.js');
const config = require('../../src/config.js');

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal analysis object with configurable item counts. */
function makeAnalysis({ tickets = 0, actions = 0, crs = 0, blockers = 0 } = {}) {
  return {
    tickets: Array.from({ length: tickets }, () => ({})),
    action_items: Array.from({ length: actions }, () => ({})),
    change_requests: Array.from({ length: crs }, () => ({})),
    blockers: Array.from({ length: blockers }, () => ({})),
  };
}

/** WebVTT content packed with technical terms to push complexity > 30. */
const TECHNICAL_VTT = `WEBVTT

00:00:00.000 --> 00:00:10.000
<v Alice>We need to fix the API endpoint for the backend migration deploy merge branch commit sprint</v>

00:00:10.000 --> 00:00:20.000
<v Bob>The regression hotfix is on staging. Check the database schema query and the pipeline deploy.</v>

00:00:20.000 --> 00:00:30.000
<v Alice>Also look at the Dockerfile and kubernetes config. The JWT OAuth CORS webhook setup is broken.</v>

00:00:30.000 --> 00:00:40.000
<v Bob>Let me open the UserService.ts and OrderController.cs files. CR 101 and ticket #202 are related.</v>
`;

// ── calculateThinkingBudget ──────────────────────────────────────────

describe('calculateThinkingBudget', () => {
  it('returns BASE budget (16384) with default params', () => {
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 1,
      previousAnalyses: [],
      contextDocs: [],
    });
    expect(result.budget).toBe(16384);
    expect(result.reason).toBe('base budget');
    expect(result.complexity).toBeDefined();
  });

  it('allows baseBudget override', () => {
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 1,
      previousAnalyses: [],
      contextDocs: [],
      baseBudget: 12000,
    });
    expect(result.budget).toBe(12000);
  });

  it('gives +2048 first-segment bonus for multi-segment calls', () => {
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 3,
      previousAnalyses: [],
      contextDocs: [],
    });
    // BASE (16384) + first-segment bonus (2048) = 18432
    expect(result.budget).toBe(16384 + 2048);
    expect(result.reason).toContain('first-segment');
  });

  it('gives position boost to the last segment', () => {
    const result = calculateThinkingBudget({
      segmentIndex: 4,
      totalSegments: 5,
      previousAnalyses: [],
      contextDocs: [],
    });
    // positionRatio = 4/4 = 1.0 → boost = 6144
    expect(result.budget).toBe(16384 + 6144);
    expect(result.reason).toContain('position');
  });

  it('increases budget when previousAnalyses have many items (>20)', () => {
    // 5 analyses × 5 tickets = 25 items  →  min(4096, 25*100) = 2500
    const prev = Array.from({ length: 5 }, () => makeAnalysis({ tickets: 5 }));
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 1,
      previousAnalyses: prev,
      contextDocs: [],
    });
    expect(result.budget).toBe(16384 + 2500);
    expect(result.reason).toContain('cross-ref');
    expect(result.reason).toContain('25 accumulated items');
  });

  it('gives smaller boost for medium item count (>8, <=20)', () => {
    // 3 analyses × 4 items = 12 items  →  min(2048, 12*80) = 960
    const prev = Array.from({ length: 3 }, () =>
      makeAnalysis({ tickets: 2, actions: 1, crs: 1 }),
    );
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 1,
      previousAnalyses: prev,
      contextDocs: [],
    });
    expect(result.budget).toBe(16384 + 960);
    expect(result.reason).toContain('cross-ref');
    expect(result.reason).toContain('12 items');
  });

  it('increases budget when contextDocs > 5', () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({ name: `doc${i}` }));
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 1,
      previousAnalyses: [],
      contextDocs: docs,
    });
    // docBoost = min(3072, 8*256) = 2048
    expect(result.budget).toBe(16384 + 2048);
    expect(result.reason).toContain('docs');
  });

  it('never exceeds model MAX even with all boosts active', () => {
    const modelMax = config.getMaxThinkingBudget();
    const prev = Array.from({ length: 10 }, () =>
      makeAnalysis({ tickets: 5, actions: 3, crs: 2, blockers: 1 }),
    );
    const docs = Array.from({ length: 15 }, (_, i) => ({ name: `doc${i}` }));
    const result = calculateThinkingBudget({
      segmentIndex: 9,
      totalSegments: 10,
      previousAnalyses: prev,
      contextDocs: docs,
      vttContent: TECHNICAL_VTT,
      baseBudget: 24000, // push well past MAX before clamping
    });
    expect(result.budget).toBeLessThanOrEqual(modelMax);
    expect(result.budget).toBe(modelMax);
  });

  it('never falls below MIN (8192) even with very low baseBudget', () => {
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 1,
      previousAnalyses: [],
      contextDocs: [],
      baseBudget: 100,
    });
    expect(result.budget).toBe(8192);
  });

  it('increases budget for VTT with technical terms (score > 30)', () => {
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 1,
      previousAnalyses: [],
      contextDocs: [],
      vttContent: TECHNICAL_VTT,
    });
    expect(result.complexity.complexityScore).toBeGreaterThan(30);
    expect(result.budget).toBeGreaterThan(16384);
    expect(result.reason).toContain('transcript');
  });

  it('returns complexityScore 0 for empty vttContent', () => {
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 1,
      previousAnalyses: [],
      contextDocs: [],
      vttContent: '',
    });
    expect(result.complexity.complexityScore).toBe(0);
  });

  it('reason string explains boost factors', () => {
    const prev = Array.from({ length: 5 }, () => makeAnalysis({ tickets: 5 }));
    const docs = Array.from({ length: 8 }, (_, i) => ({ name: `doc${i}` }));
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 3,
      previousAnalyses: prev,
      contextDocs: docs,
    });
    // Should contain cross-ref, docs, first-segment
    expect(result.reason).toContain('cross-ref');
    expect(result.reason).toContain('docs');
    expect(result.reason).toContain('first-segment');
  });

  it('gives no first-segment bonus for single-segment calls', () => {
    const result = calculateThinkingBudget({
      segmentIndex: 0,
      totalSegments: 1,
      previousAnalyses: [],
      contextDocs: [],
    });
    expect(result.reason).not.toContain('first-segment');
  });
});

// ── calculateCompilationBudget ───────────────────────────────────────

describe('calculateCompilationBudget', () => {
  it('returns base budget (10240) with 1 segment', () => {
    const result = calculateCompilationBudget([makeAnalysis({ tickets: 1 })]);
    expect(result.budget).toBe(10240);
    expect(result.reason).toBe('base budget');
  });

  it('adds segment boost when segment count > 4', () => {
    // 6 segments → boost = min(8192, (6-4)*2048) = 4096
    const analyses = Array.from({ length: 6 }, () => makeAnalysis({ tickets: 1 }));
    const result = calculateCompilationBudget(analyses);
    expect(result.budget).toBe(10240 + 4096);
    expect(result.reason).toContain('segments');
  });

  it('adds item boost when total items > 30', () => {
    // 3 segments × 12 tickets = 36 items → boost = min(6144, 36*100) = 3600
    const analyses = Array.from({ length: 3 }, () => makeAnalysis({ tickets: 12 }));
    const result = calculateCompilationBudget(analyses);
    expect(result.budget).toBe(10240 + 3600);
    expect(result.reason).toContain('items');
  });

  it('adds smaller item boost when total items > 10 and <= 30', () => {
    // 3 segments × 5 tickets = 15 items → boost = min(3072, 15*80) = 1200
    const analyses = Array.from({ length: 3 }, () => makeAnalysis({ tickets: 5 }));
    const result = calculateCompilationBudget(analyses);
    expect(result.budget).toBe(10240 + 1200);
    expect(result.reason).toContain('items');
  });

  it('never exceeds COMPILATION_MAX (24576)', () => {
    // 10 segments + tons of items → both boosts maxed
    const analyses = Array.from({ length: 10 }, () =>
      makeAnalysis({ tickets: 20, actions: 10, crs: 5, blockers: 5 }),
    );
    const result = calculateCompilationBudget(analyses);
    expect(result.budget).toBeLessThanOrEqual(24576);
    expect(result.budget).toBe(24576);
  });

  it('uses default baseBudget when none provided', () => {
    const result = calculateCompilationBudget([makeAnalysis()]);
    expect(result.budget).toBe(10240);
  });

  it('allows baseBudget override', () => {
    const result = calculateCompilationBudget([makeAnalysis()], 12000);
    expect(result.budget).toBe(12000);
  });
});
