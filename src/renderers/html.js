/**
 * HTML renderer — generates a self-contained HTML report from compiled results.
 *
 * Mirrors the same data flow and sections as markdown.js, but outputs
 * a fully styled, interactive HTML document with:
 *  - Inline CSS (no external dependencies)
 *  - Collapsible sections
 *  - Sortable tables
 *  - Dark/light theme toggle
 *  - Print-friendly layout
 */

'use strict';

const {
  clusterNames, resolve,
  dedupBy, normalizeDesc, dedupByDesc,
  escHtml,
} = require('./shared');

// ════════════════════════════════════════════════════════════
//  Inline CSS
// ════════════════════════════════════════════════════════════

const CSS = `
:root {
  --bg: #ffffff; --fg: #1a1a2e; --card: #f8f9fa; --border: #dee2e6;
  --accent: #4361ee; --accent-light: #e8edff; --success: #2ecc71;
  --warning: #f39c12; --danger: #e74c3c; --muted: #6c757d;
  --table-stripe: #f2f4f8; --shadow: 0 2px 8px rgba(0,0,0,0.08);
}
[data-theme="dark"] {
  --bg: #1a1a2e; --fg: #e0e0e0; --card: #16213e; --border: #2a2a4a;
  --accent: #7b8cff; --accent-light: #1e2a4a; --success: #27ae60;
  --warning: #e67e22; --danger: #c0392b; --muted: #aaa;
  --table-stripe: #1e2a3e; --shadow: 0 2px 8px rgba(0,0,0,0.3);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg); color: var(--fg); line-height: 1.6; padding: 2rem; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.8rem; margin-bottom: 0.5rem; border-bottom: 3px solid var(--accent); padding-bottom: 0.5rem; }
h2 { font-size: 1.4rem; margin-top: 2rem; margin-bottom: 0.5rem; color: var(--accent); }
h3 { font-size: 1.15rem; margin-top: 1.2rem; margin-bottom: 0.4rem; }
h4 { font-size: 1rem; margin-top: 0.8rem; margin-bottom: 0.3rem; color: var(--muted); }
hr { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
blockquote { border-left: 4px solid var(--accent); padding: 0.5rem 1rem; margin: 0.5rem 0;
  background: var(--accent-light); border-radius: 0 4px 4px 0; }
code { background: var(--card); padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.9em; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  padding: 1rem 1.2rem; margin: 0.8rem 0; box-shadow: var(--shadow); }
.badge { display: inline-block; padding: 0.1em 0.5em; border-radius: 3px; font-size: 0.8em; font-weight: 600; }
.badge-high { background: #d4edda; color: #155724; }
.badge-medium { background: #fff3cd; color: #856404; }
.badge-low { background: #f8d7da; color: #721c24; }
.badge-pri-high { background: var(--danger); color: #fff; }
.badge-pri-medium { background: var(--warning); color: #fff; }
.badge-pri-low { background: var(--success); color: #fff; }
.badge-pri-critical { background: #5c0011; color: #fff; }
table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; font-size: 0.9rem; }
th { background: var(--accent); color: #fff; text-align: left; padding: 0.5rem 0.7rem; }
td { padding: 0.4rem 0.7rem; border-bottom: 1px solid var(--border); }
tr:nth-child(even) td { background: var(--table-stripe); }
details { margin: 0.5rem 0; }
details summary { cursor: pointer; font-weight: 600; padding: 0.3rem 0; color: var(--accent); }
details summary:hover { text-decoration: underline; }
ul, ol { padding-left: 1.5rem; margin: 0.3rem 0; }
li { margin: 0.2rem 0; }
.checkbox { margin-right: 0.3rem; }
.meta-grid { display: grid; grid-template-columns: auto 1fr; gap: 0.2rem 1rem; margin: 0.5rem 0; font-size: 0.9rem; }
.meta-grid dt { font-weight: 600; color: var(--muted); }
.conf-bar { display: flex; gap: 0; height: 8px; border-radius: 4px; overflow: hidden; margin: 0.3rem 0; }
.conf-bar span { display: block; }
.conf-bar .high { background: var(--success); }
.conf-bar .med { background: var(--warning); }
.conf-bar .low { background: var(--danger); }
.theme-toggle { position: fixed; top: 1rem; right: 1rem; background: var(--card); border: 1px solid var(--border);
  border-radius: 50%; width: 36px; height: 36px; cursor: pointer; font-size: 1.1rem; z-index: 100; }
.person-section { border-left: 3px solid var(--accent); padding-left: 1rem; margin: 1rem 0; }
.star { border-left-color: var(--warning); }
.footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border);
  font-size: 0.85rem; color: var(--muted); text-align: center; }
@media print { .theme-toggle { display: none; } body { max-width: 100%; padding: 0.5cm; } }
@media (max-width: 700px) { body { padding: 0.8rem; } table { font-size: 0.8rem; } }
`;

const JS_SCRIPT = `
document.querySelector('.theme-toggle').addEventListener('click', () => {
  const d = document.documentElement;
  d.dataset.theme = d.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', d.dataset.theme);
});
(function() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
})();
`;

// ════════════════════════════════════════════════════════════
//  Helper builders
// ════════════════════════════════════════════════════════════

const e = escHtml;

function confBadgeHtml(c) {
  if (!c) return '';
  const cls = { HIGH: 'badge-high', MEDIUM: 'badge-medium', LOW: 'badge-low' }[c] || '';
  return ` <span class="badge ${cls}">${e(c)}</span>`;
}

function priBadgeHtml(p) {
  if (!p) return '';
  const cls = { high: 'badge-pri-high', medium: 'badge-pri-medium', low: 'badge-pri-low', critical: 'badge-pri-critical' }[p] || '';
  return ` <span class="badge ${cls}">${e(p)}</span>`;
}

function tsHtml(ts, seg, video) {
  if (!ts) return '';
  let label = '';
  if (seg && video) {
    const short = shortVideoHtml(video);
    label = ` <small>(${short} · Seg ${seg})</small>`;
  } else if (seg) {
    label = ` <small>(Seg ${seg})</small>`;
  }
  return `<code>${e(ts)}</code>${label}`;
}

/** Shorten a video filename for HTML display. */
function shortVideoHtml(name) {
  if (!name) return '';
  let s = name.replace(/\.[^.]+$/, '');
  if (s.length > 35) s = s.substring(0, 30) + '…';
  return e(s);
}

// ════════════════════════════════════════════════════════════
//  Main Renderer
// ════════════════════════════════════════════════════════════

/**
 * Render compiled analysis results as a self-contained HTML document.
 *
 * @param {object} options
 * @param {object} options.compiled - The AI-compiled unified analysis
 * @param {object} options.meta - Call metadata
 * @returns {string} Complete HTML document
 */
function renderResultsHtml({ compiled, meta }) {
  const h = [];
  const ln = (...args) => h.push(args.join(''));

  if (!compiled) {
    return `<!DOCTYPE html><html><head><title>Call Analysis</title></head><body>
      <h1>Call Analysis</h1><p>No compiled result available.</p></body></html>`;
  }

  // ── Extract & deduplicate all data (same as markdown.js) ──
  const allTickets = dedupBy(compiled.tickets || [], t => t.ticket_id);
  const allCRs = dedupBy(compiled.change_requests || [], cr => cr.id);
  const allActions = dedupBy(compiled.action_items || [], ai => ai.id);
  const allBlockers = dedupBy(compiled.blockers || [], b => b.id);
  const allScope = dedupBy(compiled.scope_changes || [], sc => sc.id);
  const allFiles = dedupBy(compiled.file_references || [], f => f.resolved_path || f.file_name);
  const summary = compiled.summary || compiled.executive_summary || '';
  const yourTasks = compiled.your_tasks || null;

  // ── Discover & cluster participant names ──
  const rawNames = new Set();
  const addName = n => { if (n && n.trim()) rawNames.add(n.trim()); };
  allActions.forEach(ai => addName(ai.assigned_to));
  allCRs.forEach(cr => addName(cr.assigned_to));
  allBlockers.forEach(b => addName(b.owner));
  allScope.forEach(sc => addName(sc.decided_by));
  allTickets.forEach(t => { addName(t.assignee); addName(t.reviewer); });
  if (yourTasks?.user_name) addName(yourTasks.user_name);
  if (yourTasks) (yourTasks.tasks_waiting_on_others || []).forEach(w => addName(w.waiting_on));

  const clusterMap = clusterNames([...rawNames]);
  const teamKeywords = ['team', 'qa', 'dba', 'devops', 'db team', 'external'];
  const people = [...clusterMap.keys()]
    .filter(n => n && !teamKeywords.some(kw => n.toLowerCase() === kw))
    .sort();

  const nameMatch = (raw, canonical) => {
    if (!raw || !canonical) return false;
    return resolve(raw, clusterMap) === canonical;
  };

  const currentUserCanonical = meta.userName ? resolve(meta.userName, clusterMap) : null;
  const orderedPeople = [];
  if (currentUserCanonical && people.includes(currentUserCanonical)) orderedPeople.push(currentUserCanonical);
  for (const p of people) if (p !== currentUserCanonical) orderedPeople.push(p);

  // ══════════════════════════════════════════════════════
  //  HTML HEAD
  // ══════════════════════════════════════════════════════
  ln('<!DOCTYPE html>');
  ln('<html lang="en">');
  ln('<head>');
  ln('<meta charset="utf-8">');
  ln('<meta name="viewport" content="width=device-width, initial-scale=1">');
  ln(`<title>Call Analysis — ${e(meta.callName || 'Report')}</title>`);
  ln(`<style>${CSS}</style>`);
  ln('</head>');
  ln('<body>');
  ln('<button class="theme-toggle" title="Toggle theme">🌗</button>');

  // ══════════════════════════════════════════════════════
  //  HEADER
  // ══════════════════════════════════════════════════════
  ln(`<h1>📋 Call Analysis — ${e(meta.callName || 'Unknown')}</h1>`);
  ln('<dl class="meta-grid">');
  ln(`<dt>Date</dt><dd>${e(meta.processedAt ? meta.processedAt.slice(0, 10) : 'N/A')}</dd>`);
  ln(`<dt>Participants</dt><dd>${e(orderedPeople.join(', ') || 'Unknown')}</dd>`);
  ln(`<dt>Segments</dt><dd>${e(String(meta.segmentCount || 'N/A'))}</dd>`);
  ln(`<dt>Model</dt><dd>${e(meta.geminiModel || 'N/A')}</dd>`);

  const comp = meta.compilation;
  if (comp) {
    const tu = comp.tokenUsage || {};
    const durSec = comp.durationMs ? (comp.durationMs / 1000).toFixed(1) : '?';
    ln(`<dt>Compilation</dt><dd>${durSec}s | ${(tu.inputTokens || 0).toLocaleString()} in → ${(tu.outputTokens || 0).toLocaleString()} out tokens</dd>`);
  }

  const cost = meta.costSummary;
  if (cost && cost.totalTokens > 0) {
    ln(`<dt>Cost</dt><dd>$${cost.totalCost.toFixed(4)} (${cost.totalTokens.toLocaleString()} tokens)</dd>`);
  }
  ln('</dl>');

  // Confidence filter notice
  if (compiled._filterMeta && compiled._filterMeta.minConfidence !== 'LOW') {
    const fm = compiled._filterMeta;
    const levelLabel = fm.minConfidence === 'HIGH' ? 'HIGH' : 'MEDIUM and HIGH';
    ln('<div class="notice" style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px 14px;margin:12px 0;color:#664d03;">');
    ln(`⚠️ <strong>Confidence filter active:</strong> showing only ${e(levelLabel)} confidence items. `);
    ln(`Kept ${fm.filteredCounts.total}/${fm.originalCounts.total} items (${fm.removed} removed). Full unfiltered data in <code>results.json</code>.`);
    ln('</div>');
  }

  // File integrity warnings
  const intWarnings = meta.integrityWarnings;
  if (intWarnings && intWarnings.length > 0) {
    const bgColor = intWarnings.some(w => w.severity === 'error') ? '#fdd' : '#fff3cd';
    const borderColor = intWarnings.some(w => w.severity === 'error') ? '#dc3545' : '#ffc107';
    ln(`<div class="notice" style="background:${bgColor};border:1px solid ${borderColor};border-radius:6px;padding:10px 14px;margin:12px 0;">`);
    ln('<strong>⚠️ File Integrity Issues Detected</strong><br>');
    for (const w of intWarnings) {
      const icon = w.severity === 'error' ? '🔴' : w.severity === 'warning' ? '🟡' : 'ℹ️';
      ln(`${icon} <strong>${e(w.file)}</strong> (${e(w.type)}) — ${e(w.message)}<br>`);
      if (w.detail) ln(`<em style="margin-left:1.5em;color:#666;">${e(w.detail)}</em><br>`);
    }
    const hasErrors = intWarnings.some(w => w.severity === 'error');
    if (hasErrors) {
      ln('<br><strong>Some files may be broken.</strong> Results may be incomplete — re-download or replace broken files.');
    } else {
      ln('<br>Results may be affected — review flagged files for completeness.');
    }
    ln('</div>');
  }

  // Segment details grouped by video (collapsible)
  const segs = meta.segments || [];
  if (segs.length > 0) {
    // Group by video
    const videoGroups = [];
    const videoOrder = [];
    const videoMap = {};
    for (const s of segs) {
      const key = s.video || 'Unknown';
      if (!videoMap[key]) { videoMap[key] = []; videoOrder.push(key); }
      videoMap[key].push(s);
    }
    for (const v of videoOrder) videoGroups.push({ video: v, segs: videoMap[v] });
    const multiVideo = videoGroups.length > 1;

    ln('<details>');
    ln(`<summary>📼 Segment Details (${segs.length}${multiVideo ? ` from ${videoGroups.length} videos` : ''})</summary>`);

    let globalIdx = 0;
    for (const group of videoGroups) {
      if (multiVideo) ln(`<h4>🎬 ${e(group.video)} (${group.segs.length} segments)</h4>`);
      ln('<table><tr><th>#</th><th>File</th><th>Duration</th><th>Size</th></tr>');
      for (const s of group.segs) {
        globalIdx++;
        ln(`<tr><td>${globalIdx}</td><td>${e(s.file)}</td><td>${e(s.duration || '?')}</td><td>${e(s.sizeMB || '?')} MB</td></tr>`);
      }
      ln('</table>');
    }
    ln('</details>');
  }

  ln('<hr>');

  // ══════════════════════════════════════════════════════
  //  CONFIDENCE DISTRIBUTION
  // ══════════════════════════════════════════════════════
  const allConfItems = [...allTickets, ...allCRs, ...allActions, ...allBlockers, ...allScope];
  if (allConfItems.length > 0) {
    const confHigh = allConfItems.filter(i => i.confidence === 'HIGH').length;
    const confMed = allConfItems.filter(i => i.confidence === 'MEDIUM').length;
    const confLow = allConfItems.filter(i => i.confidence === 'LOW').length;
    const confTotal = allConfItems.length;

    if (confHigh + confMed + confLow > 0) {
      ln('<h3>📊 Confidence Distribution</h3>');
      ln('<div class="conf-bar">');
      if (confHigh > 0) ln(`<span class="high" style="width:${((confHigh / confTotal) * 100).toFixed(1)}%" title="HIGH: ${confHigh}"></span>`);
      if (confMed > 0) ln(`<span class="med" style="width:${((confMed / confTotal) * 100).toFixed(1)}%" title="MEDIUM: ${confMed}"></span>`);
      if (confLow > 0) ln(`<span class="low" style="width:${((confLow / confTotal) * 100).toFixed(1)}%" title="LOW: ${confLow}"></span>`);
      ln('</div>');
      ln('<table><tr><th>Level</th><th>Count</th><th>%</th></tr>');
      if (confHigh > 0) ln(`<tr><td>🟢 HIGH</td><td>${confHigh}</td><td>${((confHigh / confTotal) * 100).toFixed(0)}%</td></tr>`);
      if (confMed > 0) ln(`<tr><td>🟡 MEDIUM</td><td>${confMed}</td><td>${((confMed / confTotal) * 100).toFixed(0)}%</td></tr>`);
      if (confLow > 0) ln(`<tr><td>🔴 LOW</td><td>${confLow}</td><td>${((confLow / confTotal) * 100).toFixed(0)}%</td></tr>`);
      ln('</table>');
      if (confLow > 0) {
        ln('<blockquote>⚠️ <strong>LOW confidence items</strong> need human verification before acting on them.</blockquote>');
      }
    }
  }

  // ══════════════════════════════════════════════════════
  //  EXECUTIVE SUMMARY
  // ══════════════════════════════════════════════════════
  ln('<h2>📝 Executive Summary</h2>');
  if (summary) ln(`<p>${e(summary)}</p>`);

  // ── Completed in call ──
  const completedInCall = yourTasks?.completed_in_call || [];
  if (completedInCall.length > 0) {
    ln('<h3>✅ Resolved During This Call</h3><ul>');
    for (const item of completedInCall) ln(`<li>✅ ${e(item)}</li>`);
    ln('</ul>');
  }

  ln('<hr>');

  // ══════════════════════════════════════════════════════
  //  YOUR TASKS (current user)
  // ══════════════════════════════════════════════════════
  if (currentUserCanonical && yourTasks) {
    ln(`<h2>⭐ Your Tasks — ${e(currentUserCanonical)}</h2>`);
    ln('<div class="person-section star">');

    if (yourTasks.summary) ln(`<blockquote>${e(yourTasks.summary)}</blockquote>`);

    // Owned tickets
    const myTickets = dedupBy(
      allTickets.filter(t => nameMatch(t.assignee, currentUserCanonical)),
      t => t.ticket_id
    );
    if (myTickets.length > 0) {
      ln(`<p><strong>🎫 Your Tickets:</strong> ${myTickets.map(t => `${e(t.ticket_id)} (${e((t.status || '?').replace(/_/g, ' '))})`).join(' · ')}</p>`);
    }

    // Todo items
    const todoItems = dedupByDesc(yourTasks.tasks_todo || []);
    const myActions = allActions.filter(ai =>
      nameMatch(ai.assigned_to, currentUserCanonical) &&
      (ai.status === 'todo' || ai.status === 'in_progress')
    );
    const allTodos = [...todoItems];
    const todoDescKeys = new Set(allTodos.map(t => normalizeDesc(t.description)));
    for (const ai of myActions) {
      const dk = normalizeDesc(ai.description);
      if (!todoDescKeys.has(dk)) { allTodos.push(ai); todoDescKeys.add(dk); }
    }
    if (allTodos.length > 0) {
      ln('<h3>📌 To Do</h3><ul>');
      for (const item of allTodos) {
        const pri = priBadgeHtml(item.priority);
        const conf = confBadgeHtml(item.confidence);
        const source = item.source ? ` <em>(${e(item.source)})</em>` : '';
        const ts = item.referenced_at ? ` @ ${tsHtml(item.referenced_at, item.source_segment, item.source_video)}` : '';
        const blocker = item.blocked_by ? `<br>&nbsp;&nbsp;⛔ <strong>Blocked by</strong>: ${e(item.blocked_by)}` : '';
        ln(`<li><input type="checkbox" class="checkbox" disabled> ${e(item.description)}${pri}${conf}${source}${ts}${blocker}</li>`);
      }
      ln('</ul>');
    }

    // CRs assigned to user
    const myCRs = dedupBy(
      allCRs.filter(cr => nameMatch(cr.assigned_to, currentUserCanonical) && cr.status !== 'completed'),
      cr => cr.id
    );
    if (myCRs.length > 0) {
      ln('<h3>🔧 Your Change Requests</h3><ul>');
      for (const cr of myCRs) {
        const status = cr.status ? ` <code>${e(cr.status)}</code>` : '';
        const pri = priBadgeHtml(cr.priority);
        const where = cr.where?.file_path ? ` → <code>${e(cr.where.file_path)}</code>` : '';
        const ts = cr.referenced_at ? ` @ ${tsHtml(cr.referenced_at, cr.source_segment, cr.source_video)}` : '';
        ln(`<li><strong>${e(cr.id)}</strong>: ${e(cr.title || cr.what)}${status}${pri}${where}${ts}`);
        if (cr.what && cr.what !== cr.title) ln(`<br>&nbsp;&nbsp;What: ${e(cr.what)}`);
        if (cr.how) ln(`<br>&nbsp;&nbsp;How: ${e(cr.how)}`);
        if (cr.why) ln(`<br>&nbsp;&nbsp;Why: ${e(cr.why)}`);
        ln('</li>');
      }
      ln('</ul>');
    }

    // Waiting on others
    const waitingItems = dedupByDesc(yourTasks.tasks_waiting_on_others || []);
    if (waitingItems.length > 0) {
      ln('<h3>⏳ Waiting On Others</h3><ul>');
      for (const w of waitingItems) {
        const resolvedWho = w.waiting_on ? resolve(w.waiting_on, clusterMap) : 'someone';
        const ts = w.referenced_at ? ` @ ${tsHtml(w.referenced_at, w.source_segment, w.source_video)}` : '';
        ln(`<li>⏳ ${e(w.description)} → waiting on <strong>${e(resolvedWho)}</strong>${ts}</li>`);
      }
      ln('</ul>');
    }

    // Decisions needed
    const decisionItems = dedupByDesc(yourTasks.decisions_needed || []);
    if (decisionItems.length > 0) {
      ln('<h3>❓ Decisions Needed</h3><ul>');
      for (const d of decisionItems) {
        const resolvedWho = d.from_whom ? resolve(d.from_whom, clusterMap) : 'someone';
        const ts = d.referenced_at ? ` @ ${tsHtml(d.referenced_at, d.source_segment, d.source_video)}` : '';
        ln(`<li>${e(d.description)} → from <strong>${e(resolvedWho)}</strong>${ts}</li>`);
      }
      ln('</ul>');
    }

    // User's blockers
    const myBlockers = dedupBy(
      allBlockers.filter(b => nameMatch(b.owner, currentUserCanonical)),
      b => b.id
    );
    if (myBlockers.length > 0) {
      ln('<h3>🚫 Your Blockers</h3><ul>');
      for (const b of myBlockers) {
        const env = (b.environments || []).length > 0 ? ` [${b.environments.join(', ')}]` : '';
        const status = b.status ? ` (${e(b.status)})` : '';
        const bConf = confBadgeHtml(b.confidence);
        const ts = b.referenced_at ? ` @ ${tsHtml(b.referenced_at, b.source_segment, b.source_video)}` : '';
        ln(`<li><strong>${e(b.id)}</strong>: ${e(b.description)}${e(env)}${status}${bConf}${ts}</li>`);
      }
      ln('</ul>');
    }

    ln('</div>');
    ln('<hr>');
  }

  // ══════════════════════════════════════════════════════
  //  DETAILED TICKET ANALYSIS
  // ══════════════════════════════════════════════════════
  if (allTickets.length > 0) {
    ln('<h2>🎫 Detailed Ticket Analysis</h2>');
    for (const t of allTickets) {
      const assignee = t.assignee ? resolve(t.assignee, clusterMap) : 'Unassigned';
      const reviewer = t.reviewer ? resolve(t.reviewer, clusterMap) : null;
      const status = (t.status || 'unknown').replace(/_/g, ' ');
      const tConf = confBadgeHtml(t.confidence);

      ln('<div class="card">');
      ln(`<h3>${e(t.ticket_id || t.id || 'Unknown')} — ${e(t.title || 'Untitled')}${tConf}</h3>`);
      ln(`<blockquote><strong>Status</strong>: ${e(status)} | <strong>Assignee</strong>: ${e(assignee)}${reviewer ? ` | <strong>Reviewer</strong>: ${e(reviewer)}` : ''}</blockquote>`);

      // Documented state
      const ds = t.documented_state;
      if (ds) {
        ln('<h4>📄 Documented State</h4><ul>');
        if (ds.source) ln(`<li><strong>Source</strong>: <code>${e(ds.source)}</code></li>`);
        if (ds.plan_status) ln(`<li><strong>Plan Status</strong>: ${e(ds.plan_status)}</li>`);
        if (ds.checklist_progress) ln(`<li><strong>Checklist</strong>: ${e(typeof ds.checklist_progress === 'object' ? JSON.stringify(ds.checklist_progress) : ds.checklist_progress)}</li>`);
        if (ds.sub_tickets && ds.sub_tickets.length > 0) {
          ln('<li><strong>Sub-tickets</strong>:<ul>');
          for (const st of ds.sub_tickets) ln(`<li><strong>${e(st.id)}</strong> ${e(st.title)} — ${e(st.documented_status || '?')}</li>`);
          ln('</ul></li>');
        }
        if (ds.open_blockers && ds.open_blockers.length > 0) {
          ln('<li><strong>Documented Blockers</strong>:<ul>');
          for (const ob of ds.open_blockers) ln(`<li>⚠️ ${e(ob)}</li>`);
          ln('</ul></li>');
        }
        ln('</ul>');
      }

      // Discussed state
      const disc = t.discussed_state;
      if (disc) {
        ln('<h4>💬 Discussed in Call</h4>');
        if (disc.summary) ln(`<p>${e(disc.summary)}</p>`);
        if (disc.discrepancies && disc.discrepancies.length > 0) {
          ln('<p><strong>⚡ Discrepancies (docs vs. call)</strong>:</p><ul>');
          for (const d of disc.discrepancies) ln(`<li>⚡ ${e(d)}</li>`);
          ln('</ul>');
        }
      }

      // Video segments
      const vs = t.video_segments || [];
      if (vs.length > 0) {
        ln('<h4>🎬 Video Segments</h4><ul>');
        for (const seg of vs) {
          const start = seg.start_time || '?';
          const end = seg.end_time || '?';
          const segLabel = seg.source_segment ? ` <small>(${seg.source_video ? shortVideoHtml(seg.source_video) + ' \u00b7 ' : ''}Seg ${seg.source_segment})</small>` : '';
          ln(`<li><code>${e(start)}</code> → <code>${e(end)}</code>${segLabel}: ${e(seg.description)}</li>`);
        }
        ln('</ul>');
      }

      // Key quotes
      const comments = t.comments || [];
      if (comments.length > 0) {
        ln('<h4>🗣️ Key Quotes</h4><ul>');
        for (const cmt of comments) {
          const speaker = cmt.speaker ? resolve(cmt.speaker, clusterMap) : 'Unknown';
          const ts = cmt.timestamp ? `<code>${e(cmt.timestamp)}</code> ` : '';
          const segLabel = cmt.source_segment ? `<small>(${cmt.source_video ? shortVideoHtml(cmt.source_video) + ' · ' : ''}Seg ${cmt.source_segment})</small> ` : '';
          ln(`<li>${ts}${segLabel}<strong>${e(speaker)}</strong>: "${e(cmt.text)}"</li>`);
        }
        ln('</ul>');
      }

      // Code changes
      const codeChanges = t.code_changes || [];
      if (codeChanges.length > 0) {
        ln('<h4>💻 Code Changes</h4><ul>');
        for (const cc of codeChanges) {
          const type = cc.type ? `[${e(cc.type)}] ` : '';
          const pri = priBadgeHtml(cc.priority);
          const ts = cc.referenced_at ? ` @ ${tsHtml(cc.referenced_at, cc.source_segment, cc.source_video)}` : '';
          ln(`<li>${type}<code>${e(cc.file_path || '?')}</code>${pri}${ts}<br>${e(cc.description)}</li>`);
        }
        ln('</ul>');
      }

      // Related CRs for this ticket
      const ticketCRs = allCRs.filter(cr => (cr.related_tickets || []).includes(t.ticket_id));
      if (ticketCRs.length > 0) {
        ln(`<h4>🔗 Change Requests for ${e(t.ticket_id)}</h4><ul>`);
        for (const cr of ticketCRs) {
          const status = cr.status ? ` <code>${e(cr.status)}</code>` : '';
          const assignee = cr.assigned_to ? resolve(cr.assigned_to, clusterMap) : '?';
          const pri = priBadgeHtml(cr.priority);
          const ts = cr.referenced_at ? ` @ ${tsHtml(cr.referenced_at, cr.source_segment, cr.source_video)}` : '';
          ln(`<li><strong>${e(cr.id)}</strong>: ${e(cr.title || cr.what)}${status}${pri} → ${e(assignee)}${ts}`);
          if (cr.what && cr.what !== cr.title) ln(`<br><em>What:</em> ${e(cr.what)}`);
          if (cr.how) ln(`<br><em>How:</em> ${e(cr.how)}`);
          if (cr.why) ln(`<br><em>Why:</em> ${e(cr.why)}`);
          if (cr.where?.file_path) ln(`<br><em>File:</em> <code>${e(cr.where.file_path)}</code>`);
          ln('</li>');
        }
        ln('</ul>');
      }

      // Related blockers for this ticket
      const ticketBlockers = allBlockers.filter(b => (b.blocks || []).includes(t.ticket_id));
      if (ticketBlockers.length > 0) {
        ln(`<h4>🚫 Blockers for ${e(t.ticket_id)}</h4><ul>`);
        for (const b of ticketBlockers) {
          const env = (b.environments || []).length > 0 ? ` [${b.environments.join(', ')}]` : '';
          const status = b.status ? ` (${e(b.status)})` : '';
          const owner = b.owner ? ` → ${e(resolve(b.owner, clusterMap))}` : '';
          const ts = b.referenced_at ? ` @ ${tsHtml(b.referenced_at, b.source_segment, b.source_video)}` : '';
          ln(`<li><strong>${e(b.id)}</strong>${owner}: ${e(b.description)}${e(env)}${status}${ts}</li>`);
        }
        ln('</ul>');
      }

      ln('</div>');
    }
  }

  // ══════════════════════════════════════════════════════
  //  ALL ACTION ITEMS
  // ══════════════════════════════════════════════════════
  if (allActions.length > 0) {
    ln('<h2>📋 All Action Items</h2>');
    ln('<table><tr><th>ID</th><th>Description</th><th>Assigned To</th><th>Status</th><th>Priority</th><th>Conf</th><th>Ref</th><th>Timestamp</th></tr>');
    for (const ai of allActions) {
      const assignee = (ai.assigned_to || ai.assignee) ? resolve(ai.assigned_to || ai.assignee, clusterMap) : '-';
      const status = (ai.status || '?').replace(/_/g, ' ');
      const pri = priBadgeHtml(ai.priority);
      const conf = confBadgeHtml(ai.confidence);
      const ref = [...(ai.related_tickets || []), ...(ai.related_changes || [])].join(', ') || '-';
      const ts = ai.referenced_at ? tsHtml(ai.referenced_at, ai.source_segment, ai.source_video) : '-';
      ln(`<tr><td>${e(ai.id)}</td><td>${e(ai.description)}</td><td>${e(assignee)}</td><td>${e(status)}</td><td>${pri || '-'}</td><td>${conf || '-'}</td><td>${e(ref)}</td><td>${ts}</td></tr>`);
    }
    ln('</table>');
  }

  // ══════════════════════════════════════════════════════
  //  OTHER PARTICIPANTS
  // ══════════════════════════════════════════════════════
  const otherPeople = orderedPeople.filter(p => p !== currentUserCanonical);
  if (otherPeople.length > 0) {
    ln('<h2>👥 Other Participants</h2>');
    for (const person of otherPeople) {
      const personActions = allActions.filter(ai => nameMatch(ai.assigned_to, person));
      const personCRs = dedupBy(allCRs.filter(cr => nameMatch(cr.assigned_to, person) && cr.status !== 'completed'), cr => cr.id);
      const personBlockersOwned = dedupBy(allBlockers.filter(b => nameMatch(b.owner, person)), b => b.id);
      const personTickets = dedupBy(allTickets.filter(t => nameMatch(t.assignee, person)), t => t.ticket_id);

      const hasContent = personActions.length > 0 || personCRs.length > 0 || personBlockersOwned.length > 0 || personTickets.length > 0;
      if (!hasContent) continue;

      ln(`<div class="person-section"><h3>${e(person)}</h3>`);

      if (personTickets.length > 0) {
        ln(`<p><strong>🎫 Tickets:</strong> ${personTickets.map(t => `${e(t.ticket_id)} (${e((t.status || '?').replace(/_/g, ' '))})`).join(' · ')}</p>`);
      }

      const actionableTodos = dedupByDesc(personActions.filter(ai => ai.status === 'todo' || ai.status === 'in_progress'));
      if (actionableTodos.length > 0) {
        ln('<strong>📌 To Do</strong><ul>');
        for (const item of actionableTodos) {
          const pri = priBadgeHtml(item.priority);
          const ref = (item.related_tickets || []).length > 0 ? ` <em>(${item.related_tickets.join(', ')})</em>` : '';
          const ts = item.referenced_at ? ` @ ${tsHtml(item.referenced_at, item.source_segment, item.source_video)}` : '';
          ln(`<li><input type="checkbox" class="checkbox" disabled> ${e(item.description)}${pri}${ref}${ts}</li>`);
        }
        ln('</ul>');
      }

      if (personCRs.length > 0) {
        ln('<strong>🔧 Change Requests</strong><ul>');
        for (const cr of personCRs) {
          const status = cr.status ? ` <code>${e(cr.status)}</code>` : '';
          const pri = priBadgeHtml(cr.priority);
          const ts = cr.referenced_at ? ` @ ${tsHtml(cr.referenced_at, cr.source_segment, cr.source_video)}` : '';
          ln(`<li><strong>${e(cr.id)}</strong>: ${e(cr.title || cr.what)}${status}${pri}${ts}</li>`);
        }
        ln('</ul>');
      }

      if (personBlockersOwned.length > 0) {
        ln('<strong>🚫 Blockers</strong><ul>');
        for (const b of personBlockersOwned) {
          const env = (b.environments || []).length > 0 ? ` [${b.environments.join(', ')}]` : '';
          const status = b.status ? ` (${e(b.status)})` : '';
          const ts = b.referenced_at ? ` @ ${tsHtml(b.referenced_at, b.source_segment, b.source_video)}` : '';
          ln(`<li><strong>${e(b.id)}</strong>: ${e(b.description)}${e(env)}${status}${ts}</li>`);
        }
        ln('</ul>');
      }

      ln('</div>');
    }
  }

  // ══════════════════════════════════════════════════════
  //  TEAM / EXTERNAL BLOCKERS
  // ══════════════════════════════════════════════════════
  const teamBlockers = dedupBy(allBlockers.filter(b => !orderedPeople.some(p => nameMatch(b.owner, p))), b => b.id);
  if (teamBlockers.length > 0) {
    ln('<h2>🚫 Team / External Blockers</h2><ul>');
    for (const b of teamBlockers) {
      const env = (b.environments || []).length > 0 ? ` [${b.environments.join(', ')}]` : '';
      const status = b.status ? ` (${e(b.status)})` : '';
      const type = b.type ? ` <em>[${e(b.type.replace(/_/g, ' '))}]</em>` : '';
      const owner = b.owner ? ` — ${e(b.owner)}` : '';
      const ts = b.referenced_at ? ` @ ${tsHtml(b.referenced_at, b.source_segment, b.source_video)}` : '';
      ln(`<li><strong>${e(b.id)}</strong>${owner}: ${e(b.description)}${e(env)}${status}${type}${ts}</li>`);
    }
    ln('</ul><hr>');
  }

  // ══════════════════════════════════════════════════════
  //  SCOPE CHANGES
  // ══════════════════════════════════════════════════════
  if (allScope.length > 0) {
    ln('<h2>🔀 Scope Changes</h2><ul>');
    for (const sc of allScope) {
      const icon = { added: '➕', removed: '➖', deferred: '⏸️', approach_changed: '🔄', ownership_changed: '👤', requirements_changed: '📋' }[sc.type] || '🔀';
      const decidedBy = sc.decided_by ? resolve(sc.decided_by, clusterMap) : null;
      const scConf = confBadgeHtml(sc.confidence);
      const ts = sc.referenced_at ? ` @ ${tsHtml(sc.referenced_at, sc.source_segment, sc.source_video)}` : '';
      const scDesc = sc.new_scope || sc.title || sc.what || sc.description || 'No description';
      ln(`<li>${icon} <strong>${e(sc.id)}</strong> (${e((sc.type || '').replace(/_/g, ' '))}): ${e(scDesc)}${scConf}${ts}`);
      if (sc.original_scope && sc.original_scope !== 'not documented') ln(`<br>&nbsp;&nbsp;Was: ${e(sc.original_scope)}`);
      if (sc.reason) ln(`<br>&nbsp;&nbsp;Reason: ${e(sc.reason)}`);
      if (decidedBy) ln(`<br>&nbsp;&nbsp;Decided by: ${e(decidedBy)}`);
      ln('</li>');
    }
    ln('</ul><hr>');
  }

  // ══════════════════════════════════════════════════════
  //  ALL CHANGE REQUESTS
  // ══════════════════════════════════════════════════════
  if (allCRs.length > 0) {
    ln('<h2>🔧 All Change Requests</h2>');
    ln('<table><tr><th>ID</th><th>Title</th><th>Type</th><th>Status</th><th>Priority</th><th>Conf</th><th>Assignee</th><th>File</th><th>Timestamp</th></tr>');
    for (const cr of allCRs) {
      const assignee = cr.assigned_to ? resolve(cr.assigned_to, clusterMap) : '-';
      const status = cr.status || '-';
      const conf = confBadgeHtml(cr.confidence);
      const type = cr.type || '-';
      const file = cr.where?.file_path ? `<code>${e(cr.where.file_path)}</code>` : '-';
      const pri = priBadgeHtml(cr.priority);
      const ts = cr.referenced_at ? tsHtml(cr.referenced_at, cr.source_segment, cr.source_video) : '-';
      ln(`<tr><td>${e(cr.id)}</td><td>${e(cr.title || cr.what || '-')}</td><td>${e(type)}</td><td>${e(status)}</td><td>${pri || '-'}</td><td>${conf || '-'}</td><td>${e(assignee)}</td><td>${file}</td><td>${ts}</td></tr>`);
    }
    ln('</table>');

    // Detailed breakdown
    ln('<details><summary>📖 Change Request Details</summary>');
    for (const cr of allCRs) {
      const assignee = cr.assigned_to ? resolve(cr.assigned_to, clusterMap) : '?';
      const status = cr.status ? ` <code>${e(cr.status)}</code>` : '';
      const crTs = cr.referenced_at ? ` @ ${tsHtml(cr.referenced_at, cr.source_segment, cr.source_video)}` : '';
      ln(`<div class="card"><strong>${e(cr.id)}</strong>: ${e(cr.title || cr.what)}${status} → ${e(assignee)}${crTs}`);
      if (cr.what && cr.what !== cr.title) ln(`<br>What: ${e(cr.what)}`);
      if (cr.how) ln(`<br>How: ${e(cr.how)}`);
      if (cr.why) ln(`<br>Why: ${e(cr.why)}`);
      if (cr.where?.file_path) ln(`<br>File: <code>${e(cr.where.file_path)}</code>`);
      ln('</div>');
    }
    ln('</details><hr>');
  }

  // ══════════════════════════════════════════════════════
  //  FILE REFERENCES
  // ══════════════════════════════════════════════════════
  if (allFiles.length > 0) {
    const actionableFiles = allFiles.filter(f => f.role && !['reference_only', 'source_of_truth'].includes(f.role));
    const referenceFiles = allFiles.filter(f => !f.role || ['reference_only', 'source_of_truth'].includes(f.role));

    if (actionableFiles.length > 0) {
      ln('<h2>📂 Files Requiring Action</h2>');
      ln('<table><tr><th>File</th><th>Role</th><th>Type</th><th>Tickets</th><th>Changes</th></tr>');
      for (const f of actionableFiles) {
        const role = (f.role || '').replace(/_/g, ' ');
        const type = (f.file_type || '').replace(/_/g, ' ');
        const tickets = (f.mentioned_in_tickets || []).join(', ') || '-';
        const changes = (f.mentioned_in_changes || []).join(', ') || '-';
        ln(`<tr><td>${e(f.file_name)}</td><td>${e(role)}</td><td>${e(type)}</td><td>${e(tickets)}</td><td>${e(changes)}</td></tr>`);
      }
      ln('</table>');
    }

    if (referenceFiles.length > 0) {
      ln(`<details><summary>📎 Reference Files (${referenceFiles.length})</summary>`);
      ln('<table><tr><th>File</th><th>Type</th><th>Tickets</th><th>Notes</th></tr>');
      for (const f of referenceFiles) {
        const type = (f.file_type || '').replace(/_/g, ' ');
        const tickets = (f.mentioned_in_tickets || []).join(', ') || '-';
        const notes = f.notes ? e(f.notes.slice(0, 80)) + (f.notes.length > 80 ? '...' : '') : '-';
        ln(`<tr><td>${e(f.file_name)}</td><td>${e(type)}</td><td>${e(tickets)}</td><td>${notes}</td></tr>`);
      }
      ln('</table></details>');
    }
  }

  // ── Footer ──
  const genTs = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const stats = [
    `${allTickets.length} tickets`,
    `${allCRs.length} CRs`,
    `${allActions.length} actions`,
    `${allBlockers.length} blockers`,
    `${allScope.length} scope changes`,
    `${allFiles.length} files`,
  ].join(' · ');
  ln(`<div class="footer">Generated ${genTs} — AI-compiled final result | ${stats}</div>`);

  ln(`<script>${JS_SCRIPT}</script>`);
  ln('</body></html>');

  return h.join('\n');
}

module.exports = { renderResultsHtml };
