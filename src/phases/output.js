'use strict';

const fs = require('fs');
const path = require('path');

// --- Config ---
const config = require('../config');

// --- Services ---
const { uploadToStorage } = require('../services/firebase');

// --- Renderers ---
const { renderResultsMarkdown } = require('../renderers/markdown');
const { renderResultsHtml } = require('../renderers/html');
const { renderResultsPdf } = require('../renderers/pdf');
const { renderResultsDocx } = require('../renderers/docx');
const { renderChangeRequestHandoff } = require('../renderers/change-requests');

// --- Utils ---
const { loadPreviousCompilation, generateDiff, renderDiffMarkdown } = require('../utils/diff-engine');
const { filterByConfidence } = require('../utils/confidence-filter');
const { auditRun, renderAuditMarkdown, formatAuditLine } = require('../utils/coverage-audit');
const { buildPersonScope } = require('../utils/person-scope');
const { c } = require('../utils/colors');

// --- Shared state ---
const { getLog, phaseTimer, PROJECT_ROOT, uploadSkipReason } = require('./_shared');

/** Check whether a given output type should be rendered. */
function shouldRender(opts, type) {
  if (opts.formats) return opts.formats.has(type);
  // Fallback for legacy callers
  if (opts.format === 'all') return true;
  return opts.format === type;
}

// ======================== PHASE: OUTPUT ========================

/**
 * Write results JSON, generate Markdown, upload final artifacts.
 * Returns { runDir, jsonPath, mdPath }.
 */
async function phaseOutput(ctx, results, compiledAnalysis, compilationRun, compilationPayload) {
  const log = getLog();
  const timer = phaseTimer('output');
  const { opts, targetDir, storage, firebaseReady, callName, progress, costTracker, userName } = ctx;

  progress.setPhase('output');

  // Determine output directory
  const runTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : path.join(targetDir, 'runs', runTs);
  fs.mkdirSync(runDir, { recursive: true });
  log.step(`Run folder created → ${runDir}`);

  // Copy compilation JSON into run folder
  if (compilationPayload) {
    const runCompFile = path.join(runDir, 'compilation.json');
    fs.writeFileSync(runCompFile, JSON.stringify(compilationPayload, null, 2), 'utf8');
  }

  // Attach cost summary to results
  results.costSummary = costTracker.getSummary();

  // Write results JSON (always written; logged only when JSON format is requested)
  const jsonPath = path.join(runDir, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
  if (shouldRender(opts, 'json')) {
    log.step(`Results JSON saved → ${jsonPath}`);
  }

  // Generate Markdown
  const mdPath = path.join(runDir, 'results.md');
  // Kept for the coverage audit below: it checks that every compiled item is
  // actually visible in the document, not merely present in the data.
  let renderedMarkdown = '';
  const totalSegs = results.files.reduce((s, f) => s + (f.segmentCount || 0), 0);

  // Apply confidence filter for rendered output (MD/HTML) — results.json keeps full data
  let renderData = compiledAnalysis;
  if (compiledAnalysis && opts.minConfidence && opts.minConfidence !== 'low') {
    renderData = filterByConfidence(compiledAnalysis, opts.minConfidence);
    const meta = renderData._filterMeta;
    if (meta && meta.removed > 0) {
      console.log(`  Confidence filter: ${meta.minConfidence} → kept ${meta.filteredCounts.total}/${meta.originalCounts.total} items (${meta.removed} removed)`);
      log.step(`Confidence filter applied: ${meta.minConfidence}, removed ${meta.removed} items`);
    }
  }

  // Build shared meta for renderers
  const renderMeta = {
    callName: results.callName,
    processedAt: results.processedAt,
    geminiModel: config.GEMINI_MODEL,
    userName,
    segmentCount: totalSegs,
    compilation: compilationRun || null,
    costSummary: results.costSummary,
    integrityWarnings: results.integrityWarnings || null,
    segments: results.files.flatMap(f => {
      const speed = results.settings?.speed || 1;
      let cum = 0;
      return (f.segments || []).map(s => {
        const startSec = cum;
        cum += (s.durationSeconds || 0) * speed;
        return {
          file: s.segmentFile,
          duration: s.duration,
          durationSeconds: s.durationSeconds,
          sizeMB: s.fileSizeMB,
          video: f.originalFile,
          startTimeSec: startSec,
          endTimeSec: cum,
          segmentNumber: (s.segmentIndex || 0) + 1,
        };
      });
    }),
    settings: results.settings,
    diagrams: !opts.noDiagrams,
  };

  if (renderData && !renderData._incomplete) {
    // --- Markdown report ---
    if (shouldRender(opts, 'md')) {
      const mdContent = renderResultsMarkdown({ compiled: renderData, meta: renderMeta });
      renderedMarkdown = mdContent;
      fs.writeFileSync(mdPath, mdContent, 'utf8');
      log.step(`Results MD saved (compiled) → ${mdPath}`);
      console.log(`  ${c.success('Markdown report (AI-compiled)')} → ${c.cyan(path.basename(mdPath))}`);
    }

    // --- HTML report ---
    if (shouldRender(opts, 'html') && !opts.noHtml) {
      const htmlPath = path.join(runDir, 'results.html');
      const htmlContent = renderResultsHtml({ compiled: renderData, meta: renderMeta });
      fs.writeFileSync(htmlPath, htmlContent, 'utf8');
      log.step(`Results HTML saved → ${htmlPath}`);
      console.log(`  ${c.success('HTML report')} → ${c.cyan(path.basename(htmlPath))}`);

      // --- PDF report (requires HTML first) ---
      if (shouldRender(opts, 'pdf')) {
        try {
          const pdfPath = path.join(runDir, 'results.pdf');
          const pdfInfo = await renderResultsPdf(htmlContent, pdfPath);
          log.step(`Results PDF saved → ${pdfPath}`);
          console.log(`  ${c.success('PDF report')} → ${c.cyan(path.basename(pdfPath))} ${c.dim(`(${(pdfInfo.bytes / 1024).toFixed(0)} KB)`)}`);
        } catch (pdfErr) {
          console.warn(`  ${c.warn('PDF generation failed:')} ${pdfErr.message}`);
          log.warn(`PDF generation error: ${pdfErr.message}`);
        }
      }
    } else if (shouldRender(opts, 'pdf')) {
      // PDF requested without HTML — generate HTML in memory
      try {
        const htmlContent = renderResultsHtml({ compiled: renderData, meta: renderMeta });
        const pdfPath = path.join(runDir, 'results.pdf');
        const pdfInfo = await renderResultsPdf(htmlContent, pdfPath);
        log.step(`Results PDF saved → ${pdfPath}`);
        console.log(`  ${c.success('PDF report')} → ${c.cyan(path.basename(pdfPath))} ${c.dim(`(${(pdfInfo.bytes / 1024).toFixed(0)} KB)`)}`);
      } catch (pdfErr) {
        console.warn(`  ${c.warn('PDF generation failed:')} ${pdfErr.message}`);
        log.warn(`PDF generation error: ${pdfErr.message}`);
      }
    }

    // --- DOCX report ---
    if (shouldRender(opts, 'docx')) {
      try {
        const docxPath = path.join(runDir, 'results.docx');
        const docxBuffer = await renderResultsDocx({ compiled: renderData, meta: renderMeta });
        fs.writeFileSync(docxPath, docxBuffer);
        log.step(`Results DOCX saved → ${docxPath}`);
        console.log(`  ${c.success('DOCX report')} → ${c.cyan(path.basename(docxPath))} ${c.dim(`(${(docxBuffer.length / 1024).toFixed(0)} KB)`)}`);
      } catch (docxErr) {
        console.warn(`  ${c.warn('DOCX generation failed:')} ${docxErr.message}`);
        log.warn(`DOCX generation error: ${docxErr.message}`);
      }
    }
  } else if (shouldRender(opts, 'md')) {
    const { renderResultsMarkdownLegacy } = require('../renderers/markdown');
    const mdContent = renderResultsMarkdownLegacy(results);
    renderedMarkdown = mdContent;
    fs.writeFileSync(mdPath, mdContent, 'utf8');
    log.step(`Results MD saved (legacy merge) → ${mdPath}`);
    console.log(`  ${c.success('Markdown report (legacy merge)')} → ${c.cyan(path.basename(mdPath))}`);
  }

  // === CHANGE REQUEST HANDOFF ===
  // The other team implementing these changes was not on the call and should not
  // have to read a call report to find their work. Same data, standalone, deduped
  // and priority-ordered: Markdown to read, CSV to import into a tracker.
  let crPaths = null;
  if (renderData && !opts.noChangeRequests) {
    try {
      const handoff = renderChangeRequestHandoff({ compiled: renderData, meta: renderMeta });
      const crMdPath = path.join(runDir, 'change-requests.md');
      const crCsvPath = path.join(runDir, 'change-requests.csv');
      fs.writeFileSync(crMdPath, handoff.markdown, 'utf8');
      fs.writeFileSync(crCsvPath, handoff.csv, 'utf8');
      crPaths = { md: crMdPath, csv: crCsvPath, count: handoff.changeRequests.length };
      const cts = handoff.counts;
      log.step(`Change request handoff saved → ${crMdPath} (${handoff.changeRequests.length} CRs)`);
      console.log(`  ${c.success('Change requests (send to the other team)')} → ${c.cyan('change-requests.md')} + ${c.cyan('change-requests.csv')}`);
      console.log(`    ${c.dim(`${handoff.changeRequests.length} deduplicated · ${cts.critical} critical · ${cts.high} high · ${cts.medium} medium · ${cts.low} low${cts.unset ? ` · ${cts.unset} unprioritized` : ''}`)}`);
    } catch (crErr) {
      console.warn(`  ${c.warn('Change request handoff failed:')} ${crErr.message}`);
      log.warn(`Change request handoff error: ${crErr.message}`);
    }
  }

  // === COVERAGE AUDIT ===
  // Verifies the pipeline did not silently drop work: every item found in every
  // segment must survive compilation and be visible in the rendered report.
  let auditReport = null;
  let auditPaths = null;
  if (!opts.noAudit && renderData) {
    try {
      const personScope = userName
        ? buildPersonScope({
          person: userName,
          tickets: renderData.tickets || [],
          changeRequests: renderData.change_requests || [],
          actionItems: renderData.action_items || [],
          blockers: renderData.blockers || [],
          scopeChanges: renderData.scope_changes || [],
          fileReferences: renderData.file_references || [],
          yourTasks: renderData.your_tasks || null,
        })
        : null;

      auditReport = auditRun({
        results,
        // Audited against the UNFILTERED analysis: an item --min-confidence
        // withheld is reported as withheld, never as work that went missing.
        compiled: compiledAnalysis || renderData,
        filteredCompiled: renderData,
        renderedText: renderedMarkdown,
        meta: renderMeta,
        personScope,
      });

      const auditMdPath = path.join(runDir, 'audit.md');
      const auditJsonPath = path.join(runDir, 'audit.json');
      fs.writeFileSync(auditMdPath, renderAuditMarkdown(auditReport), 'utf8');
      fs.writeFileSync(auditJsonPath, JSON.stringify(auditReport, null, 2), 'utf8');
      auditPaths = { md: auditMdPath, json: auditJsonPath };
      results.audit = { status: auditReport.status, totals: auditReport.totals, issues: auditReport.issues };
      // results.json was written before the audit ran — rewrite it so the verdict
      // is in the machine-readable output too, not only in audit.md.
      fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');

      log.step(`Coverage audit: ${auditReport.status} — ${JSON.stringify(auditReport.totals)}`);
      console.log(`  ${formatAuditLine(auditReport)} → ${c.cyan('audit.md')}`);
      for (const issue of auditReport.issues.slice(0, 5)) {
        console.log(`    ${c.dim('· ' + issue)}`);
      }
      if (auditReport.issues.length > 5) {
        console.log(`    ${c.dim(`· …${auditReport.issues.length - 5} more in audit.md`)}`);
      }
    } catch (auditErr) {
      console.warn(`  ${c.warn('Coverage audit failed:')} ${auditErr.message}`);
      log.warn(`Coverage audit error: ${auditErr.message}`);
    }
  }

  // === DIFF ENGINE (v6) ===
  let diffResult = null;
  if (!opts.disableDiff && compiledAnalysis) {
    try {
      const prevComp = loadPreviousCompilation(targetDir, runTs);
      if (prevComp && prevComp.compiled) {
        diffResult = generateDiff(compiledAnalysis, prevComp.compiled);
        // Inject the previous run timestamp into the diff
        if (diffResult.hasDiff) {
          diffResult.previousTimestamp = prevComp.timestamp;
          const diffMd = renderDiffMarkdown(diffResult);
          if (shouldRender(opts, 'md')) {
            fs.appendFileSync(mdPath, '\n\n' + diffMd, 'utf8');
          }
          fs.writeFileSync(path.join(runDir, 'diff.json'), JSON.stringify(diffResult, null, 2), 'utf8');
          log.step(`Diff report: ${diffResult.totals.newItems} new, ${diffResult.totals.removedItems} removed, ${diffResult.totals.changedItems} changed`);
          console.log(`  ${c.success('Diff report appended')} (vs ${c.dim(prevComp.timestamp)})`);
        } else {
          console.log(`  ${c.info('No differences vs previous run')} (${c.dim(prevComp.timestamp)})`);
        }
      } else {
        console.log(`  ${c.info('No previous compilation found for diff comparison')}`);
      }
    } catch (diffErr) {
      console.warn(`  ${c.warn('Diff generation failed:')} ${diffErr.message}`);
      log.warn(`Diff generation error: ${diffErr.message}`);
    }
  }

  // Upload results to Firebase
  if (firebaseReady && !opts.skipUpload && !opts.dryRun) {
    try {
      const resultsStoragePath = `calls/${callName}/runs/${runTs}/results.json`;
      // Results always upload fresh (never skip-existing) — they change every run
      const url = await uploadToStorage(storage, jsonPath, resultsStoragePath);
      results.storageUrl = url;
      fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
      console.log(`  ${c.success('Results JSON uploaded')} → ${c.dim(resultsStoragePath)}`);

      if (shouldRender(opts, 'md') && fs.existsSync(mdPath)) {
        const mdStoragePath = `calls/${callName}/runs/${runTs}/results.md`;
        await uploadToStorage(storage, mdPath, mdStoragePath);
        console.log(`  ${c.success('Results MD uploaded')} → ${c.dim(mdStoragePath)}`);
      }

      // The handoff and the audit are the two files people forward on, so they
      // upload with the report rather than living only on the machine that ran.
      for (const extra of [crPaths?.md, crPaths?.csv, auditPaths?.md]) {
        if (!extra || !fs.existsSync(extra)) continue;
        const name = path.basename(extra);
        await uploadToStorage(storage, extra, `calls/${callName}/runs/${runTs}/${name}`);
        console.log(`  ${c.success(`${name} uploaded`)} → ${c.dim(`calls/${callName}/runs/${runTs}/${name}`)}`);
      }
    } catch (err) {
      console.warn(`  ${c.warn('Results upload failed:')} ${err.message}`);
    }
  } else if (opts.skipUpload) {
    console.log(`  ${c.dim('Skipping results upload')} ${c.dim(`(${uploadSkipReason(opts)})`)}`);
  } else {
    console.log(`  ${c.warn('Skipping results upload')} ${c.dim('(Firebase auth not configured)')}`);
  }

  timer.end();
  return { runDir, jsonPath, mdPath, runTs, crPaths, auditPaths, audit: auditReport };
}

module.exports = phaseOutput;
