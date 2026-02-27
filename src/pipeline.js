/**
 * Pipeline orchestrator — main processing flow.
 *
 * Compress → Upload → AI Segment Analysis → AI Final Compilation → JSON + MD output.
 *
 * Architecture: each pipeline phase is a separate function that receives
 * a shared `ctx` (context) object. This makes phases independently testable
 * and allows the main `run()` to read as a clean sequence of steps.
 *
 * v6 improvements:
 *  - Confidence Scoring: every extracted item gets HIGH/MEDIUM/LOW confidence
 *  - Multi-Pass Focused Re-extraction: targeted second pass for weak areas
 *  - Learning Loop: historical analysis to auto-adjust budgets and thresholds
 *  - Diff-Aware Compilation: delta report comparing against previous runs
 *  - Structured Logging: JSONL structured log with phase spans and metrics
 *  - Parallel Segment Analysis: process 2-3 segments concurrently
 *  - All v5 features retained: quality gate, adaptive budget, boundary detection, health dashboard
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --- Config ---
const config = require('./config');
const {
  VIDEO_EXTS, DOC_EXTS, SPEED, SEG_TIME, PRESET,
  LOG_LEVEL, MAX_PARALLEL_UPLOADS, THINKING_BUDGET, COMPILATION_THINKING_BUDGET,
  validateConfig, GEMINI_MODELS, setActiveModel, getActiveModelPricing,
} = config;

// --- Services ---
const { initFirebase, uploadToStorage, storageExists } = require('./services/firebase');
const { initGemini, prepareDocsForGemini, processWithGemini, compileFinalResult, analyzeVideoForContext, cleanupGeminiFiles } = require('./services/gemini');
const { compressAndSegment, probeFormat, verifySegment } = require('./services/video');
const { isGitAvailable, isGitRepo, initRepo } = require('./services/git');

// --- Utils ---
const { findDocsRecursive } = require('./utils/fs');
const { fmtDuration, fmtBytes } = require('./utils/format');
const { promptUser, promptUserText } = require('./utils/prompt');
const { parseArgs, showHelp, selectFolder, selectModel } = require('./utils/cli');
const { parallelMap } = require('./utils/retry');
const Progress = require('./utils/progress');
const CostTracker = require('./utils/cost-tracker');
const { assessQuality, formatQualityLine, getConfidenceStats, THRESHOLDS } = require('./utils/quality-gate');
const { calculateThinkingBudget, calculateCompilationBudget } = require('./utils/adaptive-budget');
const { detectBoundaryContext, sliceVttForSegment } = require('./utils/context-manager');
const { buildHealthReport, printHealthDashboard } = require('./utils/health-dashboard');
const { identifyWeaknesses, runFocusedPass, mergeFocusedResults } = require('./utils/focused-reanalysis');
const { loadHistory, saveHistory, buildHistoryEntry, analyzeHistory, printLearningInsights } = require('./utils/learning-loop');
const { loadPreviousCompilation, generateDiff, renderDiffMarkdown } = require('./utils/diff-engine');
const { detectAllChanges, serializeReport } = require('./utils/change-detector');
const { assessProgressLocal, assessProgressWithAI, mergeProgressIntoAnalysis, buildProgressSummary, renderProgressMarkdown, STATUS_ICONS } = require('./utils/progress-updater');
const { discoverTopics, generateAllDocuments, writeDeepDiveOutput } = require('./utils/deep-dive');
const { planTopics, generateAllDynamicDocuments, writeDynamicOutput } = require('./utils/dynamic-mode');

// --- Renderers ---
const { renderResultsMarkdown } = require('./renderers/markdown');

// --- Logger ---
const Logger = require('./logger');

// Global reference — set in run()
let log = null;

// Graceful shutdown flag
let shuttingDown = false;

// ======================== PROJECT ROOT ========================
// PKG_ROOT = where the package is installed (for reading prompt.json, package.json)
// PROJECT_ROOT = where the user runs from (CWD) — logs, history, gemini_runs go here
const PKG_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = process.cwd();

// ======================== PHASE HELPERS ========================

/** Create a timing wrapper for phase profiling — also writes structured log spans */
function phaseTimer(phaseName) {
  const t0 = Date.now();
  if (log && log.phaseStart) log.phaseStart(phaseName);
  return {
    end(meta = {}) {
      const ms = Date.now() - t0;
      if (log && log.phaseEnd) log.phaseEnd({ ...meta, durationMs: ms });
      if (log) log.step(`PHASE ${phaseName} completed in ${(ms / 1000).toFixed(1)}s`);
      return ms;
    },
  };
}

// ======================== PHASE: INIT ========================

/**
 * Parse CLI args, validate config, initialize logger, set up shutdown handlers.
 * Returns the pipeline context object shared by all phases.
 */
async function phaseInit() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.help || flags.h) showHelp();
  if (flags.version || flags.v) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    process.stdout.write(`v${pkg.version}\n`);
    return null; // signal early exit
  }

  const opts = {
    skipUpload: !!flags['skip-upload'],
    forceUpload: !!flags['force-upload'],
    noStorageUrl: !!flags['no-storage-url'],
    skipCompression: !!flags['skip-compression'],
    skipGemini: !!flags['skip-gemini'],
    resume: !!flags.resume,
    reanalyze: !!flags.reanalyze,
    dryRun: !!flags['dry-run'],
    userName: flags.name || null,
    parallel: parseInt(flags.parallel, 10) || MAX_PARALLEL_UPLOADS,
    logLevel: flags['log-level'] || LOG_LEVEL,
    outputDir: flags.output || null,
    thinkingBudget: parseInt(flags['thinking-budget'], 10) || THINKING_BUDGET,
    compilationThinkingBudget: parseInt(flags['compilation-thinking-budget'], 10) || COMPILATION_THINKING_BUDGET,
    parallelAnalysis: parseInt(flags['parallel-analysis'], 10) || 2, // concurrent segment analysis
    disableFocusedPass: !!flags['no-focused-pass'],
    disableLearning: !!flags['no-learning'],
    disableDiff: !!flags['no-diff'],
    deepDive: !!flags['deep-dive'],
    dynamic: !!flags.dynamic,
    request: typeof flags.request === 'string' ? flags.request : null,
    updateProgress: !!flags['update-progress'],
    repoPath: flags.repo || null,
    model: typeof flags.model === 'string' ? flags.model : null,
  };

  // --- Resolve folder: positional arg or interactive selection ---
  let folderArg = positional[0];
  if (!folderArg) {
    folderArg = await selectFolder(PROJECT_ROOT);
    if (!folderArg) {
      showHelp();
    }
  }

  const targetDir = path.resolve(folderArg);
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw new Error(`"${targetDir}" is not a valid folder. Check the path and try again.`);
  }

  // --- Validate configuration ---
  const configCheck = validateConfig({
    skipFirebase: opts.skipUpload,
    skipGemini: opts.skipGemini,
  });
  if (!configCheck.valid) {
    console.error('\n  Configuration errors:');
    configCheck.errors.forEach(e => console.error(`    ✗ ${e}`));
    console.error('\n  Fix these in .env or environment variables. See .env.example for reference.\n');
    throw new Error('Invalid configuration. See errors above.');
  }

  // --- Initialize logger ---
  const logsDir = path.join(PROJECT_ROOT, 'logs');
  log = new Logger(logsDir, path.basename(targetDir), { level: opts.logLevel });
  log.patchConsole();
  log.step(`START processing "${path.basename(targetDir)}"`);

  // --- Learning Loop: load historical insights ---
  let learningInsights = { hasData: false, budgetAdjustment: 0, compilationBudgetAdjustment: 0 };
  if (!opts.disableLearning) {
    const history = loadHistory(PROJECT_ROOT);
    learningInsights = analyzeHistory(history);
    if (learningInsights.hasData) {
      printLearningInsights(learningInsights);
      // Apply budget adjustments from learning
      if (learningInsights.budgetAdjustment !== 0) {
        opts.thinkingBudget = Math.max(8192, opts.thinkingBudget + learningInsights.budgetAdjustment);
        log.step(`Learning: adjusted thinking budget → ${opts.thinkingBudget}`);
      }
      if (learningInsights.compilationBudgetAdjustment !== 0) {
        opts.compilationThinkingBudget = Math.max(8192, opts.compilationThinkingBudget + learningInsights.compilationBudgetAdjustment);
        log.step(`Learning: adjusted compilation budget → ${opts.compilationThinkingBudget}`);
      }
    }
  }

  // --- Graceful shutdown handler ---
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(`\n  ⚠ Received ${signal} — shutting down gracefully...`);
    log.step(`SHUTDOWN requested (${signal})`);
    log.close();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // --- Model selection ---
  if (opts.model) {
    // CLI flag: --model <id> — validate and activate
    setActiveModel(opts.model);
    log.step(`Model set via flag: ${config.GEMINI_MODEL}`);
  } else {
    // Interactive model selection
    const chosenModel = await selectModel(GEMINI_MODELS, config.GEMINI_MODEL);
    setActiveModel(chosenModel);
    log.step(`Model selected: ${config.GEMINI_MODEL}`);
  }

  // --- Initialize progress tracking ---
  const progress = new Progress(targetDir);
  const costTracker = new CostTracker(getActiveModelPricing());

  return { opts, targetDir, progress, costTracker };
}

// ======================== PHASE: DISCOVER ========================

/**
 * Discover videos and documents, resolve user name, show banner.
 * Returns augmented ctx with videoFiles, allDocFiles, userName.
 */
async function phaseDiscover(ctx) {
  const timer = phaseTimer('discover');
  const { opts, targetDir, progress } = ctx;

  console.log('');
  console.log('==============================================');
  console.log(' Video Compress → Upload → AI Process');
  console.log('==============================================');

  // Show active flags
  const activeFlags = [];
  if (opts.skipUpload) activeFlags.push('skip-upload');
  if (opts.forceUpload) activeFlags.push('force-upload');
  if (opts.noStorageUrl) activeFlags.push('no-storage-url');
  if (opts.skipCompression) activeFlags.push('skip-compression');
  if (opts.skipGemini) activeFlags.push('skip-gemini');
  if (opts.resume) activeFlags.push('resume');
  if (opts.reanalyze) activeFlags.push('reanalyze');
  if (opts.dryRun) activeFlags.push('dry-run');
  if (activeFlags.length > 0) {
    console.log(`  Flags: ${activeFlags.join(', ')}`);
  }
  console.log('');

  // --- Resume check ---
  if (opts.resume && progress.hasResumableState()) {
    progress.printResumeSummary();
    console.log('');
  }

  // --- Ask for user's name (or use --name flag) ---
  let userName = opts.userName;
  if (!userName) {
    if (opts.resume && progress.state.userName) {
      userName = progress.state.userName;
      console.log(`  Using saved name: ${userName}`);
    } else {
      userName = await promptUserText('  Your name (for task assignment detection): ');
    }
  }
  if (!userName) {
    throw new Error('Name is required for personalized analysis. Use --name "Your Name" or enter it when prompted.');
  }
  log.step(`User identified as: ${userName}`);

  // --- Find video files ---
  let videoFiles = fs.readdirSync(targetDir)
    .filter(f => {
      const stat = fs.statSync(path.join(targetDir, f));
      return stat.isFile() && VIDEO_EXTS.includes(path.extname(f).toLowerCase());
    })
    .map(f => path.join(targetDir, f));

  if (videoFiles.length === 0) {
    throw new Error('No video files found (mp4/mkv/avi/mov/webm). Check that the folder contains video files.');
  }

  // --- Find ALL document files recursively ---
  const allDocFiles = findDocsRecursive(targetDir, DOC_EXTS);

  console.log('');
  console.log(`  User    : ${userName}`);
  console.log(`  Source  : ${targetDir}`);
  console.log(`  Videos  : ${videoFiles.length}`);
  console.log(`  Docs    : ${allDocFiles.length}`);
  console.log(`  Speed   : ${SPEED}x`);
  console.log(`  Segments: < 5 min each (${SEG_TIME}s)`);
  console.log(`  Model   : ${config.GEMINI_MODEL}`);
  console.log(`  Parallel: ${opts.parallel} concurrent uploads`);
  console.log(`  Thinking: ${opts.thinkingBudget} tokens (analysis) / ${opts.compilationThinkingBudget} tokens (compilation)`);
  console.log('');

  // Save progress init
  progress.init(path.basename(targetDir), userName);

  console.log(`  Found ${videoFiles.length} video file(s):`);
  videoFiles.forEach((f, i) => console.log(`    [${i + 1}] ${path.basename(f)}`));

  // If multiple video files found, let user select which to process
  if (videoFiles.length > 1) {
    console.log('');
    const selectionInput = await promptUserText(`  Which files to process? (comma-separated numbers, or "all", default: all): `);
    const trimmed = (selectionInput || '').trim().toLowerCase();
    if (trimmed && trimmed !== 'all') {
      const indices = trimmed.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0 && n < videoFiles.length);
      if (indices.length > 0) {
        videoFiles = indices.map(i => videoFiles[i]);
        console.log(`  → Processing ${videoFiles.length} selected file(s):`);
        videoFiles.forEach(f => console.log(`    - ${path.basename(f)}`));
      } else {
        console.log('  → Invalid selection, processing all files');
      }
    } else {
      console.log('  → Processing all video files');
    }
  }
  log.step(`Found ${videoFiles.length} video(s): ${videoFiles.map(f => path.basename(f)).join(', ')}`);
  console.log('');

  if (allDocFiles.length > 0) {
    console.log(`  Found ${allDocFiles.length} document(s) for context (recursive):`);
    allDocFiles.forEach(f => console.log(`    - ${f.relPath}`));
    console.log('');
  }

  timer.end();
  return { ...ctx, videoFiles, allDocFiles, userName };
}

// ======================== PHASE: SERVICES ========================

/**
 * Initialize Firebase and Gemini services, prepare context documents.
 * Returns augmented ctx with storage, firebaseReady, ai, contextDocs.
 */
async function phaseServices(ctx) {
  const timer = phaseTimer('services');
  const { opts, allDocFiles } = ctx;
  const callName = path.basename(ctx.targetDir);

  console.log('Initializing services...');

  let storage = null;
  let firebaseReady = false;
  if (!opts.skipUpload && !opts.dryRun) {
    const fb = await initFirebase();
    storage = fb.storage;
    firebaseReady = fb.authenticated;
  } else if (opts.skipUpload) {
    console.log('  Firebase: skipped (--skip-upload)');
  } else {
    console.log('  Firebase: skipped (--dry-run)');
  }

  let ai = null;
  if (!opts.skipGemini && !opts.dryRun) {
    ai = await initGemini();
    console.log('  Gemini AI: ready');
  } else if (opts.skipGemini) {
    console.log('  Gemini AI: skipped (--skip-gemini)');
  } else {
    console.log('  Gemini AI: skipped (--dry-run)');
  }

  log.step(`Services: Firebase auth=${firebaseReady}, Gemini=${ai ? 'ready' : 'skipped'}`);

  // --- Prepare documents for Gemini ---
  let contextDocs = [];
  if (ai) {
    contextDocs = await prepareDocsForGemini(ai, allDocFiles);
  } else if (allDocFiles.length > 0) {
    console.log(`  ⚠ Skipping Gemini doc preparation (AI not active)`);
    contextDocs = allDocFiles
      .filter(({ absPath }) => ['.txt', '.md', '.vtt', '.srt', '.csv', '.json', '.xml', '.html']
        .includes(path.extname(absPath).toLowerCase()))
      .map(({ absPath, relPath }) => ({
        type: 'inlineText',
        fileName: relPath,
        content: fs.readFileSync(absPath, 'utf8'),
      }));
  }

  // --- Upload documents to Firebase Storage for archival ---
  const docStorageUrls = {};
  if (firebaseReady && !opts.skipUpload) {
    await parallelMap(allDocFiles, async ({ absPath: docPath, relPath }) => {
      if (shuttingDown) return;
      const docStoragePath = `calls/${callName}/documents/${relPath}`;
      try {
        if (!opts.forceUpload) {
          const existingUrl = await storageExists(storage, docStoragePath);
          if (existingUrl) {
            docStorageUrls[relPath] = existingUrl;
            console.log(`  ✓ Document already in Storage → ${docStoragePath}`);
            return;
          }
        }
        const url = await uploadToStorage(storage, docPath, docStoragePath);
        docStorageUrls[relPath] = url;
        console.log(`  ✓ Document ${opts.forceUpload ? '(re-uploaded)' : '→'} ${docStoragePath}`);
      } catch (err) {
        console.warn(`  ⚠ Document upload failed (${relPath}): ${err.message}`);
      }
    }, opts.parallel);
  } else if (opts.skipUpload) {
    console.log('  ⚠ Skipping document uploads (--skip-upload)');
  } else {
    console.log('  ⚠ Skipping document uploads (Firebase auth not configured)');
  }
  console.log('');

  timer.end();
  return { ...ctx, storage, firebaseReady, ai, contextDocs, docStorageUrls, callName };
}

// ======================== PHASE: PROCESS VIDEO ========================

/**
 * Process a single video: compress → upload segments → analyze with Gemini.
 * Returns { fileResult, segmentAnalyses }.
 */
async function phaseProcessVideo(ctx, videoPath, videoIndex) {
  const {
    opts, callName, storage, firebaseReady, ai, contextDocs,
    progress, costTracker, userName,
  } = ctx;

  const baseName = path.basename(videoPath, path.extname(videoPath));
  const compressedDir = path.join(ctx.targetDir, 'compressed');

  console.log('──────────────────────────────────────────────');
  console.log(`[${videoIndex + 1}/${ctx.videoFiles.length}] ${path.basename(videoPath)}`);
  console.log('──────────────────────────────────────────────');

  // ---- Compress & Segment ----
  log.step(`Compressing "${path.basename(videoPath)}"`);
  const segmentDir = path.join(compressedDir, baseName);
  let segments;
  const existingSegments = fs.existsSync(segmentDir)
    ? fs.readdirSync(segmentDir).filter(f => f.startsWith('segment_') && f.endsWith('.mp4')).sort()
    : [];

  if (opts.skipCompression || opts.dryRun) {
    if (existingSegments.length > 0) {
      segments = existingSegments.map(f => path.join(segmentDir, f));
      console.log(`  ✓ Using ${segments.length} existing segment(s) (${opts.dryRun ? '--dry-run' : '--skip-compression'})`);
    } else {
      console.warn(`  ⚠ No existing segments found — cannot skip compression for "${baseName}"`);
      if (opts.dryRun) {
        console.log(`  [DRY-RUN] Would compress "${path.basename(videoPath)}" into segments`);
        return { fileResult: null, segmentAnalyses: [] };
      }
      segments = compressAndSegment(videoPath, segmentDir);
      log.step(`Compressed → ${segments.length} segment(s)`);
    }
  } else if (existingSegments.length > 0) {
    segments = existingSegments.map(f => path.join(segmentDir, f));
    log.step(`SKIP compression — ${segments.length} segment(s) already on disk`);
    console.log(`  ✓ Skipped compression — ${segments.length} segment(s) already exist`);
  } else {
    segments = compressAndSegment(videoPath, segmentDir);
    log.step(`Compressed → ${segments.length} segment(s)`);
    console.log(`  → ${segments.length} segment(s) created`);
  }

  progress.markCompressed(baseName, segments.length);
  const origSize = fs.statSync(videoPath).size;
  log.step(`original=${(origSize / 1048576).toFixed(2)}MB (${fmtBytes(origSize)}) | ${segments.length} segment(s)`);
  console.log('');

  const fileResult = {
    originalFile: path.basename(videoPath),
    originalSizeMB: (origSize / 1048576).toFixed(2),
    segmentCount: segments.length,
    segments: [],
  };

  // ---- Pre-validate all segments before sending to Gemini ----
  if (!opts.skipGemini && !opts.dryRun) {
    const invalidSegs = segments.filter(s => !verifySegment(s));
    if (invalidSegs.length > 0) {
      console.warn(`  ⚠ Pre-validation: ${invalidSegs.length}/${segments.length} segment(s) are corrupt:`);
      invalidSegs.forEach(s => console.warn(`    ✗ ${path.basename(s)}`));
      console.warn(`    → Corrupt segments will be skipped during analysis.`);
      console.warn(`    → Delete "${segmentDir}" and re-run to re-compress.`);
      log.warn(`Pre-validation: ${invalidSegs.length} corrupt segments in ${baseName}`);
    }
  }

  // ---- Upload all segments to Firebase (parallel) ----
  progress.setPhase('upload');
  const segmentMeta = [];

  if (!opts.skipUpload && firebaseReady && !opts.dryRun) {
    const metaList = segments.map((segPath) => {
      const segName = path.basename(segPath);
      const storagePath = `calls/${callName}/segments/${baseName}/${segName}`;
      const durStr = probeFormat(segPath, 'duration');
      const durSec = durStr ? parseFloat(durStr) : null;
      const sizeMB = (fs.statSync(segPath).size / 1048576).toFixed(2);
      return { segPath, segName, storagePath, durSec, sizeMB, storageUrl: null };
    });

    await parallelMap(metaList, async (meta, j) => {
      if (shuttingDown) return;
      console.log(`  ── Segment ${j + 1}/${segments.length}: ${meta.segName} (upload) ──`);
      console.log(`    Duration: ${fmtDuration(meta.durSec)} | Size: ${meta.sizeMB} MB`);

      const resumedUrl = progress.getUploadUrl(meta.storagePath);
      if (resumedUrl && opts.resume) {
        meta.storageUrl = resumedUrl;
        console.log(`    ✓ Upload resumed from checkpoint`);
        return;
      }

      try {
        if (!opts.forceUpload) {
          const existingUrl = await storageExists(storage, meta.storagePath);
          if (existingUrl) {
            meta.storageUrl = existingUrl;
            log.step(`SKIP upload — ${meta.segName} already in Storage`);
            console.log(`    ✓ Already in Storage → ${meta.storagePath}`);
            progress.markUploaded(meta.storagePath, meta.storageUrl);
            return;
          }
        }
        console.log(`    ${opts.forceUpload ? 'Re-uploading' : 'Uploading'} to Firebase Storage...`);
        meta.storageUrl = await uploadToStorage(storage, meta.segPath, meta.storagePath);
        console.log(`    ✓ ${opts.forceUpload ? 'Re-uploaded' : 'Uploaded'} → ${meta.storagePath}`);
        log.step(`Upload OK: ${meta.segName} → ${meta.storagePath}`);
        progress.markUploaded(meta.storagePath, meta.storageUrl);
      } catch (err) {
        console.error(`    ✗ Firebase upload failed: ${err.message}`);
        log.error(`Upload FAIL: ${meta.segName} — ${err.message}`);
      }
    }, opts.parallel);

    segmentMeta.push(...metaList);
  } else {
    for (let j = 0; j < segments.length; j++) {
      const segPath = segments[j];
      const segName = path.basename(segPath);
      const storagePath = `calls/${callName}/segments/${baseName}/${segName}`;
      const durStr = probeFormat(segPath, 'duration');
      const durSec = durStr ? parseFloat(durStr) : null;
      const sizeMB = (fs.statSync(segPath).size / 1048576).toFixed(2);

      console.log(`  ── Segment ${j + 1}/${segments.length}: ${segName} ──`);
      console.log(`    Duration: ${fmtDuration(durSec)} | Size: ${sizeMB} MB`);
      if (opts.skipUpload) console.log(`    ⚠ Upload skipped (--skip-upload)`);

      segmentMeta.push({ segPath, segName, storagePath, storageUrl: null, durSec, sizeMB });
    }
  }

  // Calculate cumulative time offsets for VTT time-slicing
  let cumulativeTimeSec = 0;
  for (const meta of segmentMeta) {
    meta.startTimeSec = cumulativeTimeSec;
    meta.endTimeSec = cumulativeTimeSec + (meta.durSec || 0) * SPEED;
    cumulativeTimeSec = meta.endTimeSec;
  }

  console.log('');
  log.step(`All ${segments.length} segment(s) processed. Starting Gemini analysis...`);
  console.log('');

  // ---- Analyze all segments with Gemini ----
  progress.setPhase('analyze');
  const geminiRunsDir = path.join(PROJECT_ROOT, 'gemini_runs', callName, baseName);
  fs.mkdirSync(geminiRunsDir, { recursive: true });

  let forceReanalyze = opts.reanalyze;
  if (!forceReanalyze && !opts.skipGemini && !opts.dryRun) {
    const allExistingRuns = fs.readdirSync(geminiRunsDir).filter(f => f.endsWith('.json'));
    if (allExistingRuns.length > 0) {
      console.log(`  Found ${allExistingRuns.length} existing Gemini run file(s) in:`);
      console.log(`    ${geminiRunsDir}`);
      console.log('');
      if (!opts.resume) {
        forceReanalyze = await promptUser('  Re-analyze all segments? (y/n, default: n): ');
      }
      if (forceReanalyze) {
        console.log('  → Will re-analyze all segments (previous runs preserved with timestamps)');
        log.step('User chose to re-analyze all segments');
      } else {
        console.log('  → Using cached results where available');
      }
      console.log('');
    }
  }

  const previousAnalyses = [];
  const segmentAnalyses = [];
  const segmentReports = []; // Quality reports for health dashboard

  for (let j = 0; j < segments.length; j++) {
    if (shuttingDown) break;

    const { segPath, segName, storagePath, storageUrl, durSec, sizeMB } = segmentMeta[j];

    console.log(`  ── Segment ${j + 1}/${segments.length}: ${segName} (AI) ──`);

    if (opts.skipGemini) {
      console.log(`    ⚠ Skipped (--skip-gemini)`);
      fileResult.segments.push({
        segmentFile: segName, segmentIndex: j,
        storagePath, storageUrl,
        duration: fmtDuration(durSec), durationSeconds: durSec,
        fileSizeMB: parseFloat(sizeMB), geminiRunFile: null, analysis: null,
      });
      console.log('');
      continue;
    }

    if (opts.dryRun) {
      console.log(`    [DRY-RUN] Would analyze with ${config.GEMINI_MODEL}`);
      fileResult.segments.push({
        segmentFile: segName, segmentIndex: j,
        storagePath, storageUrl,
        duration: fmtDuration(durSec), durationSeconds: durSec,
        fileSizeMB: parseFloat(sizeMB), geminiRunFile: null, analysis: null,
      });
      console.log('');
      continue;
    }

    const runPrefix = `segment_${String(j).padStart(2, '0')}_`;
    const existingRuns = fs.readdirSync(geminiRunsDir)
      .filter(f => f.startsWith(runPrefix) && f.endsWith('.json'))
      .sort();
    const latestRunFile = existingRuns.length > 0 ? existingRuns[existingRuns.length - 1] : null;
    const latestRunPath = latestRunFile ? path.join(geminiRunsDir, latestRunFile) : null;

    let analysis = null;
    let geminiRunFile = null;

    // Skip if valid run exists and user didn't choose to re-analyze
    if (!forceReanalyze && latestRunPath && fs.existsSync(latestRunPath)) {
      try {
        const existingRun = JSON.parse(fs.readFileSync(latestRunPath, 'utf8'));
        geminiRunFile = path.relative(PROJECT_ROOT, path.join(geminiRunsDir, latestRunFile));
        analysis = existingRun.output.parsed || { rawResponse: existingRun.output.raw };
        analysis._geminiMeta = {
          model: existingRun.run.model,
          processedAt: existingRun.run.timestamp,
          durationMs: existingRun.run.durationMs,
          tokenUsage: existingRun.run.tokenUsage || null,
          runFile: geminiRunFile,
          parseSuccess: existingRun.output.parseSuccess,
          skipped: true,
        };
        previousAnalyses.push(analysis);
        // Track cached run costs too
        if (existingRun.run.tokenUsage) {
          costTracker.addSegment(segName, existingRun.run.tokenUsage, existingRun.run.durationMs, true);
        }

        // Quality gate on cached results
        const cachedQuality = assessQuality(analysis, {
          parseSuccess: existingRun.output.parseSuccess,
          rawLength: (existingRun.output.raw || '').length,
        });
        segmentReports.push({ segmentName: segName, qualityReport: cachedQuality, retried: false, retryImproved: false });
        console.log(formatQualityLine(cachedQuality, segName));

        const ticketCount = analysis.tickets ? analysis.tickets.length : 0;
        log.step(`SKIP Gemini — ${segName} already analyzed (${ticketCount} ticket(s), quality: ${cachedQuality.score}/100)`);
        console.log(`    ✓ Already analyzed — loaded from ${latestRunFile}`);
      } catch (err) {
        console.warn(`    ⚠ Existing run file corrupt, re-analyzing: ${err.message}`);
        analysis = null;
      }
    }

    if (!analysis) {
      // Pre-flight: verify segment is a valid MP4
      if (!verifySegment(segPath)) {
        console.error(`    ✗ Segment "${segName}" is corrupt (missing moov atom / unreadable).`);
        console.error(`      → Delete "${path.dirname(segPath)}" and re-run to re-compress.`);
        log.error(`Segment corrupt: ${segName} — skipping Gemini`);
        analysis = { error: `Segment file corrupt: ${segName}` };
        fileResult.segments.push({
          segmentFile: segName, segmentIndex: j,
          storagePath, storageUrl,
          duration: fmtDuration(durSec), durationSeconds: durSec,
          fileSizeMB: parseFloat(sizeMB), geminiRunFile: null, analysis,
        });
        console.log('');
        continue;
      }

      // === ADAPTIVE THINKING BUDGET ===
      // Find VTT content for this segment for complexity analysis
      let vttContentForAnalysis = '';
      for (const doc of contextDocs) {
        if (doc.type === 'inlineText' && (doc.fileName.endsWith('.vtt') || doc.fileName.endsWith('.srt'))) {
          if (segmentMeta[j].startTimeSec != null && segmentMeta[j].endTimeSec != null) {
            vttContentForAnalysis = sliceVttForSegment(doc.content, segmentMeta[j].startTimeSec, segmentMeta[j].endTimeSec);
          } else {
            vttContentForAnalysis = doc.content;
          }
          break;
        }
      }

      const budgetResult = calculateThinkingBudget({
        segmentIndex: j,
        totalSegments: segments.length,
        previousAnalyses,
        contextDocs,
        vttContent: vttContentForAnalysis,
        baseBudget: opts.thinkingBudget,
      });
      const adaptiveBudget = budgetResult.budget;
      console.log(`    Thinking budget: ${adaptiveBudget.toLocaleString()} tokens (${budgetResult.reason})`);
      if (budgetResult.complexity.complexityScore > 0) {
        log.debug(`Segment ${j} complexity: ${budgetResult.complexity.complexityScore}/100 — words:${budgetResult.complexity.wordCount} speakers:${budgetResult.complexity.speakerCount} tech:${budgetResult.complexity.hasTechnicalTerms}`);
      }

      // === SMART BOUNDARY CONTEXT ===
      const prevAnalysis = previousAnalyses.length > 0 ? previousAnalyses[previousAnalyses.length - 1] : null;
      const boundaryCtx = detectBoundaryContext(
        vttContentForAnalysis,
        segmentMeta[j].startTimeSec || 0,
        segmentMeta[j].endTimeSec || 0,
        j,
        prevAnalysis
      );

      // === FIRST ATTEMPT ===
      let retried = false;
      let retryImproved = false;
      let geminiFileUri = null;   // Gemini File API URI — reused for retry + focused pass
      let geminiFileMime = null;
      let geminiFileName = null;  // Gemini resource name — needed for cleanup

      try {
        const geminiRun = await processWithGemini(
          ai, segPath,
          `${callName}_${baseName}_seg${String(j).padStart(2, '0')}`,
          contextDocs,
          previousAnalyses,
          userName,
          PKG_ROOT,
          {
            segmentIndex: j,
            totalSegments: segments.length,
            segmentStartSec: segmentMeta[j].startTimeSec,
            segmentEndSec: segmentMeta[j].endTimeSec,
            thinkingBudget: adaptiveBudget,
            boundaryContext: boundaryCtx,
            storageDownloadUrl: opts.noStorageUrl ? null : (storageUrl || null),
          }
        );

        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const runFileName = `segment_${String(j).padStart(2, '0')}_${ts}.json`;
        const runFilePath = path.join(geminiRunsDir, runFileName);
        fs.writeFileSync(runFilePath, JSON.stringify(geminiRun, null, 2), 'utf8');
        geminiRunFile = path.relative(PROJECT_ROOT, runFilePath);
        log.debug(`Gemini model run saved → ${runFilePath}`);

        // Capture Gemini File API URI for reuse in retry / focused pass
        // When external URL was used, fileUri IS the storage URL — reuse it the same way
        geminiFileUri = geminiRun.input.videoFile.fileUri;
        geminiFileMime = geminiRun.input.videoFile.mimeType;
        geminiFileName = geminiRun.input.videoFile.geminiFileName || null;
        const usedExternalUrl = geminiRun.input.videoFile.usedExternalUrl || false;

        analysis = geminiRun.output.parsed || { rawResponse: geminiRun.output.raw };
        analysis._geminiMeta = {
          model: geminiRun.run.model,
          processedAt: geminiRun.run.timestamp,
          durationMs: geminiRun.run.durationMs,
          tokenUsage: geminiRun.run.tokenUsage || null,
          runFile: geminiRunFile,
          parseSuccess: geminiRun.output.parseSuccess,
        };

        // Track cost
        costTracker.addSegment(segName, geminiRun.run.tokenUsage, geminiRun.run.durationMs, false);

        // === QUALITY GATE ===
        const qualityReport = assessQuality(analysis, {
          parseSuccess: geminiRun.output.parseSuccess,
          rawLength: (geminiRun.output.raw || '').length,
          segmentIndex: j,
          totalSegments: segments.length,
        });
        console.log(formatQualityLine(qualityReport, segName));

        // === AUTO-RETRY on FAIL ===
        if (qualityReport.shouldRetry && !shuttingDown) {
          console.log(`    ↻ Quality below threshold (${qualityReport.score}/${THRESHOLDS.PASS}) — retrying with enhanced hints...`);
          log.step(`Quality gate FAIL for ${segName} (score: ${qualityReport.score}) — retrying`);
          retried = true;

          // Boost thinking budget for retry (+25%)
          const retryBudget = Math.min(32768, Math.round(adaptiveBudget * 1.25));

          try {
            const retryRun = await processWithGemini(
              ai, segPath,
              `${callName}_${baseName}_seg${String(j).padStart(2, '0')}_retry`,
              contextDocs,
              previousAnalyses,
              userName,
              PKG_ROOT,
              {
                segmentIndex: j,
                totalSegments: segments.length,
                segmentStartSec: segmentMeta[j].startTimeSec,
                segmentEndSec: segmentMeta[j].endTimeSec,
                thinkingBudget: retryBudget,
                boundaryContext: boundaryCtx,
                retryHints: qualityReport.retryHints,
                existingFileUri: geminiFileUri,
                existingFileMime: geminiFileMime,
                existingGeminiFileName: geminiFileName,
              }
            );

            const retryTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const retryRunFileName = `segment_${String(j).padStart(2, '0')}_retry_${retryTs}.json`;
            const retryRunFilePath = path.join(geminiRunsDir, retryRunFileName);
            fs.writeFileSync(retryRunFilePath, JSON.stringify(retryRun, null, 2), 'utf8');

            const retryAnalysis = retryRun.output.parsed || { rawResponse: retryRun.output.raw };
            const retryQuality = assessQuality(retryAnalysis, {
              parseSuccess: retryRun.output.parseSuccess,
              rawLength: (retryRun.output.raw || '').length,
              segmentIndex: j,
              totalSegments: segments.length,
            });

            // Track retry cost
            costTracker.addSegment(`${segName}_retry`, retryRun.run.tokenUsage, retryRun.run.durationMs, false);

            // Use retry result if better
            if (retryQuality.score > qualityReport.score) {
              retryImproved = true;
              analysis = retryAnalysis;
              analysis._geminiMeta = {
                model: retryRun.run.model,
                processedAt: retryRun.run.timestamp,
                durationMs: retryRun.run.durationMs,
                tokenUsage: retryRun.run.tokenUsage || null,
                runFile: path.relative(PROJECT_ROOT, retryRunFilePath),
                parseSuccess: retryRun.output.parseSuccess,
                retryOf: geminiRunFile,
              };
              geminiRunFile = path.relative(PROJECT_ROOT, retryRunFilePath);
              console.log(`    ✓ Retry improved quality: ${qualityReport.score} → ${retryQuality.score}`);
              console.log(formatQualityLine(retryQuality, segName));
              log.step(`Retry improved ${segName}: ${qualityReport.score} → ${retryQuality.score}`);
              segmentReports.push({ segmentName: segName, qualityReport: retryQuality, retried: true, retryImproved: true });
            } else {
              console.log(`    ⚠ Retry did not improve (${qualityReport.score} → ${retryQuality.score}), keeping original`);
              segmentReports.push({ segmentName: segName, qualityReport, retried: true, retryImproved: false });
            }
          } catch (retryErr) {
            console.warn(`    ⚠ Retry failed: ${retryErr.message} — keeping original result`);
            segmentReports.push({ segmentName: segName, qualityReport, retried: true, retryImproved: false });
          }
        } else {
          segmentReports.push({ segmentName: segName, qualityReport, retried: false, retryImproved: false });
        }

        // === FOCUSED RE-ANALYSIS (v6) ===
        if (!opts.disableFocusedPass && ai && !shuttingDown) {
          const lastReport = segmentReports[segmentReports.length - 1];
          const weakness = identifyWeaknesses(lastReport.qualityReport, analysis);
          if (weakness.shouldReanalyze) {
            console.log(`    🔍 Focused re-analysis: ${weakness.weakAreas.length} weak area(s) → ${weakness.weakAreas.join(', ')}`);
            log.step(`Focused re-analysis for ${segName}: ${weakness.weakAreas.join(', ')}`);
            try {
              const focusedResult = await runFocusedPass(ai, analysis, weakness.focusPrompt, {
                videoUri: geminiFileUri || null,
                segmentIndex: j,
                totalSegments: segments.length,
                thinkingBudget: 12288,
              });
              if (focusedResult) {
                analysis = mergeFocusedResults(analysis, focusedResult);
                if (focusedResult._focusedPassMeta) {
                  costTracker.addSegment(`${segName}_focused`, focusedResult._focusedPassMeta, 0, false);
                }
                console.log(`    ✓ Focused pass enhanced ${weakness.weakAreas.length} area(s)`);
                log.step(`Focused re-analysis merged for ${segName}`);
              } else {
                console.log(`    ℹ Focused pass found no additional items`);
              }
            } catch (focErr) {
              console.warn(`    ⚠ Focused re-analysis error: ${focErr.message}`);
              log.warn(`Focused re-analysis failed for ${segName}: ${focErr.message}`);
            }
          }
        }

        // === CONFIDENCE STATS (v6) ===
        const confStats = getConfidenceStats(analysis);
        if (confStats.total > 0) {
          console.log(`    Confidence: ${confStats.high}H/${confStats.medium}M/${confStats.low}L/${confStats.missing}? (${confStats.coverage}% coverage)`);
          if (log.metric) log.metric('confidence_coverage', confStats.coverage);
        }

        previousAnalyses.push(analysis);

        // === CLEANUP: delete Gemini File API upload after all passes ===
        // Skip cleanup when external URL was used — no Gemini file was uploaded
        if (geminiFileName && ai && !usedExternalUrl) {
          cleanupGeminiFiles(ai, geminiFileName).catch(() => {});
        }

        const ticketCount = analysis.tickets ? analysis.tickets.length : 0;
        const tok = geminiRun.run.tokenUsage || {};
        const sourceLabel = usedExternalUrl ? 'via Storage URL' : (geminiFileName ? 'via File API' : 'direct');
        log.step(`Gemini OK: ${segName} (${sourceLabel}) — ${ticketCount} ticket(s) | ${geminiRun.run.durationMs}ms | tokens: ${tok.inputTokens || 0}in/${tok.outputTokens || 0}out/${tok.thoughtTokens || 0}think/${tok.totalTokens || 0}total`);
        log.debug(`Gemini parsed: ${JSON.stringify(analysis).substring(0, 500)}`);
        console.log(`    ✓ AI analysis complete (${(geminiRun.run.durationMs / 1000).toFixed(1)}s)${retried ? (retryImproved ? ' [retry improved]' : ' [retried]') : ''}`);
        progress.markAnalyzed(`${baseName}_seg${j}`, geminiRunFile);
      } catch (err) {
        console.error(`    ✗ Gemini failed: ${err.message}`);
        log.error(`Gemini FAIL: ${segName} — ${err.message}`);
        analysis = { error: err.message };
        segmentReports.push({ segmentName: segName, qualityReport: { grade: 'FAIL', score: 0, issues: [err.message] }, retried: false, retryImproved: false });
      }
    }

    fileResult.segments.push({
      segmentFile: segName,
      segmentIndex: j,
      storagePath,
      storageUrl,
      duration: fmtDuration(durSec),
      durationSeconds: durSec,
      fileSizeMB: parseFloat(sizeMB),
      geminiRunFile,
      analysis,
    });

    // Collect for final compilation (skip errored)
    if (analysis && !analysis.error) {
      const segNum = j + 1;
      const tagSeg = (arr) => (arr || []).forEach(item => { item.source_segment = segNum; });
      tagSeg(analysis.action_items);
      tagSeg(analysis.change_requests);
      tagSeg(analysis.blockers);
      tagSeg(analysis.scope_changes);
      tagSeg(analysis.file_references);
      if (analysis.tickets) {
        analysis.tickets.forEach(t => {
          t.source_segment = segNum;
          tagSeg(t.comments);
          tagSeg(t.code_changes);
          tagSeg(t.video_segments);
        });
      }
      if (analysis.your_tasks) {
        tagSeg(analysis.your_tasks.tasks_todo);
        tagSeg(analysis.your_tasks.tasks_waiting_on_others);
        tagSeg(analysis.your_tasks.decisions_needed);
      }
      segmentAnalyses.push(analysis);
    }

    console.log('');
  }

  // Compute totals for this file
  fileResult.compressedTotalMB = fileResult.segments
    .reduce((sum, s) => sum + s.fileSizeMB, 0).toFixed(2);
  fileResult.compressionRatio = (
    (1 - parseFloat(fileResult.compressedTotalMB) / parseFloat(fileResult.originalSizeMB)) * 100
  ).toFixed(1) + '% reduction';

  return { fileResult, segmentAnalyses, segmentReports };
}

// ======================== PHASE: COMPILE ========================

/**
 * Send all segment analyses to Gemini for final compilation.
 * Returns { compiledAnalysis, compilationRun }.
 */
async function phaseCompile(ctx, allSegmentAnalyses) {
  const timer = phaseTimer('compile');
  const { opts, ai, userName, callName, costTracker, progress } = ctx;

  progress.setPhase('compile');

  let compiledAnalysis = null;
  let compilationRun = null;

  if (allSegmentAnalyses.length > 0 && !opts.skipGemini && !opts.dryRun && !shuttingDown) {
    try {
      // Adaptive compilation budget
      const compBudget = calculateCompilationBudget(allSegmentAnalyses, opts.compilationThinkingBudget);
      console.log(`  Compilation thinking budget: ${compBudget.budget.toLocaleString()} tokens (${compBudget.reason})`);

      const compilationResult = await compileFinalResult(
        ai, allSegmentAnalyses, userName, callName, PKG_ROOT,
        { thinkingBudget: compBudget.budget }
      );

      compiledAnalysis = compilationResult.compiled;
      compilationRun = compilationResult.run;

      // Track compilation cost
      if (compilationRun?.tokenUsage) {
        costTracker.addCompilation(compilationRun.tokenUsage, compilationRun.durationMs);
      }

      // Validate compilation output
      if (compiledAnalysis) {
        const hasTickets = Array.isArray(compiledAnalysis.tickets) && compiledAnalysis.tickets.length > 0;
        const hasActions = Array.isArray(compiledAnalysis.action_items) && compiledAnalysis.action_items.length > 0;
        const hasBlockers = Array.isArray(compiledAnalysis.blockers) && compiledAnalysis.blockers.length > 0;
        const hasCRs = Array.isArray(compiledAnalysis.change_requests) && compiledAnalysis.change_requests.length > 0;

        if (!hasTickets && !hasActions && !hasBlockers && !hasCRs) {
          console.warn('  ⚠ Compilation parsed OK but is missing structured data (no tickets, actions, blockers, or CRs)');
          console.warn('  → Falling back to raw segment merge for full data');
          log.warn('Compilation incomplete — missing all structured fields, using segment merge fallback');
          compiledAnalysis._incomplete = true;
        }
      }

      // Save compilation run
      const compilationDir = path.join(PROJECT_ROOT, 'gemini_runs', callName);
      fs.mkdirSync(compilationDir, { recursive: true });
      const compTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const compilationFile = path.join(compilationDir, `compilation_${compTs}.json`);
      const compilationPayload = {
        run: compilationRun,
        output: { raw: compilationResult.raw, parsed: compiledAnalysis, parseSuccess: compiledAnalysis !== null },
      };
      fs.writeFileSync(compilationFile, JSON.stringify(compilationPayload, null, 2), 'utf8');
      log.step(`Compilation run saved → ${compilationFile}`);

      progress.markCompilationDone();

      timer.end();
      return { compiledAnalysis, compilationRun, compilationPayload, compilationFile };
    } catch (err) {
      console.error(`  ✗ Final compilation failed: ${err.message}`);
      log.error(`Compilation FAIL — ${err.message}`);
      console.warn('  → Falling back to raw segment merge for MD');
    }
  }

  timer.end();
  return { compiledAnalysis, compilationRun, compilationPayload: null, compilationFile: null };
}

// ======================== PHASE: OUTPUT ========================

/**
 * Write results JSON, generate Markdown, upload final artifacts.
 * Returns { runDir, jsonPath, mdPath }.
 */
async function phaseOutput(ctx, results, compiledAnalysis, compilationRun, compilationPayload) {
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

  // Write results JSON
  const jsonPath = path.join(runDir, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
  log.step(`Results JSON saved → ${jsonPath}`);

  // Generate Markdown
  const mdPath = path.join(runDir, 'results.md');
  const totalSegs = results.files.reduce((s, f) => s + f.segmentCount, 0);

  if (compiledAnalysis && !compiledAnalysis._incomplete) {
    const mdContent = renderResultsMarkdown({
      compiled: compiledAnalysis,
      meta: {
        callName: results.callName,
        processedAt: results.processedAt,
        geminiModel: config.GEMINI_MODEL,
        userName,
        segmentCount: totalSegs,
        compilation: compilationRun || null,
        costSummary: results.costSummary,
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
      },
    });
    fs.writeFileSync(mdPath, mdContent, 'utf8');
    log.step(`Results MD saved (compiled) → ${mdPath}`);
    console.log(`  ✓ Markdown report (AI-compiled) → ${path.basename(mdPath)}`);
  } else {
    const { renderResultsMarkdownLegacy } = require('./renderers/markdown');
    const mdContent = renderResultsMarkdownLegacy(results);
    fs.writeFileSync(mdPath, mdContent, 'utf8');
    log.step(`Results MD saved (legacy merge) → ${mdPath}`);
    console.log(`  ✓ Markdown report (legacy merge) → ${path.basename(mdPath)}`);
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
          fs.appendFileSync(mdPath, '\n\n' + diffMd, 'utf8');
          fs.writeFileSync(path.join(runDir, 'diff.json'), JSON.stringify(diffResult, null, 2), 'utf8');
          log.step(`Diff report: ${diffResult.totals.newItems} new, ${diffResult.totals.removedItems} removed, ${diffResult.totals.changedItems} changed`);
          console.log(`  ✓ Diff report appended (vs ${prevComp.timestamp})`);
        } else {
          console.log(`  ℹ No differences vs previous run (${prevComp.timestamp})`);
        }
      } else {
        console.log(`  ℹ No previous compilation found for diff comparison`);
      }
    } catch (diffErr) {
      console.warn(`  ⚠ Diff generation failed: ${diffErr.message}`);
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
      console.log(`  ✓ Results JSON uploaded → ${resultsStoragePath}`);

      const mdStoragePath = `calls/${callName}/runs/${runTs}/results.md`;
      await uploadToStorage(storage, mdPath, mdStoragePath);
      console.log(`  ✓ Results MD uploaded → ${mdStoragePath}`);
    } catch (err) {
      console.warn(`  ⚠ Results upload failed: ${err.message}`);
    }
  } else if (opts.skipUpload) {
    console.log('  ⚠ Skipping results upload (--skip-upload)');
  } else {
    console.log('  ⚠ Skipping results upload (Firebase auth not configured)');
  }

  timer.end();
  return { runDir, jsonPath, mdPath, runTs };
}

// ======================== PHASE: SUMMARY ========================

/**
 * Print the final summary with timing, cost, and file locations.
 */
function phaseSummary(ctx, results, { jsonPath, mdPath, runTs, compilationRun }) {
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

// ======================== PHASE: DEEP DIVE ========================

/**
 * Generate explanatory documents for topics discussed in the meeting.
 * Two-phase: discover topics → generate documents in parallel.
 */
async function phaseDeepDive(ctx, compiledAnalysis, runDir) {
  const timer = phaseTimer('deep_dive');
  const { ai, callName, userName, costTracker, opts, contextDocs } = ctx;

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  DEEP DIVE — Generating Explanatory Documents');
  console.log('══════════════════════════════════════════════');
  console.log('');

  const thinkingBudget = opts.thinkingBudget ||
    require('./config').DEEP_DIVE_THINKING_BUDGET;

  // Gather context snippets from inline text docs (for richer AI context)
  const contextSnippets = [];
  for (const doc of (contextDocs || [])) {
    if (doc.type === 'inlineText' && doc.content) {
      const snippet = doc.content.length > 3000
        ? doc.content.slice(0, 3000) + '\n... (truncated)'
        : doc.content;
      contextSnippets.push(`[${doc.fileName}]\n${snippet}`);
    }
  }

  // Phase 1: Discover topics
  console.log('  Phase 1: Discovering topics...');
  let topicResult;
  try {
    topicResult = await discoverTopics(ai, compiledAnalysis, {
      callName, userName, thinkingBudget, contextSnippets,
    });
  } catch (err) {
    console.error(`  ✗ Topic discovery failed: ${err.message}`);
    log.error(`Deep dive topic discovery failed: ${err.message}`);
    timer.end();
    return;
  }

  const topics = topicResult.topics;
  if (!topics || topics.length === 0) {
    console.log('  ℹ No topics identified for deep dive');
    log.step('Deep dive: no topics discovered');
    timer.end();
    return;
  }

  console.log(`  ✓ Found ${topics.length} topic(s):`);
  topics.forEach(t => console.log(`    ${t.id} [${t.category}] ${t.title}`));
  console.log('');

  if (topicResult.tokenUsage) {
    costTracker.addSegment('deep-dive-discovery', topicResult.tokenUsage, topicResult.durationMs, false);
  }
  log.step(`Deep dive: ${topics.length} topics discovered in ${(topicResult.durationMs / 1000).toFixed(1)}s`);

  // Phase 2: Generate documents
  console.log(`  Phase 2: Generating ${topics.length} document(s)...`);
  const documents = await generateAllDocuments(ai, topics, compiledAnalysis, {
    callName,
    userName,
    thinkingBudget,
    contextSnippets,
    concurrency: Math.min(opts.parallelAnalysis || 2, 3), // match pipeline parallelism
    onProgress: (done, total, topic) => {
      console.log(`    [${done}/${total}] ✓ ${topic.title}`);
    },
  });

  // Track cost
  for (const doc of documents) {
    if (doc.tokenUsage && doc.tokenUsage.totalTokens > 0) {
      costTracker.addSegment(`deep-dive-${doc.topic.id}`, doc.tokenUsage, doc.durationMs, false);
    }
  }

  // Phase 3: Write output
  const deepDiveDir = path.join(runDir, 'deep-dive');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const { indexPath, stats } = writeDeepDiveOutput(deepDiveDir, documents, {
    callName,
    timestamp: ts,
  });

  console.log('');
  console.log(`  ✓ Deep dive complete: ${stats.successful}/${stats.total} documents generated`);
  console.log(`    Output: ${path.relative(PROJECT_ROOT, deepDiveDir)}/`);
  console.log(`    Index:  ${path.relative(PROJECT_ROOT, indexPath)}`);
  if (stats.failed > 0) {
    console.log(`    ⚠ ${stats.failed} document(s) failed`);
  }
  console.log(`    Tokens: ${stats.totalTokens.toLocaleString()} | Time: ${(stats.totalDurationMs / 1000).toFixed(1)}s`);
  console.log('');

  log.step(`Deep dive complete: ${stats.successful} docs, ${stats.totalTokens} tokens, ${(stats.totalDurationMs / 1000).toFixed(1)}s`);
  timer.end();
}

// ======================== MAIN PIPELINE ========================

async function run() {
  // Phase 1: Init
  const initCtx = await phaseInit();
  if (!initCtx) return; // --version early exit

  // --- Smart Change Detection mode ---
  if (initCtx.opts.updateProgress) {
    return await runProgressUpdate(initCtx);
  }

  // --- Dynamic document-only mode ---
  if (initCtx.opts.dynamic) {
    return await runDynamic(initCtx);
  }

  // Phase 2: Discover
  const ctx = await phaseDiscover(initCtx);

  // Phase 3: Services
  const fullCtx = await phaseServices(ctx);

  // Phase 4: Process each video
  const allSegmentAnalyses = [];
  const allSegmentReports = [];
  const pipelineStartMs = Date.now();
  const results = {
    processedAt: new Date().toISOString(),
    sourceFolder: fullCtx.targetDir,
    callName: fullCtx.callName,
    userName: fullCtx.userName,
    settings: {
      speed: SPEED,
      segmentTimeSec: SEG_TIME,
      preset: PRESET,
      geminiModel: config.GEMINI_MODEL,
      thinkingBudget: fullCtx.opts.thinkingBudget,
    },
    flags: fullCtx.opts,
    contextDocuments: fullCtx.contextDocs.map(d => d.fileName),
    documentStorageUrls: fullCtx.docStorageUrls,
    firebaseAuthenticated: fullCtx.firebaseReady,
    files: [],
  };

  fullCtx.progress.setPhase('compress');
  if (log && log.phaseStart) log.phaseStart('process_videos');

  for (let i = 0; i < fullCtx.videoFiles.length; i++) {
    if (shuttingDown) break;

    const { fileResult, segmentAnalyses, segmentReports } = await phaseProcessVideo(fullCtx, fullCtx.videoFiles[i], i);
    if (fileResult) {
      results.files.push(fileResult);
      allSegmentAnalyses.push(...segmentAnalyses);
      allSegmentReports.push(...(segmentReports || []));
    }
  }

  if (log && log.phaseEnd) log.phaseEnd({ videoCount: fullCtx.videoFiles.length, segmentCount: allSegmentAnalyses.length });

  // Phase 5: Compile
  const { compiledAnalysis, compilationRun, compilationPayload, compilationFile } = await phaseCompile(fullCtx, allSegmentAnalyses);

  // Quality gate on compilation output
  let compilationQuality = null;
  if (compiledAnalysis && compilationRun) {
    compilationQuality = assessQuality(compiledAnalysis, {
      parseSuccess: compilationRun.parseSuccess,
      rawLength: 0, // not easily accessible but not critical
    });
    log.step(`Compilation quality: ${compilationQuality.score}/100 (${compilationQuality.grade})`);
  }

  if (compilationRun) {
    results.compilation = {
      runFile: compilationFile ? path.relative(PROJECT_ROOT, compilationFile) : null,
      ...compilationRun,
    };
  }
  results._compilationPayload = compilationPayload;

  // Phase 6: Output
  const outputResult = await phaseOutput(fullCtx, results, compiledAnalysis, compilationRun, compilationPayload);
  delete results._compilationPayload;

  // Phase 7: Health Dashboard
  const healthReport = buildHealthReport({
    segmentReports: allSegmentReports,
    allSegmentAnalyses,
    costSummary: fullCtx.costTracker.getSummary(),
    compilationQuality,
    totalDurationMs: Date.now() - pipelineStartMs,
  });
  printHealthDashboard(healthReport);

  // Add health report to results
  results.healthReport = healthReport;

  // --- Learning Loop: save run history (v6) ---
  if (!fullCtx.opts.disableLearning) {
    try {
      const hadFocusedPasses = allSegmentAnalyses.some(a => a._focused_pass_applied);
      const entry = buildHistoryEntry({
        callName: fullCtx.callName,
        healthReport,
        costSummary: fullCtx.costTracker.getSummary(),
        segmentCount: allSegmentAnalyses.length,
        compilationQuality,
        baseBudget: fullCtx.opts.thinkingBudget,
        compilationBudget: fullCtx.opts.compilationThinkingBudget,
        hadFocusedPasses,
      });
      saveHistory(PROJECT_ROOT, entry);
      log.step('Learning history saved');
    } catch (histErr) {
      log.warn(`Failed to save learning history: ${histErr.message}`);
    }
  }

  // Phase 8: Summary
  phaseSummary(fullCtx, results, { ...outputResult, compilationRun });

  // Phase 9 (optional): Deep Dive — generate explanatory documents
  if (fullCtx.opts.deepDive && compiledAnalysis && !fullCtx.opts.skipGemini && !fullCtx.opts.dryRun && !shuttingDown) {
    await phaseDeepDive(fullCtx, compiledAnalysis, outputResult.runDir);
  }

  // Cleanup
  fullCtx.progress.cleanup();
  log.close();
}

// ======================== DYNAMIC DOCUMENT-ONLY MODE ========================

/**
 * Alternative pipeline mode: generate documents from context docs + user request.
 * No video required — works purely from documents and the user's request.
 *
 * Triggered by --dynamic flag.
 */
async function runDynamic(initCtx) {
  const { opts, targetDir } = initCtx;
  const folderName = path.basename(targetDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  DYNAMIC MODE — AI Document Generation');
  console.log('══════════════════════════════════════════════');
  console.log(`  Folder: ${folderName}`);
  console.log(`  Source: ${targetDir}`);
  console.log(`  Mode:   Video + Documents (auto-detect)`);
  console.log('');

  // 1. Get user request (from --request flag or interactive prompt)
  let userRequest = opts.request;
  if (!userRequest) {
    userRequest = await promptUserText('  What do you want to generate?\n  (e.g. "Plan migration from X to Y", "Explain this codebase", "Create learning guide for React")\n\n  → ');
  }
  if (!userRequest || !userRequest.trim()) {
    console.error('\n  ✗ A request is required for dynamic mode.');
    console.error('    Use --request "your request" or enter it when prompted.');
    initCtx.progress.cleanup();
    log.close();
    return;
  }
  console.log(`\n  Request: "${userRequest}"`);
  log.step(`Dynamic mode: "${userRequest}"`);

  // 2. Ask for user name (for attribution)
  let userName = opts.userName;
  if (!userName) {
    userName = await promptUserText('\n  Your name (optional, press Enter to skip): ');
  }
  if (userName) log.step(`User: ${userName}`);

  // 3. Discover documents AND video files
  console.log('');
  console.log('  Discovering content...');
  const allDocFiles = findDocsRecursive(targetDir, DOC_EXTS);
  const videoFiles = fs.readdirSync(targetDir)
    .filter(f => {
      const stat = fs.statSync(path.join(targetDir, f));
      return stat.isFile() && VIDEO_EXTS.includes(path.extname(f).toLowerCase());
    })
    .map(f => path.join(targetDir, f));

  console.log(`  Found ${allDocFiles.length} document(s)`);
  if (allDocFiles.length > 0) {
    allDocFiles.forEach(f => console.log(`    - ${f.relPath}`));
  }
  console.log(`  Found ${videoFiles.length} video file(s)`);
  if (videoFiles.length > 0) {
    videoFiles.forEach(f => console.log(`    - ${path.basename(f)}`));
  }
  log.step(`Discovered ${allDocFiles.length} document(s), ${videoFiles.length} video(s)`);

  // 4. Initialize Gemini
  console.log('');
  console.log('  Initializing AI...');
  if (opts.skipGemini || opts.dryRun) {
    console.error('  ✗ Dynamic mode requires Gemini AI. Remove --skip-gemini / --dry-run.');
    initCtx.progress.cleanup();
    log.close();
    return;
  }

  // Validate config for Gemini
  const configCheck = validateConfig({ skipFirebase: true, skipGemini: false });
  if (!configCheck.valid) {
    console.error('\n  Configuration errors:');
    configCheck.errors.forEach(e => console.error(`    ✗ ${e}`));
    initCtx.progress.cleanup();
    log.close();
    return;
  }

  const ai = await initGemini();
  console.log('  ✓ Gemini AI ready');
  const costTracker = initCtx.costTracker;

  // 5. Process video files (compress → segment → analyze for context)
  const videoSummaries = [];
  if (videoFiles.length > 0) {
    console.log('');
    console.log(`  ── Video Processing (${videoFiles.length} file${videoFiles.length > 1 ? 's' : ''}) ──`);
    const compressedDir = path.join(targetDir, 'compressed');

    for (let vi = 0; vi < videoFiles.length; vi++) {
      const videoPath = videoFiles[vi];
      const baseName = path.basename(videoPath, path.extname(videoPath));
      const segmentDir = path.join(compressedDir, baseName);

      console.log(`\n  [${vi + 1}/${videoFiles.length}] ${path.basename(videoPath)}`);

      // Compress & segment (reuse existing if available)
      let segments;
      const existingSegments = fs.existsSync(segmentDir)
        ? fs.readdirSync(segmentDir).filter(f => f.startsWith('segment_') && f.endsWith('.mp4')).sort()
        : [];

      if (existingSegments.length > 0) {
        segments = existingSegments.map(f => path.join(segmentDir, f));
        console.log(`  ✓ Using ${segments.length} existing segment(s)`);
        log.step(`SKIP compression — ${segments.length} segment(s) already on disk for "${baseName}"`);
      } else {
        console.log('  Compressing & segmenting...');
        segments = compressAndSegment(videoPath, segmentDir);
        console.log(`  → ${segments.length} segment(s) created`);
        log.step(`Compressed "${baseName}" → ${segments.length} segment(s)`);
      }

      // Validate segments
      const validSegments = segments.filter(s => verifySegment(s));
      if (validSegments.length < segments.length) {
        console.warn(`  ⚠ ${segments.length - validSegments.length} corrupt segment(s) skipped`);
      }

      // Analyze each segment with Gemini to extract context
      console.log(`  Analyzing ${validSegments.length} segment(s) for content...`);
      for (let si = 0; si < validSegments.length; si++) {
        const segPath = validSegments[si];
        const segName = path.basename(segPath);
        const displayName = `${baseName}/${segName}`;

        try {
          const result = await analyzeVideoForContext(ai, segPath, displayName, {
            thinkingBudget: 8192,
            segmentIndex: si,
            totalSegments: validSegments.length,
          });

          videoSummaries.push({
            videoFile: path.basename(videoPath),
            segment: segName,
            segmentIndex: si,
            totalSegments: validSegments.length,
            summary: result.summary,
          });

          if (result.tokenUsage) {
            costTracker.addSegment(`dynamic-video-${baseName}-${segName}`, result.tokenUsage, result.durationMs, false);
          }
        } catch (err) {
          console.error(`    ✗ Failed to analyze ${segName}: ${err.message}`);
          log.error(`Dynamic video analysis failed for ${displayName}: ${err.message}`);
        }
      }
    }

    console.log('');
    console.log(`  ✓ Video analysis complete: ${videoSummaries.length} segment summary(ies)`);
    log.step(`Dynamic video analysis: ${videoSummaries.length} segment summaries extracted`);
  }

  // 6. Load document contents as snippets for AI
  const INLINE_EXTS = ['.vtt', '.srt', '.txt', '.md', '.csv', '.json', '.xml', '.html'];
  const docSnippets = [];
  for (const { absPath, relPath } of allDocFiles) {
    if (INLINE_EXTS.includes(path.extname(absPath).toLowerCase())) {
      try {
        let content = fs.readFileSync(absPath, 'utf8');
        if (content.length > 8000) {
          content = content.slice(0, 8000) + '\n... (truncated)';
        }
        docSnippets.push(`[${relPath}]\n${content}`);
      } catch { /* skip unreadable */ }
    }
  }
  console.log(`  Loaded ${docSnippets.length} document(s) as context for AI`);
  if (videoSummaries.length > 0) {
    console.log(`  Plus ${videoSummaries.length} video segment summary(ies) as context`);
  }
  console.log('');

  const thinkingBudget = opts.thinkingBudget || THINKING_BUDGET;

  // 7. Phase 1: Plan topics
  console.log('  Phase 1: Planning documents...');
  let planResult;
  try {
    planResult = await planTopics(ai, userRequest, docSnippets, {
      folderName, userName, thinkingBudget, videoSummaries,
    });
  } catch (err) {
    console.error(`  ✗ Topic planning failed: ${err.message}`);
    log.error(`Dynamic topic planning failed: ${err.message}`);
    initCtx.progress.cleanup();
    log.close();
    return;
  }

  const topics = planResult.topics;
  if (!topics || topics.length === 0) {
    console.log('  ℹ No documents planned — request may be too vague.');
    console.log('    Try a more specific request or add context documents to the folder.');
    initCtx.progress.cleanup();
    log.close();
    return;
  }

  if (planResult.tokenUsage) {
    costTracker.addSegment('dynamic-planning', planResult.tokenUsage, planResult.durationMs, false);
  }

  console.log(`  ✓ Planned ${topics.length} document(s) in ${(planResult.durationMs / 1000).toFixed(1)}s:`);
  topics.forEach(t => console.log(`    ${t.id} [${t.category}] ${t.title}`));
  if (planResult.projectSummary) {
    console.log(`\n  Summary: ${planResult.projectSummary}`);
  }
  console.log('');
  log.step(`Dynamic mode: ${topics.length} topics planned in ${(planResult.durationMs / 1000).toFixed(1)}s`);

  // 8. Phase 2: Generate all documents
  console.log(`  Phase 2: Generating ${topics.length} document(s)...`);
  const documents = await generateAllDynamicDocuments(ai, topics, userRequest, docSnippets, {
    folderName,
    userName,
    thinkingBudget,
    videoSummaries,
    concurrency: Math.min(opts.parallelAnalysis || 2, 3),
    onProgress: (done, total, topic) => {
      console.log(`    [${done}/${total}] ✓ ${topic.title}`);
    },
  });

  // Track cost
  for (const doc of documents) {
    if (doc.tokenUsage && doc.tokenUsage.totalTokens > 0) {
      costTracker.addSegment(`dynamic-${doc.topic.id}`, doc.tokenUsage, doc.durationMs, false);
    }
  }

  // 9. Write output
  const runDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : path.join(targetDir, 'runs', ts);
  const { indexPath, stats } = writeDynamicOutput(runDir, documents, {
    folderName,
    userRequest,
    projectSummary: planResult.projectSummary,
    timestamp: ts,
  });

  console.log('');
  console.log(`  ✓ Dynamic generation complete: ${stats.successful}/${stats.total} documents`);
  console.log(`    Output:  ${path.relative(PROJECT_ROOT, runDir)}/`);
  console.log(`    Index:   ${path.relative(PROJECT_ROOT, indexPath)}`);
  if (stats.failed > 0) {
    console.log(`    ⚠ ${stats.failed} document(s) failed`);
  }
  console.log(`    Tokens:  ${stats.totalTokens.toLocaleString()} | Time: ${(stats.totalDurationMs / 1000).toFixed(1)}s`);

  // 10. Cost summary
  const cost = costTracker.getSummary();
  if (cost.totalTokens > 0) {
    console.log('');
    console.log(`  Cost estimate (${config.GEMINI_MODEL}):`);
    console.log(`    Input:    ${cost.inputTokens.toLocaleString()} ($${cost.inputCost.toFixed(4)})`);
    console.log(`    Output:   ${cost.outputTokens.toLocaleString()} ($${cost.outputCost.toFixed(4)})`);
    console.log(`    Thinking: ${cost.thinkingTokens.toLocaleString()} ($${cost.thinkingCost.toFixed(4)})`);
    console.log(`    Total:    ${cost.totalTokens.toLocaleString()} tokens | $${cost.totalCost.toFixed(4)}`);
  }

  // 11. Firebase upload (optional)
  if (!opts.skipUpload) {
    try {
      const { storage, authenticated } = await initFirebase();
      if (authenticated && storage) {
        const storagePath = `calls/${folderName}/dynamic/${ts}`;
        const indexStoragePath = `${storagePath}/INDEX.md`;
        await uploadToStorage(storage, indexPath, indexStoragePath);
        console.log(`  ✓ Uploaded to Firebase: ${storagePath}/`);
        log.step(`Firebase upload complete: ${storagePath}`);
      }
    } catch (fbErr) {
      console.warn(`  ⚠ Firebase upload failed: ${fbErr.message}`);
      log.warn(`Firebase upload failed: ${fbErr.message}`);
    }
  }

  console.log('');
  console.log('  ══════════════════════════════════════');
  console.log('  Dynamic Mode Complete');
  console.log('  ══════════════════════════════════════');
  if (videoSummaries.length > 0) {
    console.log(`  Videos:    ${videoFiles.length} (${videoSummaries.length} segments analyzed)`);
  }
  console.log(`  Documents: ${stats.successful}`);
  console.log(`  Output:    ${path.relative(PROJECT_ROOT, runDir)}/`);
  console.log(`  Elapsed:   ${log.elapsed()}`);
  console.log('');

  log.step(`Dynamic mode complete: ${stats.successful} docs, ${stats.totalTokens} tokens`);
  log.step('DONE');
  initCtx.progress.cleanup();
  log.close();
}

// ======================== SMART CHANGE DETECTION ========================

/**
 * Alternative pipeline mode: detect what changed since last analysis
 * and assess progress on extracted items via git + AI.
 *
 * Triggered by --update-progress flag.
 */
async function runProgressUpdate(initCtx) {
  const { opts, targetDir } = initCtx;
  const callName = path.basename(targetDir);
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');

  console.log('');
  console.log('==============================================');
  console.log(' Smart Change Detection & Progress Update');
  console.log('==============================================');
  console.log(`  Call:   ${callName}`);
  console.log(`  Folder: ${targetDir}`);
  console.log('');

  // 0. Ensure a git repo exists for change tracking
  if (isGitAvailable() && !isGitRepo(opts.repoPath || targetDir)) {
    try {
      const { root, created } = initRepo(targetDir);
      if (created) {
        console.log(`  ✓ Initialized git repository in ${root}`);
        log.step(`Git repo initialized: ${root}`);
      }
    } catch (gitErr) {
      console.warn(`  ⚠ Could not initialize git: ${gitErr.message}`);
      log.warn(`Git init failed: ${gitErr.message}`);
    }
  }

  // 1. Load previous compilation
  const prev = loadPreviousCompilation(targetDir);
  if (!prev) {
    console.error('  ✗ No previous analysis found. Run the full pipeline first.');
    console.error('    Usage: taskex "' + callName + '"');
    initCtx.progress.cleanup();
    log.close();
    return;
  }
  console.log(`  ✓ Loaded previous analysis from ${prev.timestamp}`);
  log.step(`Loaded previous compilation: ${prev.timestamp}`);

  // 2. Detect changes
  console.log('  Detecting changes...');
  const changeReport = detectAllChanges({
    repoPath: opts.repoPath,
    callDir: targetDir,
    sinceISO: prev.timestamp,
    analysis: prev.compiled,
  });

  console.log(`  ✓ Git: ${changeReport.totals.commits} commits, ${changeReport.totals.filesChanged} files changed`);
  console.log(`  ✓ Docs: ${changeReport.totals.docsChanged} document(s) updated`);
  console.log(`  ✓ Items: ${changeReport.items.length} trackable items found`);
  console.log(`  ✓ Correlations: ${changeReport.totals.itemsWithMatches} items with matches`);
  log.step(`Changes detected: ${changeReport.totals.commits} commits, ${changeReport.totals.filesChanged} files, ${changeReport.totals.docsChanged} docs`);
  console.log('');

  // 3. Local assessment (always runs)
  const localAssessments = assessProgressLocal(changeReport.items, changeReport.correlations);
  const localSummary = buildProgressSummary(localAssessments);
  console.log(`  Local assessment: ${localSummary.done} done, ${localSummary.inProgress} in progress, ${localSummary.notStarted} not started`);

  // 4. AI-enhanced assessment (if Gemini is available)
  let finalAssessments = localAssessments;
  let overallSummary = null;
  let recommendations = [];
  let aiMode = 'local';

  if (!opts.skipGemini) {
    try {
      console.log('  Running AI-enhanced assessment...');
      const ai = await initGemini();
      const aiResult = await assessProgressWithAI(ai, changeReport.items, changeReport, localAssessments, {
        thinkingBudget: opts.thinkingBudget,
      });
      finalAssessments = aiResult.assessments;
      overallSummary = aiResult.overall_summary;
      recommendations = aiResult.recommendations;
      aiMode = 'ai-enhanced';

      const aiSummary = buildProgressSummary(finalAssessments);
      console.log(`  ✓ AI assessment: ${aiSummary.done} done, ${aiSummary.inProgress} in progress, ${aiSummary.notStarted} not started`);

      if (aiResult.tokenUsage) {
        initCtx.costTracker.addSegment('progress-assessment', aiResult.tokenUsage, 0, false);
      }
      log.step(`AI assessment complete (model: ${aiResult.model})`);
    } catch (err) {
      console.warn(`  ⚠ AI assessment failed, using local assessment: ${err.message}`);
      log.warn(`AI assessment failed: ${err.message}`);
    }
  } else {
    console.log('  Skipping AI assessment (--skip-gemini)');
  }
  console.log('');

  // 5. Merge progress into analysis
  const annotatedAnalysis = mergeProgressIntoAnalysis(
    JSON.parse(JSON.stringify(prev.compiled)),
    finalAssessments
  );

  // 6. Create output
  const runDir = path.join(targetDir, 'runs', ts);
  fs.mkdirSync(runDir, { recursive: true });

  const progressData = {
    timestamp: ts,
    mode: aiMode,
    callName,
    sinceAnalysis: prev.timestamp,
    changeReport: serializeReport(changeReport),
    assessments: finalAssessments,
    summary: buildProgressSummary(finalAssessments),
    overallSummary,
    recommendations,
    annotatedAnalysis,
  };

  const progressJsonPath = path.join(runDir, 'progress.json');
  fs.writeFileSync(progressJsonPath, JSON.stringify(progressData, null, 2));
  log.step(`Wrote ${progressJsonPath}`);

  const progressMd = renderProgressMarkdown({
    assessments: finalAssessments,
    changeReport,
    overallSummary,
    recommendations,
    meta: { callName, timestamp: ts, mode: aiMode },
  });
  const progressMdPath = path.join(runDir, 'progress.md');
  fs.writeFileSync(progressMdPath, progressMd);
  log.step(`Wrote ${progressMdPath}`);

  console.log(`  ✓ Progress report: ${path.relative(PROJECT_ROOT, progressMdPath)}`);
  console.log(`  ✓ Progress data:   ${path.relative(PROJECT_ROOT, progressJsonPath)}`);

  // 7. Firebase upload (if available)
  if (!opts.skipUpload) {
    try {
      const { storage, authenticated } = await initFirebase();
      if (storage && authenticated) {
        const storagePath = `calls/${callName}/progress/${ts}`;
        await uploadToStorage(storage, progressJsonPath, `${storagePath}/progress.json`);
        await uploadToStorage(storage, progressMdPath, `${storagePath}/progress.md`);
        console.log(`  ✓ Uploaded to Firebase: ${storagePath}/`);
        log.step(`Firebase upload complete: ${storagePath}`);
      }
    } catch (fbErr) {
      console.warn(`  ⚠ Firebase upload failed: ${fbErr.message}`);
      log.warn(`Firebase upload failed: ${fbErr.message}`);
    }
  }

  // 8. Print summary
  const finalSummary = buildProgressSummary(finalAssessments);
  console.log('');
  console.log('  ══════════════════════════════════════');
  console.log('  Progress Update Complete');
  console.log('  ══════════════════════════════════════');
  console.log(`  ${STATUS_ICONS.DONE} Completed:   ${finalSummary.done}`);
  console.log(`  ${STATUS_ICONS.IN_PROGRESS} In Progress: ${finalSummary.inProgress}`);
  console.log(`  ${STATUS_ICONS.NOT_STARTED} Not Started: ${finalSummary.notStarted}`);
  console.log(`  ${STATUS_ICONS.SUPERSEDED} Superseded:  ${finalSummary.superseded}`);
  const completionPct = finalSummary.total > 0 ? ((finalSummary.done / finalSummary.total) * 100).toFixed(0) : 0;
  console.log(`  Overall: ${completionPct}% complete (${finalSummary.done}/${finalSummary.total})`);
  console.log('');

  // Cleanup
  initCtx.progress.cleanup();
  log.close();
}

module.exports = { run, getLog: () => log };
