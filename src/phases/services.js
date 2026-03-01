'use strict';

const fs = require('fs');
const path = require('path');

// --- Services ---
const { initFirebase, uploadToStorage, storageExists } = require('../services/firebase');
const { initGemini, prepareDocsForGemini } = require('../services/gemini');

// --- Modes ---
const { deepSummarize } = require('../modes/deep-summary');

// --- Utils ---
const { parallelMap } = require('../utils/retry');

// --- Shared state ---
const { c } = require('../utils/colors');
const { getLog, isShuttingDown, phaseTimer } = require('./_shared');

// ======================== PHASE: SERVICES ========================

/**
 * Initialize Firebase and Gemini services, prepare context documents.
 * Returns augmented ctx with storage, firebaseReady, ai, contextDocs.
 */
async function phaseServices(ctx) {
  const log = getLog();
  const timer = phaseTimer('services');
  const { opts, allDocFiles } = ctx;
  const callName = path.basename(ctx.targetDir);

  console.log(`${c.dim('Initializing services...')}`);

  let storage = null;
  let firebaseReady = false;
  if (!opts.skipUpload && !opts.dryRun) {
    const fb = await initFirebase();
    storage = fb.storage;
    firebaseReady = fb.authenticated;
  } else if (opts.skipUpload) {
    console.log(`  Firebase: ${c.dim('skipped (--skip-upload)')}`);
  } else {
    console.log(`  Firebase: ${c.dim('skipped (--dry-run)')}`);
  }

  let ai = null;
  if (!opts.skipGemini && !opts.dryRun) {
    ai = await initGemini();
    console.log(`  ${c.success('Gemini AI: ready')}`);
  } else if (opts.skipGemini) {
    console.log(`  Gemini AI: ${c.dim('skipped (--skip-gemini)')}`);
  } else {
    console.log(`  Gemini AI: ${c.dim('skipped (--dry-run)')}`);
  }

  log.step(`Services: Firebase auth=${firebaseReady}, Gemini=${ai ? 'ready' : 'skipped'}`);

  // --- Prepare documents for Gemini ---
  let contextDocs = [];
  if (ai) {
    contextDocs = await prepareDocsForGemini(ai, allDocFiles);
  } else if (allDocFiles.length > 0) {
    console.log(`  ${c.warn('Skipping Gemini doc preparation (AI not active)')}`);
    contextDocs = allDocFiles
      .filter(({ absPath }) => ['.txt', '.md', '.vtt', '.srt', '.csv', '.json', '.xml', '.html']
        .includes(path.extname(absPath).toLowerCase()))
      .map(({ absPath, relPath }) => ({
        type: 'inlineText',
        fileName: relPath,
        content: fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF/, ''),
      }));
  }

  // --- Upload documents to Firebase Storage for archival ---
  const docStorageUrls = {};
  if (firebaseReady && !opts.skipUpload) {
    await parallelMap(allDocFiles, async ({ absPath: docPath, relPath }) => {
      if (isShuttingDown()) return;
      const docStoragePath = `calls/${callName}/documents/${relPath}`;
      try {
        if (!opts.forceUpload) {
          const existingUrl = await storageExists(storage, docStoragePath);
          if (existingUrl) {
            docStorageUrls[relPath] = existingUrl;
            console.log(`  ${c.success(`Document already in Storage \u2192 ${c.cyan(docStoragePath)}`)}`);
            return;
          }
        }
        const url = await uploadToStorage(storage, docPath, docStoragePath);
        docStorageUrls[relPath] = url;
        console.log(`  ${c.success(`Document ${opts.forceUpload ? '(re-uploaded)' : '\u2192'} ${c.cyan(docStoragePath)}`)}`);
      } catch (err) {
        console.warn(`  ${c.warn(`Document upload failed (${relPath}): ${err.message}`)}`);
      }
    }, opts.parallel);
  } else if (opts.skipUpload) {
    console.log(`  ${c.warn('Skipping document uploads (--skip-upload)')}`);
  } else {
    console.log(`  ${c.warn('Skipping document uploads (Firebase auth not configured)')}`);
  }
  console.log('');

  timer.end();
  return { ...ctx, storage, firebaseReady, ai, contextDocs, docStorageUrls, callName };
}

// ======================== PHASE: DEEP SUMMARY ========================

/**
 * Pre-summarize context documents to save input tokens per segment.
 * Runs only when --deep-summary flag is active.
 *
 * @param {object} ctx - Pipeline context with ai, contextDocs, opts
 * @returns {object} Updated ctx with summarized contextDocs and deepSummaryStats
 */
async function phaseDeepSummary(ctx) {
  const log = getLog();
  const { opts, ai, contextDocs } = ctx;

  if (!opts.deepSummary || !ai || contextDocs.length === 0) {
    return { ...ctx, deepSummaryStats: null };
  }

  console.log('');
  console.log(c.cyan('  ── Deep Summary — Pre-summarizing context documents ──'));
  log.step('Deep summary: starting context document pre-summarization');
  if (log && log.phaseStart) log.phaseStart('deep_summary');

  const excludeNames = opts.deepSummaryExclude || [];
  let updatedDocs = contextDocs;
  let deepSummaryStats = null;

  try {
    const result = await deepSummarize(ai, contextDocs, {
      excludeFileNames: excludeNames,
      thinkingBudget: Math.min(8192, opts.thinkingBudget),
    });

    updatedDocs = result.docs;
    deepSummaryStats = result.stats;

    if (deepSummaryStats.summarized > 0) {
      console.log(`  ${c.success(`Summarized ${c.highlight(deepSummaryStats.summarized)} doc(s) — saved ~${c.highlight(deepSummaryStats.savedTokens.toLocaleString())} tokens (${c.yellow(deepSummaryStats.savingsPercent + '%')} reduction)`)}`);
      console.log(`    ${c.dim('Original:')} ~${deepSummaryStats.originalTokens.toLocaleString()} tokens → ${c.dim('Condensed:')} ~${deepSummaryStats.summaryTokens.toLocaleString()} tokens`);
      if (deepSummaryStats.keptFull > 0) {
        console.log(`    ${c.dim('Kept full:')} ${deepSummaryStats.keptFull} doc(s) (excluded from summary)`);
      }
      log.step(`Deep summary: ${deepSummaryStats.summarized} docs summarized, ${deepSummaryStats.savedTokens} tokens saved (${deepSummaryStats.savingsPercent}%)`);
      log.metric('deep_summary', deepSummaryStats);
    } else {
      console.log(`  ${c.dim('No documents needed summarization')}`);
    }
  } catch (err) {
    console.warn(`  ${c.warn(`Deep summary failed (continuing with full docs): ${err.message}`)}`);
    log.warn(`Deep summary failed: ${err.message}`);
  }

  if (log && log.phaseEnd) log.phaseEnd({ stats: deepSummaryStats });
  console.log('');

  return { ...ctx, contextDocs: updatedDocs, deepSummaryStats };
}

module.exports = { phaseServices, phaseDeepSummary };
