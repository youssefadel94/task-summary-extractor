const { renderChangeRequestHandoff, renderChangeRequestsCsv } = require('../../src/renderers/change-requests');

const compiled = {
  change_requests: [
    {
      id: 'CR-3', title: 'Retire the legacy CSV export', what: 'delete the old export path',
      how: 'remove ExportV1 and route callers to ExportV2', why: 'it double-charges customers',
      type: 'cleanup', priority: 'low', status: 'actionable', assigned_to: 'Sam Carter (QA)',
      where: { file_path: 'jobs/ExportV1.cs', module: 'billing' }, referenced_at: '00:12:40',
      source_segment: 2, source_video: 'call.mp4',
    },
    {
      id: 'CR-1', title: 'Fix the login redirect loop', what: 'stop the redirect bouncing',
      type: 'bug_fix', priority: 'critical', status: 'blocked', blocked_by: 'BLK-2',
      where: { file_path: 'auth/Login.cs' }, related_tickets: ['T-1'], confidence: 'HIGH',
    },
    {
      id: 'CR-7', title: 'Fix the login redirect loop', why: 'users cannot sign in at all',
      priority: 'high', where: { file_path: 'auth/Login.cs' },
    },
    {
      id: 'CR-4', title: 'Add rate limiting to the public API', priority: 'high',
      status: 'pending_decision',
    },
  ],
  tickets: [{ ticket_id: 'T-1', assignee: 'Sam Carter' }],
  action_items: [],
};

const meta = { callName: 'sprint-sync', processedAt: '2026-09-10T09:00:00.000Z', segmentCount: 4, geminiModel: 'gemini-3-flash-preview' };

describe('renderChangeRequestHandoff', () => {
  const out = renderChangeRequestHandoff({ compiled, meta });

  it('emits every change exactly once', () => {
    // CR-1 and CR-7 are the same change under two ids.
    expect(out.changeRequests).toHaveLength(3);
    const ids = out.changeRequests.map(cr => cr.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('CR-7');
  });

  it('orders the document by priority', () => {
    expect(out.changeRequests.map(cr => cr.priority)).toEqual(['critical', 'high', 'low']);
  });

  it('keeps the detail each duplicate carried', () => {
    const merged = out.changeRequests.find(cr => cr.id === 'CR-1');
    expect(merged.why).toBe('users cannot sign in at all');
    expect(merged.merged_ids).toEqual(['CR-7']);
  });

  it('states the counts the other team reads first', () => {
    expect(out.counts).toMatchObject({ critical: 1, high: 1, low: 1 });
    expect(out.markdown).toContain('1 critical · 1 high · 0 medium · 1 low');
    expect(out.markdown).toContain('**Change requests**: 3');
  });

  it('carries what, how, why and where for each change', () => {
    expect(out.markdown).toContain('**What** — delete the old export path');
    expect(out.markdown).toContain('**How** — remove ExportV1 and route callers to ExportV2');
    expect(out.markdown).toContain('**Why** — it double-charges customers');
    expect(out.markdown).toContain('`jobs/ExportV1.cs`');
    expect(out.markdown).toContain('module: billing');
  });

  it('traces a change back to the point in the recording it came from', () => {
    expect(out.markdown).toContain('00:12:40');
    expect(out.markdown).toContain('Seg 2');
  });

  it('warns about what cannot be started yet', () => {
    expect(out.markdown).toContain('## ⚠️ Before You Start');
    expect(out.markdown).toMatch(/Awaiting a decision \(1\)/);
    expect(out.markdown).toMatch(/Blocked \(1\)/);
    expect(out.markdown).toMatch(/No owner assigned \(2\)/);
  });

  it('resolves assignee spellings against the rest of the call', () => {
    // "Sam Carter (QA)" on the CR, "Sam Carter" on the ticket — one person.
    expect(out.markdown).toContain('Sam Carter');
  });

  it('indexes every change at the top', () => {
    expect(out.markdown).toContain('## 📇 Index');
    for (const id of ['CR-1', 'CR-3', 'CR-4']) expect(out.markdown).toContain(`\`${id}\``);
  });

  it('says so when a call raised no change requests', () => {
    const empty = renderChangeRequestHandoff({ compiled: { change_requests: [] }, meta });
    expect(empty.markdown).toContain('No change requests were raised');
    expect(empty.changeRequests).toEqual([]);
  });

  it('renders from nothing at all without throwing', () => {
    expect(() => renderChangeRequestHandoff({ compiled: null })).not.toThrow();
  });
});

describe('renderChangeRequestsCsv', () => {
  const { changeRequests } = renderChangeRequestHandoff({ compiled, meta });
  const csv = renderChangeRequestsCsv(changeRequests, meta);

  it('writes a header plus one row per change', () => {
    const rows = csv.trim().split('\n');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/^id,priority,status,type,title/);
  });

  it('quotes fields containing commas', () => {
    const withComma = renderChangeRequestsCsv([{ id: 'CR-9', what: 'do this, then that' }], meta);
    expect(withComma).toContain('"do this, then that"');
  });

  it('escapes embedded quotes and flattens newlines', () => {
    const tricky = renderChangeRequestsCsv([{ id: 'CR-9', what: 'say "hi"\nthen leave' }], meta);
    expect(tricky).toContain('"say ""hi"" then leave"');
  });
});
