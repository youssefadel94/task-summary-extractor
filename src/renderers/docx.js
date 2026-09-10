/**
 * DOCX renderer — generates a Word document from compiled analysis results.
 *
 * Uses the `docx` package to programmatically build a professional DOCX file
 * that mirrors the structure of the Markdown/HTML reports.
 *
 * Usage:
 *   const { renderResultsDocx } = require('./docx');
 *   const buffer = renderResultsDocx({ compiled, meta });
 *   fs.writeFileSync('results.docx', buffer);
 */

'use strict';

const {
  clusterNames, resolve,
  dedupBy,
} = require('./shared');

// Same merge-and-sort as the Markdown report: one CR per change, urgent first.
const { packChangeRequests } = require('../utils/cr-pack');

// Everything a single --name is on the hook for, gathered from every collection.
const { buildPersonScope } = require('../utils/person-scope');

// ════════════════════════════════════════════════════════════
//  Lazy-load docx package
// ════════════════════════════════════════════════════════════

let docx;
function loadDocx() {
  if (!docx) {
    try {
      docx = require('docx');
    } catch {
      throw new Error(
        'DOCX generation requires the "docx" package. Install it with: npm install docx'
      );
    }
  }
  return docx;
}

// ════════════════════════════════════════════════════════════
//  Color / style constants
// ════════════════════════════════════════════════════════════

const BRAND_BLUE = '4361EE';
const MUTED_GRAY = '6C757D';
const SUCCESS_GREEN = '2ECC71';
const WARNING_AMBER = 'F39C12';
const DANGER_RED = 'E74C3C';

// Priority → color map
const PRI_COLOR = { critical: DANGER_RED, high: DANGER_RED, medium: WARNING_AMBER, low: SUCCESS_GREEN };
// Confidence → color map
const CONF_COLOR = { HIGH: SUCCESS_GREEN, MEDIUM: WARNING_AMBER, LOW: DANGER_RED };

// ════════════════════════════════════════════════════════════
//  Shorthand constructors
// ════════════════════════════════════════════════════════════

function heading(text, level = 1) {
  const { Paragraph, HeadingLevel, TextRun } = loadDocx();
  const map = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
  };
  return new Paragraph({
    heading: map[level] || HeadingLevel.HEADING_1,
    children: [new TextRun({ text: String(text) })],
    spacing: { before: level <= 2 ? 300 : 200, after: 100 },
  });
}

function para(text, opts = {}) {
  const { Paragraph, TextRun } = loadDocx();
  return new Paragraph({
    children: [new TextRun({
      text: String(text || ''),
      bold: opts.bold || false,
      italics: opts.italic || false,
      color: opts.color || undefined,
      size: opts.size || undefined,
    })],
    spacing: { after: opts.spacingAfter ?? 80 },
  });
}

function bulletItem(text, level = 0) {
  const { Paragraph, TextRun } = loadDocx();
  return new Paragraph({
    children: [new TextRun({ text: String(text || '') })],
    bullet: { level },
    spacing: { after: 40 },
  });
}

function metaLine(label, value) {
  const { Paragraph, TextRun } = loadDocx();
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true, color: MUTED_GRAY }),
      new TextRun({ text: String(value || 'N/A') }),
    ],
    spacing: { after: 40 },
  });
}

function hrule() {
  const { Paragraph, BorderStyle } = loadDocx();
  return new Paragraph({
    children: [],
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
    spacing: { before: 200, after: 200 },
  });
}

function badge(text, color) {
  const { TextRun } = loadDocx();
  return new TextRun({ text: ` [${text}]`, bold: true, color: color || MUTED_GRAY });
}

// ════════════════════════════════════════════════════════════
//  Table builder
// ════════════════════════════════════════════════════════════

function buildTable(headers, rows) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle, ShadingType } = loadDocx();

  const cellBorder = {
    top: { style: BorderStyle.SINGLE, size: 1, color: 'DEE2E6' },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DEE2E6' },
    left: { style: BorderStyle.SINGLE, size: 1, color: 'DEE2E6' },
    right: { style: BorderStyle.SINGLE, size: 1, color: 'DEE2E6' },
  };

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(h =>
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 20 })] })],
        shading: { type: ShadingType.SOLID, color: BRAND_BLUE },
        borders: cellBorder,
      })
    ),
  });

  const dataRows = rows.map((cells, rowIdx) =>
    new TableRow({
      children: cells.map(cellText =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: String(cellText || ''), size: 20 })] })],
          borders: cellBorder,
          shading: rowIdx % 2 === 1 ? { type: ShadingType.SOLID, color: 'F2F4F8' } : undefined,
        })
      ),
    })
  );

  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

// ════════════════════════════════════════════════════════════
//  Section renderers
// ════════════════════════════════════════════════════════════

/**
 * The named person's section.
 *
 * Reads from a person scope rather than straight off `your_tasks`: the old
 * version rendered nothing at all when the model returned no `your_tasks`, and
 * even when it did it never showed the person's change requests, blockers,
 * reviews or scope decisions — those live in the other collections.
 *
 * @param {object|null} scope - buildPersonScope() output
 * @param {Map} clusterMap - Name cluster map, to resolve spellings
 * @param {string} [fallbackName] - The --name that matched nobody, if that is the case
 * @returns {object[]} docx elements
 */
function renderYourTasks(scope, clusterMap, fallbackName = null) {
  const elements = [];

  if (!scope || scope.isEmpty) {
    if (!fallbackName) return [];
    elements.push(heading(`⭐ Your Tasks — ${fallbackName}`, 2));
    elements.push(para(
      `No work in this call is attributed to ${fallbackName}. Check the spelling passed to --name.`,
      { italic: true, color: MUTED_GRAY }
    ));
    return elements;
  }

  const pc = scope.counts;
  elements.push(heading(`⭐ Your Tasks — ${scope.person}`, 2));

  const ledger = [];
  if (pc.tickets) ledger.push(`${pc.tickets} ticket(s)`);
  if (pc.reviewing) ledger.push(`${pc.reviewing} to review`);
  if (pc.todo) ledger.push(`${pc.todo} to do`);
  if (pc.changeRequests) ledger.push(`${pc.changeRequests} change request(s)`);
  if (pc.blockers) ledger.push(`${pc.blockers} blocker(s)`);
  if (pc.blockingMe) ledger.push(`${pc.blockingMe} blocking you`);
  if (pc.decisionsNeeded) ledger.push(`${pc.decisionsNeeded} decision(s) needed`);
  if (pc.waitingOn) ledger.push(`${pc.waitingOn} waiting on others`);
  if (pc.othersWaitingOnMe) ledger.push(`${pc.othersWaitingOnMe} others waiting on you`);
  if (ledger.length) {
    elements.push(para(`On your plate: ${ledger.join(' · ')}`, { bold: true, color: BRAND_BLUE }));
  }

  if (scope.summary) {
    elements.push(para(scope.summary, { italic: true, color: MUTED_GRAY }));
  }

  if (scope.ownedTickets.length) {
    elements.push(heading('Owned Tickets', 3));
    for (const t of scope.ownedTickets) {
      const status = t.status ? ` [${String(t.status).replace(/_/g, ' ')}]` : '';
      elements.push(bulletItem(`${t.ticket_id}${t.title ? ` — ${t.title}` : ''}${status}`));
    }
  }

  if (scope.reviewingTickets.length) {
    elements.push(heading('Awaiting Your Review', 3));
    for (const t of scope.reviewingTickets) {
      const who = t.assignee ? ` — ${resolve(t.assignee, clusterMap)}` : '';
      elements.push(bulletItem(`${t.ticket_id}${t.title ? ` — ${t.title}` : ''}${who}`));
    }
  }

  if (scope.todo.length) {
    elements.push(heading('Tasks To-Do', 3));
    for (const task of scope.todo) {
      const pri = task.priority ? ` [${task.priority}]` : '';
      const src = task.source ? ` (from ${task.source})` : '';
      const due = task.due ? ` (by ${task.due})` : '';
      elements.push(bulletItem(`${task.description || ''}${pri}${due}${src}`));
    }
  }

  if (scope.changeRequests.length) {
    elements.push(heading('Your Change Requests', 3));
    for (const cr of scope.changeRequests) {
      const pri = cr.priority ? ` [${cr.priority}]` : '';
      const where = cr.where?.file_path ? ` → ${cr.where.file_path}` : '';
      elements.push(bulletItem(`${cr.id}: ${cr.title || cr.what || ''}${pri}${where}`));
    }
  }

  if (scope.decisionsNeeded.length) {
    elements.push(heading('Decisions Needed', 3));
    for (const d of scope.decisionsNeeded) {
      const opts = (d.options || []).length ? ` — Options: ${d.options.join(', ')}` : '';
      const who = d.from_whom ? ` (from ${resolve(d.from_whom, clusterMap)})` : '';
      elements.push(bulletItem(`${d.description || d.question || ''}${who}${opts}`));
    }
  }

  if (scope.blockers.length) {
    elements.push(heading('Your Blockers', 3));
    for (const b of scope.blockers) {
      const status = b.status ? ` (${b.status})` : '';
      elements.push(bulletItem(`${b.id}: ${b.description || ''}${status}`));
    }
  }

  if (scope.blockingMe.length) {
    elements.push(heading('Blocking Your Work', 3));
    for (const b of scope.blockingMe) {
      const owner = b.owner ? resolve(b.owner, clusterMap) : 'unowned';
      elements.push(bulletItem(`${b.id}: ${b.description || ''} — owned by ${owner}`));
    }
  }

  if (scope.waitingOn.length) {
    elements.push(heading('Waiting On Others', 3));
    for (const w of scope.waitingOn) {
      const who = w.waiting_on ? resolve(w.waiting_on, clusterMap) : 'Unknown';
      elements.push(bulletItem(`${w.description || ''} — waiting on ${who}`));
    }
  }

  if (scope.othersWaitingOnMe.length) {
    elements.push(heading('Others Waiting On You', 3));
    for (const a of scope.othersWaitingOnMe) {
      const owner = a.assigned_to ? resolve(a.assigned_to, clusterMap) : 'someone';
      elements.push(bulletItem(`${owner} is blocked on you: ${a.description || ''}`));
    }
  }

  if (scope.scopeChanges.length) {
    elements.push(heading('Scope Changes You Decided', 3));
    for (const sc of scope.scopeChanges) {
      elements.push(bulletItem(`${sc.id || '—'}: ${sc.new_scope || sc.description || sc.title || ''}`));
    }
  }

  if (scope.files.length) {
    elements.push(heading('Files You Will Touch', 3));
    for (const f of scope.files) {
      elements.push(bulletItem(f.resolved_path || f.file_name));
    }
  }

  if (scope.completedInCall.length || scope.completedChangeRequests.length) {
    elements.push(heading('Completed In Call', 3));
    for (const item of scope.completedInCall) {
      elements.push(bulletItem(typeof item === 'string' ? item : (item.description || item.action || String(item))));
    }
    for (const cr of scope.completedChangeRequests) {
      elements.push(bulletItem(`${cr.id}: ${cr.title || cr.what || ''}`));
    }
  }

  if (scope.mentions.length) {
    elements.push(heading('Mentioned You', 3));
    for (const m of scope.mentions) {
      const owner = m.owner ? resolve(m.owner, clusterMap) : 'unassigned';
      elements.push(bulletItem(`[${m.kind.replace(/_/g, ' ')}] ${m.id ? `${m.id}: ` : ''}${m.label} — ${owner}`));
    }
  }

  return elements;
}

function renderTickets(tickets, clusterMap) {
  if (!tickets.length) return [];
  const elements = [heading('🎫 Tickets', 2)];
  const rows = tickets.map(t => [
    t.ticket_id || '—',
    t.title || t.summary || '',
    t.status ? t.status.replace(/_/g, ' ') : '—',
    t.priority || '—',
    t.assignee ? resolve(t.assignee, clusterMap) : '—',
    t.estimated_effort || '—',
    t.confidence || '—',
  ]);
  elements.push(buildTable(['ID', 'Title', 'Status', 'Priority', 'Assignee', 'Effort', 'Conf.'], rows));
  return elements;
}

function renderActions(actions, clusterMap) {
  if (!actions.length) return [];
  const elements = [heading('📋 Action Items', 2)];
  const rows = actions.map(ai => [
    ai.description || ai.action || '',
    ai.assigned_to ? resolve(ai.assigned_to, clusterMap) : '—',
    ai.deadline || '—',
    ai.estimated_effort || '—',
    ai.priority || '—',
    ai.confidence || '—',
  ]);
  elements.push(buildTable(['Action', 'Assigned To', 'Deadline', 'Effort', 'Priority', 'Conf.'], rows));
  return elements;
}

function renderChangeRequests(crs, clusterMap) {
  if (!crs.length) return [];
  const elements = [heading('🔄 Change Requests', 2)];
  for (const cr of crs) {
    const { Paragraph, TextRun } = loadDocx();
    const typeLabel = cr.type ? ` (${cr.type.replace(/_/g, ' ')})` : '';
    const statusLabel = cr.status ? ` [${cr.status.replace(/_/g, ' ')}]` : '';
    elements.push(new Paragraph({
      children: [
        new TextRun({ text: `${cr.id}: ${cr.title || cr.what || 'Untitled'}${typeLabel}${statusLabel}`, bold: true }),
        badge(cr.priority || '—', PRI_COLOR[cr.priority] || MUTED_GRAY),
        badge(cr.confidence || '—', CONF_COLOR[cr.confidence] || MUTED_GRAY),
      ],
      spacing: { before: 120, after: 40 },
    }));
    if (cr.what && cr.what !== cr.title) elements.push(bulletItem(`What: ${cr.what}`));
    if (cr.how) elements.push(bulletItem(`How: ${cr.how}`));
    if (cr.why) elements.push(bulletItem(`Why: ${cr.why}`));
    if (cr.where?.file_path) elements.push(bulletItem(`File: ${cr.where.file_path}`));
    if (cr.assigned_to) elements.push(bulletItem(`Owner: ${resolve(cr.assigned_to, clusterMap)}`));
    if ((cr.related_tickets || []).length > 0) elements.push(bulletItem(`Tickets: ${cr.related_tickets.join(', ')}`));
  }
  return elements;
}

function renderBlockers(blockers, clusterMap) {
  if (!blockers.length) return [];
  const elements = [heading('🚧 Blockers', 2)];
  const rows = blockers.map(b => [
    b.description || '',
    b.owner ? resolve(b.owner, clusterMap) : '—',
    (b.type || b.severity || b.priority || '—').replace(/_/g, ' '),
    (b.status || b.resolution || '—').replace(/_/g, ' '),
    b.confidence || '—',
  ]);
  elements.push(buildTable(['Blocker', 'Owner', 'Type', 'Status', 'Conf.'], rows));
  return elements;
}

function renderScopeChanges(scopes, clusterMap) {
  if (!scopes.length) return [];
  const elements = [heading('📐 Scope Changes', 2)];
  for (const sc of scopes) {
    const icon = { added: '➕', removed: '➖', deferred: '⏸️', approach_changed: '🔄', ownership_changed: '👤', requirements_changed: '📋' }[sc.type] || '🔀';
    const decidedBy = sc.decided_by ? resolve(sc.decided_by, clusterMap) : null;
    const typeLabel = (sc.type || '').replace(/_/g, ' ');
    const mainText = sc.new_scope || sc.reason || sc.id || '';
    elements.push(bulletItem(`${icon} ${sc.id} (${typeLabel}): ${mainText} [${sc.impact || '?'}]`));
    if (sc.original_scope && sc.original_scope !== 'not documented') {
      elements.push(bulletItem(`Was: ${sc.original_scope}`, 1));
    }
    if (sc.reason && sc.new_scope) elements.push(bulletItem(`Reason: ${sc.reason}`, 1));
    if (decidedBy) elements.push(bulletItem(`Decided by: ${decidedBy}`, 1));
    if ((sc.related_tickets || []).length > 0) elements.push(bulletItem(`Tickets: ${sc.related_tickets.join(', ')}`, 1));
  }
  return elements;
}

function renderFileReferences(files) {
  if (!files.length) return [];
  const elements = [heading('📁 File References', 2)];
  // Split into actionable and reference-only (matches HTML/MD renderers)
  const actionable = files.filter(f => f.role && !['reference_only', 'source_of_truth'].includes(f.role));
  const reference = files.filter(f => !f.role || ['reference_only', 'source_of_truth'].includes(f.role));

  if (actionable.length > 0) {
    elements.push(heading('Files Requiring Action', 3));
    const rows = actionable.map(f => [
      f.file_name || '—',
      (f.role || '').replace(/_/g, ' '),
      (f.file_type || '').replace(/_/g, ' '),
      (f.mentioned_in_tickets || []).join(', ') || '—',
      (f.mentioned_in_changes || []).join(', ') || '—',
      f.resolved_path || '—',
    ]);
    elements.push(buildTable(['File', 'Role', 'Type', 'Tickets', 'Changes', 'Path'], rows));
  }

  if (reference.length > 0) {
    elements.push(heading('Reference Files', 3));
    const rows = reference.map(f => [
      f.file_name || '—',
      (f.file_type || '').replace(/_/g, ' '),
      (f.mentioned_in_tickets || []).join(', ') || '—',
      f.notes ? f.notes.slice(0, 80) + (f.notes.length > 80 ? '...' : '') : '—',
    ]);
    elements.push(buildTable(['File', 'Type', 'Tickets', 'Notes'], rows));
  }
  return elements;
}

// ════════════════════════════════════════════════════════════
//  Main export
// ════════════════════════════════════════════════════════════

/**
 * Generate a DOCX buffer from compiled analysis results.
 *
 * @param {object} options
 * @param {object} options.compiled - The AI-compiled unified analysis
 * @param {object} options.meta    - Call metadata
 * @returns {Promise<Buffer>} DOCX file buffer
 */
async function renderResultsDocx({ compiled, meta }) {
  const { Document, Packer, Paragraph, TextRun, Header, Footer, AlignmentType } = loadDocx();

  if (!compiled) {
    const fallback = new Document({
      sections: [{
        children: [
          heading('Call Analysis', 1),
          para('No compiled result available — AI compilation may have failed.'),
        ],
      }],
    });
    return Packer.toBuffer(fallback);
  }

  // Deduplicate data
  const allTickets = dedupBy(compiled.tickets || [], t => t.ticket_id);
  const allCRs = packChangeRequests(compiled.change_requests || []);
  const allActions = dedupBy(compiled.action_items || [], ai => ai.id);
  const allBlockers = dedupBy(compiled.blockers || [], b => b.id);
  const allScope = dedupBy(compiled.scope_changes || [], sc => sc.id);
  const allFiles = dedupBy(compiled.file_references || [], f => f.resolved_path || f.file_name);
  const summary = compiled.summary || compiled.executive_summary || '';
  const yourTasks = compiled.your_tasks || null;

  // Build cluster map
  const rawNames = new Set();
  const addName = n => { if (n?.trim()) rawNames.add(n.trim()); };
  allActions.forEach(ai => addName(ai.assigned_to));
  allCRs.forEach(cr => addName(cr.assigned_to));
  allBlockers.forEach(b => addName(b.owner));
  allScope.forEach(sc => addName(sc.decided_by));
  allTickets.forEach(t => { addName(t.assignee); addName(t.reviewer); });
  if (yourTasks?.user_name) addName(yourTasks.user_name);
  const clusterMap = clusterNames([...rawNames]);

  const teamKeywords = ['team', 'qa', 'dba', 'devops', 'db team', 'external'];
  const people = [...clusterMap.keys()]
    .filter(n => n && !teamKeywords.some(kw => n.toLowerCase() === kw))
    .sort();

  // ── Build document sections ──
  const children = [];

  // Title
  children.push(heading(`📋 Call Analysis — ${meta.callName || 'Unknown'}`, 1));

  // Metadata block
  children.push(metaLine('Date', meta.processedAt ? meta.processedAt.slice(0, 10) : 'N/A'));
  children.push(metaLine('Participants', people.join(', ') || 'Unknown'));
  children.push(metaLine('Segments', String(meta.segmentCount || 'N/A')));
  children.push(metaLine('Model', meta.geminiModel || 'N/A'));

  const comp = meta.compilation;
  if (comp) {
    const tu = comp.tokenUsage || {};
    const durSec = comp.durationMs ? (comp.durationMs / 1000).toFixed(1) : '?';
    children.push(metaLine('Compilation',
      `${durSec}s | ${(tu.inputTokens || 0).toLocaleString()} input → ${(tu.outputTokens || 0).toLocaleString()} output tokens`
    ));
  }

  const cost = meta.costSummary;
  if (cost && cost.totalTokens > 0) {
    children.push(metaLine('Cost',
      `$${cost.totalCost.toFixed(4)} (${cost.totalTokens.toLocaleString()} tokens | ${(cost.totalDurationMs / 1000).toFixed(1)}s)`
    ));
  }

  // Confidence filter notice
  if (compiled._filterMeta && compiled._filterMeta.minConfidence !== 'LOW') {
    const fm = compiled._filterMeta;
    const label = fm.minConfidence === 'HIGH' ? 'HIGH' : 'MEDIUM+';
    children.push(para(
      `⚠ Confidence filter: showing only ${label} items. Kept ${fm.filteredCounts.total}/${fm.originalCounts.total} (${fm.removed} removed).`,
      { italic: true, color: WARNING_AMBER }
    ));
  }

  children.push(hrule());

  // Summary
  if (summary) {
    children.push(heading('Executive Summary', 2));
    // Split summary into paragraphs
    const parts = String(summary).split(/\n\n+/);
    for (const p of parts) {
      if (p.trim()) children.push(para(p.trim()));
    }
    children.push(hrule());
  }

  // Confidence distribution
  const allConf = [...allTickets, ...allCRs, ...allActions, ...allBlockers, ...allScope];
  if (allConf.length > 0) {
    const hi = allConf.filter(i => i.confidence === 'HIGH').length;
    const md = allConf.filter(i => i.confidence === 'MEDIUM').length;
    const lo = allConf.filter(i => i.confidence === 'LOW').length;
    children.push(para(
      `Confidence: 🟢 HIGH ${hi} | 🟡 MEDIUM ${md} | 🔴 LOW ${lo} — Total ${allConf.length} items`,
      { italic: true, color: MUTED_GRAY }
    ));
  }

  // Your Tasks — the named person's slice of every collection, not just the
  // model's your_tasks object (which is often absent entirely).
  const currentUserCanonical = meta.userName ? resolve(meta.userName, clusterMap) : null;
  const personScope = currentUserCanonical
    ? buildPersonScope({
      person: currentUserCanonical,
      matches: raw => !!raw && resolve(raw, clusterMap) === currentUserCanonical,
      tickets: allTickets,
      changeRequests: allCRs,
      actionItems: allActions,
      blockers: allBlockers,
      scopeChanges: allScope,
      fileReferences: allFiles,
      yourTasks,
    })
    : null;
  children.push(...renderYourTasks(personScope, clusterMap, meta.userName || null));

  // Tickets
  children.push(...renderTickets(allTickets, clusterMap));

  // Action Items
  children.push(...renderActions(allActions, clusterMap));

  // Change Requests
  children.push(...renderChangeRequests(allCRs, clusterMap));

  // Blockers
  children.push(...renderBlockers(allBlockers, clusterMap));

  // Scope Changes
  children.push(...renderScopeChanges(allScope, clusterMap));

  // File References
  children.push(...renderFileReferences(allFiles));

  // ── Assemble document ──
  const doc = new Document({
    title: `Call Analysis — ${meta.callName || 'Unknown'}`,
    creator: 'taskex',
    description: 'Auto-generated call analysis report',
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 }, // 11pt
        },
        heading1: {
          run: { size: 32, bold: true, color: BRAND_BLUE, font: 'Calibri' },
        },
        heading2: {
          run: { size: 28, bold: true, color: BRAND_BLUE, font: 'Calibri' },
        },
        heading3: {
          run: { size: 24, bold: true, font: 'Calibri' },
        },
      },
    },
    sections: [{
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: 'taskex — Call Analysis Report', color: MUTED_GRAY, size: 16, italics: true })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `Generated by taskex • ${new Date().toISOString().slice(0, 10)}`, color: MUTED_GRAY, size: 16 })],
          })],
        }),
      },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { renderResultsDocx };
