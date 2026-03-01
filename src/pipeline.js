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

// --- Services (for alternative modes — lazy-loaded inside each function) ---
// initFirebase, uploadToStorage, initGemini, compileFinalResult, analyzeVideoForContext,
// compressAndSegment, verifySegment, isGitAvailable, isGitRepo, initRepo

// --- Utils (for run orchestration + alt modes) ---
const { c } = require('./utils/colors');
const { findDocsRecursive } = require('./utils/fs');
const { promptUserText } = require('./utils/cli');
const { createProgressBar } = require('./utils/progress-bar');
const { buildHealthReport, printHealthDashboard } = require('./utils/health-dashboard');
const { saveHistory, buildHistoryEntry } = require('./utils/learning-loop');
const { loadPreviousCompilation } = require('./utils/diff-engine');

// --- Modes & renderers (lazy-loaded inside each alternative mode function) ---
// detectAllChanges, serializeReport, assessProgressLocal, assessProgressWithAI, etc.

// ======================== MAIN PIPELINE ========================

async function run() {
  // Lazy imports for run() — quality gate
  const { assessQuality } = require('./utils/quality-gate');

  // Phase 1: Init
  const initCtx = await phaseInit();
  if (!initCtx) return; // --version early exit
  const log = getLog();
  const bar = initCtx.progressBar;

  // --- Smart Change Detection mode ---
  if (initCtx.opts.updateProgress) {
    bar.finish();
    return await runProgressUpdate(initCtx);
  }

  // --- Dynamic document-only mode ---
  if (initCtx.opts.dynamic) {
    bar.finish();
    return await runDynamic(initCtx);
  }

  // Phase 2: Discover
  bar.setPhase('discover');
  const ctx = await phaseDiscover(initCtx);
  bar.tick('Files discovered');

  // --- Document-only mode: skip media processing, go straight to compilation ---
  if (ctx.inputMode === 'document') {
    bar.finish();
    return await runDocOnly(ctx);
  }

  // Phase 3: Services
  bar.setPhase('services');
  const fullCtx = await phaseServices(ctx);
  bar.tick('Services ready');

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
  bar.setPhase('analyze', mediaFiles.length);
  if (log && log.phaseStart) log.phaseStart('process_videos');

  for (let i = 0; i < mediaFiles.length; i++) {
    if (isShuttingDown()) break;

    bar.tick(path.basename(mediaFiles[i]));
    const { fileResult, segmentAnalyses, segmentReports } = await phaseProcessVideo(fullCtx, mediaFiles[i], i);
    if (fileResult) {
      results.files.push(fileResult);
      allSegmentAnalyses.push(...segmentAnalyses);
      allSegmentReports.push(...(segmentReports || []));
    }
  }

  if (log && log.phaseEnd) log.phaseEnd({ videoCount: mediaFiles.length, segmentCount: allSegmentAnalyses.length });

  // Phase 5: Compile
  bar.setPhase('compile', 1);
  const { compiledAnalysis, compilationRun, compilationPayload, compilationFile } = await phaseCompile(fullCtx, allSegmentAnalyses);
  bar.tick('Compilation done');

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
  bar.setPhase('output', 3);
  const outputResult = await phaseOutput(fullCtx, results, compiledAnalysis, compilationRun, compilationPayload);
  delete results._compilationPayload;
  bar.tick('Output files written');

  // Phase 7: Health Dashboard
  const healthReport = buildHealthReport({
    segmentReports: allSegmentReports,
    allSegmentAnalyses,
    costSummary: fullCtx.costTracker.getSummary(),
    compilationQuality,
    totalDurationMs: Date.now() - pipelineStartMs,
  });
  printHealthDashboard(healthReport);
  bar.tick('Health dashboard generated');

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
  bar.setPhase('summary', 1);
  phaseSummary(fullCtx, results, { ...outputResult, compilationRun });
  bar.tick('Summary displayed');

  // Phase 9 (optional): Deep Dive — generate explanatory documents
  if (fullCtx.opts.deepDive && compiledAnalysis && !fullCtx.opts.skipGemini && !fullCtx.opts.dryRun && !isShuttingDown()) {
    bar.setPhase('deep-dive', 1);
    await phaseDeepDive(fullCtx, compiledAnalysis, outputResult.runDir);
    bar.tick('Deep dive complete');
  }

  // Cleanup
  bar.finish();
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
  // Lazy imports for doc-only mode
  const { compileFinalResult } = require('./services/gemini');
  const { validateAnalysis, formatSchemaLine, normalizeAnalysis } = require('./utils/schema-validator');
  const { renderResultsMarkdown } = require('./renderers/markdown');
  const { renderResultsHtml } = require('./renderers/html');
  const { renderResultsPdf } = require('./renderers/pdf');
  const { renderResultsDocx } = require('./renderers/docx');

  const { opts, targetDir, allDocFiles, userName, progress, costTracker } = ctx;
  const callName = path.basename(targetDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const pipelineStartMs = Date.now();
  const log = getLog();
  const bar = createProgressBar({ costTracker, callName });

  console.log('');
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log(c.heading('  DOCUMENT-ONLY MODE — Analyzing Documents'));
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log(`  Folder: ${c.cyan(callName)}`);
  console.log(`  Documents: ${c.highlight(allDocFiles.length)}`);
  console.log('');

  // Initialize services
  bar.setPhase('services', 1);
  const serviceCtx = await phaseServices(ctx);
  const { ai, contextDocs, storage, firebaseReady, docStorageUrls } = serviceCtx;
  bar.tick('Services ready');

  if (!ai) {
    console.error(`  ${c.error('Document-only mode requires Gemini AI. Remove --skip-gemini / --dry-run.')}`);
    bar.finish();
    progress.cleanup();
    log.close();
    return;
  }

  if (contextDocs.length === 0) {
    console.error(`  ${c.error('No documents could be loaded for analysis.')}`);
    bar.finish();
    progress.cleanup();
    log.close();
    return;
  }

  // Build a single analysis from all documents (send as one "segment")
  bar.setPhase('compile', 1);
  console.log(`  Analyzing ${c.highlight(contextDocs.length)} document(s) with ${c.cyan(config.GEMINI_MODEL)}...`);

  let compiledAnalysis = null;
  let compilationRun = null;
  let compilationPayload = null;
  let compilationFile = null;

  try {
    const compBudget = opts.compilationThinkingBudget;
    console.log(`  Thinking budget: ${c.highlight(compBudget.toLocaleString())} tokens`);

    // Use compileFinalResult with empty segment analyses — it will use contextDocs as primary input
    const compilationResult = await compileFinalResult(
      ai, [], userName, callName, PKG_ROOT,
      {
        thinkingBudget: compBudget,
        contextDocs,
        docOnlyMode: true,
      }
    );

    compiledAnalysis = normalizeAnalysis(compilationResult.compiled);
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

    console.log(`  ${c.success(`Analysis complete (${c.yellow((compilationRun.durationMs / 1000).toFixed(1) + 's')})`)}`);

    // Schema validation on doc-only compilation
    if (compiledAnalysis) {
      const docSchemaReport = validateAnalysis(compiledAnalysis, 'compiled');
      console.log(formatSchemaLine(docSchemaReport));
      if (!docSchemaReport.valid && docSchemaReport.errorCount > 0) {
        log.warn(`Doc-only schema: ${docSchemaReport.summary}`);
      }
    }

    bar.tick('Compilation done');
    progress.markCompilationDone();
  } catch (err) {
    console.error(`  ${c.error(`Document analysis failed: ${err.message}`)}`); 
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

  const shouldRender = (type) => opts.formats ? opts.formats.has(type) : (opts.format === 'all' || opts.format === type);

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

    if (shouldRender('md')) {
      const mdContent = renderResultsMarkdown({ compiled: compiledAnalysis, meta: mdMeta });
      const mdPath = path.join(runDir, 'results.md');
      fs.writeFileSync(mdPath, mdContent, 'utf8');
      console.log(`  ${c.success(`Markdown report → ${c.cyan(path.basename(mdPath))}`)}`); 
    }

    if (shouldRender('html') && !opts.noHtml) {
      const htmlContent = renderResultsHtml({ compiled: compiledAnalysis, meta: mdMeta });
      const htmlPath = path.join(runDir, 'results.html');
      fs.writeFileSync(htmlPath, htmlContent, 'utf8');
      console.log(`  ${c.success(`HTML report → ${c.cyan(path.basename(htmlPath))}`)}`); 

      // PDF (uses rendered HTML)
      if (shouldRender('pdf')) {
        try {
          const pdfPath = path.join(runDir, 'results.pdf');
          const pdfInfo = await renderResultsPdf(htmlContent, pdfPath);
          console.log(`  ${c.success(`PDF report → ${c.cyan(path.basename(pdfPath))}`)} ${c.dim(`(${(pdfInfo.bytes / 1024).toFixed(0)} KB)`)}`);
        } catch (pdfErr) {
          console.warn(`  ${c.warn('PDF generation failed:')} ${pdfErr.message}`);
        }
      }
    } else if (shouldRender('pdf')) {
      // PDF requested without HTML — build HTML in memory
      try {
        const htmlContent = renderResultsHtml({ compiled: compiledAnalysis, meta: mdMeta });
        const pdfPath = path.join(runDir, 'results.pdf');
        const pdfInfo = await renderResultsPdf(htmlContent, pdfPath);
        console.log(`  ${c.success(`PDF report → ${c.cyan(path.basename(pdfPath))}`)} ${c.dim(`(${(pdfInfo.bytes / 1024).toFixed(0)} KB)`)}`);
      } catch (pdfErr) {
        console.warn(`  ${c.warn('PDF generation failed:')} ${pdfErr.message}`);
      }
    }

    // DOCX report
    if (shouldRender('docx')) {
      try {
        const docxPath = path.join(runDir, 'results.docx');
        const docxBuffer = await renderResultsDocx({ compiled: compiledAnalysis, meta: mdMeta });
        fs.writeFileSync(docxPath, docxBuffer);
        console.log(`  ${c.success(`DOCX report → ${c.cyan(path.basename(docxPath))}`)} ${c.dim(`(${(docxBuffer.length / 1024).toFixed(0)} KB)`)}`);
      } catch (docxErr) {
        console.warn(`  ${c.warn('DOCX generation failed:')} ${docxErr.message}`);
      }
    }
  }

  // Cost summary
  const cost = costTracker.getSummary();
  if (cost.totalTokens > 0) {
    console.log('');
    console.log(`  ${c.heading(`Cost estimate (${config.GEMINI_MODEL}):`)}`); 
    console.log(`    Input:    ${c.yellow(cost.inputTokens.toLocaleString())} ${c.dim(`($${cost.inputCost.toFixed(4)})`)}`); 
    console.log(`    Output:   ${c.yellow(cost.outputTokens.toLocaleString())} ${c.dim(`($${cost.outputCost.toFixed(4)})`)}`); 
    console.log(`    Thinking: ${c.yellow(cost.thinkingTokens.toLocaleString())} ${c.dim(`($${cost.thinkingCost.toFixed(4)})`)}`); 
    console.log(`    Total:    ${c.highlight(cost.totalTokens.toLocaleString())} tokens | ${c.highlight(`$${cost.totalCost.toFixed(4)}`)}`); 
  }

  console.log('');
  console.log(c.cyan('  ══════════════════════════════════════'));
  console.log(c.heading('  Document-Only Analysis Complete'));
  console.log(c.cyan('  ══════════════════════════════════════'));
  console.log(`  Documents: ${c.highlight(contextDocs.length)}`);
  console.log(`  Output:    ${c.cyan(path.relative(PROJECT_ROOT, runDir) + '/')}`);
  console.log(`  Elapsed:   ${c.yellow(log.elapsed())}`);
  console.log('');

  log.step('Doc-only mode complete');
  log.step('DONE');
  bar.finish();
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
  // Lazy imports for dynamic mode
  const { initGemini, analyzeVideoForContext } = require('./services/gemini');
  const { initFirebase, uploadToStorage } = require('./services/firebase');
  const { compressAndSegment, verifySegment } = require('./services/video');
  const { planTopics, generateAllDynamicDocuments, writeDynamicOutput } = require('./modes/dynamic-mode');

  const { opts, targetDir } = initCtx;
  const log = getLog();
  const folderName = path.basename(targetDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bar = createProgressBar({ costTracker: initCtx.costTracker, callName: folderName });

  console.log('');
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log(c.heading('  DYNAMIC MODE — AI Document Generation'));
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log(`  Folder: ${c.cyan(folderName)}`);
  console.log(`  Source: ${c.dim(targetDir)}`);
  console.log(`  Mode:   ${c.yellow('Video + Documents (auto-detect)')}`);
  console.log('');

  // 1. Get user request (from --request flag or interactive prompt)
  let userRequest = opts.request;
  if (!userRequest) {
    userRequest = await promptUserText('  What do you want to generate?\n  (e.g. "Plan migration from X to Y", "Explain this codebase", "Create learning guide for React")\n\n  → ');
  }
  if (!userRequest || !userRequest.trim()) {
    console.error(`\n  ${c.error('A request is required for dynamic mode.')}`);
    console.error(`    ${c.dim('Use --request "your request" or enter it when prompted.')}`);
    bar.finish();    initCtx.progress.cleanup();
    log.close();
    return;
  }
  console.log(`\n  Request: ${c.highlight(`"${userRequest}"`)}`);
  log.step(`Dynamic mode: "${userRequest}"`);

  // 2. Ask for user name (for attribution)
  let userName = opts.userName;
  if (!userName) {
    userName = await promptUserText('\n  Your name (optional, press Enter to skip): ');
  }
  if (userName) log.step(`User: ${userName}`);

  // 3. Discover documents AND video files
  console.log('');
  console.log(`  ${c.dim('Discovering content...')}`);
  const allDocFiles = findDocsRecursive(targetDir, DOC_EXTS);
  const videoFiles = fs.readdirSync(targetDir)
    .filter(f => {
      const stat = fs.statSync(path.join(targetDir, f));
      return stat.isFile() && VIDEO_EXTS.includes(path.extname(f).toLowerCase());
    })
    .map(f => path.join(targetDir, f));

  console.log(`  Found ${c.highlight(allDocFiles.length)} document(s)`);
  if (allDocFiles.length > 0) {
    allDocFiles.forEach(f => console.log(`    ${c.dim('-')} ${c.cyan(f.relPath)}`));
  }
  console.log(`  Found ${c.highlight(videoFiles.length)} video file(s)`);
  if (videoFiles.length > 0) {
    videoFiles.forEach(f => console.log(`    ${c.dim('-')} ${c.cyan(path.basename(f))}`));
  }
  log.step(`Discovered ${allDocFiles.length} document(s), ${videoFiles.length} video(s)`);

  // 4. Initialize Gemini
  console.log('');
  console.log(`  ${c.dim('Initializing AI...')}`);
  if (opts.skipGemini || opts.dryRun) {
    console.error(`  ${c.error('Dynamic mode requires Gemini AI. Remove --skip-gemini / --dry-run.')}`);
    bar.finish();
    initCtx.progress.cleanup();
    log.close();
    return;
  }

  // Validate config for Gemini
  const configCheck = validateConfig({ skipFirebase: true, skipGemini: false });
  if (!configCheck.valid) {
    console.error(`\n  ${c.error('Configuration errors:')}`);
    configCheck.errors.forEach(e => console.error(`    ${c.error(e)}`));
    bar.finish();
    initCtx.progress.cleanup();
    log.close();
    return;
  }

  const ai = await initGemini();
  console.log(`  ${c.success('Gemini AI ready')}`);
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

      console.log(`\n  ${c.dim(`[${vi + 1}/${videoFiles.length}]`)} ${c.cyan(path.basename(videoPath))}`);

      // Compress & segment (reuse existing if available)
      let segments;
      const existingSegments = fs.existsSync(segmentDir)
        ? fs.readdirSync(segmentDir).filter(f => f.startsWith('segment_') && f.endsWith('.mp4')).sort()
        : [];

      if (existingSegments.length > 0) {
        segments = existingSegments.map(f => path.join(segmentDir, f));
        console.log(`  ${c.success(`Using ${c.highlight(segments.length)} existing segment(s)`)}`);
        log.step(`SKIP compression — ${segments.length} segment(s) already on disk for "${baseName}"`);
      } else {
        console.log('  Compressing & segmenting...');
        segments = compressAndSegment(videoPath, segmentDir);
        console.log(`  → ${c.highlight(segments.length)} segment(s) created`);
        log.step(`Compressed "${baseName}" → ${segments.length} segment(s)`);
      }

      // Validate segments
      const validSegments = segments.filter(s => verifySegment(s));
      if (validSegments.length < segments.length) {
        console.warn(`  ${c.warn(`${segments.length - validSegments.length} corrupt segment(s) skipped`)}`);
      }

      // Analyze each segment with Gemini to extract context
      console.log(`  Analyzing ${c.highlight(validSegments.length)} segment(s) for content...`);
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
          console.error(`    ${c.error(`Failed to analyze ${segName}: ${err.message}`)}`);
          log.error(`Dynamic video analysis failed for ${displayName}: ${err.message}`);
        }
      }
    }

    console.log('');
    console.log(`  ${c.success(`Video analysis complete: ${c.highlight(videoSummaries.length)} segment summary(ies)`)}`);
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
        let content = fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '');
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
  console.log(`  Loaded ${c.highlight(docSnippets.length)} document(s) as context for AI`);
  if (videoSummaries.length > 0) {
    console.log(`  Plus ${c.highlight(videoSummaries.length)} video segment summary(ies) as context`);
  }
  console.log('');

  const thinkingBudget = opts.thinkingBudget || THINKING_BUDGET;

  // 7. Phase 1: Plan topics
  console.log(`  ${c.dim('Phase 1:')} Planning documents...`);
  let planResult;
  try {
    planResult = await planTopics(ai, userRequest, docSnippets, {
      folderName, userName, thinkingBudget, videoSummaries,
    });
  } catch (err) {
    console.error(`  ${c.error(`Topic planning failed: ${err.message}`)}`);
    log.error(`Dynamic topic planning failed: ${err.message}`);    bar.finish();    initCtx.progress.cleanup();
    log.close();
    return;
  }

  const topics = planResult.topics;
  if (!topics || topics.length === 0) {
    console.log(`  ${c.info('No documents planned \u2014 request may be too vague.')}`);
    console.log(`    ${c.dim('Try a more specific request or add context documents to the folder.')}`);
    bar.finish();
    initCtx.progress.cleanup();
    log.close();
    return;
  }

  if (planResult.tokenUsage) {
    costTracker.addSegment('dynamic-planning', planResult.tokenUsage, planResult.durationMs, false);
  }

  console.log(`  ${c.success(`Planned ${c.highlight(topics.length)} document(s) in ${c.yellow((planResult.durationMs / 1000).toFixed(1) + 's')}:`)}`);
  topics.forEach(t => console.log(`    ${c.dim(t.id)} ${c.dim(`[${t.category}]`)} ${c.cyan(t.title)}`));
  if (planResult.projectSummary) {
    console.log(`\n  Summary: ${c.dim(planResult.projectSummary)}`);
  }
  console.log('');
  log.step(`Dynamic mode: ${topics.length} topics planned in ${(planResult.durationMs / 1000).toFixed(1)}s`);

  // 8. Phase 2: Generate all documents
  console.log(`  ${c.dim('Phase 2:')} Generating ${c.highlight(topics.length)} document(s)...`);
  const documents = await generateAllDynamicDocuments(ai, topics, userRequest, docSnippets, {
    folderName,
    userName,
    thinkingBudget,
    videoSummaries,
    concurrency: Math.min(opts.parallelAnalysis || 2, 3),
    onProgress: (done, total, topic) => {
      console.log(`    ${c.dim(`[${done}/${total}]`)} ${c.success(topic.title)}`);
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
  console.log(`  ${c.success(`Dynamic generation complete: ${c.highlight(stats.successful + '/' + stats.total)} documents`)}`);
  console.log(`    Output:  ${c.cyan(path.relative(PROJECT_ROOT, runDir) + '/')}`);
  console.log(`    Index:   ${c.cyan(path.relative(PROJECT_ROOT, indexPath))}`);
  if (stats.failed > 0) {
    console.log(`    ${c.warn(`${stats.failed} document(s) failed`)}`);
  }
  console.log(`    Tokens:  ${c.yellow(stats.totalTokens.toLocaleString())} | Time: ${c.yellow((stats.totalDurationMs / 1000).toFixed(1) + 's')}`);

  // 10. Cost summary
  const cost = costTracker.getSummary();
  if (cost.totalTokens > 0) {
    console.log('');
    console.log(`  ${c.heading(`Cost estimate (${config.GEMINI_MODEL}):`)}`); 
    console.log(`    Input:    ${c.yellow(cost.inputTokens.toLocaleString())} ${c.dim(`($${cost.inputCost.toFixed(4)})`)}`); 
    console.log(`    Output:   ${c.yellow(cost.outputTokens.toLocaleString())} ${c.dim(`($${cost.outputCost.toFixed(4)})`)}`); 
    console.log(`    Thinking: ${c.yellow(cost.thinkingTokens.toLocaleString())} ${c.dim(`($${cost.thinkingCost.toFixed(4)})`)}`); 
    console.log(`    Total:    ${c.highlight(cost.totalTokens.toLocaleString())} tokens | ${c.highlight(`$${cost.totalCost.toFixed(4)}`)}`);
  }

  // 11. Firebase upload (optional)
  if (!opts.skipUpload) {
    try {
      const { storage, authenticated } = await initFirebase();
      if (authenticated && storage) {
        const storagePath = `calls/${folderName}/dynamic/${ts}`;
        const indexStoragePath = `${storagePath}/INDEX.md`;
        await uploadToStorage(storage, indexPath, indexStoragePath);
        console.log(`  ${c.success(`Uploaded to Firebase: ${c.cyan(storagePath + '/')}`)}`); 
        log.step(`Firebase upload complete: ${storagePath}`);
      }
    } catch (fbErr) {
      console.warn(`  ${c.warn(`Firebase upload failed: ${fbErr.message}`)}`);
      log.warn(`Firebase upload failed: ${fbErr.message}`);
    }
  }

  console.log('');
  console.log(c.cyan('  ══════════════════════════════════════'));
  console.log(c.heading('  Dynamic Mode Complete'));
  console.log(c.cyan('  ══════════════════════════════════════'));
  if (videoSummaries.length > 0) {
    console.log(`  Videos:    ${c.highlight(videoFiles.length)} (${c.yellow(videoSummaries.length)} segments analyzed)`);
  }
  console.log(`  Documents: ${c.highlight(stats.successful)}`);
  console.log(`  Output:    ${c.cyan(path.relative(PROJECT_ROOT, runDir) + '/')}`);
  console.log(`  Elapsed:   ${c.yellow(log.elapsed())}`);
  console.log('');

  log.step(`Dynamic mode complete: ${stats.successful} docs, ${stats.totalTokens} tokens`);
  log.step('DONE');
  bar.finish();
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
  // Lazy imports for progress-update mode
  const { initGemini } = require('./services/gemini');
  const { initFirebase, uploadToStorage } = require('./services/firebase');
  const { isGitAvailable, isGitRepo, initRepo } = require('./services/git');
  const { detectAllChanges, serializeReport } = require('./modes/change-detector');
  const { assessProgressLocal, assessProgressWithAI, mergeProgressIntoAnalysis, buildProgressSummary, renderProgressMarkdown, STATUS_ICONS } = require('./modes/progress-updater');

  const { opts, targetDir } = initCtx;
  const log = getLog();
  const callName = path.basename(targetDir);
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');

  console.log('');
  console.log(c.cyan('=============================================='));
  console.log(c.heading(' Smart Change Detection & Progress Update'));
  console.log(c.cyan('=============================================='));
  console.log(`  Call:   ${c.cyan(callName)}`);
  console.log(`  Folder: ${c.dim(targetDir)}`);
  console.log('');

  // 0. Ensure a git repo exists for change tracking
  if (isGitAvailable() && !isGitRepo(opts.repoPath || targetDir)) {
    try {
      const { root, created } = initRepo(targetDir);
      if (created) {
        console.log(`  ${c.success(`Initialized git repository in ${c.cyan(root)}`)}`);
        log.step(`Git repo initialized: ${root}`);
      }
    } catch (gitErr) {
      console.warn(`  ${c.warn(`Could not initialize git: ${gitErr.message}`)}`);
      log.warn(`Git init failed: ${gitErr.message}`);
    }
  }

  // 1. Load previous compilation
  const prev = loadPreviousCompilation(targetDir);
  if (!prev) {
    console.error(`  ${c.error('No previous analysis found. Run the full pipeline first.')}`);
    console.error(`    ${c.dim('Usage: taskex "' + callName + '"')}`);
    initCtx.progress.cleanup();
    log.close();
    return;
  }
  console.log(`  ${c.success(`Loaded previous analysis from ${c.yellow(prev.timestamp)}`)}`);
  log.step(`Loaded previous compilation: ${prev.timestamp}`);

  // 2. Detect changes
  console.log(`  ${c.dim('Detecting changes...')}`);
  const changeReport = detectAllChanges({
    repoPath: opts.repoPath,
    callDir: targetDir,
    sinceISO: prev.timestamp,
    analysis: prev.compiled,
  });

  console.log(`  ${c.success(`Git: ${c.highlight(changeReport.totals.commits)} commits, ${c.highlight(changeReport.totals.filesChanged)} files changed`)}`);
  console.log(`  ${c.success(`Docs: ${c.highlight(changeReport.totals.docsChanged)} document(s) updated`)}`);
  console.log(`  ${c.success(`Items: ${c.highlight(changeReport.items.length)} trackable items found`)}`);
  console.log(`  ${c.success(`Correlations: ${c.highlight(changeReport.totals.itemsWithMatches)} items with matches`)}`);
  log.step(`Changes detected: ${changeReport.totals.commits} commits, ${changeReport.totals.filesChanged} files, ${changeReport.totals.docsChanged} docs`);
  console.log('');

  // 3. Local assessment (always runs)
  const localAssessments = assessProgressLocal(changeReport.items, changeReport.correlations);
  const localSummary = buildProgressSummary(localAssessments);
  console.log(`  Local assessment: ${c.green(localSummary.done + ' done')}, ${c.yellow(localSummary.inProgress + ' in progress')}, ${c.dim(localSummary.notStarted + ' not started')}`);

  // 4. AI-enhanced assessment (if Gemini is available)
  let finalAssessments = localAssessments;
  let overallSummary = null;
  let recommendations = [];
  let aiMode = 'local';

  if (!opts.skipGemini) {
    try {
      console.log(`  ${c.dim('Running AI-enhanced assessment...')}`);
      const ai = await initGemini();
      const aiResult = await assessProgressWithAI(ai, changeReport.items, changeReport, localAssessments, {
        thinkingBudget: opts.thinkingBudget,
      });
      finalAssessments = aiResult.assessments;
      overallSummary = aiResult.overall_summary;
      recommendations = aiResult.recommendations;
      aiMode = 'ai-enhanced';

      const aiSummary = buildProgressSummary(finalAssessments);
      console.log(`  ${c.success(`AI assessment: ${c.green(aiSummary.done + ' done')}, ${c.yellow(aiSummary.inProgress + ' in progress')}, ${c.dim(aiSummary.notStarted + ' not started')}`)}`);

      if (aiResult.tokenUsage) {
        initCtx.costTracker.addSegment('progress-assessment', aiResult.tokenUsage, 0, false);
      }
      log.step(`AI assessment complete (model: ${aiResult.model})`);
    } catch (err) {
      console.warn(`  ${c.warn(`AI assessment failed, using local assessment: ${err.message}`)}`);
      log.warn(`AI assessment failed: ${err.message}`);
    }
  } else {
    console.log(`  ${c.dim('Skipping AI assessment (--skip-gemini)')}`);
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

  console.log(`  ${c.success(`Progress report: ${c.cyan(path.relative(PROJECT_ROOT, progressMdPath))}`)}`); 
  console.log(`  ${c.success(`Progress data:   ${c.cyan(path.relative(PROJECT_ROOT, progressJsonPath))}`)}`);

  // 7. Firebase upload (if available)
  if (!opts.skipUpload) {
    try {
      const { storage, authenticated } = await initFirebase();
      if (storage && authenticated) {
        const storagePath = `calls/${callName}/progress/${ts}`;
        await uploadToStorage(storage, progressJsonPath, `${storagePath}/progress.json`);
        await uploadToStorage(storage, progressMdPath, `${storagePath}/progress.md`);
        console.log(`  ${c.success(`Uploaded to Firebase: ${c.cyan(storagePath + '/')}`)}`); 
        log.step(`Firebase upload complete: ${storagePath}`);
      }
    } catch (fbErr) {
      console.warn(`  ${c.warn(`Firebase upload failed: ${fbErr.message}`)}`);
      log.warn(`Firebase upload failed: ${fbErr.message}`);
    }
  }

  // 8. Print summary
  const finalSummary = buildProgressSummary(finalAssessments);
  console.log('');
  console.log(c.cyan('  ══════════════════════════════════════'));
  console.log(c.heading('  Progress Update Complete'));
  console.log(c.cyan('  ══════════════════════════════════════'));
  console.log(`  ${STATUS_ICONS.DONE} Completed:   ${c.green(finalSummary.done)}`);
  console.log(`  ${STATUS_ICONS.IN_PROGRESS} In Progress: ${c.yellow(finalSummary.inProgress)}`);
  console.log(`  ${STATUS_ICONS.NOT_STARTED} Not Started: ${c.dim(finalSummary.notStarted)}`);
  console.log(`  ${STATUS_ICONS.SUPERSEDED} Superseded:  ${c.dim(finalSummary.superseded)}`);
  const completionPct = finalSummary.total > 0 ? ((finalSummary.done / finalSummary.total) * 100).toFixed(0) : 0;
  console.log(`  Overall: ${c.highlight(completionPct + '%')} complete (${c.highlight(finalSummary.done + '/' + finalSummary.total)})`);
  console.log('');

  // Cleanup
  initCtx.progress.cleanup();
  log.close();
}

module.exports = { run, getLog };
