'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Services ---
const { initFirebase, uploadToStorage, storageExists } = require('../services/firebase');
const { initGemini, prepareDocsForGemini } = require('../services/gemini');

// --- Modes ---
const { deepSummarize } = require('../modes/deep-summary');
const { isTranscriptFile } = require('../modes/deep-summary');

// --- Utils ---
const { parallelMap } = require('../utils/retry');
const { estimateTokens } = require('../utils/context-manager');

// --- Shared state ---
const { c } = require('../utils/colors');
const { getLog, isShuttingDown, phaseTimer, PROJECT_ROOT } = require('./_shared');

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
    let cached = 0;
    let uploaded = 0;
    const uploadWarnings = [];
    await parallelMap(allDocFiles, async ({ absPath: docPath, relPath }) => {
      if (isShuttingDown()) return;
      const docStoragePath = `calls/${callName}/documents/${relPath}`;
      try {
        if (!opts.forceUpload) {
          const existingUrl = await storageExists(storage, docStoragePath);
          if (existingUrl) {
            docStorageUrls[relPath] = existingUrl;
            cached++;
            return;
          }
        }
        const url = await uploadToStorage(storage, docPath, docStoragePath);
        docStorageUrls[relPath] = url;
        uploaded++;
      } catch (err) {
        uploadWarnings.push(`${relPath}: ${err.message}`);
      }
    }, opts.parallel);

    // Compact summary
    const total = cached + uploaded;
    if (uploaded === 0 && cached > 0) {
      console.log(`  ${c.success(`${total} doc(s) in Storage`)} ${c.dim('(all cached)')}`);
    } else if (uploaded > 0 && cached > 0) {
      console.log(`  ${c.success(`${total} doc(s) in Storage`)} ${c.dim(`(${cached} cached, ${uploaded} uploaded)`)}`);
    } else if (uploaded > 0) {
      console.log(`  ${c.success(`${uploaded} doc(s) uploaded to Storage`)}`);
    }
    for (const w of uploadWarnings) {
      console.warn(`    ${c.warn(`Upload failed: ${w}`)}`);
    }
  } else if (opts.skipUpload) {
    console.log(`  ${c.warn('Skipping document uploads (--skip-upload)')}`);
  } else {
    console.log(`  ${c.warn('Skipping document uploads (Firebase auth not configured)')}`);
  }
  console.log('');

  timer.end();
  return { ...ctx, storage, firebaseReady, ai, contextDocs, docStorageUrls, callName };
}

// ======================== DEEP SUMMARY CACHING HELPERS ========================

/**
 * Compute a fingerprint for the document set + exclude list.
 * Changes to any doc's content, additions/removals, or exclude-list changes
 * invalidate the cache.
 */
function deepSummaryFingerprint(contextDocs, excludeNames) {
  const hash = crypto.createHash('sha256');
  // Sort for determinism
  const sorted = [...contextDocs]
    .filter(d => d.content && !isTranscriptFile(d.fileName))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  for (const d of sorted) {
    hash.update(d.fileName);
    hash.update(String(d.content.length));
    // Include first 512 + last 512 chars for change detection without hashing megabytes
    hash.update(d.content.slice(0, 512));
    if (d.content.length > 512) hash.update(d.content.slice(-512));
  }
  hash.update(JSON.stringify([...excludeNames].sort()));
  return hash.digest('hex').slice(0, 16);
}

/**
 * Try to load a cached deep summary from gemini_runs/<callName>/.
 * @returns {{ summaries: Object, stats: Object } | null}
 */
function loadCachedDeepSummary(callName, fingerprint) {
  const cacheDir = path.join(PROJECT_ROOT, 'gemini_runs', callName);
  if (!fs.existsSync(cacheDir)) return null;
  const cacheFile = path.join(cacheDir, `deep_summary_${fingerprint}.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (data.fingerprint === fingerprint && data.summaries) return data;
    return null;
  } catch { return null; }
}

/**
 * Save deep summary result to cache.
 */
function saveCachedDeepSummary(callName, fingerprint, summaries, stats, excludeNames) {
  const cacheDir = path.join(PROJECT_ROOT, 'gemini_runs', callName);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `deep_summary_${fingerprint}.json`);
  const data = {
    fingerprint,
    savedAt: new Date().toISOString(),
    excludeNames: [...excludeNames],
    summaries,
    stats,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf8');
  return cacheFile;
}

/**
 * Apply cached summaries to context docs (same logic as deepSummarize's post-processing).
 * Returns { docs, stats }.
 */
function applyCachedSummaries(contextDocs, cached, excludeNames) {
  const excludeSet = new Set(excludeNames.map(n => n.toLowerCase()));
  const summaryMap = new Map();
  for (const [k, v] of Object.entries(cached.summaries)) {
    summaryMap.set(k.toLowerCase(), v);
  }

  let originalTokens = 0;
  let summaryTokens = 0;
  const resultDocs = [];

  for (const doc of contextDocs) {
    if (doc.type !== 'inlineText' && !doc.content) { resultDocs.push(doc); continue; }
    if (excludeSet.has(doc.fileName.toLowerCase())) { resultDocs.push(doc); continue; }
    if (isTranscriptFile(doc.fileName)) { resultDocs.push(doc); continue; }

    const summary = summaryMap.get(doc.fileName.toLowerCase());
    if (summary && summary.length > 0) {
      const origTok = estimateTokens(doc.content);
      const sumTok = estimateTokens(summary);
      originalTokens += origTok;
      summaryTokens += sumTok;
      const summarizedDoc = {
        ...doc,
        type: 'inlineText',
        content: `[Deep Summary — original: ~${origTok.toLocaleString()} tokens → condensed: ~${sumTok.toLocaleString()} tokens]\n\n${summary}`,
        _originalLength: doc.content.length,
        _summaryLength: summary.length,
        _deepSummarized: true,
      };
      delete summarizedDoc.fileUri;
      delete summarizedDoc.mimeType;
      delete summarizedDoc.geminiFileName;
      resultDocs.push(summarizedDoc);
    } else {
      resultDocs.push(doc);
    }
  }

  const savedTokens = originalTokens - summaryTokens;
  const savingsPercent = originalTokens > 0
    ? parseFloat(((savedTokens / originalTokens) * 100).toFixed(1))
    : 0;

  return {
    docs: resultDocs,
    stats: {
      ...cached.stats,
      originalTokens,
      summaryTokens,
      savedTokens,
      savingsPercent,
      cached: true,
    },
  };
}

// ======================== PHASE: DEEP SUMMARY ========================

/**
 * Pre-summarize context documents to save input tokens per segment.
 * Runs only when --deep-summary flag is active.
 * Caches results to gemini_runs/<callName>/deep_summary_<hash>.json.
 *
 * @param {object} ctx - Pipeline context with ai, contextDocs, opts
 * @returns {object} Updated ctx with summarized contextDocs and deepSummaryStats
 */
async function phaseDeepSummary(ctx) {
  const log = getLog();
  const { opts, ai, contextDocs, callName } = ctx;

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

  // --- Cache check ---
  const fingerprint = deepSummaryFingerprint(contextDocs, excludeNames);
  if (!opts.reanalyze) {
    const cached = loadCachedDeepSummary(callName, fingerprint);
    if (cached) {
      const applied = applyCachedSummaries(contextDocs, cached, excludeNames);
      updatedDocs = applied.docs;
      deepSummaryStats = applied.stats;
      console.log(`  ${c.success(`Loaded cached deep summary (${c.highlight(Object.keys(cached.summaries).length)} doc(s) condensed)`)}`);
      console.log(`    ${c.dim('Saved')} ~${deepSummaryStats.savedTokens.toLocaleString()} tokens (${c.yellow(deepSummaryStats.savingsPercent + '%')} reduction)`);
      console.log(`    ${c.dim(`Cache: deep_summary_${fingerprint}.json`)}`);
      log.step(`Deep summary: loaded from cache (fingerprint: ${fingerprint})`);
      if (log && log.phaseEnd) log.phaseEnd({ stats: deepSummaryStats, cached: true });
      console.log('');
      return { ...ctx, contextDocs: updatedDocs, deepSummaryStats };
    }
  }

  // --- Run Gemini summarization ---
  try {
    const result = await deepSummarize(ai, contextDocs, {
      excludeFileNames: excludeNames,
      thinkingBudget: Math.min(8192, opts.thinkingBudget),
    });

    updatedDocs = result.docs;
    deepSummaryStats = result.stats;

    if (deepSummaryStats.summarized > 0) {
      // Save to cache
      const rawSummaries = {};
      for (const doc of updatedDocs) {
        if (doc._deepSummarized && doc.content) {
          // Extract just the summary text (after the header line)
          const headerEnd = doc.content.indexOf('\n\n');
          rawSummaries[doc.fileName] = headerEnd >= 0 ? doc.content.slice(headerEnd + 2) : doc.content;
        }
      }
      const cacheFile = saveCachedDeepSummary(callName, fingerprint, rawSummaries, deepSummaryStats, excludeNames);
      console.log(`  ${c.success(`Summarized ${c.highlight(deepSummaryStats.summarized)} doc(s) — saved ~${c.highlight(deepSummaryStats.savedTokens.toLocaleString())} tokens (${c.yellow(deepSummaryStats.savingsPercent + '%')} reduction)`)}`);
      console.log(`    ${c.dim('Original:')} ~${deepSummaryStats.originalTokens.toLocaleString()} tokens → ${c.dim('Condensed:')} ~${deepSummaryStats.summaryTokens.toLocaleString()} tokens`);
      if (deepSummaryStats.keptFull > 0) {
        console.log(`    ${c.dim('Kept full:')} ${deepSummaryStats.keptFull} doc(s) (excluded from summary)`);
      }
      console.log(`    ${c.dim(`Cached → deep_summary_${fingerprint}.json`)}`);
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
