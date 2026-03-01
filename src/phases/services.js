'use strict';

const fs = require('fs');
const path = require('path');

// --- Services ---
const { initFirebase, uploadToStorage, storageExists } = require('../services/firebase');
const { initGemini, prepareDocsForGemini } = require('../services/gemini');

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

module.exports = phaseServices;
