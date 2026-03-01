'use strict';

// --- Config ---
const config = require('../config');

// --- Utils ---
const { c } = require('../utils/colors');

// --- Shared state ---
const { getLog } = require('./_shared');

// ======================== PHASE: SUMMARY ========================

/**
 * Print the final summary with timing, cost, and file locations.
 */
function phaseSummary(ctx, results, { jsonPath, mdPath, runTs, compilationRun }) {
  const log = getLog();
  const { opts, firebaseReady, callName, docStorageUrls, costTracker } = ctx;
  const totalSegs = results.files.reduce((s, f) => s + f.segmentCount, 0);

  console.log('');
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log(c.heading(' COMPLETE'));
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log(`  Results JSON : ${c.cyan(jsonPath)}`);
  console.log(`  Results MD   : ${c.cyan(mdPath)}`);
  console.log(`  Files        : ${c.highlight(results.files.length)}`);
  console.log(`  Segments     : ${c.highlight(totalSegs)}`);
  console.log(`  Elapsed      : ${c.yellow(log.elapsed())}`);
  if (compilationRun) {
    console.log(`  Compilation  : ${c.yellow((compilationRun.durationMs / 1000).toFixed(1) + 's')} | ${c.yellow((compilationRun.tokenUsage?.totalTokens?.toLocaleString() || '?') + ' tokens')}`);
  }
  results.files.forEach(f => {
    console.log(`  ${c.dim(f.originalFile)}: ${c.yellow(f.originalSizeMB + ' MB')} → ${c.green(f.compressedTotalMB + ' MB')} ${c.dim(`(${f.compressionRatio})`)}`);
  });

  // Cost breakdown
  const cost = costTracker.getSummary();
  if (cost.totalTokens > 0) {
    console.log('');
    console.log(`  ${c.heading(`Cost estimate (${config.GEMINI_MODEL}):`)}`);
    console.log(`    Input tokens  : ${c.yellow(cost.inputTokens.toLocaleString())} ${c.dim(`($${cost.inputCost.toFixed(4)})`)}`);
    console.log(`    Output tokens : ${c.yellow(cost.outputTokens.toLocaleString())} ${c.dim(`($${cost.outputCost.toFixed(4)})`)}`);
    console.log(`    Thinking tokens: ${c.yellow(cost.thinkingTokens.toLocaleString())} ${c.dim(`($${cost.thinkingCost.toFixed(4)})`)}`);
    console.log(`    Total         : ${c.highlight(cost.totalTokens.toLocaleString() + ' tokens')} | ${c.green('$' + cost.totalCost.toFixed(4))}`);
    console.log(`    AI time       : ${c.yellow((cost.totalDurationMs / 1000).toFixed(1) + 's')}`);
  }

  if (firebaseReady && !opts.skipUpload) {
    console.log('');
    console.log(`  ${c.heading('Firebase Storage:')}`);
    console.log(`    ${c.dim(`calls/${callName}/documents/`)}  → ${c.yellow(Object.keys(docStorageUrls).length)} doc(s)`);
    console.log(`    ${c.dim(`calls/${callName}/segments/`)}   → ${c.yellow(totalSegs)} segment(s)`);
    console.log(`    ${c.dim(`calls/${callName}/runs/${runTs}/`)}  → results.json + results.md`);
    if (results.storageUrl) {
      console.log(`    Results URL: ${c.link(results.storageUrl)}`);
    }
  } else {
    console.log('');
    console.log(`  ${c.warn('Firebase Storage: uploads skipped')}`);
  }

  // Log summary
  log.summary([
    `Call: ${callName}`,
    `Videos: ${results.files.length}`,
    `Segments: ${totalSegs}`,
    `Compiled: ${results.compilation ? 'Yes (AI)' : 'No (fallback merge)'}`,
    `Firebase: ${firebaseReady && !opts.skipUpload ? 'OK' : 'skipped'}`,
    `Documents: ${results.contextDocuments.length}`,
    `Cost: $${cost.totalCost.toFixed(4)} (${cost.totalTokens.toLocaleString()} tokens)`,
    `Elapsed: ${log.elapsed()}`,
    ...results.files.map(f => `  ${f.originalFile}: ${f.originalSizeMB}MB → ${f.compressedTotalMB}MB (${f.compressionRatio})`),
    `Results JSON: ${jsonPath}`,
    `Results MD: ${mdPath}`,
    `Logs: ${log.detailedPath}`,
  ]);
  log.step('DONE');

  console.log(`  Logs: ${c.dim(log.detailedPath)}`);
  console.log(`         ${c.dim(log.minimalPath)}`);
  console.log('');
}

module.exports = phaseSummary;
