'use strict';

// --- Config ---
const config = require('../config');

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
  console.log('==============================================');
  console.log(' COMPLETE');
  console.log('==============================================');
  console.log(`  Results JSON : ${jsonPath}`);
  console.log(`  Results MD   : ${mdPath}`);
  console.log(`  Files        : ${results.files.length}`);
  console.log(`  Segments     : ${totalSegs}`);
  console.log(`  Elapsed      : ${log.elapsed()}`);
  if (compilationRun) {
    console.log(`  Compilation  : ${(compilationRun.durationMs / 1000).toFixed(1)}s | ${compilationRun.tokenUsage?.totalTokens?.toLocaleString() || '?'} tokens`);
  }
  results.files.forEach(f => {
    console.log(`  ${f.originalFile}: ${f.originalSizeMB} MB → ${f.compressedTotalMB} MB (${f.compressionRatio})`);
  });

  // Cost breakdown
  const cost = costTracker.getSummary();
  if (cost.totalTokens > 0) {
    console.log('');
    console.log(`  Cost estimate (${config.GEMINI_MODEL}):`);
    console.log(`    Input tokens  : ${cost.inputTokens.toLocaleString()} ($${cost.inputCost.toFixed(4)})`);
    console.log(`    Output tokens : ${cost.outputTokens.toLocaleString()} ($${cost.outputCost.toFixed(4)})`);
    console.log(`    Thinking tokens: ${cost.thinkingTokens.toLocaleString()} ($${cost.thinkingCost.toFixed(4)})`);
    console.log(`    Total         : ${cost.totalTokens.toLocaleString()} tokens | $${cost.totalCost.toFixed(4)}`);
    console.log(`    AI time       : ${(cost.totalDurationMs / 1000).toFixed(1)}s`);
  }

  if (firebaseReady && !opts.skipUpload) {
    console.log('');
    console.log('  Firebase Storage:');
    console.log(`    calls/${callName}/documents/  → ${Object.keys(docStorageUrls).length} doc(s)`);
    console.log(`    calls/${callName}/segments/   → ${totalSegs} segment(s)`);
    console.log(`    calls/${callName}/runs/${runTs}/  → results.json + results.md`);
    if (results.storageUrl) {
      console.log(`    Results URL: ${results.storageUrl}`);
    }
  } else {
    console.log('');
    console.log('  ⚠ Firebase Storage: uploads skipped');
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

  console.log(`  Logs: ${log.detailedPath}`);
  console.log(`         ${log.minimalPath}`);
  console.log('');
}

module.exports = phaseSummary;
