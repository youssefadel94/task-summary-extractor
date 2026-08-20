/**
 * Mermaid — diagram generation for the Markdown outputs.
 *
 * Two jobs:
 *  1. Build deterministic diagrams from compiled pipeline data (work-item map,
 *     ownership map, blocker chains, confidence/progress pies). No AI involved —
 *     these are derived straight from the extracted items.
 *  2. Keep AI-authored diagrams renderable: `MERMAID_RULES` tells the model how
 *     to write valid Mermaid, and `sanitizeMermaidBlocks()` repairs the mistakes
 *     it still makes (unquoted labels, parentheses, `<br>` variants, `end` ids).
 *
 * Every label is emitted as a double-quoted string with quotes/newlines/angle
 * brackets stripped, and every node id is synthetic (`T1`, `CR2`, …), so real
 * ticket IDs like `PROJ-123` can never break the parser.
 *
 * Usage:
 *   const { buildWorkItemMap, sanitizeMermaidBlocks, MERMAID_RULES } = require('./utils/mermaid');
 *
 * @module mermaid
 */

'use strict';

// ======================== CONSTANTS ========================

/** Max characters kept in a node label before ellipsis. */
const LABEL_MAX = 52;

/** Node ceilings — past these a diagram is more noise than signal. */
const LIMITS = {
  tickets: 12,
  changeRequests: 14,
  actionItems: 14,
  blockers: 8,
  people: 8,
  itemsPerPerson: 6,
};

/**
 * Mermaid authoring rules appended to every AI writing prompt.
 * Deliberately terse and rule-shaped — the models follow numbered constraints
 * far more reliably than prose.
 */
const MERMAID_RULES = `DIAGRAM RULES (Mermaid):
- Include Mermaid diagrams wherever a relationship, flow, sequence, hierarchy, timeline, or comparison is easier to see than to read. Aim for at least one diagram in any document that describes a process, an architecture, or how parts connect. Do NOT add a diagram to a document that is purely a list of facts.
- Write them as fenced blocks opened with three backticks followed by the word mermaid, and closed with three backticks.
- Pick the right type: \`flowchart TB\`/\`flowchart LR\` for processes and relationships, \`sequenceDiagram\` for interactions over time, \`erDiagram\` for data models, \`stateDiagram-v2\` for state machines, \`gantt\` for schedules, \`pie\` for proportions.
- ALWAYS wrap node text in double quotes: \`A["Load config"]\`, never \`A[Load config]\`. Unquoted parentheses, commas, colons, braces and slashes break the parser.
- ALWAYS wrap edge labels in double quotes: \`A -->|"on failure"| B\`, never \`A -->|on failure| B\`.
- Use short alphanumeric node ids (\`A\`, \`B1\`, \`STEP2\`). Never use \`end\` as an id, and never put a raw hyphen, dot or space in an id — put the real name in the quoted label instead.
- Never use double quotes, angle brackets or backticks INSIDE a label. Use \`\\n\` for a line break inside a label.
- Declare a subgraph before any edge that references it.
- Keep each diagram under ~20 nodes. Several focused diagrams beat one dense one.
- Put a sentence before or after each diagram explaining what it shows — the diagram supplements the prose, it does not replace it.`;

// ======================== LABEL / ID HELPERS ========================

/**
 * Sanitize arbitrary text into something safe inside a double-quoted Mermaid label.
 * Strips the characters that terminate a label or get parsed as markup, collapses
 * whitespace, and truncates.
 *
 * @param {*} text - raw value
 * @param {number} [maxLen=LABEL_MAX] - truncation length
 * @returns {string} label body (caller adds the surrounding quotes)
 */
function mermaidLabel(text, maxLen = LABEL_MAX) {
  if (text == null) return '';
  let s = String(text)
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/["`]/g, "'")
    .replace(/[<>]/g, '')
    .replace(/\|/g, '/')
    .replace(/\{|\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1).trimEnd()}…`;
  return s;
}

/**
 * Build a synthetic, always-valid node id. Real IDs go in the label.
 * @param {string} prefix - short alpha prefix (e.g. 'T', 'CR')
 * @param {number} index - 0-based position
 * @returns {string}
 */
function nodeId(prefix, index) {
  return `${prefix}${index + 1}`;
}

/**
 * Wrap a built diagram body in a fenced mermaid block.
 * @param {string[]} lines - diagram lines (without the fence)
 * @returns {string} fenced block
 */
function fence(lines) {
  return ['```mermaid', ...lines, '```'].join('\n');
}

/**
 * Normalize an ID-ish value into a comparable key.
 * @param {*} v
 * @returns {string}
 */
function idKey(v) {
  return v == null ? '' : String(v).trim().toUpperCase();
}

/**
 * Coerce a field that may be a string or an array of strings into an array.
 * The compiled schema is loose here — `related_tickets` comes back as either.
 * @param {*} v
 * @returns {string[]}
 */
function toList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter(x => x != null).map(String);
  return String(v).split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

// ======================== DETERMINISTIC BUILDERS ========================

/**
 * Work-item map — how tickets, change requests, action items and blockers connect.
 *
 * Only items that actually link to a rendered ticket are drawn; an unconnected
 * change request adds a node and no information. Returns null when there is
 * nothing worth drawing (fewer than 2 nodes, or no edges at all).
 *
 * @param {object} data
 * @param {object[]} [data.tickets]
 * @param {object[]} [data.changeRequests]
 * @param {object[]} [data.actionItems]
 * @param {object[]} [data.blockers]
 * @returns {string|null} fenced mermaid block, or null
 */
function buildWorkItemMap({ tickets = [], changeRequests = [], actionItems = [], blockers = [] } = {}) {
  const shownTickets = tickets.slice(0, LIMITS.tickets);
  if (shownTickets.length === 0) return null;

  const ticketNode = new Map(); // normalized ticket id → node id
  const lines = ['flowchart LR'];
  const edges = [];

  lines.push('    subgraph TICKETS["🎫 Tickets"]');
  lines.push('        direction TB');
  shownTickets.forEach((t, i) => {
    const id = nodeId('T', i);
    const label = mermaidLabel(`${t.ticket_id || 'Ticket'} — ${t.title || 'Untitled'}`);
    const status = t.status ? mermaidLabel(t.status, 24) : '';
    lines.push(`        ${id}["${label}${status ? `\\n${status}` : ''}"]`);
    if (t.ticket_id) ticketNode.set(idKey(t.ticket_id), id);
  });
  lines.push('    end');

  // Change requests → the tickets they implement
  const crLines = [];
  let crIdx = 0;
  for (const cr of changeRequests) {
    if (crIdx >= LIMITS.changeRequests) break;
    const targets = toList(cr.related_tickets).map(idKey).filter(k => ticketNode.has(k));
    if (targets.length === 0) continue;
    const id = nodeId('CR', crIdx++);
    crLines.push(`        ${id}["${mermaidLabel(`${cr.id || 'CR'} — ${cr.title || cr.what || 'Change'}`)}"]`);
    for (const k of targets) edges.push(`    ${id} -->|"changes"| ${ticketNode.get(k)}`);
  }
  if (crLines.length > 0) {
    lines.push('    subgraph CRS["🔧 Change Requests"]');
    lines.push('        direction TB');
    lines.push(...crLines);
    lines.push('    end');
  }

  // Action items → the tickets/CRs they advance
  const aiLines = [];
  let aiIdx = 0;
  for (const ai of actionItems) {
    if (aiIdx >= LIMITS.actionItems) break;
    const targets = toList(ai.related_tickets).map(idKey).filter(k => ticketNode.has(k));
    if (targets.length === 0) continue;
    const id = nodeId('A', aiIdx++);
    const who = ai.assigned_to ? `\\n${mermaidLabel(ai.assigned_to, 24)}` : '';
    aiLines.push(`        ${id}["${mermaidLabel(ai.description || ai.id || 'Action')}${who}"]`);
    for (const k of targets) edges.push(`    ${id} -->|"acts on"| ${ticketNode.get(k)}`);
  }
  if (aiLines.length > 0) {
    lines.push('    subgraph ACTIONS["✅ Action Items"]');
    lines.push('        direction TB');
    lines.push(...aiLines);
    lines.push('    end');
  }

  // Blockers → what they block
  const bLines = [];
  let bIdx = 0;
  for (const b of blockers) {
    if (bIdx >= LIMITS.blockers) break;
    const targets = toList(b.blocks).map(idKey).filter(k => ticketNode.has(k));
    if (targets.length === 0) continue;
    const id = nodeId('B', bIdx++);
    bLines.push(`        ${id}["${mermaidLabel(`${b.id || 'Blocker'} — ${b.description || b.type || 'Blocked'}`)}"]`);
    for (const k of targets) edges.push(`    ${id} ==>|"blocks"| ${ticketNode.get(k)}`);
  }
  if (bLines.length > 0) {
    lines.push('    subgraph BLOCKERS["🚫 Blockers"]');
    lines.push('        direction TB');
    lines.push(...bLines);
    lines.push('    end');
  }

  if (edges.length === 0) return null;

  lines.push('');
  lines.push(...edges);
  lines.push('');
  lines.push('    classDef blocked stroke:#d64545,stroke-width:2px;');
  if (bLines.length > 0) {
    const blockedIds = bLines.map((_, i) => nodeId('B', i)).join(',');
    lines.push(`    class ${blockedIds} blocked;`);
  }

  return fence(lines);
}

/**
 * Confidence distribution as a pie chart.
 * @param {{high:number, medium:number, low:number, unset:number}} counts
 * @returns {string|null}
 */
function buildConfidencePie({ high = 0, medium = 0, low = 0, unset = 0 } = {}) {
  if (high + medium + low + unset === 0) return null;
  const lines = ['pie showData', '    title Confidence distribution'];
  if (high > 0) lines.push(`    "🟢 HIGH" : ${high}`);
  if (medium > 0) lines.push(`    "🟡 MEDIUM" : ${medium}`);
  if (low > 0) lines.push(`    "🔴 LOW" : ${low}`);
  if (unset > 0) lines.push(`    "⚪ UNSET" : ${unset}`);
  return fence(lines);
}

/**
 * Ownership map — who owns which tickets, actions and blockers.
 *
 * @param {object} data
 * @param {string[]} data.people - canonical names, current user first
 * @param {function(string, string): boolean} data.nameMatch - (rawName, canonical) => boolean
 * @param {object[]} [data.tickets]
 * @param {object[]} [data.actionItems]
 * @param {object[]} [data.blockers]
 * @param {string} [data.currentUser] - canonical name to highlight
 * @returns {string|null}
 */
function buildOwnershipMap({ people = [], nameMatch, tickets = [], actionItems = [], blockers = [], currentUser = null } = {}) {
  if (typeof nameMatch !== 'function' || people.length === 0) return null;

  const lines = ['flowchart LR'];
  const edges = [];
  let drew = 0;
  const shownPeople = people.slice(0, LIMITS.people);

  shownPeople.forEach((person, pi) => {
    const pid = nodeId('P', pi);
    const isUser = currentUser && person === currentUser;
    lines.push(`    ${pid}(["${isUser ? '⭐ ' : ''}${mermaidLabel(person, 28)}"])`);

    let owned = 0;
    const own = (arr, matchField, prefix, icon, labelOf) => {
      for (let i = 0; i < arr.length && owned < LIMITS.itemsPerPerson; i++) {
        const item = arr[i];
        if (!nameMatch(item[matchField], person)) continue;
        const iid = `${pid}${prefix}${owned}`;
        lines.push(`    ${iid}["${icon} ${mermaidLabel(labelOf(item))}"]`);
        edges.push(`    ${pid} --> ${iid}`);
        owned++;
        drew++;
      }
    };

    own(tickets, 'assignee', 'T', '🎫', t => `${t.ticket_id || 'Ticket'} — ${t.title || 'Untitled'}`);
    own(actionItems, 'assigned_to', 'A', '✅', a => a.description || a.id || 'Action');
    own(blockers, 'owner', 'B', '🚫', b => b.description || b.id || 'Blocker');

    if (owned === 0) {
      // Person with nothing assigned adds a dangling node — drop them entirely.
      lines.pop();
    }
  });

  if (drew === 0 || edges.length === 0) return null;

  lines.push('');
  lines.push(...edges);
  if (currentUser && shownPeople.includes(currentUser)) {
    const uid = nodeId('P', shownPeople.indexOf(currentUser));
    lines.push('');
    lines.push('    classDef me stroke-width:3px;');
    lines.push(`    class ${uid} me;`);
  }
  return fence(lines);
}

/**
 * Blocker impact chain — blocker → what it blocks → who owns it.
 * @param {object[]} blockers
 * @returns {string|null}
 */
function buildBlockerMap(blockers = []) {
  const shown = blockers.slice(0, LIMITS.blockers);
  if (shown.length === 0) return null;

  const lines = ['flowchart LR'];
  const edges = [];
  shown.forEach((b, i) => {
    const bid = nodeId('B', i);
    const sev = b.type ? `\\n${mermaidLabel(b.type, 20)}` : '';
    lines.push(`    ${bid}{"${mermaidLabel(b.id || `Blocker ${i + 1}`, 28)}${sev}"}`);
    lines.push(`    ${bid}D["${mermaidLabel(b.description || 'No description')}"]`);
    edges.push(`    ${bid} --> ${bid}D`);

    const blocks = toList(b.blocks).slice(0, 4);
    blocks.forEach((target, ti) => {
      const tid = `${bid}X${ti}`;
      lines.push(`    ${tid}(["${mermaidLabel(target, 32)}"])`);
      edges.push(`    ${bid}D ==>|"blocks"| ${tid}`);
    });

    if (b.owner) {
      const oid = `${bid}O`;
      lines.push(`    ${oid}["👤 ${mermaidLabel(b.owner, 28)}"]`);
      edges.push(`    ${oid} -.->|"owns"| ${bid}`);
    }
  });

  lines.push('');
  lines.push(...edges);
  return fence(lines);
}

/**
 * Progress status breakdown as a pie chart.
 * @param {{done:number, inProgress:number, notStarted:number, superseded:number}} summary
 * @returns {string|null}
 */
function buildProgressPie({ done = 0, inProgress = 0, notStarted = 0, superseded = 0 } = {}) {
  if (done + inProgress + notStarted + superseded === 0) return null;
  const lines = ['pie showData', '    title Item status'];
  if (done > 0) lines.push(`    "✅ Completed" : ${done}`);
  if (inProgress > 0) lines.push(`    "🔄 In Progress" : ${inProgress}`);
  if (notStarted > 0) lines.push(`    "⬜ Not Started" : ${notStarted}`);
  if (superseded > 0) lines.push(`    "🔁 Superseded" : ${superseded}`);
  return fence(lines);
}

/**
 * Progress flow — items grouped by status, with the git evidence that moved them.
 * @param {object} data
 * @param {object[]} data.assessments
 * @param {object} [data.changeReport]
 * @returns {string|null}
 */
function buildProgressFlow({ assessments = [], changeReport = null } = {}) {
  if (assessments.length === 0) return null;

  const buckets = {
    DONE: { icon: '✅', label: 'Completed', items: [] },
    IN_PROGRESS: { icon: '🔄', label: 'In Progress', items: [] },
    NOT_STARTED: { icon: '⬜', label: 'Not Started', items: [] },
    SUPERSEDED: { icon: '🔁', label: 'Superseded', items: [] },
  };
  for (const a of assessments) {
    const bucket = buckets[a.status];
    if (bucket && bucket.items.length < 6) bucket.items.push(a);
  }

  const active = Object.entries(buckets).filter(([, b]) => b.items.length > 0);
  if (active.length === 0) return null;

  const lines = ['flowchart LR'];
  const edges = [];

  const commits = changeReport?.totals?.commits || 0;
  const files = changeReport?.totals?.filesChanged || 0;
  if (commits > 0 || files > 0) {
    lines.push(`    GIT[("📦 Git evidence\\n${commits} commit(s) · ${files} file(s)")]`);
  }

  active.forEach(([status, bucket], bi) => {
    const sid = `S${bi}`;
    lines.push(`    subgraph ${sid}["${bucket.icon} ${bucket.label} (${bucket.items.length})"]`);
    lines.push('        direction TB');
    bucket.items.forEach((item, ii) => {
      lines.push(`        ${sid}I${ii}["${mermaidLabel(`${item.item_id || 'Item'} — ${item.title || item.item_type || ''}`)}"]`);
    });
    lines.push('    end');
    if ((commits > 0 || files > 0) && status === 'DONE') {
      edges.push(`    GIT ==>|"evidence"| ${sid}`);
    }
  });

  if (edges.length > 0) {
    lines.push('');
    lines.push(...edges);
  }
  return fence(lines);
}

/**
 * Document map — the generated document set, grouped by category.
 *
 * Drawn at the top of an INDEX.md so the reader can see the shape of the set
 * before reading any of it.
 *
 * @param {object} data
 * @param {string} [data.title] - centre node text (the request the set answers)
 * @param {Array<{category: string, label: string, docs: Array<{title: string}>}>} data.groups
 * @returns {string|null}
 */
function buildDocumentMap({ title = 'Generated documents', groups = [] } = {}) {
  const active = groups.filter(g => (g.docs || []).length > 0);
  if (active.length === 0) return null;

  const lines = ['flowchart LR'];
  const edges = [];
  lines.push(`    ROOT(["${mermaidLabel(title, 64)}"])`);

  active.slice(0, 10).forEach((group, gi) => {
    const gid = nodeId('G', gi);
    lines.push(`    ${gid}["${mermaidLabel(group.label || group.category, 32)}"]`);
    edges.push(`    ROOT --> ${gid}`);
    (group.docs || []).slice(0, 8).forEach((doc, di) => {
      const did = `${gid}D${di}`;
      lines.push(`    ${did}["${mermaidLabel(doc.title || 'Untitled')}"]`);
      edges.push(`    ${gid} --> ${did}`);
    });
  });

  lines.push('');
  lines.push(...edges);
  return fence(lines);
}

// ======================== AI OUTPUT SANITIZER ========================

/** Mermaid keywords that must never be used as a bare node id. */
const RESERVED_IDS = new Set(['end', 'graph', 'subgraph', 'class', 'click', 'style', 'direction']);

/** Diagram types whose bodies are NOT node/edge syntax — left untouched. */
const NON_FLOW_TYPES = /^\s*(pie|gantt|sequenceDiagram|erDiagram|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey|xychart|block)/;

/**
 * Repair one flowchart-ish diagram body.
 * Quotes bare node labels and bare edge labels, normalizes `<br>` to `\n`, and
 * renames reserved-word ids. Anything already quoted is left alone.
 *
 * @param {string} code - diagram source (no fences)
 * @returns {string}
 */
function repairFlowchart(code) {
  let out = code.replace(/<br\s*\/?>/gi, '\\n');

  // Mask everything already inside double quotes so the repairs below can never
  // touch — or re-quote — a label the model got right.
  const masked = [];
  const mask = text => {
    masked.push(text);
    return `@@MMD${masked.length - 1}@@`;
  };
  out = out.replace(/"[^"\n]*"/g, mask);

  const isMask = t => /^@@MMD\d+@@$/.test(t.trim());
  const expand = t => {
    let v = t;
    // Masks nest — a repaired shape can hold an already-quoted label.
    while (/@@MMD\d+@@/.test(v)) v = v.replace(/@@MMD(\d+)@@/g, (m, n) => masked[Number(n)]);
    return v;
  };

  // Bare node labels — quote them. Two-character shapes are matched first so
  // `A([x])` is not mistaken for `A(` followed by `[x]`. Each repaired shape is
  // masked whole, so a later single-char pass cannot wrap it a second time.
  const SHAPES = [
    ['[(', ')]'], ['([', '])'], ['((', '))'], ['[[', ']]'], ['{{', '}}'],
    ['[', ']'], ['(', ')'], ['{', '}'],
  ];
  const esc = t => t.replace(/[[\](){}]/g, ch => `\\${ch}`);
  for (const [open, close] of SHAPES) {
    // A single-char shape must not swallow its own closer; a two-char shape is
    // bounded by the lazy quantifier reaching the full closing pair.
    const inner = close.length === 1 ? `[^\\n${esc(close)}]` : '[^\\n]';
    const re = new RegExp(`(^|[^\\w])([A-Za-z][\\w]*)${esc(open)}(${inner}+?)${esc(close)}`, 'g');
    out = out.replace(re, (m, pre, id, label) => {
      if (isMask(label)) return `${pre}${id}${mask(`${open}${label}${close}`)}`;
      // A bare label can still hold a quoted run (`He said "hi"`). Nested double
      // quotes are a parse error, so expand and downgrade them to single quotes.
      const body = expand(label).replace(/"/g, "'").trim();
      return `${pre}${id}${mask(`${open}"${body}"${close}`)}`;
    });
  }

  // Bare edge labels: A -->|text| B
  out = out.replace(/\|([^|\n]+?)\|/g, (m, label) =>
    (isMask(label) ? m : `|"${expand(label).replace(/"/g, "'").trim()}"|`));

  // Reserved words used as node ids — `end` in particular is a parse error that
  // silently kills the whole diagram.
  for (const word of RESERVED_IDS) {
    out = out.replace(new RegExp(`(^|\\s)${word}(?=@@MMD\\d+@@)`, 'g'), `$1${word}Node`);
    out = out.replace(new RegExp(`((?:-->|==>|-\\.->|---|===)\\s*)${word}(?=\\s|$)`, 'gm'), `$1${word}Node`);
  }

  return expand(out);
}

/**
 * Repair AI-authored mermaid blocks inside a Markdown document.
 *
 * The models reliably produce *almost* valid Mermaid — the recurring failures are
 * unquoted labels containing parentheses or commas, `<br>` tags, and `end` used
 * as a node id. Each of those silently breaks rendering on GitHub, so every
 * generated document is passed through here before it is written to disk.
 *
 * @param {string} markdown - full document text
 * @returns {string} the document with its mermaid blocks repaired
 */
function sanitizeMermaidBlocks(markdown) {
  if (!markdown || typeof markdown !== 'string') return markdown;
  if (!markdown.includes('```mermaid')) return markdown;

  const lines = markdown.split('\n');
  const out = [];
  let buf = null;

  for (const line of lines) {
    if (buf === null && /^\s*```\s*mermaid\s*$/i.test(line)) {
      buf = [];
      out.push('```mermaid');
      continue;
    }
    if (buf !== null) {
      if (/^\s*```\s*$/.test(line)) {
        const code = buf.join('\n');
        out.push(NON_FLOW_TYPES.test(code) ? code : repairFlowchart(code));
        out.push('```');
        buf = null;
        continue;
      }
      buf.push(line);
      continue;
    }
    out.push(line);
  }

  // Unterminated fence — emit what we buffered rather than dropping it.
  if (buf !== null) {
    const code = buf.join('\n');
    out.push(NON_FLOW_TYPES.test(code) ? code : repairFlowchart(code));
  }

  return out.join('\n');
}

module.exports = {
  MERMAID_RULES,
  LIMITS,
  mermaidLabel,
  sanitizeMermaidBlocks,
  buildWorkItemMap,
  buildConfidencePie,
  buildOwnershipMap,
  buildBlockerMap,
  buildProgressPie,
  buildProgressFlow,
  buildDocumentMap,
};
