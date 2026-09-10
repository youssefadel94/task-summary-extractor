/**
 * Coverage audit — proof that nothing extracted was lost on the way out.
 *
 * A run passes through four narrowings, each of which can silently drop work:
 *
 *   segments → compilation (the model merges and quietly discards)
 *           → backfill      (recovers what compilation dropped)
 *           → confidence filter (drops LOW items when asked to)
 *           → renderers     (only print what their sections happen to cover)
 *
 * Backfill already repairs the biggest of those. What was missing is any way to
 * *see* it: a run reports "12 tickets" and nobody can tell whether the call had
 * 12 or 19. This audits every stage end to end and writes the result next to the
 * report, so a dropped item is a line in a file rather than something a person
 * discovers a sprint later.
 *
 * The audit never modifies the analysis — it only observes and reports.
 */

'use strict';

const { RECONCILED_FIELDS, wordSet, isNearDuplicate } = require('./compilation-backfill');
const { normalizeChangeRequests } = require('./cr-pack');
const { c } = require('./colors');

/** Collections audited, with the display name and the owner field to check. */
const COLLECTIONS = [
  { field: 'tickets', label: 'Tickets', idField: 'ticket_id', ownerField: 'assignee' },
  { field: 'change_requests', label: 'Change requests', idField: 'id', ownerField: 'assigned_to' },
  { field: 'action_items', label: 'Action items', idField: 'id', ownerField: 'assigned_to' },
  { field: 'blockers', label: 'Blockers', idField: 'id', ownerField: 'owner' },
  { field: 'scope_changes', label: 'Scope changes', idField: 'id', ownerField: 'decided_by' },
  { field: 'file_references', label: 'File references', idField: 'file_name', ownerField: null },
];

const keyFor = field => (RECONCILED_FIELDS.find(f => f.field === field) || {}).key;
const fuzzyFor = field => !!(RECONCILED_FIELDS.find(f => f.field === field) || {}).fuzzy;

/** Flatten every per-segment analysis out of a results object. */
function collectSegmentAnalyses(results) {
  const out = [];
  for (const file of (results?.files || [])) {
    for (const seg of (file.segments || [])) {
      if (seg?.analysis && !seg.analysis.error) {
        out.push({ ...seg.analysis, _video: file.originalFile, _segment: seg.segmentFile });
      }
    }
  }
  return out;
}

/** Segment-level health: how many segments produced a usable analysis. */
function auditSegments(results) {
  let total = 0, analyzed = 0, failed = 0, empty = 0;
  const failures = [];

  for (const file of (results?.files || [])) {
    for (const seg of (file.segments || [])) {
      total++;
      const a = seg?.analysis;
      if (!a || a.error) {
        failed++;
        failures.push({
          video: file.originalFile,
          segment: seg?.segmentFile || `#${seg?.segmentIndex ?? '?'}`,
          error: a?.error ? String(a.error).slice(0, 200) : 'no analysis produced',
        });
        continue;
      }
      analyzed++;
      const items = COLLECTIONS.reduce((n, col) => n + ((a[col.field] || []).length), 0);
      if (items === 0) empty++;
    }
  }

  return { total, analyzed, failed, empty, failures };
}

/**
 * Per-collection accounting: what the segments found vs what survived into the
 * compiled result, and which distinct items are missing from it.
 */
function auditCollections(compiled, segmentAnalyses) {
  const rows = [];

  for (const col of COLLECTIONS) {
    const key = keyFor(col.field);
    const fuzzy = fuzzyFor(col.field);
    const compiledItems = Array.isArray(compiled?.[col.field]) ? compiled[col.field] : [];

    const present = new Set(compiledItems.map(i => key ? key(i) : null).filter(Boolean));
    const presentSets = fuzzy ? [...present].map(wordSet) : [];

    let rawCount = 0;
    const distinct = new Map();
    for (const a of segmentAnalyses) {
      for (const item of (a[col.field] || [])) {
        rawCount++;
        const k = key ? key(item) : null;
        if (!k || distinct.has(k)) continue;
        distinct.set(k, { item, video: a._video, segment: a._segment });
      }
    }

    const missing = [];
    for (const [k, entry] of distinct) {
      if (present.has(k)) continue;
      if (fuzzy && isNearDuplicate(k, presentSets)) continue;
      missing.push({
        key: k,
        label: entry.item.title || entry.item.what || entry.item.description || entry.item.file_name || k,
        id: entry.item[col.idField] || null,
        video: entry.video,
        segment: entry.segment,
      });
    }

    const recovered = compiledItems.filter(i => i && i._recovered).length;
    const unsourced = compiledItems.filter(i => i && i.source_segment == null).length;
    const unowned = col.ownerField
      ? compiledItems.filter(i => !i?.[col.ownerField]).length
      : 0;
    const noId = compiledItems.filter(i => !i?.[col.idField]).length;

    rows.push({
      field: col.field,
      label: col.label,
      segmentTotal: rawCount,
      segmentDistinct: distinct.size,
      compiled: compiledItems.length,
      recovered,
      missing,
      missingCount: missing.length,
      unsourced,
      unowned,
      noId,
      ownerField: col.ownerField,
    });
  }

  return rows;
}

/**
 * Render coverage: is every compiled item actually visible in the document the
 * user reads? A collection with no section in the renderer scores 100% on every
 * other check and still shows the reader nothing.
 */
function auditRendered(compiled, renderedText) {
  if (!renderedText) return null;

  const results = [];
  for (const col of COLLECTIONS) {
    const items = Array.isArray(compiled?.[col.field]) ? compiled[col.field] : [];
    if (items.length === 0) continue;

    const missing = [];
    for (const item of items) {
      const id = item?.[col.idField];
      const needle = id || (item?.title || item?.description || item?.what || '').slice(0, 40);
      if (!needle) continue;
      if (!renderedText.includes(String(needle))) {
        missing.push({ id: id || null, label: item.title || item.what || item.description || needle });
      }
    }

    results.push({
      field: col.field,
      label: col.label,
      total: items.length,
      shown: items.length - missing.length,
      missing,
    });
  }

  return results;
}

/** How many duplicate change requests the packer collapsed. */
function auditChangeRequestDedup(compiled) {
  const raw = Array.isArray(compiled?.change_requests) ? compiled.change_requests : [];
  const packed = normalizeChangeRequests(raw);
  const merged = packed.filter(cr => (cr.merged_ids || []).length > 0);
  return {
    before: raw.length,
    after: packed.length,
    collapsed: raw.length - packed.length,
    mergedIds: merged.map(cr => ({ id: cr.id, absorbed: cr.merged_ids })),
    unprioritized: packed.filter(cr => !cr.priority).length,
  };
}

/**
 * What --min-confidence kept out of the report.
 *
 * These items are not lost — they are in results.json and were withheld on
 * purpose — so they must never be counted as dropped work. They are still worth
 * naming: a run that quietly withholds a third of its findings should say so.
 *
 * @param {object} compiled - Before the filter
 * @param {object|null} filteredCompiled - After it (null when no filter ran)
 * @returns {object|null}
 */
function auditWithheld(compiled, filteredCompiled) {
  if (!filteredCompiled || filteredCompiled === compiled) return null;
  const meta = filteredCompiled._filterMeta;
  if (!meta || !meta.removed) return null;

  const byCollection = {};
  for (const col of COLLECTIONS) {
    const before = (compiled?.[col.field] || []).length;
    const after = (filteredCompiled[col.field] || []).length;
    if (before > after) byCollection[col.field] = before - after;
  }

  return {
    minConfidence: meta.minConfidence || 'LOW',
    total: meta.removed,
    byCollection,
  };
}

/**
 * Which models actually answered.
 *
 * A parallel run deals segments across the registry, and a model that was
 * overloaded hands its segment to another one mid-run — so the model named in
 * the report header is only the model that was *asked* first. This records what
 * really produced each segment.
 */
function auditModels(segmentAnalyses) {
  const counts = {};
  let unknown = 0;
  for (const a of segmentAnalyses) {
    const model = a?._geminiMeta?.model;
    if (!model) { unknown++; continue; }
    counts[model] = (counts[model] || 0) + 1;
  }
  return {
    counts,
    distinct: Object.keys(counts).length,
    unknown,
    segments: segmentAnalyses.length,
  };
}

/** Confidence spread across every collection — how much of the run is guesswork. */
function auditConfidence(compiled) {
  const dist = { HIGH: 0, MEDIUM: 0, LOW: 0, unset: 0 };
  for (const col of COLLECTIONS) {
    for (const item of (compiled?.[col.field] || [])) {
      const conf = item?.confidence;
      if (conf && dist[conf] != null) dist[conf]++;
      else dist.unset++;
    }
  }
  dist.total = dist.HIGH + dist.MEDIUM + dist.LOW + dist.unset;
  return dist;
}

/**
 * Run the full audit.
 *
 * @param {object} o
 * @param {object} o.results - The run results (files → segments → analysis)
 * @param {object} o.compiled - The compiled analysis, BEFORE the confidence filter
 * @param {object} [o.filteredCompiled] - What was actually handed to the renderers
 *   (`compiled` minus anything --min-confidence withheld). Defaults to `compiled`.
 * @param {string} [o.renderedText] - The rendered Markdown, for render coverage
 * @param {object} [o.meta] - Call metadata
 * @param {object} [o.personScope] - Output of buildPersonScope, when --name was used
 * @returns {object} The audit report
 */
function auditRun({ results, compiled, filteredCompiled = null, renderedText = '', meta = {}, personScope = null } = {}) {
  const shown = filteredCompiled || compiled;
  const segmentAnalyses = collectSegmentAnalyses(results);
  const segments = auditSegments(results);
  const collections = auditCollections(compiled, segmentAnalyses);
  const withheld = auditWithheld(compiled, filteredCompiled);
  // Render coverage is judged against what the renderers were actually given —
  // an item the confidence filter withheld on purpose is not a rendering bug.
  const rendered = auditRendered(shown, renderedText);
  const changeRequests = auditChangeRequestDedup(compiled);
  const confidence = auditConfidence(compiled);
  const models = auditModels(segmentAnalyses);

  const totalMissing = collections.reduce((n, r) => n + r.missingCount, 0);
  const totalRenderMissing = (rendered || []).reduce((n, r) => n + r.missing.length, 0);
  const totalCompiled = collections.reduce((n, r) => n + r.compiled, 0);
  const totalRecovered = collections.reduce((n, r) => n + r.recovered, 0);

  const issues = [];
  if (segments.failed > 0) issues.push(`${segments.failed} of ${segments.total} segments produced no analysis — that part of the call is not in the report`);
  if (totalMissing > 0) issues.push(`${totalMissing} distinct segment items are absent from the compiled result`);
  if (totalRenderMissing > 0) issues.push(`${totalRenderMissing} compiled items are not visible anywhere in the rendered report`);
  if (changeRequests.unprioritized > 0) issues.push(`${changeRequests.unprioritized} change requests have no priority and need triage`);
  if (withheld && withheld.total > 0) {
    issues.push(`${withheld.total} items are in the data but withheld from the report by --min-confidence ${withheld.minConfidence.toLowerCase()}`);
  }
  for (const r of collections) {
    if (r.unowned > 0 && r.compiled > 0) issues.push(`${r.unowned}/${r.compiled} ${r.label.toLowerCase()} have no owner`);
    if (r.noId > 0) issues.push(`${r.noId}/${r.compiled} ${r.label.toLowerCase()} have no id — they cannot be tracked across runs`);
  }
  if (personScope && personScope.isEmpty) {
    issues.push(`No work found for "${personScope.person}" — check the spelling of --name against the participant list`);
  }

  // Anything genuinely lost fails the audit; missing owners and ids are warnings.
  const status = (segments.failed > 0 || totalMissing > 0 || totalRenderMissing > 0)
    ? 'FAIL'
    : (issues.length > 0 ? 'WARN' : 'PASS');

  return {
    status,
    generatedAt: new Date().toISOString(),
    callName: meta.callName || null,
    model: meta.geminiModel || null,
    segments,
    collections,
    rendered,
    changeRequests,
    confidence,
    models,
    withheld,
    personScope: personScope
      ? { person: personScope.person, counts: personScope.counts, isEmpty: personScope.isEmpty }
      : null,
    totals: {
      compiled: totalCompiled,
      recovered: totalRecovered,
      missing: totalMissing,
      renderMissing: totalRenderMissing,
    },
    issues,
  };
}

const STATUS_ICON = { PASS: '✅', WARN: '⚠️', FAIL: '❌' };

/**
 * Render the audit as Markdown.
 *
 * @param {object} report - Output of auditRun
 * @returns {string}
 */
function renderAuditMarkdown(report) {
  const lines = [];
  const ln = (...a) => lines.push(a.join(''));

  ln(`# 🔍 Coverage Audit — ${report.callName || 'Unknown'}`);
  ln('');
  ln(`> **Result**: ${STATUS_ICON[report.status]} **${report.status}**  `);
  ln(`> **Segments**: ${report.segments.analyzed}/${report.segments.total} analyzed${report.segments.failed ? ` · ${report.segments.failed} failed` : ''}${report.segments.empty ? ` · ${report.segments.empty} with no items` : ''}  `);
  ln(`> **Items in report**: ${report.totals.compiled}${report.totals.recovered ? ` (${report.totals.recovered} recovered by backfill)` : ''}  `);
  ln(`> **Lost**: ${report.totals.missing} from compilation · ${report.totals.renderMissing} from the rendered report  `);
  ln(`> **Generated**: ${report.generatedAt.slice(0, 19).replace('T', ' ')}  `);
  ln('');

  if (report.issues.length === 0) {
    ln('Every item extracted from every segment is present in the compiled result and visible in the report.');
    ln('');
  } else {
    ln('## ⚠️ Findings');
    ln('');
    for (const issue of report.issues) ln(`- ${issue}`);
    ln('');
  }

  ln('---');
  ln('');
  ln('## 📊 Item Accounting');
  ln('');
  ln('| Collection | Found in segments | Distinct | In report | Recovered | Missing | No owner | No source |');
  ln('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of report.collections) {
    const miss = r.missingCount > 0 ? `**${r.missingCount}**` : '0';
    ln(`| ${r.label} | ${r.segmentTotal} | ${r.segmentDistinct} | ${r.compiled} | ${r.recovered || '—'} | ${miss} | ${r.ownerField ? r.unowned : '—'} | ${r.unsourced} |`);
  }
  ln('');
  ln('_"Found in segments" counts every mention across segments; the same ticket discussed five times counts five times. "Distinct" is what remains after dedup — that is the number "In report" should match._');
  ln('');

  const withMissing = report.collections.filter(r => r.missingCount > 0);
  if (withMissing.length) {
    ln('### ❌ Items missing from the compiled result');
    ln('');
    for (const r of withMissing) {
      ln(`**${r.label}** (${r.missingCount})`);
      ln('');
      for (const m of r.missing) {
        ln(`- ${m.id ? `\`${m.id}\` — ` : ''}${m.label}${m.segment ? ` _(${m.segment})_` : ''}`);
      }
      ln('');
    }
  }

  if (report.segments.failures.length) {
    ln('### 🚫 Segments that produced no analysis');
    ln('');
    ln('| Video | Segment | Reason |');
    ln('| --- | --- | --- |');
    for (const f of report.segments.failures) {
      ln(`| ${f.video || '—'} | ${f.segment} | ${String(f.error).replace(/\|/g, '\\|')} |`);
    }
    ln('');
  }

  if (report.rendered?.length) {
    ln('---');
    ln('');
    ln('## 🖨️ Render Coverage');
    ln('');
    ln('| Collection | In report data | Visible in document | Hidden |');
    ln('| --- | --- | --- | --- |');
    for (const r of report.rendered) {
      ln(`| ${r.label} | ${r.total} | ${r.shown} | ${r.missing.length || '—'} |`);
    }
    ln('');
    const hidden = report.rendered.filter(r => r.missing.length);
    for (const r of hidden) {
      ln(`**Hidden ${r.label.toLowerCase()}**:`);
      for (const m of r.missing) ln(`- ${m.id ? `\`${m.id}\` — ` : ''}${m.label}`);
      ln('');
    }
  }

  if (report.withheld) {
    ln('---');
    ln('');
    ln('## 🙈 Withheld by the Confidence Filter');
    ln('');
    ln(`${report.withheld.total} item(s) were extracted and kept in \`results.json\`, but held out of the report because \`--min-confidence ${report.withheld.minConfidence.toLowerCase()}\` was in effect. They are not lost — lower the threshold to see them.`);
    ln('');
    const rows = Object.entries(report.withheld.byCollection);
    if (rows.length) {
      ln('| Collection | Withheld |');
      ln('| --- | --- |');
      for (const [field, n] of rows) {
        const label = (COLLECTIONS.find(c2 => c2.field === field) || {}).label || field;
        ln(`| ${label} | ${n} |`);
      }
      ln('');
    }
  }

  ln('---');
  ln('');
  ln('## 🔧 Change Request Dedup');
  ln('');
  ln(`- Raised across segments: **${report.changeRequests.before}**`);
  ln(`- After merging duplicates: **${report.changeRequests.after}**${report.changeRequests.collapsed ? ` (${report.changeRequests.collapsed} collapsed)` : ''}`);
  if (report.changeRequests.unprioritized) ln(`- Without a priority: **${report.changeRequests.unprioritized}** — these sort last and need triage`);
  ln('');
  if (report.changeRequests.mergedIds.length) {
    ln('| Kept | Absorbed duplicates |');
    ln('| --- | --- |');
    for (const m of report.changeRequests.mergedIds) {
      ln(`| \`${m.id}\` | ${m.absorbed.map(x => `\`${x}\``).join(', ')} |`);
    }
    ln('');
  }

  ln('---');
  ln('');
  if (report.models && report.models.distinct > 0) {
    ln('## 🤖 Models Used');
    ln('');
    ln('| Model | Segments |');
    ln('| --- | --- |');
    for (const [model, n] of Object.entries(report.models.counts).sort((a, b) => b[1] - a[1])) {
      ln(`| ${model} | ${n} |`);
    }
    ln('');
    ln(`_${report.models.distinct} model(s) answered across ${report.models.segments} analyzed segment(s). A run spreads segments over the registry and moves a segment to another model when one is overloaded, so this is what actually produced the report._`);
    ln('');
    ln('---');
    ln('');
  }

  ln('## 🎯 Confidence');
  ln('');
  const cf = report.confidence;
  ln(`| HIGH | MEDIUM | LOW | Unset | Total |`);
  ln('| --- | --- | --- | --- | --- |');
  ln(`| ${cf.HIGH} | ${cf.MEDIUM} | ${cf.LOW} | ${cf.unset} | ${cf.total} |`);
  ln('');

  if (report.personScope) {
    ln('---');
    ln('');
    ln(`## 👤 Scope for "${report.personScope.person}"`);
    ln('');
    const pc = report.personScope.counts;
    ln('| Tickets | Reviewing | CRs | To do | Blockers | Blocked by others | Waiting on | Owed to others | Decisions | Mentions |');
    ln('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    ln(`| ${pc.tickets} | ${pc.reviewing} | ${pc.changeRequests} | ${pc.todo} | ${pc.blockers} | ${pc.blockingMe} | ${pc.waitingOn} | ${pc.othersWaitingOnMe} | ${pc.decisionsNeeded} | ${pc.mentions} |`);
    ln('');
  }

  ln('---');
  ln('');
  ln(`_Audit generated ${report.generatedAt.slice(0, 19).replace('T', ' ')} — this file checks the pipeline, not the content of the call._`);
  ln('');

  return lines.join('\n');
}

/** One-line console summary of an audit report. */
function formatAuditLine(report) {
  const icon = STATUS_ICON[report.status];
  const parts = [`${report.totals.compiled} items`];
  if (report.totals.recovered) parts.push(`${report.totals.recovered} recovered`);
  if (report.totals.missing) parts.push(`${report.totals.missing} missing`);
  if (report.totals.renderMissing) parts.push(`${report.totals.renderMissing} unrendered`);
  if (report.segments.failed) parts.push(`${report.segments.failed} failed segments`);
  const body = `${icon} Audit ${report.status} — ${parts.join(' · ')}`;
  if (report.status === 'FAIL') return c.warn(body);
  if (report.status === 'WARN') return c.warn(body);
  return c.success(body);
}

module.exports = {
  auditRun,
  renderAuditMarkdown,
  formatAuditLine,
  collectSegmentAnalyses,
  auditSegments,
  auditCollections,
  auditRendered,
  auditChangeRequestDedup,
  auditConfidence,
  auditModels,
  auditWithheld,
  COLLECTIONS,
};
