const {
  packChangeRequests,
  normalizeChangeRequests,
  sortChangeRequests,
  crSignature,
  priorityRank,
  priorityCounts,
  sourceLabel,
} = require('../../src/utils/cr-pack');

describe('crSignature', () => {
  it('ignores the id — differing ids for one change is the case it exists for', () => {
    const a = { id: 'CR-1', title: 'Fix the login redirect loop', where: { file_path: 'src/auth/Login.cs' } };
    const b = { id: 'CR-9', title: 'Fix the login redirect loop', where: { file_path: 'other/Login.cs' } };
    expect(crSignature(a)).toBe(crSignature(b));
  });

  it('separates the same wording in different files', () => {
    const a = { title: 'Add validation to the form', where: { file_path: 'ui/Order.cs' } };
    const b = { title: 'Add validation to the form', where: { file_path: 'ui/Customer.cs' } };
    expect(crSignature(a)).not.toBe(crSignature(b));
  });

  it('refuses to sign text too short to match safely', () => {
    expect(crSignature({ title: 'Fix' })).toBe('');
    expect(crSignature(null)).toBe('');
  });
});

describe('normalizeChangeRequests', () => {
  it('collapses the same change raised under two ids', () => {
    const out = normalizeChangeRequests([
      { id: 'CR-1', title: 'Fix the login redirect loop', source_segment: 2 },
      { id: 'CR-7', title: 'Fix the login redirect loop', source_segment: 5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('CR-1');
    expect(out[0].merged_ids).toEqual(['CR-7']);
  });

  it('unions what each partial copy knew', () => {
    const [cr] = normalizeChangeRequests([
      { id: 'CR-1', title: 'Rework the export scheduler', related_tickets: ['T-1'] },
      { id: 'CR-1', how: 'move it onto the queue', related_tickets: ['T-2'], where: { file_path: 'jobs/Export.cs' } },
      { id: 'CR-1', why: 'the nightly run times out' },
    ]);
    expect(cr.how).toBe('move it onto the queue');
    expect(cr.why).toBe('the nightly run times out');
    expect(cr.where.file_path).toBe('jobs/Export.cs');
    expect(cr.related_tickets.sort()).toEqual(['T-1', 'T-2']);
  });

  it('keeps the most urgent priority a copy reported', () => {
    // Under-reporting priority is how urgent work gets scheduled late.
    const [cr] = normalizeChangeRequests([
      { id: 'CR-1', title: 'Restore the nightly backup job', priority: 'low' },
      { id: 'CR-1', title: 'Restore the nightly backup job', priority: 'critical' },
      { id: 'CR-1', title: 'Restore the nightly backup job', priority: 'medium' },
    ]);
    expect(cr.priority).toBe('critical');
  });

  it('keeps the longer wording of each free-text field', () => {
    const [cr] = normalizeChangeRequests([
      { id: 'CR-1', what: 'fix export' },
      { id: 'CR-1', what: 'fix the export job so it retries on a timeout' },
    ]);
    expect(cr.what).toBe('fix the export job so it retries on a timeout');
  });

  it('records every segment a copy came from', () => {
    const [cr] = normalizeChangeRequests([
      { id: 'CR-1', title: 'Rework the export scheduler', source_segment: 1, source_video: 'call.mp4' },
      { id: 'CR-2', title: 'Rework the export scheduler', source_segment: 4, source_video: 'call.mp4' },
    ]);
    expect(cr.sources).toEqual(['call.mp4 · Seg 1', 'call.mp4 · Seg 4']);
  });

  it('folds a copy that never said where into the one that did', () => {
    // One segment named the file, another only described the change.
    const out = normalizeChangeRequests([
      { id: 'CR-1', title: 'Fix the login redirect loop', where: { file_path: 'auth/Login.cs' } },
      { id: 'CR-9', title: 'Fix the login redirect loop', priority: 'high' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].where.file_path).toBe('auth/Login.cs');
    expect(out[0].priority).toBe('high');
  });

  it('folds in the same order when the located copy arrives second', () => {
    const out = normalizeChangeRequests([
      { id: 'CR-9', title: 'Fix the login redirect loop', priority: 'high' },
      { id: 'CR-1', title: 'Fix the login redirect loop', where: { file_path: 'auth/Login.cs' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].where.file_path).toBe('auth/Login.cs');
  });

  it('still separates the same wording in two different files', () => {
    const out = normalizeChangeRequests([
      { id: 'CR-1', title: 'Add validation to the form', where: { file_path: 'ui/Order.cs' } },
      { id: 'CR-2', title: 'Add validation to the form', where: { file_path: 'ui/Customer.cs' } },
    ]);
    expect(out).toHaveLength(2);
  });

  it('leaves genuinely different changes alone', () => {
    const out = normalizeChangeRequests([
      { id: 'CR-1', title: 'Fix the login redirect loop' },
      { id: 'CR-2', title: 'Add audit logging to the export job' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('survives junk entries', () => {
    expect(normalizeChangeRequests([null, undefined, 'nope', { id: 'CR-1' }])).toHaveLength(1);
    expect(normalizeChangeRequests(null)).toEqual([]);
  });
});

describe('sortChangeRequests', () => {
  it('orders critical first and unprioritized last', () => {
    const out = sortChangeRequests([
      { id: 'A' },
      { id: 'B', priority: 'medium' },
      { id: 'C', priority: 'critical' },
      { id: 'D', priority: 'low' },
      { id: 'E', priority: 'high' },
    ]);
    expect(out.map(cr => cr.id)).toEqual(['C', 'E', 'B', 'D', 'A']);
  });

  it('breaks a priority tie with how stuck the work is', () => {
    const out = sortChangeRequests([
      { id: 'A', priority: 'high', status: 'completed' },
      { id: 'B', priority: 'high', status: 'blocked' },
      { id: 'C', priority: 'high', status: 'actionable' },
    ]);
    expect(out.map(cr => cr.id)).toEqual(['B', 'C', 'A']);
  });

  it('is stable across repeated runs of the same data', () => {
    const input = [
      { id: 'CR-10', priority: 'high' },
      { id: 'CR-2', priority: 'high' },
      { id: 'CR-1', priority: 'high' },
    ];
    expect(sortChangeRequests(input).map(cr => cr.id))
      .toEqual(sortChangeRequests(input).map(cr => cr.id));
    // Numeric-aware so CR-2 precedes CR-10.
    expect(sortChangeRequests(input).map(cr => cr.id)).toEqual(['CR-1', 'CR-2', 'CR-10']);
  });

  it('does not mutate its input', () => {
    const input = [{ id: 'B', priority: 'low' }, { id: 'A', priority: 'critical' }];
    sortChangeRequests(input);
    expect(input.map(cr => cr.id)).toEqual(['B', 'A']);
  });
});

describe('packChangeRequests', () => {
  it('deduplicates and sorts in one pass', () => {
    const out = packChangeRequests([
      { id: 'CR-1', title: 'Fix the login redirect loop', priority: 'low' },
      { id: 'CR-2', title: 'Add audit logging to the export job', priority: 'critical' },
      { id: 'CR-3', title: 'Fix the login redirect loop', priority: 'high' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('CR-2');
    expect(out[1].priority).toBe('high');   // the merged login CR was promoted
  });
});

describe('priorityCounts / priorityRank / sourceLabel', () => {
  it('counts every bucket including the unset one', () => {
    expect(priorityCounts([
      { priority: 'critical' }, { priority: 'high' }, { priority: 'high' }, {},
    ])).toEqual({ critical: 1, high: 2, medium: 0, low: 0, unset: 1 });
  });

  it('ranks unset last', () => {
    expect(priorityRank('critical')).toBeLessThan(priorityRank('low'));
    expect(priorityRank(undefined)).toBeGreaterThan(priorityRank('low'));
  });

  it('labels a source with whatever it knows', () => {
    expect(sourceLabel({ source_video: 'a.mp4', source_segment: 3 })).toBe('a.mp4 · Seg 3');
    expect(sourceLabel({ source_segment: 3 })).toBe('Seg 3');
    expect(sourceLabel({})).toBe('');
  });
});
