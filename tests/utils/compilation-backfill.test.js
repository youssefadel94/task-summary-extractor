'use strict';

const { backfillCompiledItems, ticketKey } = require('../../src/utils/compilation-backfill');

describe('backfillCompiledItems', () => {
  it('restores distinct action items the merge dropped', () => {
    // Regression from a real run: segments held 8 distinct action items, the
    // compiled output kept 3, and the other 5 never reached the report.
    const segments = [
      { action_items: [
        { id: 'AI-1', description: 'Finish the registration flow logic in the API.' },
        { id: 'AI-2', description: 'Clean up code.' },
      ] },
      { action_items: [
        { id: 'AI-1', description: 'Wire the Report, Contact Us and Evaluation screens' },
        { id: 'AI-2', description: 'Clean up code.' }, // duplicate across segments
      ] },
    ];
    const compiled = { action_items: [{ id: 'AI-1', description: 'Clean up code.' }] };

    const { recovered, totalRecovered } = backfillCompiledItems(compiled, segments);

    expect(totalRecovered).toBe(2);
    expect(recovered.action_items).toBe(2);
    expect(compiled.action_items).toHaveLength(3);
    const descs = compiled.action_items.map(a => a.description);
    expect(descs).toContain('Finish the registration flow logic in the API.');
    expect(descs).toContain('Wire the Report, Contact Us and Evaluation screens');
    // Recovered entries are marked and get fresh sequential IDs.
    const restored = compiled.action_items.filter(a => a._recovered);
    expect(restored.map(a => a.id)).toEqual(['AI-2', 'AI-3']);
  });

  it('treats an actor-prefixed restatement as the same action', () => {
    const segments = [{ action_items: [{ description: 'Youssef to clean up code.' }] }];
    const compiled = { action_items: [{ id: 'AI-1', description: 'Clean up code.' }] };

    const { totalRecovered } = backfillCompiledItems(compiled, segments);

    expect(totalRecovered).toBe(0);
    expect(compiled.action_items).toHaveLength(1);
  });

  it('matches tickets on their numeric id so PBI-20392 and 20392 are one ticket', () => {
    expect(ticketKey({ ticket_id: 'PBI-20392' })).toBe(ticketKey({ ticket_id: '20392' }));

    const segments = [
      { tickets: [{ ticket_id: '20392', title: 'Sign-up procedures' }] },
      { tickets: [{ ticket_id: 'PBI-40001', title: 'Genuinely new ticket' }] },
    ];
    const compiled = { tickets: [{ ticket_id: 'PBI-20392', title: 'Sign-up procedures' }] };

    const { totalRecovered } = backfillCompiledItems(compiled, segments);

    expect(totalRecovered).toBe(1);
    expect(compiled.tickets.map(t => t.ticket_id)).toEqual(['PBI-20392', 'PBI-40001']);
  });

  it('restores blockers, change requests, scope changes and file references', () => {
    const segments = [{
      blockers: [{ description: 'DB objects missing' }],
      change_requests: [{ id: 'CR-API-02', description: 'Add pagination' }],
      scope_changes: [{ description: 'Added evaluation screen' }],
      file_references: [{ resolved_path: 'src/api/types.ts' }],
    }];
    const compiled = { blockers: [], change_requests: [], scope_changes: [], file_references: [] };

    const { recovered } = backfillCompiledItems(compiled, segments);

    expect(recovered.blockers).toBe(1);
    expect(recovered.change_requests).toBe(1);
    expect(recovered.scope_changes).toBe(1);
    expect(recovered.file_references).toBe(1);
    expect(compiled.blockers[0].id).toBe('BLK-1');
  });

  it('does not restore a re-phrasing of an item already present', () => {
    // Segments describe one blocker several ways; restoring each phrasing would
    // clutter the report with the same blocker three times.
    const segments = [
      { blockers: [{ description: 'All Business App database objects are missing.' }] },
      { blockers: [{ description: 'All Business App database objects — nothing exists yet.' }] },
    ];
    const compiled = { blockers: [{ id: 'BLK-1', description: 'All Business App database objects missing' }] };

    const { totalRecovered } = backfillCompiledItems(compiled, segments);

    expect(totalRecovered).toBe(0);
    expect(compiled.blockers).toHaveLength(1);
  });

  it('still restores genuinely different work that shares some words', () => {
    const segments = [{ blockers: [
      { description: 'Business.Api connection strings still set to SET_BY_OPS' },
      { description: 'Payment methods approval pending from the business team' },
    ] }];
    const compiled = { blockers: [{ id: 'BLK-1', description: 'All database objects are missing' }] };

    const { totalRecovered } = backfillCompiledItems(compiled, segments);

    expect(totalRecovered).toBe(2);
  });

  it('leaves a complete compilation untouched', () => {
    const segments = [{ action_items: [{ description: 'Clean up code.' }] }];
    const compiled = { action_items: [{ id: 'AI-1', description: 'Clean up code.' }] };

    const { totalRecovered } = backfillCompiledItems(compiled, segments);

    expect(totalRecovered).toBe(0);
    expect(compiled.action_items).toHaveLength(1);
    expect(compiled.action_items[0]._recovered).toBeUndefined();
  });

  it('is a no-op when compilation failed to parse', () => {
    expect(backfillCompiledItems(null, [{ action_items: [{ description: 'x' }] }]).totalRecovered).toBe(0);
  });
});
