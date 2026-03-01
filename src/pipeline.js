/**
 * Pipeline orchestrator — main processing flow.
 *
 * Compress → Upload → AI Segment Analysis → AI Final Compilation → JSON + MD output.
 *
 * Architecture: each pipeline phase is a separate module under src/phases/.
 * The shared `ctx` (context) object flows through phases. This makes phases
 * independently testable and allows run() to read as a clean sequence of steps.
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
const { VIDEO_EXTS, DOC_EXTS, SPEED, SEG_TIME, PRESET, THINKING_BUDGET, validateConfig } = config;

// --- Shared state ---
const { getLog, isShuttingDown, PKG_ROOT, PROJECT_ROOT } = require('./phases/_shared');

// --- Pipeline phases ---
const phaseInit        = require('./phases/init');
const phaseDiscover    = require('./phases/discover');
const phaseServices    = require('./phases/services');
const phaseProcessVideo = require('./phases/process-media');
const phaseCompile     = require('./phases/compile');
const phaseOutput      = require('./phases/output');
const phaseSummary     = require('./phases/summary');
const phaseDeepDive    = require('./phases/deep-dive');

// --- Services (for alternative modes) ---
const { initFirebase, uploadToStorage } = require('./services/firebase');
const { initGemini, compileFinalResult, analyzeVideoForContext } = require('./services/gemini');
const { compressAndSegment, verifySegment } = require('./services/video');
const { isGitAvailable, isGitRepo, initRepo } = require('./services/git');

// --- Utils (for alternative modes + run orchestration) ---
const { findDocsRecursive } = require('./utils/fs');
const { promptUserText } = require('./utils/cli');
const { assessQuality } = require('./utils/quality-gate');
const { validateAnalysis, formatSchemaLine } = require('./utils/schema-validator');
const { buildHealthReport, printHealthDashboard } = require('./utils/health-dashboard');
const { saveHistory, buildHistoryEntry } = require('./utils/learning-loop');
const { loadPreviousCompilation } = require('./utils/diff-engine');

// --- Modes (for alternative pipelines) ---
const { detectAllChanges, serializeReport } = require('./modes/change-detector');
const { assessProgressLocal, assessProgressWithAI, mergeProgressIntoAnalysis, buildProgressSummary, renderProgressMarkdown, STATUS_ICONS } = require('./modes/progress-updater');
const { planTopics, generateAllDynamicDocuments, writeDynamicOutput } = require('./modes/dynamic-mode');

// --- Renderers (for alternative modes) ---
const { renderResultsMarkdown } = require('./renderers/markdown');
const { renderResultsHtml } = require('./renderers/html');

// ======================== MAIN PIPELINE ========================

async function run() {
  // Phase 1: Init
  const initCtx = await phaseInit();
  if (!initCtx) return; // --version early exit
  const log = getLog();

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

  // --- Document-only mode: skip media processing, go straight to compilation ---
  if (ctx.inputMode === 'document') {
    return await runDocOnly(ctx);
  }

  // Phase 3: Services
  const fullCtx = await phaseServices(ctx);

  // Phase 4: Process each media file (video or audio)
  const allSegmentAnalyses = [];
  const allSegmentReports = [];
  const pipelineStartMs = Date.now();
  const mediaFiles = ctx.inputMode === 'video' ? fullCtx.videoFiles : fullCtx.audioFiles;
  const results = {
    processedAt: new Date().toISOString(),
    sourceFolder: fullCtx.targetDir,
    callName: fullCtx.callName,
    userName: fullCtx.userName,
    inputMode: ctx.inputMode,
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

  for (let i = 0; i < mediaFiles.length; i++) {
    if (isShuttingDown()) break;

    const { fileResult, segmentAnalyses, segmentReports } = await phaseProcessVideo(fullCtx, mediaFiles[i], i);
    if (fileResult) {
      results.files.push(fileResult);
      allSegmentAnalyses.push(...segmentAnalyses);
      allSegmentReports.push(...(segmentReports || []));
    }
  }

  if (log && log.phaseEnd) log.phaseEnd({ videoCount: mediaFiles.length, segmentCount: allSegmentAnalyses.length });

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
  if (fullCtx.opts.deepDive && compiledAnalysis && !fullCtx.opts.skipGemini && !fullCtx.opts.dryRun && !isShuttingDown()) {
    await phaseDeepDive(fullCtx, compiledAnalysis, outputResult.runDir);
  }

  // Cleanup
  fullCtx.progress.cleanup();
  log.close();
}

// ======================== DOCUMENT-ONLY MODE ========================

/**
 * Document-only pipeline mode: no media files, analyze documents directly.
 * Sends all documents to Gemini for compilation, skipping segment processing.
 *
 * Triggered automatically when no video/audio files are found.
 */
async function runDocOnly(ctx) {
  const { opts, targetDir, allDocFiles, userName, progress, costTracker } = ctx;
  const callName = path.basename(targetDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const pipelineStartMs = Date.now();
  const log = getLog();

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  DOCUMENT-ONLY MODE — Analyzing Documents');
  console.log('══════════════════════════════════════════════');
  console.log(`  Folder: ${callName}`);
  console.log(`  Documents: ${allDocFiles.length}`);
  console.log('');

  // Initialize services
  const serviceCtx = await phaseServices(ctx);
  const { ai, contextDocs, storage, firebaseReady, docStorageUrls } = serviceCtx;

  if (!ai) {
    console.error('  ✗ Document-only mode requires Gemini AI. Remove --skip-gemini / --dry-run.');
    progress.cleanup();
    log.close();
    return;
  }

  if (contextDocs.length === 0) {
    console.error('  ✗ No documents could be loaded for analysis.');
    progress.cleanup();
    log.close();
    return;
  }

  // Build a single analysis from all documents (send as one "segment")
  console.log(`  Analyzing ${contextDocs.length} document(s) with ${config.GEMINI_MODEL}...`);

  let compiledAnalysis = null;
  let compilationRun = null;
  let compilationPayload = null;
  let compilationFile = null;

  try {
    const compBudget = opts.compilationThinkingBudget;
    console.log(`  Thinking budget: ${compBudget.toLocaleString()} tokens`);

    // Use compileFinalResult with empty segment analyses — it will use contextDocs as primary input
    const compilationResult = await compileFinalResult(
      ai, [], userName, callName, PKG_ROOT,
      {
        thinkingBudget: compBudget,
        contextDocs,
        docOnlyMode: true,
      }
    );

    compiledAnalysis = compilationResult.compiled;
    compilationRun = compilationResult.run;

    if (compilationRun?.tokenUsage) {
      costTracker.addCompilation(compilationRun.tokenUsage, compilationRun.durationMs);
    }

    // Save compilation run
    const compilationDir = path.join(PROJECT_ROOT, 'gemini_runs', callName);
    fs.mkdirSync(compilationDir, { recursive: true });
    const compTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    compilationFile = path.join(compilationDir, `compilation_doconly_${compTs}.json`);
    compilationPayload = {
      run: compilationRun,
      output: { raw: compilationResult.raw, parsed: compiledAnalysis, parseSuccess: compiledAnalysis !== null },
    };
    fs.writeFileSync(compilationFile, JSON.stringify(compilationPayload, null, 2), 'utf8');
    log.step(`Doc-only compilation saved → ${compilationFile}`);

    console.log(`  ✓ Analysis complete (${(compilationRun.durationMs / 1000).toFixed(1)}s)`);

    // Schema validation on doc-only compilation
    if (compiledAnalysis) {
      const docSchemaReport = validateAnalysis(compiledAnalysis, 'compiled');
      console.log(formatSchemaLine(docSchemaReport));
      if (!docSchemaReport.valid && docSchemaReport.errorCount > 0) {
        log.warn(`Doc-only schema: ${docSchemaReport.summary}`);
      }
    }

    progress.markCompilationDone();
  } catch (err) {
    console.error(`  ✗ Document analysis failed: ${err.message}`);
    log.error(`Doc-only compilation FAIL — ${err.message}`);
  }

  // Build results structure
  const results = {
    processedAt: new Date().toISOString(),
    sourceFolder: targetDir,
    callName,
    userName,
    inputMode: 'document',
    settings: {
      geminiModel: config.GEMINI_MODEL,
      thinkingBudget: opts.thinkingBudget,
    },
    flags: opts,
    contextDocuments: contextDocs.map(d => d.fileName),
    documentStorageUrls: docStorageUrls || {},
    firebaseAuthenticated: firebaseReady,
    files: [],
    compilation: compilationRun ? {
      runFile: compilationFile ? path.relative(PROJECT_ROOT, compilationFile) : null,
      ...compilationRun,
    } : null,
  };
  results.costSummary = costTracker.getSummary();

  // Write output
  const runDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : path.join(targetDir, 'runs', ts);
  fs.mkdirSync(runDir, { recursive: true });

  if (compilationPayload) {
    fs.writeFileSync(path.join(runDir, 'compilation.json'), JSON.stringify(compilationPayload, null, 2), 'utf8');
  }

  const jsonPath = path.join(runDir, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');

  if (compiledAnalysis) {
    const mdMeta = {
      callName,
      processedAt: results.processedAt,
      geminiModel: config.GEMINI_MODEL,
      userName,
      segmentCount: 0,
      compilation: compilationRun || null,
      costSummary: results.costSummary,
      segments: [],
      settings: results.settings,
    };

    const mdContent = renderResultsMarkdown({ compiled: compiledAnalysis, meta: mdMeta });
    const mdPath = path.join(runDir, 'results.md');
    fs.writeFileSync(mdPath, mdContent, 'utf8');
    console.log(`  ✓ Markdown report → ${path.basename(mdPath)}`);

    if (!opts.noHtml) {
      const htmlContent = renderResultsHtml({ compiled: compiledAnalysis, meta: mdMeta });
      const htmlPath = path.join(runDir, 'results.html');
      fs.writeFileSync(htmlPath, htmlContent, 'utf8');
      console.log(`  ✓ HTML report → ${path.basename(htmlPath)}`);
    }
  }

  // Cost summary
  const cost = costTracker.getSummary();
  if (cost.totalTokens > 0) {
    console.log('');
    console.log(`  Cost estimate (${config.GEMINI_MODEL}):`);
    console.log(`    Input:    ${cost.inputTokens.toLocaleString()} ($${cost.inputCost.toFixed(4)})`);
    console.log(`    Output:   ${cost.outputTokens.toLocaleString()} ($${cost.outputCost.toFixed(4)})`);
    console.log(`    Thinking: ${cost.thinkingTokens.toLocaleString()} ($${cost.thinkingCost.toFixed(4)})`);
    console.log(`    Total:    ${cost.totalTokens.toLocaleString()} tokens | $${cost.totalCost.toFixed(4)}`);
  }

  console.log('');
  console.log('  ══════════════════════════════════════');
  console.log('  Document-Only Analysis Complete');
  console.log('  ══════════════════════════════════════');
  console.log(`  Documents: ${contextDocs.length}`);
  console.log(`  Output:    ${path.relative(PROJECT_ROOT, runDir)}/`);
  console.log(`  Elapsed:   ${log.elapsed()}`);
  console.log('');

  log.step('Doc-only mode complete');
  log.step('DONE');
  progress.cleanup();
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
  const log = getLog();
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

  // 6. Load document contents as snippets for AI (text files + parsed binary docs)
  const INLINE_EXTS = ['.vtt', '.srt', '.txt', '.md', '.csv', '.json', '.xml'];
  const { parseDocument, canParse } = require('./services/doc-parser');
  const docSnippets = [];
  for (const { absPath, relPath } of allDocFiles) {
    const ext = path.extname(absPath).toLowerCase();
    try {
      if (INLINE_EXTS.includes(ext)) {
        let content = fs.readFileSync(absPath, 'utf8');
        if (content.length > 8000) {
          content = content.slice(0, 8000) + '\n... (truncated)';
        }
        docSnippets.push(`[${relPath}]\n${content}`);
      } else if (canParse(ext)) {
        const result = await parseDocument(absPath, { maxLength: 8000, silent: true });
        if (result.success && result.text) {
          docSnippets.push(`[${relPath}]\n${result.text}`);
        }
      }
    } catch { /* skip unreadable */ }
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
  const log = getLog();
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

module.exports = { run, getLog };
