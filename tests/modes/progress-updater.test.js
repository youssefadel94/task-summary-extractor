/**
 * Tests for progress-updater.js — local assessment, merge, summary, markdown rendering.
 */
const {
  STATUS,
  STATUS_ICONS,
  assessProgressLocal,
  mergeProgressIntoAnalysis,
  buildProgressSummary,
  renderProgressMarkdown,
} = require('../../src/modes/progress-updater');

// ─── STATUS constants ────────────────────────────────────────────────────────

describe('STATUS constants', () => {
  it('exports all expected statuses', () => {
    expect(STATUS.DONE).toBe('DONE');
    expect(STATUS.IN_PROGRESS).toBe('IN_PROGRESS');
    expect(STATUS.NOT_STARTED).toBe('NOT_STARTED');
    expect(STATUS.SUPERSEDED).toBe('SUPERSEDED');
  });

  it('exports status icons', () => {
    expect(STATUS_ICONS.DONE).toBeDefined();
    expect(STATUS_ICONS.IN_PROGRESS).toBeDefined();
    expect(STATUS_ICONS.NOT_STARTED).toBeDefined();
    expect(STATUS_ICONS.SUPERSEDED).toBeDefined();
  });
});

// ─── assessProgressLocal ─────────────────────────────────────────────────────

describe('assessProgressLocal', () => {
  const items = [
    { id: 'T1', type: 'ticket', title: 'Fix login' },
    { id: 'CR1', type: 'change_request', title: 'Update API' },
    { id: 'AI1', type: 'action_item', title: 'Write tests' },
  ];

  it('returns NOT_STARTED for all items when correlations are empty', () => {
    const correlations = new Map();
    const result = assessProgressLocal(items, correlations);
    expect(result).toHaveLength(3);
    result.forEach(r => {
      expect(r.status).toBe('NOT_STARTED');
      expect(r.confidence).toBe('LOW');
      expect(r.evidence).toEqual([]);
    });
  });

  it('returns DONE for items with high correlation scores', () => {
    const correlations = new Map([
      ['T1', {
        itemId: 'T1',
        score: 0.8,
        evidence: [{ type: 'id_in_commit', detail: 'Commit abc: Fix T1' }],
        localAssessment: 'DONE',
        localConfidence: 'MEDIUM',
      }],
    ]);
    const result = assessProgressLocal(items, correlations);
    const t1 = result.find(r => r.item_id === 'T1');
    expect(t1.status).toBe('DONE');
    expect(t1.confidence).toBe('MEDIUM');
    expect(t1.evidence).toHaveLength(1);
  });

  it('returns IN_PROGRESS for items with moderate correlation scores', () => {
    const correlations = new Map([
      ['CR1', {
        itemId: 'CR1',
        score: 0.35,
        evidence: [{ type: 'keyword_match', detail: 'API found in commits' }],
        localAssessment: 'IN_PROGRESS',
        localConfidence: 'LOW',
      }],
    ]);
    const result = assessProgressLocal(items, correlations);
    const cr1 = result.find(r => r.item_id === 'CR1');
    expect(cr1.status).toBe('IN_PROGRESS');
  });

  it('returns NOT_STARTED for items with zero-score correlations', () => {
    const correlations = new Map([
      ['AI1', {
        itemId: 'AI1',
        score: 0,
        evidence: [],
        localAssessment: 'NOT_STARTED',
        localConfidence: 'VERY_LOW',
      }],
    ]);
    const result = assessProgressLocal(items, correlations);
    const ai1 = result.find(r => r.item_id === 'AI1');
    expect(ai1.status).toBe('NOT_STARTED');
  });

  it('handles empty items array', () => {
    expect(assessProgressLocal([], new Map())).toEqual([]);
  });
});

// ─── buildProgressSummary ────────────────────────────────────────────────────

describe('buildProgressSummary', () => {
  it('counts each status correctly', () => {
    const assessments = [
      { status: 'DONE' },
      { status: 'DONE' },
      { status: 'IN_PROGRESS' },
      { status: 'NOT_STARTED' },
      { status: 'SUPERSEDED' },
    ];
    const s = buildProgressSummary(assessments);
    expect(s.done).toBe(2);
    expect(s.inProgress).toBe(1);
    expect(s.notStarted).toBe(1);
    expect(s.superseded).toBe(1);
    expect(s.total).toBe(5);
  });

  it('returns zeros for empty array', () => {
    const s = buildProgressSummary([]);
    expect(s.done).toBe(0);
    expect(s.total).toBe(0);
  });
});

// ─── mergeProgressIntoAnalysis ───────────────────────────────────────────────

describe('mergeProgressIntoAnalysis', () => {
  it('adds _progress to matching items', () => {
    const analysis = {
      tickets: [{ ticket_id: 'T1', title: 'Fix bug' }],
      change_requests: [{ id: 'CR1', title: 'Update' }],
      action_items: [],
      blockers: [],
      scope_changes: [],
    };
    const assessments = [
      { item_id: 'T1', status: 'DONE', confidence: 'HIGH', evidence: [], notes: 'Done' },
      { item_id: 'CR1', status: 'IN_PROGRESS', confidence: 'LOW', evidence: [], notes: 'WIP' },
    ];
    const result = mergeProgressIntoAnalysis(analysis, assessments);
    expect(result.tickets[0]._progress.status).toBe('DONE');
    expect(result.change_requests[0]._progress.status).toBe('IN_PROGRESS');
    expect(result.tickets[0]._progress.assessedAt).toBeDefined();
  });

  it('handles null analysis gracefully', () => {
    expect(mergeProgressIntoAnalysis(null, [])).toBeNull();
  });

  it('handles null assessments gracefully', () => {
    const analysis = { tickets: [{ ticket_id: 'T1' }] };
    expect(mergeProgressIntoAnalysis(analysis, null)).toBe(analysis);
  });

  it('does not crash on analysis with missing sections', () => {
    const analysis = {};
    const result = mergeProgressIntoAnalysis(analysis, [{ item_id: 'X', status: 'DONE' }]);
    expect(result).toEqual({});
  });
});

// ─── renderProgressMarkdown ──────────────────────────────────────────────────

describe('renderProgressMarkdown', () => {
  it('renders a valid markdown report', () => {
    const md = renderProgressMarkdown({
      assessments: [
        { item_id: 'T1', item_type: 'ticket', title: 'Fix login', status: 'DONE', confidence: 'HIGH', evidence: [], notes: 'Done via PR' },
        { item_id: 'AI1', item_type: 'action_item', title: 'Tests', status: 'NOT_STARTED', confidence: 'LOW', evidence: [], notes: 'No changes' },
      ],
      changeReport: {
        git: { available: true, branch: 'main', commits: [{ hash: 'abc' }], changedFiles: [{ path: 'f.js', status: 'M', changes: 2 }] },
        documents: { changes: [] },
        totals: { commits: 1, filesChanged: 1, docsChanged: 0 },
      },
      meta: { callName: 'test-call', timestamp: '2026-03-04', mode: 'auto' },
    });

    expect(md).toContain('# Progress Report');
    expect(md).toContain('test-call');
    expect(md).toContain('auto');
    expect(md).toContain('Completed');
    expect(md).toContain('Not Started');
    expect(md).toContain('50%');
    expect(md).toContain('T1');
    expect(md).toContain('AI1');
  });

  it('renders mode: auto for auto-tracked runs', () => {
    const md = renderProgressMarkdown({
      assessments: [],
      changeReport: {
        git: { available: false },
        documents: { changes: [] },
        totals: { commits: 0, filesChanged: 0, docsChanged: 0 },
      },
      meta: { mode: 'auto' },
    });
    expect(md).toContain('Mode: auto');
  });
});
