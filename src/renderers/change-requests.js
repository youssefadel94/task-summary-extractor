/**
 * Change-request handoff — the file you send to the other team.
 *
 * `results.md` is a report about a call: it is long, it is written for whoever
 * attended, and the change requests are one section a third of the way down.
 * The team that has to *implement* those changes was not on the call and does
 * not want the rest of it. So the CRs also render standalone here: every CR
 * exactly once, most urgent first, each one carrying what to change, where, how
 * and why, plus the ticket links and the point in the recording it came from so
 * anything ambiguous can be checked at the source.
 *
 * Two artifacts, same data:
 *   - change-requests.md  — readable handoff, grouped by priority
 *   - change-requests.csv — same rows for importing into a tracker
 */

'use strict';

const { packChangeRequests, priorityCounts } = require('../utils/cr-pack');
const { resolve, clusterNames, shortVideo } = require('./shared');

/** Escape a value for a Markdown table cell. */
const esc = s => (s == null ? '' : String(s).replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '\\|'));

/** Priority buckets, in the order the other team should work through them. */
const BUCKETS = [
  { key: 'critical', heading: '🔴 Critical', note: 'Blocking or breaking — start here.' },
  { key: 'high', heading: '🟠 High', note: 'Needed this cycle.' },
  { key: 'medium', heading: '🟡 Medium', note: 'Planned work.' },
  { key: 'low', heading: '🟢 Low', note: 'Nice to have.' },
  { key: 'unset', heading: '⚪ Unprioritized', note: 'No priority was stated on the call — needs triage.' },
];

/** Quote a CSV field. */
function csvCell(v) {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ').trim();
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render the change requests as a CSV importable into a tracker.
 *
 * @param {object[]} crs - Already packed (deduped + sorted)
 * @param {object} [meta]
 * @returns {string}
 */
function renderChangeRequestsCsv(crs, meta = {}) {
  const header = [
    'id', 'priority', 'status', 'type', 'title', 'what', 'how', 'why',
    'file_path', 'module', 'component', 'assigned_to', 'related_tickets',
    'dependencies', 'blocked_by', 'confidence', 'referenced_at', 'source', 'merged_ids', 'call',
  ];
  const rows = [header.join(',')];

  for (const cr of crs) {
    rows.push([
      cr.id,
      cr.priority,
      cr.status,
      cr.type,
      cr.title || cr.what,
      cr.what,
      cr.how,
      cr.why,
      cr.where?.file_path,
      cr.where?.module,
      cr.where?.component,
      cr.assigned_to,
      (cr.related_tickets || []).join('; '),
      (cr.dependencies || []).join('; '),
      cr.blocked_by,
      cr.confidence,
      cr.referenced_at,
      (cr.sources || []).join('; '),
      (cr.merged_ids || []).join('; '),
      meta.callName,
    ].map(csvCell).join(','));
  }

  return rows.join('\n') + '\n';
}

/**
 * Render the standalone change-request handoff document.
 *
 * @param {object} o
 * @param {object} o.compiled - Compiled analysis
 * @param {object} [o.meta] - Call metadata (callName, processedAt, geminiModel…)
 * @returns {{ markdown: string, csv: string, changeRequests: object[], counts: object }}
 */
function renderChangeRequestHandoff({ compiled, meta = {} }) {
  const crs = packChangeRequests(compiled?.change_requests || []);
  const counts = priorityCounts(crs);

  // Resolve assignee spellings the same way the main report does, so "Y. Adel"
  // and "Youssef Adel" are not handed over as two different people.
  const rawNames = new Set();
  for (const cr of crs) if (cr.assigned_to) rawNames.add(cr.assigned_to);
  for (const t of (compiled?.tickets || [])) { if (t.assignee) rawNames.add(t.assignee); if (t.reviewer) rawNames.add(t.reviewer); }
  for (const a of (compiled?.action_items || [])) if (a.assigned_to) rawNames.add(a.assigned_to);
  const clusterMap = clusterNames([...rawNames]);
  const who = n => (n ? resolve(n, clusterMap) : null);

  const lines = [];
  const ln = (...a) => lines.push(a.join(''));

  ln(`# 🔧 Change Requests — ${meta.callName || 'Unknown'}`);
  ln('');
  ln(`> **Source**: ${meta.callName || 'call analysis'}${meta.processedAt ? ` · ${meta.processedAt.slice(0, 10)}` : ''}  `);
  if (meta.segmentCount) ln(`> **Segments covered**: ${meta.segmentCount}  `);
  ln(`> **Change requests**: ${crs.length} (deduplicated — each change appears once)  `);
  ln(`> **Priority**: ${counts.critical} critical · ${counts.high} high · ${counts.medium} medium · ${counts.low} low${counts.unset ? ` · ${counts.unset} unprioritized` : ''}  `);
  ln('');

  if (crs.length === 0) {
    ln('_No change requests were raised in this call._');
    ln('');
    return { markdown: lines.join('\n'), csv: renderChangeRequestsCsv(crs, meta), changeRequests: crs, counts };
  }

  ln('This document is self-contained: everything needed to action these changes is below. Items are ordered by priority — work down the list.');
  ln('');
  ln('---');
  ln('');

  // ── Index ──
  ln('## 📇 Index');
  ln('');
  ln('| # | ID | Priority | Status | Type | Change | Where | Owner |');
  ln('| --- | --- | --- | --- | --- | --- | --- | --- |');
  crs.forEach((cr, i) => {
    const place = cr.where?.file_path
      ? `\`${cr.where.file_path}\``
      : (cr.where?.component || cr.where?.module || '—');
    ln(`| ${i + 1} | \`${esc(cr.id)}\` | ${cr.priority || '—'} | ${cr.status || '—'} | ${cr.type || '—'} | ${esc(cr.title || cr.what)} | ${esc(place)} | ${esc(who(cr.assigned_to) || 'unassigned')} |`);
  });
  ln('');
  ln('---');
  ln('');

  // ── Detail, grouped by priority ──
  for (const bucket of BUCKETS) {
    const inBucket = crs.filter(cr =>
      bucket.key === 'unset' ? !cr.priority : cr.priority === bucket.key
    );
    if (inBucket.length === 0) continue;

    ln(`## ${bucket.heading} (${inBucket.length})`);
    ln('');
    ln(`_${bucket.note}_`);
    ln('');

    for (const cr of inBucket) {
      ln(`### \`${cr.id}\` — ${cr.title || cr.what}`);
      ln('');

      const facts = [];
      if (cr.type) facts.push(`**Type**: ${cr.type.replace(/_/g, ' ')}`);
      if (cr.status) facts.push(`**Status**: ${cr.status.replace(/_/g, ' ')}`);
      if (cr.priority) facts.push(`**Priority**: ${cr.priority}`);
      const owner = who(cr.assigned_to);
      facts.push(`**Owner**: ${owner || '⚠️ unassigned'}`);
      if (cr.confidence) facts.push(`**Confidence**: ${cr.confidence}`);
      ln(facts.join(' · '));
      ln('');

      if (cr.what) { ln(`**What** — ${cr.what}`); ln(''); }
      if (cr.how) { ln(`**How** — ${cr.how}`); ln(''); }
      if (cr.why) { ln(`**Why** — ${cr.why}`); ln(''); }

      const where = [];
      if (cr.where?.file_path) where.push(`\`${cr.where.file_path}\``);
      if (cr.where?.module) where.push(`module: ${cr.where.module}`);
      if (cr.where?.component) where.push(`component: ${cr.where.component}`);
      if (cr.code_map_match) where.push(`code map: \`${cr.code_map_match}\``);
      if (where.length) { ln(`**Where** — ${where.join(' · ')}`); ln(''); }

      if ((cr.related_tickets || []).length) { ln(`**Related tickets** — ${cr.related_tickets.join(', ')}`); ln(''); }
      if ((cr.dependencies || []).length) { ln(`**Depends on** — ${cr.dependencies.join(', ')}`); ln(''); }
      if (cr.blocked_by) { ln(`⛔ **Blocked by** — ${cr.blocked_by}`); ln(''); }

      // Plain text, not italics: fmtTs already emits its own emphasis, and
      // wrapping it again produced broken `_raised at \`ts\` _(Seg 1)_ ·` markup.
      const trace = [];
      if (cr.referenced_at) {
        const where = [cr.source_video ? shortVideo(cr.source_video) : null, cr.source_segment ? `Seg ${cr.source_segment}` : null]
          .filter(Boolean).join(' · ');
        trace.push(`raised at \`${cr.referenced_at}\`${where ? ` (${where})` : ''}`);
      } else if ((cr.sources || []).length) {
        trace.push(`from ${(cr.sources || []).join(', ')}`);
      }
      if ((cr.merged_ids || []).length) trace.push(`merged duplicates: ${cr.merged_ids.join(', ')}`);
      if (cr.confidence_reason) trace.push(cr.confidence_reason);
      if (trace.length) { ln(`> ${trace.join(' · ')}`); ln(''); }
    }

    ln('---');
    ln('');
  }

  // ── Things the other team cannot start on yet ──
  const needsDecision = crs.filter(cr => cr.status === 'pending_decision');
  const blocked = crs.filter(cr => cr.status === 'blocked' || cr.blocked_by);
  const unassigned = crs.filter(cr => !cr.assigned_to);

  if (needsDecision.length || blocked.length || unassigned.length) {
    ln('## ⚠️ Before You Start');
    ln('');
    if (needsDecision.length) {
      ln(`**Awaiting a decision (${needsDecision.length})** — do not implement until confirmed:`);
      for (const cr of needsDecision) ln(`- \`${cr.id}\` — ${cr.title || cr.what}`);
      ln('');
    }
    if (blocked.length) {
      ln(`**Blocked (${blocked.length})**:`);
      for (const cr of blocked) ln(`- \`${cr.id}\` — ${cr.title || cr.what}${cr.blocked_by ? ` (blocked by ${cr.blocked_by})` : ''}`);
      ln('');
    }
    if (unassigned.length) {
      ln(`**No owner assigned (${unassigned.length})** — needs an owner before it can be scheduled:`);
      for (const cr of unassigned) ln(`- \`${cr.id}\` — ${cr.title || cr.what}`);
      ln('');
    }
    ln('---');
    ln('');
  }

  const genTs = new Date().toISOString().slice(0, 19).replace('T', ' ');
  ln(`_Generated ${genTs} from ${meta.callName || 'call analysis'}${meta.geminiModel ? ` · ${meta.geminiModel}` : ''} — ${crs.length} change requests, deduplicated and priority-sorted._`);
  ln('');

  return {
    markdown: lines.join('\n'),
    csv: renderChangeRequestsCsv(crs, meta),
    changeRequests: crs,
    counts,
  };
}

module.exports = { renderChangeRequestHandoff, renderChangeRequestsCsv, BUCKETS };
