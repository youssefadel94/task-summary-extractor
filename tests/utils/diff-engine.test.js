const { generateDiff, renderDiffMarkdown } = require('../../src/utils/diff-engine');

// ─── generateDiff ────────────────────────────────────────────────────────────

describe('generateDiff', () => {
  it('returns hasDiff:false with reason "no_previous_run" when previous is null', () => {
    const result = generateDiff({ tickets: [] }, null);
    expect(result).toEqual({ hasDiff: false, reason: 'no_previous_run' });
  });

  it('returns hasDiff:false with reason "no_current_data" when current is null', () => {
    const result = generateDiff(null, { tickets: [] });
    expect(result).toEqual({ hasDiff: false, reason: 'no_current_data' });
  });

  it('returns hasDiff:true when both current and previous are valid objects', () => {
    const result = generateDiff({ tickets: [] }, { tickets: [] });
    expect(result.hasDiff).toBe(true);
  });

  it('detects added tickets present in current but not in previous', () => {
    const current = { tickets: [{ ticket_id: 'T-1', title: 'New Ticket' }] };
    const previous = { tickets: [] };
    const diff = generateDiff(current, previous);

    expect(diff.tickets.added).toHaveLength(1);
    expect(diff.tickets.added[0].id).toBe('T-1');
    expect(diff.tickets.added[0]._diffStatus).toBe('new');
  });

  it('detects removed tickets present in previous but not in current', () => {
    const current = { tickets: [] };
    const previous = { tickets: [{ ticket_id: 'T-OLD', title: 'Gone' }] };
    const diff = generateDiff(current, previous);

    expect(diff.tickets.removed).toHaveLength(1);
    expect(diff.tickets.removed[0].id).toBe('T-OLD');
    expect(diff.tickets.removed[0]._diffStatus).toBe('removed');
  });

  it('detects changed items when same id but important field differs', () => {
    const current = { tickets: [{ ticket_id: 'T-1', status: 'done' }] };
    const previous = { tickets: [{ ticket_id: 'T-1', status: 'in_progress' }] };
    const diff = generateDiff(current, previous);

    expect(diff.tickets.changed).toHaveLength(1);
    expect(diff.tickets.changed[0].id).toBe('T-1');
    expect(diff.tickets.changed[0].changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'status', from: 'in_progress', to: 'done' }),
      ])
    );
  });

  it('marks items as unchanged when id matches and important fields are identical', () => {
    const ticket = { ticket_id: 'T-1', status: 'open', priority: 'high' };
    const diff = generateDiff({ tickets: [{ ...ticket }] }, { tickets: [{ ...ticket }] });

    expect(diff.tickets.unchanged).toHaveLength(1);
    expect(diff.tickets.unchanged[0]._diffStatus).toBe('unchanged');
    expect(diff.tickets.changed).toHaveLength(0);
    expect(diff.tickets.added).toHaveLength(0);
  });

  it('computes totals correctly across multiple categories', () => {
    const current = {
      tickets: [{ ticket_id: 'T-1', title: 'A' }],
      action_items: [{ id: 'AI-1', status: 'pending' }],
      change_requests: [],
      blockers: [{ id: 'B-NEW' }],
      scope_changes: [],
    };
    const previous = {
      tickets: [],
      action_items: [{ id: 'AI-1', status: 'done' }],
      change_requests: [{ id: 'CR-OLD' }],
      blockers: [],
      scope_changes: [],
    };
    const diff = generateDiff(current, previous);

    // T-1 added, AI-1 changed (status), CR-OLD removed, B-NEW added
    expect(diff.totals.newItems).toBe(2);       // T-1 + B-NEW
    expect(diff.totals.removedItems).toBe(1);    // CR-OLD
    expect(diff.totals.changedItems).toBe(1);    // AI-1
  });

  it('handles empty arrays in both current and previous without errors', () => {
    const empty = {
      tickets: [], change_requests: [], action_items: [],
      blockers: [], scope_changes: [],
    };
    const diff = generateDiff(empty, empty);

    expect(diff.hasDiff).toBe(true);
    expect(diff.totals.newItems).toBe(0);
    expect(diff.totals.removedItems).toBe(0);
    expect(diff.totals.changedItems).toBe(0);
  });

  it('detects summary changes when text differs', () => {
    const current = { summary: 'Current summary' };
    const previous = { summary: 'Old summary' };
    const diff = generateDiff(current, previous);

    expect(diff.summary.changed).toBe(true);
    expect(diff.summary.current).toBe('Current summary');
    expect(diff.summary.previous).toBe('Old summary');
  });

  it('marks summary as unchanged when text is identical', () => {
    const current = { summary: 'Same text' };
    const previous = { summary: 'Same text' };
    const diff = generateDiff(current, previous);

    expect(diff.summary.changed).toBe(false);
  });

  it('preserves previousTimestamp from previous object', () => {
    const diff = generateDiff({ tickets: [] }, { tickets: [], timestamp: '2026-02-28T10-00-00' });
    expect(diff.previousTimestamp).toBe('2026-02-28T10-00-00');
  });

  it('defaults previousTimestamp to "unknown" when missing', () => {
    const diff = generateDiff({ tickets: [] }, { tickets: [] });
    expect(diff.previousTimestamp).toBe('unknown');
  });
});

// ─── renderDiffMarkdown ──────────────────────────────────────────────────────

describe('renderDiffMarkdown', () => {
  it('returns empty string when diff is null', () => {
    expect(renderDiffMarkdown(null)).toBe('');
  });

  it('returns empty string when hasDiff is false', () => {
    expect(renderDiffMarkdown({ hasDiff: false })).toBe('');
  });

  it('reports "No changes detected" when all totals are zero', () => {
    const diff = generateDiff(
      { tickets: [], change_requests: [], action_items: [], blockers: [], scope_changes: [] },
      { tickets: [], change_requests: [], action_items: [], blockers: [], scope_changes: [] }
    );
    const md = renderDiffMarkdown(diff);

    expect(md).toContain('No changes detected since the previous run.');
  });

  it('renders heading and comparison table when changes exist', () => {
    const current = {
      tickets: [{ ticket_id: 'T-NEW', title: 'Brand new' }],
      change_requests: [], action_items: [], blockers: [], scope_changes: [],
    };
    const previous = {
      tickets: [{ ticket_id: 'T-OLD', title: 'Removed' }],
      change_requests: [], action_items: [], blockers: [], scope_changes: [],
      timestamp: '2026-02-20T12-00-00',
    };
    const diff = generateDiff(current, previous);
    const md = renderDiffMarkdown(diff);

    expect(md).toContain('## 🔄 Changes Since Previous Run');
    expect(md).toContain('2026-02-20T12-00-00');
    expect(md).toContain('Tickets');
    // New section
    expect(md).toContain('### ➕ New Items');
    expect(md).toContain('T-NEW');
    // Removed section
    expect(md).toContain('### ➖ Removed Items');
    expect(md).toContain('T-OLD');
  });

  it('renders changed items with field-level detail', () => {
    const current = {
      tickets: [{ ticket_id: 'T-1', title: 'Ticket', status: 'done' }],
      change_requests: [], action_items: [], blockers: [], scope_changes: [],
    };
    const previous = {
      tickets: [{ ticket_id: 'T-1', title: 'Ticket', status: 'open' }],
      change_requests: [], action_items: [], blockers: [], scope_changes: [],
      timestamp: 'prev',
    };
    const diff = generateDiff(current, previous);
    const md = renderDiffMarkdown(diff);

    expect(md).toContain('### 🔀 Changed Items');
    expect(md).toContain('`status`');
    expect(md).toContain('open');
    expect(md).toContain('done');
  });
});
