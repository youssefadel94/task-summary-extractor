const JSZip = require('jszip');

const { renderResultsMarkdown } = require('../../src/renderers/markdown');
const { renderResultsHtml } = require('../../src/renderers/html');
const { renderResultsDocx } = require('../../src/renderers/docx');

/**
 * One call, one person, and NO `your_tasks` object — the case where the report
 * used to show the reader nothing at all. Every format must produce the same
 * answer to "what is Jane on the hook for?".
 */
function compiled() {
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

/** Plain text of a .docx buffer, for asserting on rendered content. */
async function docxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('the named person gets the same slice in every format', () => {
  const md = renderResultsMarkdown({ compiled: compiled(), meta: meta() });
  const html = renderResultsHtml({ compiled: compiled(), meta: meta() });
  let docx;

  beforeAll(async () => {
    docx = await docxText(await renderResultsDocx({ compiled: compiled(), meta: meta() }));
  }, 30000);

  it('renders the section without a your_tasks object', () => {
    expect(md).toContain('⭐ Your Tasks — Jane Doe');
    expect(html).toContain('⭐ Your Tasks — Jane Doe');
    expect(docx).toContain('Your Tasks — Jane Doe');
  });

  it('shows the tickets they own', () => {
    for (const out of [md, html, docx]) expect(out).toContain('T-1');
  });

  it('shows the reviews waiting on them', () => {
    expect(md).toContain('Awaiting Your Review');
    expect(html).toContain('Awaiting Your Review');
    expect(docx).toContain('Awaiting Your Review');
  });

  it('shows their change requests, urgent first', () => {
    for (const out of [md, html, docx]) {
      expect(out).toContain('CR-2');
      expect(out.indexOf('CR-2')).toBeLessThan(out.lastIndexOf('CR-1'));
    }
  });

  it('shows their to-do list built from action items', () => {
    for (const out of [md, html, docx]) expect(out).toContain('migration notes');
  });

  it('shows who is blocked waiting on them', () => {
    expect(md).toContain('Others Waiting On You');
    expect(html).toContain('Others Waiting On You');
    expect(docx).toContain('Others Waiting On You');
  });

  it('shows the blockers standing in their way', () => {
    for (const out of [md, html, docx]) expect(out).toContain('Vendor credentials have not arrived');
  });

  it('shows the scope calls they made', () => {
    for (const out of [md, html, docx]) expect(out).toContain('Dropped the CSV export');
  });

  it('names the files their work touches', () => {
    for (const out of [md, html, docx]) expect(out).toContain('auth/Login.cs');
  });
});

describe('a name that matches nobody', () => {
  const ghost = meta({ userName: 'Ghost Person' });

  it('says so in Markdown and HTML instead of rendering nothing', () => {
    const md = renderResultsMarkdown({ compiled: compiled(), meta: ghost });
    const html = renderResultsHtml({ compiled: compiled(), meta: ghost });
    for (const out of [md, html]) {
      expect(out).toContain('Ghost Person');
      expect(out).toMatch(/No work in this call is attributed to/);
    }
  });

  it('says so in DOCX too', async () => {
    const text = await docxText(await renderResultsDocx({ compiled: compiled(), meta: ghost }));
    expect(text).toContain('Ghost Person');
    expect(text).toMatch(/No work in this call is attributed to/);
  }, 30000);
});

describe('no name at all', () => {
  it('omits the personal section entirely', async () => {
    const anon = meta({ userName: null });
    const md = renderResultsMarkdown({ compiled: compiled(), meta: anon });
    const html = renderResultsHtml({ compiled: compiled(), meta: anon });
    const docx = await docxText(await renderResultsDocx({ compiled: compiled(), meta: anon }));
    for (const out of [md, html, docx]) expect(out).not.toContain('Your Tasks');
  }, 30000);
});
