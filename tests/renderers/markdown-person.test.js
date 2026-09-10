const { renderResultsMarkdown } = require('../../src/renderers/markdown');

/**
 * A call where Jane owns work in every collection AND the model returned no
 * `your_tasks` object. Before the person scope existed the whole personal
 * section was skipped in exactly this case.
 */
function compiledWithoutYourTasks() {
  return {
    summary: 'Sprint sync.',
    tickets: [
      { ticket_id: 'T-1', title: 'Login bug', assignee: 'Jane Doe', status: 'in_progress' },
      { ticket_id: 'T-2', title: 'Export job', assignee: 'Sam Carter', reviewer: 'Jane Doe', status: 'review' },
    ],
    change_requests: [
      { id: 'CR-1', title: 'Fix the login redirect loop', assigned_to: 'Jane Doe', priority: 'medium', where: { file_path: 'auth/Login.cs' } },
      { id: 'CR-2', title: 'Rewrite the billing reconciliation', assigned_to: 'Jane Doe', priority: 'critical' },
    ],
    action_items: [
      { id: 'AI-1', description: 'Jane to write the migration notes', assigned_to: 'Jane Doe', status: 'todo' },
      { id: 'AI-2', description: 'Sam to run the load test', assigned_to: 'Sam Carter', waiting_on: 'Jane Doe', status: 'todo' },
    ],
    blockers: [
      { id: 'BLK-1', description: 'Staging database is empty', owner: 'Jane Doe' },
      { id: 'BLK-2', description: 'Vendor credentials have not arrived', owner: 'Sam Carter', blocks: ['T-1'] },
    ],
    scope_changes: [
      { id: 'SC-1', description: 'Dropped the CSV export from this sprint', decided_by: 'Jane Doe' },
    ],
    file_references: [
      { file_name: 'Login.cs', resolved_path: 'auth/Login.cs', mentioned_in_tickets: ['T-1'] },
    ],
    your_tasks: null,
  };
}

const meta = (overrides = {}) => ({
  callName: 'Sprint Sync',
  processedAt: '2026-09-10T09:00:00Z',
  geminiModel: 'gemini-3-flash-preview',
  userName: 'Jane Doe',
  segmentCount: 3,
  diagrams: false,
  ...overrides,
});

describe('name-scoped section', () => {
  const md = renderResultsMarkdown({ compiled: compiledWithoutYourTasks(), meta: meta() });

  it('renders the personal section even when the model returned no your_tasks', () => {
    expect(md).toContain('## ⭐ Your Tasks — Jane Doe');
  });

  it('leads with the size of the workload', () => {
    expect(md).toMatch(/\*\*On your plate\*\*:.*1 ticket/);
    expect(md).toMatch(/\*\*On your plate\*\*:.*2 change requests/);
  });

  it('shows the tickets they own and the ones waiting on their review', () => {
    expect(md).toContain('**🎫 Your Tickets**: T-1');
    expect(md).toContain('**👀 Awaiting Your Review**: T-2');
  });

  it('lists their change requests, most urgent first', () => {
    expect(md).toContain('### 🔧 Your Change Requests');
    expect(md.indexOf('CR-2')).toBeLessThan(md.indexOf('**CR-1**'));
  });

  it('turns their action items into a to-do list', () => {
    expect(md).toContain('### 📌 To Do');
    expect(md).toContain('Jane to write the migration notes');
  });

  it('shows who is blocked waiting on them', () => {
    expect(md).toContain('### 📣 Others Waiting On You');
    expect(md).toContain('Sam to run the load test');
  });

  it('shows the blockers they own and the ones standing in their way', () => {
    expect(md).toContain('### 🚫 Your Blockers');
    expect(md).toContain('Staging database is empty');
    expect(md).toContain('### ⛔ Blocking Your Work');
    expect(md).toContain('Vendor credentials have not arrived');
  });

  it('records the scope calls they made', () => {
    expect(md).toContain('### 🔀 Scope Changes You Decided');
    expect(md).toContain('Dropped the CSV export');
  });

  it('lists the files their work touches', () => {
    expect(md).toContain('### 📂 Files You Will Touch');
    expect(md).toContain('auth/Login.cs');
  });

  it('collects places they were named without being assigned', () => {
    const compiled = compiledWithoutYourTasks();
    compiled.scope_changes.push({ id: 'SC-9', description: 'Move the report Jane owns to next sprint', decided_by: 'Sam Carter' });
    const out = renderResultsMarkdown({ compiled, meta: meta() });
    expect(out).toContain('💬 Mentioned You');
    expect(out).toContain('SC-9');
  });

  it('says the name matched nobody rather than rendering nothing', () => {
    const out = renderResultsMarkdown({ compiled: compiledWithoutYourTasks(), meta: meta({ userName: 'Ghost Person' }) });
    expect(out).toContain('## ⭐ Your Tasks — Ghost Person');
    expect(out).toMatch(/No work in this call is attributed to \*\*Ghost Person\*\*/);
    expect(out).toContain('Check the spelling');
  });

  it('omits the personal section entirely when no name was given', () => {
    const out = renderResultsMarkdown({ compiled: compiledWithoutYourTasks(), meta: meta({ userName: null }) });
    expect(out).not.toContain('⭐ Your Tasks');
  });

  it('still merges your_tasks when the model does return one', () => {
    const compiled = compiledWithoutYourTasks();
    compiled.your_tasks = {
      user_name: 'Jane Doe',
      summary: 'Heaviest week of the sprint.',
      tasks_todo: [{ description: 'Draft the rollout plan' }],
      decisions_needed: [{ description: 'Pick the cutover date', from_whom: 'Sam Carter' }],
    };
    const out = renderResultsMarkdown({ compiled, meta: meta() });
    expect(out).toContain('Heaviest week of the sprint.');
    expect(out).toContain('Draft the rollout plan');
    expect(out).toContain('### ❓ Decisions Needed');
    expect(out).toContain('Jane to write the migration notes');
  });
});

describe('change requests in the main report', () => {
  it('renders each change once and orders the table by priority', () => {
    const compiled = compiledWithoutYourTasks();
    // Same change, two ids — the segments each saw it once.
    compiled.change_requests.push({ id: 'CR-9', title: 'Fix the login redirect loop', assigned_to: 'Jane Doe', priority: 'high' });
    const out = renderResultsMarkdown({ compiled, meta: meta() });

    const tableStart = out.indexOf('## 🔧 All Change Requests');
    const table = out.slice(tableStart, out.indexOf('<details>', tableStart));
    expect(table).not.toContain('CR-9');
    expect(table.indexOf('CR-2')).toBeLessThan(table.indexOf('CR-1'));
  });
});
