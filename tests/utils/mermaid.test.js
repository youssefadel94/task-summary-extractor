const {
  MERMAID_RULES,
  mermaidLabel,
  sanitizeMermaidBlocks,
  buildWorkItemMap,
  buildConfidencePie,
  buildOwnershipMap,
  buildBlockerMap,
  buildProgressPie,
  buildProgressFlow,
  buildDocumentMap,
} = require('../../src/utils/mermaid');

/** Every emitted block must be a well-formed fence with a diagram type. */
function expectFence(block) {
  expect(block).toMatch(/^```mermaid\n/);
  expect(block).toMatch(/\n```$/);
  const body = block.split('\n').slice(1, -1).join('\n');
  expect(body.trim()).toMatch(/^(flowchart|pie|sequenceDiagram|stateDiagram)/);
  return body;
}

/**
 * Structural guard: inside a flowchart body, every shape must have a quoted
 * label and every edge label must be quoted. This is what actually keeps the
 * diagrams renderable — an unquoted `(` or `,` is a hard parse error.
 */
function expectAllLabelsQuoted(body) {
  const shapeOpeners = body.match(/[A-Za-z][\w]*(?:\[\(|\(\[|\(\(|\[\[|\{\{|\[|\(|\{)(.)/g) || [];
  for (const m of shapeOpeners) {
    expect(m.endsWith('"')).toBe(true);
  }
  const edgeLabels = body.match(/\|[^|\n]*\|/g) || [];
  for (const m of edgeLabels) {
    expect(m).toMatch(/^\|".*"\|$/);
  }
}

// ─── mermaidLabel ────────────────────────────────────────────────────────────

describe('mermaidLabel', () => {
  it('returns empty string for null/undefined', () => {
    expect(mermaidLabel(null)).toBe('');
    expect(mermaidLabel(undefined)).toBe('');
  });

  it('replaces double quotes so they cannot terminate the label', () => {
    expect(mermaidLabel('He said "no"')).toBe("He said 'no'");
  });

  it('collapses newlines to spaces', () => {
    expect(mermaidLabel('line one\nline two')).toBe('line one line two');
  });

  it('strips angle brackets that would be parsed as markup', () => {
    expect(mermaidLabel('use <Button> here')).toBe('use Button here');
  });

  it('replaces pipes and braces that break node syntax', () => {
    expect(mermaidLabel('a|b {c}')).toBe('a/b c');
  });

  it('truncates past the max length with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = mermaidLabel(long, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves parentheses intact — they are safe inside quotes', () => {
    expect(mermaidLabel('Read config (from .env)')).toBe('Read config (from .env)');
  });
});

// ─── buildWorkItemMap ────────────────────────────────────────────────────────

describe('buildWorkItemMap', () => {
  const tickets = [
    { ticket_id: 'PROJ-1', title: 'Auth migration', status: 'in_progress' },
    { ticket_id: 'PROJ-2', title: 'Schema change', status: 'blocked' },
  ];

  it('returns null with no tickets', () => {
    expect(buildWorkItemMap({ tickets: [] })).toBeNull();
  });

  it('returns null when nothing links to a ticket', () => {
    expect(buildWorkItemMap({ tickets, changeRequests: [{ id: 'CR-1', title: 'Orphan' }] })).toBeNull();
  });

  it('draws change requests that reference a ticket', () => {
    const out = buildWorkItemMap({
      tickets,
      changeRequests: [{ id: 'CR-1', title: 'Rate limiting', related_tickets: ['PROJ-1'] }],
    });
    const body = expectFence(out);
    expect(body).toContain('CR-1 — Rate limiting');
    expect(body).toContain('CR1 -->|"changes"| T1');
  });

  it('matches ticket references case-insensitively', () => {
    const out = buildWorkItemMap({
      tickets,
      changeRequests: [{ id: 'CR-1', title: 'x', related_tickets: ['proj-1'] }],
    });
    expect(out).toContain('-->|"changes"| T1');
  });

  it('accepts a comma-separated string for related_tickets', () => {
    const out = buildWorkItemMap({
      tickets,
      changeRequests: [{ id: 'CR-1', title: 'x', related_tickets: 'PROJ-1, PROJ-2' }],
    });
    expect(out).toContain('CR1 -->|"changes"| T1');
    expect(out).toContain('CR1 -->|"changes"| T2');
  });

  it('draws blockers with a thick edge and the blocked class', () => {
    const out = buildWorkItemMap({
      tickets,
      blockers: [{ id: 'BLK-1', description: 'Deploy freeze', blocks: ['PROJ-2'] }],
    });
    expect(out).toContain('B1 ==>|"blocks"| T2');
    expect(out).toContain('class B1 blocked;');
  });

  it('never emits a real ticket id as a node id', () => {
    const body = buildWorkItemMap({
      tickets,
      actionItems: [{ id: 'AI-1', description: 'Do the thing', related_tickets: ['PROJ-1'] }],
    });
    // "PROJ-1" appears only inside quoted labels, never bare before a shape.
    expect(body).not.toMatch(/^\s*PROJ-1[[({]/m);
  });

  it('quotes every label and edge label', () => {
    const body = expectFence(buildWorkItemMap({
      tickets: [{ ticket_id: 'PROJ-1', title: 'Fix (urgent), then ship', status: 'open' }],
      changeRequests: [{ id: 'CR-1', title: 'A, B & C', related_tickets: ['PROJ-1'] }],
    }));
    expectAllLabelsQuoted(body);
  });

  it('caps the number of tickets drawn', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ticket_id: `T-${i}`, title: `Ticket ${i}` }));
    const out = buildWorkItemMap({
      tickets: many,
      changeRequests: [{ id: 'CR-1', title: 'x', related_tickets: ['T-0'] }],
    });
    const ticketNodes = out.match(/^\s{8}T\d+\[/gm) || [];
    expect(ticketNodes.length).toBeLessThanOrEqual(12);
  });
});

// ─── buildConfidencePie ──────────────────────────────────────────────────────

describe('buildConfidencePie', () => {
  it('returns null when every count is zero', () => {
    expect(buildConfidencePie({ high: 0, medium: 0, low: 0, unset: 0 })).toBeNull();
    expect(buildConfidencePie()).toBeNull();
  });

  it('omits slices with a zero count', () => {
    const out = buildConfidencePie({ high: 5, medium: 0, low: 2 });
    expect(out).toContain('"🟢 HIGH" : 5');
    expect(out).not.toContain('MEDIUM');
    expect(out).toContain('"🔴 LOW" : 2');
  });
});

// ─── buildOwnershipMap ───────────────────────────────────────────────────────

describe('buildOwnershipMap', () => {
  const nameMatch = (raw, canonical) => (raw || '').toLowerCase() === canonical.toLowerCase();

  it('returns null without a nameMatch function', () => {
    expect(buildOwnershipMap({ people: ['Jane'] })).toBeNull();
  });

  it('returns null when nobody owns anything', () => {
    const out = buildOwnershipMap({
      people: ['Jane'], nameMatch, tickets: [{ ticket_id: 'T-1', assignee: 'Bob' }],
    });
    expect(out).toBeNull();
  });

  it('links owned tickets, actions and blockers to their owner', () => {
    const out = buildOwnershipMap({
      people: ['Jane'],
      nameMatch,
      tickets: [{ ticket_id: 'T-1', title: 'Ship it', assignee: 'Jane' }],
      actionItems: [{ id: 'A-1', description: 'Review PR', assigned_to: 'Jane' }],
      blockers: [{ id: 'B-1', description: 'Waiting on infra', owner: 'Jane' }],
    });
    expect(out).toContain('🎫 T-1 — Ship it');
    expect(out).toContain('✅ Review PR');
    expect(out).toContain('🚫 Waiting on infra');
  });

  it('omits people who own nothing rather than leaving a dangling node', () => {
    const out = buildOwnershipMap({
      people: ['Jane', 'Bob'],
      nameMatch,
      tickets: [{ ticket_id: 'T-1', title: 'Ship it', assignee: 'Jane' }],
    });
    expect(out).not.toContain('Bob');
  });

  it('marks the current user', () => {
    const out = buildOwnershipMap({
      people: ['Jane'],
      nameMatch,
      currentUser: 'Jane',
      tickets: [{ ticket_id: 'T-1', title: 'Ship it', assignee: 'Jane' }],
    });
    expect(out).toContain('⭐ Jane');
    expect(out).toContain('class P1 me;');
  });
});

// ─── buildBlockerMap ─────────────────────────────────────────────────────────

describe('buildBlockerMap', () => {
  it('returns null with no blockers', () => {
    expect(buildBlockerMap([])).toBeNull();
  });

  it('chains blocker → description → blocked items, with the owner attached', () => {
    const out = buildBlockerMap([
      { id: 'BLK-1', type: 'infra', description: 'Redis capacity', blocks: ['PROJ-2'], owner: 'Sara' },
    ]);
    const body = expectFence(out);
    expect(body).toContain('B1 --> B1D');
    expect(body).toContain('B1D ==>|"blocks"| B1X0');
    expect(body).toContain('B1O -.->|"owns"| B1');
    expectAllLabelsQuoted(body);
  });
});

// ─── progress diagrams ───────────────────────────────────────────────────────

describe('buildProgressPie', () => {
  it('returns null when there is nothing to chart', () => {
    expect(buildProgressPie({})).toBeNull();
  });

  it('charts only the non-empty statuses', () => {
    const out = buildProgressPie({ done: 3, inProgress: 1, notStarted: 0, superseded: 0 });
    expect(out).toContain('"✅ Completed" : 3');
    expect(out).toContain('"🔄 In Progress" : 1');
    expect(out).not.toContain('Not Started');
  });
});

describe('buildProgressFlow', () => {
  const assessments = [
    { item_id: 'T-1', item_type: 'ticket', title: 'Done thing', status: 'DONE' },
    { item_id: 'T-2', item_type: 'ticket', title: 'Ongoing thing', status: 'IN_PROGRESS' },
  ];

  it('returns null with no assessments', () => {
    expect(buildProgressFlow({ assessments: [] })).toBeNull();
  });

  it('groups items into one subgraph per status', () => {
    const body = expectFence(buildProgressFlow({ assessments }));
    expect(body).toContain('✅ Completed (1)');
    expect(body).toContain('🔄 In Progress (1)');
  });

  it('links git evidence to the completed bucket when there are commits', () => {
    const out = buildProgressFlow({
      assessments,
      changeReport: { totals: { commits: 7, filesChanged: 12 } },
    });
    expect(out).toContain('📦 Git evidence');
    expect(out).toContain('GIT ==>|"evidence"| S0');
  });

  it('omits the git node when there is no git activity', () => {
    const out = buildProgressFlow({ assessments, changeReport: { totals: { commits: 0, filesChanged: 0 } } });
    expect(out).not.toContain('Git evidence');
  });
});

// ─── buildDocumentMap ────────────────────────────────────────────────────────

describe('buildDocumentMap', () => {
  it('returns null when no group has documents', () => {
    expect(buildDocumentMap({ groups: [{ category: 'guide', label: 'Guides', docs: [] }] })).toBeNull();
  });

  it('branches the request into categories and their documents', () => {
    const body = expectFence(buildDocumentMap({
      title: 'Plan the migration',
      groups: [{ category: 'guide', label: 'Guides', docs: [{ title: 'Cutover steps' }] }],
    }));
    expect(body).toContain('Plan the migration');
    expect(body).toContain('ROOT --> G1');
    expect(body).toContain('G1 --> G1D0');
    expectAllLabelsQuoted(body);
  });
});

// ─── sanitizeMermaidBlocks ───────────────────────────────────────────────────

describe('sanitizeMermaidBlocks', () => {
  const wrap = body => ['```mermaid', body, '```'].join('\n');

  it('passes through content with no mermaid blocks untouched', () => {
    const md = '# Title\n\nJust prose.\n';
    expect(sanitizeMermaidBlocks(md)).toBe(md);
  });

  it('handles null and non-string input', () => {
    expect(sanitizeMermaidBlocks(null)).toBeNull();
    expect(sanitizeMermaidBlocks(undefined)).toBeUndefined();
  });

  it('quotes a bare label containing parentheses', () => {
    const out = sanitizeMermaidBlocks(wrap('flowchart TB\n    A[Read config (from .env)] --> B'));
    expect(out).toContain('A["Read config (from .env)"]');
  });

  it('quotes bare labels in every shape', () => {
    const out = sanitizeMermaidBlocks(wrap([
      'flowchart TB',
      '    A[box, one]',
      '    B(round, two)',
      '    C{rhombus, three}',
      '    D([stadium, four])',
    ].join('\n')));
    expect(out).toContain('A["box, one"]');
    expect(out).toContain('B("round, two")');
    expect(out).toContain('C{"rhombus, three"}');
    expect(out).toContain('D(["stadium, four"])');
  });

  it('quotes bare edge labels', () => {
    const out = sanitizeMermaidBlocks(wrap('flowchart TB\n    A -->|on failure| B'));
    expect(out).toContain('-->|"on failure"| B');
  });

  it('leaves already-quoted labels alone rather than double-quoting them', () => {
    const src = wrap('flowchart TB\n    A["Already quoted"] -->|"yes"| B["Also fine"]');
    expect(sanitizeMermaidBlocks(src)).toBe(src);
  });

  it('converts <br> tags into label line breaks', () => {
    const out = sanitizeMermaidBlocks(wrap('flowchart TB\n    A["Log<br/>failure"]'));
    expect(out).toContain('Log\\nfailure');
    expect(out).not.toContain('<br');
  });

  it('renames `end` used as a node id', () => {
    const out = sanitizeMermaidBlocks(wrap('flowchart TB\n    C --> end\n    end[Done]'));
    expect(out).toContain('C --> endNode');
    expect(out).toContain('endNode["Done"]');
  });

  it('does not touch the `end` that closes a subgraph', () => {
    const out = sanitizeMermaidBlocks(wrap([
      'flowchart TB',
      '    subgraph S["Group"]',
      '        A["x"]',
      '    end',
    ].join('\n')));
    expect(out).toContain('\n    end');
    expect(out).not.toContain('endNode');
  });

  it('leaves non-flowchart diagram types untouched', () => {
    const src = wrap('pie showData\n    title Effort\n    "Backend" : 60');
    expect(sanitizeMermaidBlocks(src)).toBe(src);
  });

  it('leaves a sequence diagram untouched', () => {
    const src = wrap('sequenceDiagram\n    Alice->>Bob: Hello, Bob\n    Bob-->>Alice: Hi');
    expect(sanitizeMermaidBlocks(src)).toBe(src);
  });

  it('keeps surrounding prose and other code fences intact', () => {
    const md = [
      '# Doc',
      '',
      '```js',
      'const a = [1, 2];',
      '```',
      '',
      wrap('flowchart TB\n    A[bare, label]'),
      '',
      'Trailing prose.',
    ].join('\n');
    const out = sanitizeMermaidBlocks(md);
    expect(out).toContain('const a = [1, 2];');
    expect(out).toContain('A["bare, label"]');
    expect(out).toContain('Trailing prose.');
  });

  it('does not drop content when a fence is left unterminated', () => {
    const out = sanitizeMermaidBlocks('```mermaid\nflowchart TB\n    A[oops]');
    expect(out).toContain('A["oops"]');
  });

  it('repairs multiple blocks in one document', () => {
    const md = `${wrap('flowchart TB\n    A[first, one]')}\n\n${wrap('flowchart LR\n    B[second, two]')}`;
    const out = sanitizeMermaidBlocks(md);
    expect(out).toContain('A["first, one"]');
    expect(out).toContain('B["second, two"]');
  });
});

// ─── MERMAID_RULES ───────────────────────────────────────────────────────────

describe('MERMAID_RULES', () => {
  it('tells the model the rules that the sanitizer would otherwise have to fix', () => {
    expect(MERMAID_RULES).toContain('double quotes');
    expect(MERMAID_RULES).toContain('edge labels');
    expect(MERMAID_RULES).toMatch(/Never use `end` as an id/);
  });
});
