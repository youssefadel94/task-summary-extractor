const {
  auditRun,
  renderAuditMarkdown,
  formatAuditLine,
  collectSegmentAnalyses,
  auditSegments,
  auditChangeRequestDedup,
  auditConfidence,
  auditModels,
  auditWithheld,
} = require('../../src/utils/coverage-audit');
const { filterByConfidence } = require('../../src/utils/confidence-filter');

const results = (segments) => ({
  callName: 'demo',
  files: [{ originalFile: 'call.mp4', segments }],
});

const seg = (name, analysis) => ({ segmentFile: name, analysis });

describe('collectSegmentAnalyses', () => {
  it('flattens usable analyses and skips failed segments', () => {
    const out = collectSegmentAnalyses(results([
      seg('s1.mp4', { tickets: [{ ticket_id: 'T-1' }] }),
      seg('s2.mp4', { error: '503 overloaded' }),
      seg('s3.mp4', null),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]._segment).toBe('s1.mp4');
    expect(out[0]._video).toBe('call.mp4');
  });
});

describe('auditSegments', () => {
  it('counts analyzed, failed and empty segments with reasons', () => {
    const s = auditSegments(results([
      seg('s1.mp4', { tickets: [{ ticket_id: 'T-1' }] }),
      seg('s2.mp4', { tickets: [] }),
      seg('s3.mp4', { error: 'INVALID_ARGUMENT' }),
    ]));
    expect(s).toMatchObject({ total: 3, analyzed: 2, failed: 1, empty: 1 });
    expect(s.failures[0]).toMatchObject({ segment: 's3.mp4', video: 'call.mp4' });
  });
});

describe('auditRun', () => {
  it('passes when every segment item survived into the report and is rendered', () => {
    const compiled = {
      tickets: [{ ticket_id: 'T-1', title: 'Login bug', assignee: 'Jane', source_segment: 1 }],
    };
    const report = auditRun({
      results: results([seg('s1.mp4', { tickets: compiled.tickets })]),
      compiled,
      renderedText: 'the report mentions T-1 here',
    });
    expect(report.status).toBe('PASS');
    expect(report.totals.missing).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it('fails and names an item the compilation dropped', () => {
    const report = auditRun({
      results: results([seg('s1.mp4', {
        action_items: [
          { id: 'AI-1', description: 'Jane to write the migration notes' },
          { id: 'AI-2', description: 'Sam to run a full load test on staging' },
        ],
      })]),
      compiled: { action_items: [{ id: 'AI-1', description: 'Jane to write the migration notes', assigned_to: 'Jane', source_segment: 1 }] },
      renderedText: 'AI-1',
    });
    expect(report.status).toBe('FAIL');
    expect(report.totals.missing).toBe(1);
    const row = report.collections.find(r => r.field === 'action_items');
    expect(row.missing[0].label).toMatch(/load test/i);
  });

  it('fails when a compiled item never appears in the document', () => {
    const report = auditRun({
      results: results([seg('s1.mp4', { blockers: [{ id: 'BLK-1', description: 'Staging database is empty' }] })]),
      compiled: { blockers: [{ id: 'BLK-1', description: 'Staging database is empty', owner: 'Jane', source_segment: 1 }] },
      renderedText: 'a report that forgot the blockers section',
    });
    expect(report.status).toBe('FAIL');
    expect(report.totals.renderMissing).toBe(1);
  });

  it('warns — but does not fail — on unowned items', () => {
    const compiled = { blockers: [{ id: 'BLK-1', description: 'Staging database is empty', source_segment: 1 }] };
    const report = auditRun({
      results: results([seg('s1.mp4', compiled)]),
      compiled,
      renderedText: 'BLK-1',
    });
    expect(report.status).toBe('WARN');
    expect(report.issues.join(' ')).toMatch(/no owner/);
  });

  it('flags a --name that matched nobody in the call', () => {
    const report = auditRun({
      results: results([]),
      compiled: {},
      personScope: { person: 'Ghost', counts: { total: 0 }, isEmpty: true },
    });
    expect(report.issues.join(' ')).toMatch(/Ghost/);
  });

  it('reports how many duplicate change requests were collapsed', () => {
    const compiled = {
      change_requests: [
        { id: 'CR-1', title: 'Fix the login redirect loop', assigned_to: 'Jane', priority: 'high', source_segment: 1 },
        { id: 'CR-5', title: 'Fix the login redirect loop', assigned_to: 'Jane', priority: 'high', source_segment: 2 },
      ],
    };
    const report = auditRun({ results: results([]), compiled, renderedText: 'CR-1 CR-5' });
    expect(report.changeRequests).toMatchObject({ before: 2, after: 1, collapsed: 1 });
    expect(report.changeRequests.mergedIds[0].absorbed).toEqual(['CR-5']);
  });

  it('never modifies the analysis it audits', () => {
    const compiled = { tickets: [{ ticket_id: 'T-1', assignee: 'Jane' }] };
    const before = JSON.stringify(compiled);
    auditRun({ results: results([]), compiled, renderedText: 'T-1' });
    expect(JSON.stringify(compiled)).toBe(before);
  });

  it('survives an empty run', () => {
    const report = auditRun({});
    expect(report.status).toBe('PASS');
    expect(report.totals.compiled).toBe(0);
  });
});

describe('auditConfidence', () => {
  it('spreads confidence across every collection', () => {
    const dist = auditConfidence({
      tickets: [{ confidence: 'HIGH' }, { confidence: 'LOW' }],
      blockers: [{}],
    });
    expect(dist).toMatchObject({ HIGH: 1, LOW: 1, unset: 1, total: 3 });
  });
});

describe('auditChangeRequestDedup', () => {
  it('counts change requests with no priority', () => {
    const out = auditChangeRequestDedup({
      change_requests: [{ id: 'CR-1', title: 'Fix the login redirect loop' }],
    });
    expect(out.unprioritized).toBe(1);
  });
});

describe('renderAuditMarkdown', () => {
  it('renders the verdict, the accounting table and the missing items', () => {
    const report = auditRun({
      results: results([
        seg('s1.mp4', { action_items: [{ id: 'AI-1', description: 'Sam to run a full load test on staging' }] }),
        seg('s2.mp4', { error: 'timeout' }),
      ]),
      compiled: { action_items: [] },
      renderedText: '',
      meta: { callName: 'demo' },
    });
    const md = renderAuditMarkdown(report);
    expect(md).toContain('# 🔍 Coverage Audit — demo');
    expect(md).toContain('**FAIL**');
    expect(md).toContain('## 📊 Item Accounting');
    expect(md).toContain('load test');
    expect(md).toContain('## 🚫 Segments that produced no analysis'.replace('## ', '### '));
  });

  it('says so plainly when nothing was lost', () => {
    const md = renderAuditMarkdown(auditRun({
      results: results([seg('s1.mp4', { tickets: [{ ticket_id: 'T-1', assignee: 'Jane' }] })]),
      compiled: { tickets: [{ ticket_id: 'T-1', assignee: 'Jane', source_segment: 1 }] },
      renderedText: 'T-1',
    }));
    expect(md).toMatch(/Every item extracted from every segment/);
  });
});

describe('formatAuditLine', () => {
  it('summarises the verdict in one line', () => {
    const line = formatAuditLine(auditRun({
      results: results([]),
      compiled: { tickets: [{ ticket_id: 'T-1', assignee: 'Jane' }] },
      renderedText: 'T-1',
    }));
    expect(line).toMatch(/Audit PASS/);
    expect(line).toMatch(/1 items/);
  });
});

describe('auditModels', () => {
  it('records which model actually answered each segment', () => {
    const out = auditModels([
      { _geminiMeta: { model: 'gemini-3-flash-preview' } },
      { _geminiMeta: { model: 'gemini-3.1-pro-preview' } },
      { _geminiMeta: { model: 'gemini-3-flash-preview' } },
    ]);
    expect(out.distinct).toBe(2);
    expect(out.counts['gemini-3-flash-preview']).toBe(2);
    expect(out.segments).toBe(3);
  });

  it('counts segments whose model was never recorded', () => {
    expect(auditModels([{}, { _geminiMeta: {} }]).unknown).toBe(2);
  });
});

describe('models in the audit report', () => {
  it('names every model that produced part of the run', () => {
    const results = {
      files: [{
        originalFile: 'call.mp4',
        segments: [
          { segmentFile: 's1', analysis: { tickets: [{ ticket_id: 'T-1', assignee: 'Jane' }], _geminiMeta: { model: 'gemini-3-flash-preview' } } },
          { segmentFile: 's2', analysis: { tickets: [{ ticket_id: 'T-1', assignee: 'Jane' }], _geminiMeta: { model: 'gemini-3.1-pro-preview' } } },
        ],
      }],
    };
    const report = auditRun({
      results,
      compiled: { tickets: [{ ticket_id: 'T-1', assignee: 'Jane', source_segment: 1 }] },
      renderedText: 'T-1',
    });
    expect(report.models.distinct).toBe(2);
    const md = renderAuditMarkdown(report);
    expect(md).toContain('## 🤖 Models Used');
    expect(md).toContain('gemini-3.1-pro-preview');
  });

  it('omits the model section when no segment recorded one', () => {
    const md = renderAuditMarkdown(auditRun({ results: { files: [] }, compiled: {} }));
    expect(md).not.toContain('Models Used');
  });
});

describe('the confidence filter is reported, not mistaken for lost work', () => {
  const compiled = () => ({
    tickets: [
      { ticket_id: 'T-1', title: 'Login bug', assignee: 'Jane', confidence: 'HIGH', source_segment: 1 },
      { ticket_id: 'T-2', title: 'A guess', assignee: 'Jane', confidence: 'LOW', source_segment: 1 },
    ],
  });

  it('counts withheld items separately from missing ones', () => {
    const full = compiled();
    const shown = filterByConfidence(JSON.parse(JSON.stringify(full)), 'HIGH');
    const report = auditRun({
      results: { files: [{ originalFile: 'call.mp4', segments: [{ segmentFile: 's1', analysis: full }] }] },
      compiled: full,
      filteredCompiled: shown,
      renderedText: 'T-1',      // T-2 was withheld, so it is correctly absent
    });

    expect(report.totals.missing).toBe(0);
    expect(report.totals.renderMissing).toBe(0);
    expect(report.withheld).toMatchObject({ total: 1, minConfidence: 'HIGH' });
    expect(report.withheld.byCollection.tickets).toBe(1);
    expect(report.status).toBe('WARN');
    expect(report.issues.join(' ')).toMatch(/withheld from the report by --min-confidence high/);
  });

  it('names the withheld items in the audit document', () => {
    const full = compiled();
    const shown = filterByConfidence(JSON.parse(JSON.stringify(full)), 'HIGH');
    const md = renderAuditMarkdown(auditRun({
      results: { files: [] },
      compiled: full,
      filteredCompiled: shown,
      renderedText: 'T-1',
    }));
    expect(md).toContain('## 🙈 Withheld by the Confidence Filter');
    expect(md).toContain('They are not lost');
  });

  it('reports nothing withheld when no filter ran', () => {
    expect(auditWithheld({ tickets: [] }, null)).toBe(null);
    const unfiltered = filterByConfidence({ tickets: [{ ticket_id: 'T-1', confidence: 'LOW' }] }, 'LOW');
    expect(auditWithheld({ tickets: [{ ticket_id: 'T-1', confidence: 'LOW' }] }, unfiltered)).toBe(null);
  });
});

describe('an id a change request absorbed still counts as present', () => {
  it('does not report a merged id as missing from the report', () => {
    const report = auditRun({
      results: { files: [{ originalFile: 'call.mp4', segments: [{ segmentFile: 's1', analysis: { change_requests: [{ id: 'NEW-CR-1', title: 'Move Capacity Check to Start of Workflow' }] } }] }] },
      compiled: { change_requests: [{ id: 'CR-CAPACITY', title: 'Move Capacity Check to Start of Workflow', assigned_to: 'Jane', source_segment: 1, merged_ids: ['NEW-CR-1'] }] },
      renderedText: 'CR-CAPACITY',
    });
    expect(report.totals.missing).toBe(0);
    expect(report.issues.join(' ')).not.toMatch(/absent from the compiled result/);
  });
});
