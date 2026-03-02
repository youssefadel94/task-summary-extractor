const { identifyWeaknesses } = require('../../src/modes/focused-reanalysis');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a quality report with configurable dimension scores.
 * @param {number} overall - Overall score
 * @param {object} [dimOverrides] - Override specific dimension scores
 * @returns {object} Quality report
 */
function makeQualityReport(overall, dimOverrides = {}) {
  return {
    score: overall,
    grade: overall >= 65 ? 'PASS' : overall >= 45 ? 'WARN' : 'FAIL',
    dimensions: {
      structure: { score: dimOverrides.structure ?? 80, issues: [] },
      density: { score: dimOverrides.density ?? 50, issues: [] },
      integrity: { score: dimOverrides.integrity ?? 80, issues: [] },
      crossRef: { score: dimOverrides.crossRef ?? 100, issues: [] },
    },
  };
}

/**
 * Build a minimal analysis with configurable item counts.
 */
function makeAnalysis(opts = {}) {
  const {
    tickets = 0,
    actions = 0,
    blockers = 0,
    scopes = 0,
    crs = 0,
    withConfidence = true,
  } = opts;

  return {
    summary: 'Test summary',
    tickets: Array.from({ length: tickets }, (_, i) => ({
      ticket_id: `T-${i}`,
      title: `Ticket ${i}`,
      status: 'open',
      confidence: withConfidence ? 'HIGH' : undefined,
    })),
    action_items: Array.from({ length: actions }, (_, i) => ({
      id: `AI-${i}`,
      description: `Action ${i}`,
      assigned_to: 'Alice',
      confidence: withConfidence ? 'MEDIUM' : undefined,
    })),
    blockers: Array.from({ length: blockers }, (_, i) => ({
      id: `B-${i}`,
      description: `Blocker ${i}`,
    })),
    scope_changes: Array.from({ length: scopes }, (_, i) => ({
      id: `SC-${i}`,
      what: `Scope ${i}`,
    })),
    change_requests: Array.from({ length: crs }, (_, i) => ({
      id: `CR-${i}`,
      what: `CR ${i}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// identifyWeaknesses tests
// ---------------------------------------------------------------------------

describe('identifyWeaknesses', () => {
  it('returns no weaknesses for a high-quality analysis', () => {
    const report = makeQualityReport(75, { density: 70 });
    const analysis = makeAnalysis({ tickets: 3, actions: 2, blockers: 1 });
    const result = identifyWeaknesses(report, analysis);

    expect(result.weakAreas).toHaveLength(0);
    expect(result.shouldReanalyze).toBe(false);
  });

  it('returns null/empty for null inputs', () => {
    expect(identifyWeaknesses(null, null).shouldReanalyze).toBe(false);
    expect(identifyWeaknesses(null, null).weakAreas).toHaveLength(0);
  });

  it('identifies missing tickets when density is low', () => {
    const report = makeQualityReport(40, { density: 20 });
    const analysis = makeAnalysis({ tickets: 0, actions: 0 });
    const result = identifyWeaknesses(report, analysis);

    expect(result.weakAreas).toContain('tickets');
    expect(result.weakAreas).toContain('action_items');
      expect(result.focusPrompt).toContain('TICKET EXTRACTION');
  });

  it('identifies missing confidence on items', () => {
    const report = makeQualityReport(50, { density: 60 });
    const analysis = makeAnalysis({ tickets: 3, actions: 2, withConfidence: false });
    const result = identifyWeaknesses(report, analysis);

    expect(result.weakAreas).toContain('confidence');
  });

  // === SPARSE SEGMENT SKIP (new behaviour) ===

  it('does NOT trigger shouldReanalyze for sparse / simple segments', () => {
    // Scenario: low quality, multiple weak areas, BUT only 1 item total + low density
    // This is a simple segment — focused pass would be wasted.
    const report = makeQualityReport(40, { density: 15 });
    const analysis = makeAnalysis({ tickets: 1, actions: 0, blockers: 0 });
    const result = identifyWeaknesses(report, analysis);

    // Weak areas may still be identified (for info) but shouldReanalyze = false
    expect(result.weakAreas.length).toBeGreaterThanOrEqual(2);
    expect(result.shouldReanalyze).toBe(false);
  });

  it('does NOT trigger shouldReanalyze when 0 items + low density', () => {
    const report = makeQualityReport(35, { density: 10 });
    const analysis = makeAnalysis({ tickets: 0, actions: 0 });
    const result = identifyWeaknesses(report, analysis);

    expect(result.shouldReanalyze).toBe(false);
  });

  it('DOES trigger shouldReanalyze for low quality with enough items', () => {
    // Many items but low quality — segment is complex, focused pass is justified
    const report = makeQualityReport(45, { density: 25 });
    const analysis = makeAnalysis({ tickets: 3, actions: 2, blockers: 0, withConfidence: false });
    const result = identifyWeaknesses(report, analysis);

    expect(result.shouldReanalyze).toBe(true);
  });

  it('skips re-analysis when quality is above 60 regardless of weaknesses', () => {
    const report = makeQualityReport(62, { density: 30 });
    const analysis = makeAnalysis({ tickets: 0, actions: 0 });
    const result = identifyWeaknesses(report, analysis);

    expect(result.shouldReanalyze).toBe(false);
  });

  it('identifies cross-reference issues', () => {
    const report = makeQualityReport(45, { crossRef: 50 });
    const analysis = makeAnalysis({ tickets: 3, actions: 2 });
    const result = identifyWeaknesses(report, analysis);

    expect(result.weakAreas).toContain('cross_references');
  });
});
