const { buildPersonScope, buildMentionMatcher, resolveFirstSpeaker } = require('../../src/utils/person-scope');

/** A call where Jane owns work in every collection. */
const compiled = () => ({
  tickets: [
    { ticket_id: 'T-1', title: 'Login bug', assignee: 'Jane Doe', status: 'in_progress' },
    { ticket_id: 'T-2', title: 'Export job', assignee: 'Sam', reviewer: 'Jane Doe', status: 'review' },
    { ticket_id: 'T-3', title: 'Unrelated', assignee: 'Sam' },
  ],
  change_requests: [
    { id: 'CR-1', title: 'Fix the login redirect loop', assigned_to: 'Jane Doe', priority: 'high', where: { file_path: 'auth/Login.cs' } },
    { id: 'CR-2', title: 'Retire the legacy report', assigned_to: 'Jane Doe', priority: 'critical', status: 'completed' },
    { id: 'CR-3', title: 'Something for Sam entirely', assigned_to: 'Sam' },
  ],
  action_items: [
    { id: 'AI-1', description: 'Jane to write the migration notes', assigned_to: 'Jane Doe', status: 'todo' },
    { id: 'AI-2', description: 'Sam to run the load test', assigned_to: 'Sam', waiting_on: 'Jane Doe', status: 'todo' },
    { id: 'AI-3', description: 'Sam to update the changelog', assigned_to: 'Sam', status: 'todo' },
  ],
  blockers: [
    { id: 'BLK-1', description: 'Staging database is empty', owner: 'Jane Doe' },
    { id: 'BLK-2', description: 'Waiting on vendor credentials', owner: 'Sam', blocks: ['T-1'] },
  ],
  scope_changes: [
    { id: 'SC-1', description: 'Dropped the CSV export', decided_by: 'Jane Doe' },
  ],
  file_references: [
    { file_name: 'Login.cs', resolved_path: 'auth/Login.cs', mentioned_in_tickets: ['T-1'] },
    { file_name: 'Other.cs', resolved_path: 'misc/Other.cs', mentioned_in_tickets: ['T-3'] },
  ],
  your_tasks: null,
});

const scopeFor = (person, overrides = {}) => {
  const data = { ...compiled(), ...overrides };
  return buildPersonScope({
    person,
    matches: raw => (raw || '').toLowerCase().includes(person.split(' ')[0].toLowerCase()),
    tickets: data.tickets,
    changeRequests: data.change_requests,
    actionItems: data.action_items,
    blockers: data.blockers,
    scopeChanges: data.scope_changes,
    fileReferences: data.file_references,
    yourTasks: data.your_tasks,
  });
};

describe('buildPersonScope', () => {
  it('collects the person from every collection, with no your_tasks at all', () => {
    // The old renderer showed nothing at all in this case.
    const s = scopeFor('Jane Doe');
    expect(s.isEmpty).toBe(false);
    expect(s.ownedTickets.map(t => t.ticket_id)).toEqual(['T-1']);
    expect(s.reviewingTickets.map(t => t.ticket_id)).toEqual(['T-2']);
    expect(s.changeRequests.map(cr => cr.id)).toEqual(['CR-1']);
    expect(s.completedChangeRequests.map(cr => cr.id)).toEqual(['CR-2']);
    expect(s.actionItems.map(a => a.id)).toEqual(['AI-1']);
    expect(s.blockers.map(b => b.id)).toEqual(['BLK-1']);
    expect(s.scopeChanges.map(sc => sc.id)).toEqual(['SC-1']);
  });

  it('turns assigned action items into to-do entries', () => {
    const s = scopeFor('Jane Doe');
    expect(s.todo.map(t => t.description)).toContain('Jane to write the migration notes');
  });

  it('surfaces work other people are blocked on the person for', () => {
    const s = scopeFor('Jane Doe');
    expect(s.othersWaitingOnMe.map(a => a.id)).toEqual(['AI-2']);
  });

  it("surfaces someone else's blocker that stands in front of the person's ticket", () => {
    const s = scopeFor('Jane Doe');
    expect(s.blockingMe.map(b => b.id)).toEqual(['BLK-2']);
  });

  it('lists the files the person will touch, from tickets and CR targets', () => {
    const s = scopeFor('Jane Doe');
    const paths = s.files.map(f => f.resolved_path);
    expect(paths).toContain('auth/Login.cs');
    expect(paths).not.toContain('misc/Other.cs');
  });

  it('merges your_tasks in rather than being gated by it', () => {
    const s = scopeFor('Jane Doe', {
      your_tasks: {
        summary: 'Busy week',
        tasks_todo: [{ description: 'Draft the rollout plan' }],
        tasks_waiting_on_others: [{ description: 'Schema sign-off', waiting_on: 'Sam' }],
        decisions_needed: [{ description: 'Pick the cutover date', from_whom: 'Sam' }],
      },
    });
    expect(s.summary).toBe('Busy week');
    expect(s.todo.map(t => t.description)).toContain('Draft the rollout plan');
    expect(s.todo.map(t => t.description)).toContain('Jane to write the migration notes');
    expect(s.waitingOn).toHaveLength(1);
    expect(s.decisionsNeeded).toHaveLength(1);
  });

  it('does not list the same task twice when your_tasks restates an action item', () => {
    const s = scopeFor('Jane Doe', {
      your_tasks: { tasks_todo: [{ description: 'Write the migration notes' }] },
    });
    const notes = s.todo.filter(t => /migration notes/i.test(t.description));
    expect(notes).toHaveLength(1);
  });

  it('reports mentions of the person in work assigned to someone else', () => {
    const s = scopeFor('Jane Doe', {
      scope_changes: [{ id: 'SC-9', description: 'Cut the report Jane owns from this sprint', decided_by: 'Sam' }],
    });
    expect(s.mentions.map(m => m.id)).toContain('SC-9');
  });

  it('never counts an item as both assigned and merely mentioned', () => {
    const s = scopeFor('Jane Doe');
    const assignedIds = new Set([
      ...s.ownedTickets.map(t => t.ticket_id),
      ...s.changeRequests.map(cr => cr.id),
      ...s.actionItems.map(a => a.id),
      ...s.blockers.map(b => b.id),
    ]);
    for (const m of s.mentions) expect(assignedIds.has(m.id)).toBe(false);
  });

  it('reports empty for a name nobody in the call matches', () => {
    const s = buildPersonScope({
      person: 'Nobody Here',
      matches: () => false,
      ...{
        tickets: compiled().tickets,
        changeRequests: compiled().change_requests,
        actionItems: compiled().action_items,
        blockers: compiled().blockers,
        scopeChanges: compiled().scope_changes,
        fileReferences: compiled().file_references,
      },
    });
    expect(s.isEmpty).toBe(true);
    expect(s.counts.total).toBe(0);
  });

  it('counts the workload so the section can lead with the size of it', () => {
    const s = scopeFor('Jane Doe');
    expect(s.counts.tickets).toBe(1);
    expect(s.counts.reviewing).toBe(1);
    expect(s.counts.changeRequests).toBe(1);
    expect(s.counts.othersWaitingOnMe).toBe(1);
    expect(s.counts.total).toBeGreaterThan(0);
  });

  it('handles being called with nothing at all', () => {
    const s = buildPersonScope();
    expect(s.isEmpty).toBe(true);
  });
});

describe('buildMentionMatcher', () => {
  it('matches the full name and an unambiguous first name', () => {
    const m = buildMentionMatcher('Jane Doe');
    expect(m('ask Jane Doe about it')).toBe(true);
    expect(m('Jane will follow up')).toBe(true);
    expect(m('Sam will follow up')).toBe(false);
  });

  it('does not match a name embedded in a longer word', () => {
    const m = buildMentionMatcher('Jane Doe');
    expect(m('the Janestown migration')).toBe(false);
  });

  it('ignores a first name too short to be unambiguous', () => {
    const m = buildMentionMatcher('Ed Smith');
    expect(m('Ed Smith owns it')).toBe(true);
    expect(m('this is Ed territory')).toBe(false);
  });

  it('returns false for an empty person', () => {
    expect(buildMentionMatcher('')('anything')).toBe(false);
  });
});

describe('resolveFirstSpeaker', () => {
  it('returns whoever spoke first in the call', () => {
    expect(resolveFirstSpeaker({
      tickets: [
        { comments: [{ speaker: 'Agent 2', timestamp: '00:05:00', source_segment: 2 }] },
        { comments: [{ speaker: 'Agent 1', timestamp: '00:00:30', source_segment: 1 }] },
      ],
    })).toBe('Agent 1');
  });

  it('orders by segment before timestamp', () => {
    // Each segment's clock restarts, so a bare timestamp sort gets this backwards.
    expect(resolveFirstSpeaker({
      tickets: [{
        comments: [
          { speaker: 'Later', timestamp: '00:00:05', source_segment: 3 },
          { speaker: 'Earlier', timestamp: '00:09:50', source_segment: 1 },
        ],
      }],
    })).toBe('Earlier');
  });

  it('skips labels that name nobody', () => {
    expect(resolveFirstSpeaker({
      tickets: [{
        comments: [
          { speaker: 'Unknown', timestamp: '00:00:01', source_segment: 1 },
          { speaker: '  ', timestamp: '00:00:02', source_segment: 1 },
          { speaker: 'Jane Doe', timestamp: '00:00:03', source_segment: 1 },
        ],
      }],
    })).toBe('Jane Doe');
  });

  it('returns null when the call has no attributed quotes', () => {
    expect(resolveFirstSpeaker({ tickets: [{ comments: [] }] })).toBe(null);
    expect(resolveFirstSpeaker({ tickets: [] })).toBe(null);
    expect(resolveFirstSpeaker(null)).toBe(null);
  });

  it('handles comments with no segment or timestamp at all', () => {
    expect(resolveFirstSpeaker({ tickets: [{ comments: [{ speaker: 'Sam' }] }] })).toBe('Sam');
  });
});
