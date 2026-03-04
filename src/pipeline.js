/**
 * Pipeline orchestrator — main processing flow.
 *
 * Compress → Upload → AI Segment Analysis → AI Final Compilation → JSON + MD output.
 *
 * Architecture: each pipeline phase is a separate module under src/phases/.
 * The shared `ctx` (context) object flows through phases. This makes phases
 * independently testable and allows run() to read as a clean sequence of steps.
 *
 * v10 improvements:
 *  - Deep Summary Batch Recovery: auto-split failed batches and retry sub-batches
 *  - Compilation Auto-Retry: 1.5× budget on parse failure or quality FAIL
 *  - Dynamic Mode Fallback: merges segment analyses when compilation fails
 *  - Interactive Feature Flags: checkbox UI for toggling modes and features
 *  - Run Mode Presets: Fast/Balanced/Detailed/Custom/Dynamic
 *  - Confidence Scoring: every extracted item gets HIGH/MEDIUM/LOW confidence
 *  - Multi-Pass Focused Re-extraction: targeted second pass for weak areas
 *  - Learning Loop: historical analysis to auto-adjust budgets and thresholds
 *  - Diff-Aware Compilation: delta report comparing against previous runs
 *  - Structured Logging: JSONL structured log with phase spans and metrics
 *  - Parallel Segment Analysis: process 2-3 segments concurrently
 *  - All prior features retained: quality gate, adaptive budget, boundary detection, health dashboard
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
const { phaseServices, phaseDeepSummary } = require('./phases/services');
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
const { promptUser, promptUserText, selectDocsToExclude } = require('./utils/cli');
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

  // --- Dynamic mode: collect user request + name early, before pipeline ---
  if (initCtx.opts.dynamic) {
    if (!initCtx.opts.request) {
      if (!process.stdin.isTTY) {
        initCtx.opts.request = 'Generate a comprehensive meeting summary with key decisions, action items, and follow-ups';
        console.log(`\n  ${c.dim('No request provided — defaulting to meeting summary.')}`);
      } else {
        initCtx.opts.request = await promptUserText(
          '  What do you want to generate?\n' +
          '  (e.g. "Plan migration from X to Y", "Explain this codebase", "Create learning guide for React")\n' +
          `  ${c.dim('Press Enter for a comprehensive meeting summary')}\n\n  → `
        );
      }
    }
    if (!initCtx.opts.request || !initCtx.opts.request.trim()) {
      initCtx.opts.request = 'Generate a comprehensive meeting summary with key decisions, action items, and follow-ups';
      console.log(`\n  ${c.dim('No request provided — defaulting to meeting summary.')}`);
    }
    console.log(`\n  Request: ${c.highlight(`"${initCtx.opts.request}"`)}`);
    log.step(`Dynamic mode request: "${initCtx.opts.request}"`);

    if (!initCtx.opts.userName) {
      const name = await promptUserText('\n  Your name (optional, press Enter to skip): ');
      if (name && name.trim()) initCtx.opts.userName = name.trim();
    }
    if (initCtx.opts.userName) log.step(`User: ${initCtx.opts.userName}`);
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
  let fullCtx = await phaseServices(ctx);
  bar.tick('Services ready');

  // Phase 3.5 (optional): Deep Summary — pre-summarize context docs
  // If user didn't pass --deep-summary but has many context docs, offer it interactively
  if (!fullCtx.opts.deepSummary && process.stdin.isTTY && fullCtx.ai && fullCtx.contextDocs.length >= 3) {
    const inlineDocs = fullCtx.contextDocs.filter(d => d.type === 'inlineText' && d.content);
    const totalChars = inlineDocs.reduce((sum, d) => sum + d.content.length, 0);
    const totalTokensEstimate = Math.ceil(totalChars * 0.3);
    // Only offer when context is large enough to benefit (>100K tokens)
    if (totalTokensEstimate > 100000) {
      console.log('');
      console.log(`  ${c.cyan('You have')} ${c.highlight(inlineDocs.length)} ${c.cyan('context docs')} (~${c.highlight((totalTokensEstimate / 1000).toFixed(0) + 'K')} ${c.cyan('tokens)')}`);
      console.log(`  ${c.dim('Deep summary can reduce per-segment context by 60-80%, saving time and cost.')}`);
      const wantDeepSummary = await promptUser(`  ${c.cyan('Enable deep summary?')} [y/N] `);
      if (wantDeepSummary) {
        fullCtx.opts.deepSummary = true;
      }
    }
  }

  if (fullCtx.opts.deepSummary && fullCtx.ai && fullCtx.contextDocs.length > 0) {
    // Interactive picker: let user choose docs to keep at full fidelity
    if (process.stdin.isTTY && fullCtx.opts.deepSummaryExclude.length === 0) {
      const excluded = await selectDocsToExclude(fullCtx.contextDocs);
      fullCtx.opts.deepSummaryExclude = excluded;
    }
    bar.setPhase('deep-summary', 1);
    fullCtx = await phaseDeepSummary(fullCtx);
    bar.tick('Docs summarized');
  }

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
    integrityWarnings: (fullCtx.integrityAudit && fullCtx.integrityAudit.warnings.length > 0)
      ? fullCtx.integrityAudit.warnings : null,
    settings: {
      speed: fullCtx.opts.noCompress ? 1.0 : (fullCtx.opts.speed || SPEED),
      segmentTimeSec: fullCtx.opts.noCompress ? 1200 : (fullCtx.opts.segmentTime || SEG_TIME),
      noCompress: !!fullCtx.opts.noCompress,
      ...(fullCtx.opts.noCompress ? {} : { preset: PRESET }),
      geminiModel: config.GEMINI_MODEL,
      thinkingBudget: fullCtx.opts.thinkingBudget,
    },
    flags: fullCtx.opts,
    contextDocuments: fullCtx.contextDocs.map(d => d.fileName),
    documentStorageUrls: fullCtx.docStorageUrls,
    firebaseAuthenticated: fullCtx.firebaseReady,
    deepSummary: fullCtx.deepSummaryStats || null,
    files: [],
  };

  fullCtx.progress.setPhase('analyze');
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
    integrityWarnings: results.integrityWarnings,
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

  // Phase 10 (optional): Dynamic Topic Documents — generate topic-based docs from compiled results
  if (fullCtx.opts.dynamic && !fullCtx.opts.skipGemini && !fullCtx.opts.dryRun && !isShuttingDown()) {
    // Use compiled analysis if available; otherwise build a merged view from segments
    const dynamicSource = compiledAnalysis || mergeSegmentAnalysesForDynamic(allSegmentAnalyses);
    if (dynamicSource) {
      if (!compiledAnalysis) {
        console.log(`  ${c.warn('Compilation failed — dynamic mode will use merged segment data instead')}`);
      }
      await runDynamicTopics(fullCtx, dynamicSource, outputResult.runDir);
    }
  }

  // Phase 11 (auto): Progress Tracking — compare against previous run
  if (!fullCtx.opts.disableProgress && compiledAnalysis && !isShuttingDown()) {
    bar.setPhase('progress', 1);
    try {
      await runAutoProgressCheck(fullCtx, compiledAnalysis, outputResult.runDir, outputResult.runTs);
      bar.tick('Progress tracked');
    } catch (progressErr) {
      log.warn(`Auto progress tracking failed (non-critical): ${progressErr.message}`);
      console.warn(`  ${c.warn('Progress tracking failed (non-critical):')} ${progressErr.message}`);
    }
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

  if (isShuttingDown()) {
    bar.finish(); progress.cleanup(); log.close();
    return;
  }

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
    integrityWarnings: (ctx.integrityAudit && ctx.integrityAudit.warnings.length > 0)
      ? ctx.integrityAudit.warnings : null,
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
      integrityWarnings: results.integrityWarnings || null,
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

  // Dynamic topic documents (uses compiled results from doc-only analysis)
  if (opts.dynamic && ai && !isShuttingDown()) {
    const dynamicSource = compiledAnalysis || null;
    if (dynamicSource) {
      const dynamicCtx = { ...serviceCtx, opts, targetDir, costTracker, userName, callName };
      await runDynamicTopics(dynamicCtx, dynamicSource, runDir);
    } else {
      console.log(`  ${c.warn('Compilation failed — skipping dynamic mode (no segment data in doc-only mode)')}`);
    }
  }

  // Auto progress tracking (on by default)
  if (!opts.disableProgress && compiledAnalysis && !isShuttingDown()) {
    try {
      const docCtx = { ...serviceCtx, opts, targetDir, costTracker, userName, callName };
      await runAutoProgressCheck(docCtx, compiledAnalysis, runDir, ts);
    } catch (progressErr) {
      const docLog = getLog();
      docLog.warn(`Auto progress tracking failed (non-critical): ${progressErr.message}`);
      console.warn(`  ${c.warn('Progress tracking failed (non-critical):')} ${progressErr.message}`);
    }
  }

  log.step('Doc-only mode complete');
  log.step('DONE');
  bar.finish();
  progress.cleanup();
  log.close();
}

// ======================== SEGMENT MERGE FOR DYNAMIC FALLBACK ========================

/**
 * Build a pseudo-compiled analysis object from raw segment analyses.
 * Used as a fallback when phaseCompile fails, so dynamic mode can still run.
 * Performs simple concatenation (no AI dedup), which is good enough for
 * dynamic topic planning context.
 *
 * @param {Array<object>} allSegmentAnalyses
 * @returns {object|null}
 */
function mergeSegmentAnalysesForDynamic(allSegmentAnalyses) {
  if (!allSegmentAnalyses || allSegmentAnalyses.length === 0) return null;

  const merged = {
    tickets: [],
    change_requests: [],
    action_items: [],
    blockers: [],
    scope_changes: [],
    file_references: [],
    your_tasks: null,
    summary: '',
    _segmentMergeFallback: true,
  };

  const seenTickets = new Set();
  const seenCRs = new Set();
  const summaries = [];

  for (const seg of allSegmentAnalyses) {
    // Merge tickets (dedup by ticket_id)
    if (Array.isArray(seg.tickets)) {
      for (const t of seg.tickets) {
        if (t.ticket_id && !seenTickets.has(t.ticket_id)) {
          seenTickets.add(t.ticket_id);
          merged.tickets.push(t);
        }
      }
    }
    // Merge CRs (dedup by id)
    if (Array.isArray(seg.change_requests)) {
      for (const cr of seg.change_requests) {
        if (cr.id && !seenCRs.has(cr.id)) {
          seenCRs.add(cr.id);
          merged.change_requests.push(cr);
        }
      }
    }
    // Append all action items, blockers, scope changes, file refs
    if (Array.isArray(seg.action_items)) merged.action_items.push(...seg.action_items);
    if (Array.isArray(seg.blockers)) merged.blockers.push(...seg.blockers);
    if (Array.isArray(seg.scope_changes)) merged.scope_changes.push(...seg.scope_changes);
    if (Array.isArray(seg.file_references)) merged.file_references.push(...seg.file_references);

    // Merge your_tasks if present
    if (seg.your_tasks) {
      if (!merged.your_tasks) {
        merged.your_tasks = JSON.parse(JSON.stringify(seg.your_tasks));
      } else {
        // Merge arrays within your_tasks instead of overwriting
        for (const [key, val] of Object.entries(seg.your_tasks)) {
          if (Array.isArray(val) && Array.isArray(merged.your_tasks[key])) {
            merged.your_tasks[key].push(...val);
          } else if (!merged.your_tasks[key]) {
            merged.your_tasks[key] = val;
          }
        }
      }
    }

    if (seg.summary) summaries.push(seg.summary);
  }

  merged.summary = summaries.join(' ');
  return merged;
}

// ======================== DYNAMIC TOPIC DOCUMENTS ========================

/**
 * Generate topic-based documents from already-compiled analysis results.
 *
 * This is called AFTER the standard pipeline (or doc-only pipeline) has
 * completed compilation. It uses the compiled result as rich context for
 * AI-powered topic planning and document generation.
 *
 * Key advantages over the old standalone runDynamic():
 *  - Reuses the standard pipeline's caching, Firebase Storage URLs, and
 *    existing Gemini run results — no redundant re-uploads or re-analysis.
 *  - The compiled analysis is a unified, deduplicated summary, providing
 *    better context than raw per-segment summaries.
 *  - Offers the same "reuse or reanalyze" prompt as all other modes.
 *
 * @param {object} fullCtx - Pipeline context (ai, opts, targetDir, costTracker, etc.)
 * @param {object} compiledAnalysis - Compiled analysis from phaseCompile or doc-only
 * @param {string} parentRunDir - The run directory from the standard pipeline output
 */
async function runDynamicTopics(fullCtx, compiledAnalysis, parentRunDir) {
  const { planTopics, generateAllDynamicDocuments, writeDynamicOutput, compiledToVideoSummaries } = require('./modes/dynamic-mode');
  const { initFirebase, uploadToStorage } = require('./services/firebase');

  const { opts, targetDir, ai, costTracker } = fullCtx;
  const userName = fullCtx.userName || opts.userName;
  const log = getLog();
  const folderName = fullCtx.callName || path.basename(targetDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const userRequest = opts.request;
  if (!userRequest || !userRequest.trim()) {
    console.log(`\n  ${c.warn('⚠  Dynamic mode skipped — no request text provided.')}`);
    console.log(`    ${c.dim('Use --request "your request" or select Dynamic mode interactively.')}`);
    log.warn('Dynamic mode skipped: empty request');
    return;
  }

  console.log('');
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log(c.heading('  DYNAMIC MODE — AI Document Generation'));
  console.log(c.cyan('══════════════════════════════════════════════'));
  console.log(`  Folder:  ${c.cyan(folderName)}`);
  console.log(`  Request: ${c.highlight(`"${userRequest}"`)}`);
  console.log(`  Source:  ${c.dim('Compiled analysis from standard pipeline')}`);
  console.log('');

  // Build context from compiled analysis (replaces the old video-by-video File API approach)
  const videoSummaries = compiledToVideoSummaries(compiledAnalysis);

  // Build doc snippets from context docs (if available in fullCtx)
  const contextDocs = fullCtx.contextDocs || [];
  const INLINE_EXTS = ['.vtt', '.srt', '.txt', '.md', '.csv', '.json', '.xml'];
  const docSnippets = [];
  for (const d of contextDocs) {
    if (d.type === 'inlineText' && d.content) {
      const snippet = d.content.length > 8000 ? d.content.slice(0, 8000) + '\n... (truncated)' : d.content;
      docSnippets.push(`[${d.fileName}]\n${snippet}`);
    }
  }
  // If contextDocs is empty, try loading docs from disk (for doc-only mode compat)
  if (docSnippets.length === 0) {
    const allDocFiles = findDocsRecursive(targetDir, DOC_EXTS);
    for (const { absPath, relPath } of allDocFiles) {
      const ext = path.extname(absPath).toLowerCase();
      try {
        if (INLINE_EXTS.includes(ext)) {
          let content = fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '');
          if (content.length > 8000) content = content.slice(0, 8000) + '\n... (truncated)';
          docSnippets.push(`[${relPath}]\n${content}`);
        }
      } catch { /* skip unreadable */ }
    }
  }

  console.log(`  Context: ${c.highlight(videoSummaries.length ? 'compiled analysis' : 'documents only')} + ${c.highlight(docSnippets.length)} doc snippet(s)`);
  console.log('');

  const thinkingBudget = opts.thinkingBudget || THINKING_BUDGET;

  // Phase 1: Plan topics
  if (isShuttingDown()) return;
  console.log(`  ${c.dim('Phase 1:')} Planning documents...`);
  let planResult;
  try {
    planResult = await planTopics(ai, userRequest, docSnippets, {
      folderName,
      userName: userName || opts.userName,
      thinkingBudget,
      videoSummaries,
    });
  } catch (err) {
    console.error(`  ${c.error(`Topic planning failed: ${err.message}`)}`);
    console.error(`    ${c.dim('Tip: check your Gemini API key, or try a simpler --request.')}`);
    log.error(`Dynamic topic planning failed: ${err.message}`);
    return;
  }

  const topics = planResult.topics;
  if (!topics || topics.length === 0) {
    console.log(`  ${c.info('No documents planned — request may be too vague.')}`);
    console.log(`    ${c.dim('Try a more specific request or add context documents to the folder.')}`);
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

  // Phase 2: Generate all documents
  if (isShuttingDown()) return;
  console.log(`  ${c.dim('Phase 2:')} Generating ${c.highlight(topics.length)} document(s)...`);
  const documents = await generateAllDynamicDocuments(ai, topics, userRequest, docSnippets, {
    folderName,
    userName: userName || opts.userName,
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

  // Write output — dynamic docs go into a 'dynamic/' subdirectory of the run
  const dynamicDir = parentRunDir
    ? path.join(parentRunDir, 'dynamic')
    : path.join(targetDir, 'runs', ts, 'dynamic');
  const { indexPath, stats } = writeDynamicOutput(dynamicDir, documents, {
    folderName,
    userRequest,
    projectSummary: planResult.projectSummary,
    timestamp: ts,
  });

  console.log('');
  console.log(`  ${c.success(`Dynamic generation complete: ${c.highlight(stats.successful + '/' + stats.total)} documents`)}`);
  console.log(`    Output:  ${c.cyan(path.relative(PROJECT_ROOT, dynamicDir) + '/')}`);
  console.log(`    Index:   ${c.cyan(path.relative(PROJECT_ROOT, indexPath))}`);
  if (stats.failed > 0) {
    console.log(`    ${c.warn(`${stats.failed} document(s) failed`)}`);
  }
  console.log(`    Tokens:  ${c.yellow(stats.totalTokens.toLocaleString())} | Time: ${c.yellow((stats.totalDurationMs / 1000).toFixed(1) + 's')}`);

  // Firebase upload (optional)
  if (!opts.skipUpload && !isShuttingDown()) {
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
  console.log(`  Documents: ${c.highlight(stats.successful)}`);
  console.log(`  Output:    ${c.cyan(path.relative(PROJECT_ROOT, dynamicDir) + '/')}`);
  console.log('');

  log.step(`Dynamic mode complete: ${stats.successful} docs, ${stats.totalTokens} tokens`);
}

// ======================== AUTO PROGRESS TRACKING ========================

/**
 * Automatic progress tracking — runs at the end of every pipeline execution
 * (unless disabled with --no-progress). Compares the current compilation against
 * the most recent previous run and produces a lightweight progress snapshot.
 *
 * This is different from standalone --update-progress:
 *  - Runs as part of the normal pipeline (not a separate mode)
 *  - Uses local deterministic assessment only (no extra Gemini API calls)
 *  - Writes progress.json + progress.md into the current run directory
 *  - Initializes git repo if not already present (for future tracking)
 *  - First run simply records the baseline (no comparison possible)
 *
 * @param {object} ctx - Pipeline context with opts, targetDir, callName, costTracker
 * @param {object} compiledAnalysis - Current run's compiled analysis
 * @param {string} runDir - Current run output directory
 * @param {string} runTs - Current run timestamp string
 */
async function runAutoProgressCheck(ctx, compiledAnalysis, runDir, runTs) {
  const { isGitAvailable, isGitRepo, initRepo } = require('./services/git');
  const { detectAllChanges, serializeReport, extractTrackableItems } = require('./modes/change-detector');
  const { assessProgressLocal, buildProgressSummary, renderProgressMarkdown, STATUS_ICONS, mergeProgressIntoAnalysis } = require('./modes/progress-updater');

  const log = getLog();
  const { opts, targetDir, callName } = ctx;

  // --- Step 1: Ensure git repo exists for future change tracking ---
  try {
    if (isGitAvailable() && !isGitRepo(opts.repoPath || targetDir)) {
      const { root, created } = initRepo(targetDir);
      if (created) {
        log.step(`Git repo auto-initialized for progress tracking: ${root}`);
      }
    }
  } catch (gitErr) {
    log.warn(`Git auto-init failed (non-critical): ${gitErr.message}`);
  }

  // --- Step 2: Load previous compilation for comparison ---
  const prev = loadPreviousCompilation(targetDir, runTs);
  if (!prev) {
    // First run — no previous data to compare against. Record baseline.
    log.step('Progress tracking: first run — baseline recorded for future comparisons');
    console.log(`  ${c.info('Progress tracking:')} ${c.dim('First run — baseline recorded for future comparisons')}`);

    // Still extract and save item counts as a baseline snapshot
    const items = extractTrackableItems(compiledAnalysis);
    const baseline = {
      timestamp: runTs,
      mode: 'baseline',
      callName,
      itemCount: items.length,
      itemBreakdown: {
        tickets: (compiledAnalysis.tickets || []).length,
        change_requests: (compiledAnalysis.change_requests || []).length,
        action_items: (compiledAnalysis.action_items || []).length,
        blockers: (compiledAnalysis.blockers || []).length,
        scope_changes: (compiledAnalysis.scope_changes || []).length,
      },
      message: 'First run — baseline for future progress tracking',
    };
    try {
      fs.writeFileSync(path.join(runDir, 'progress.json'), JSON.stringify(baseline, null, 2), 'utf8');
    } catch { /* non-critical */ }
    return;
  }

  // --- Step 3: Detect changes since previous run ---
  let changeReport;
  try {
    changeReport = detectAllChanges({
      repoPath: opts.repoPath,
      callDir: targetDir,
      sinceISO: prev.timestamp,
      analysis: prev.compiled,
    });
  } catch (err) {
    log.warn(`Progress tracking: change detection failed — ${err.message}`);
    return;
  }

  // --- Step 4: Local assessment (deterministic, no API cost) ---
  const localAssessments = assessProgressLocal(changeReport.items, changeReport.correlations);
  const summary = buildProgressSummary(localAssessments);

  // --- Step 5: Merge progress into current analysis ---
  const annotated = mergeProgressIntoAnalysis(
    JSON.parse(JSON.stringify(compiledAnalysis)),
    localAssessments
  );

  // --- Step 6: Write progress data ---
  const progressData = {
    timestamp: runTs,
    mode: 'auto',
    callName,
    sinceAnalysis: prev.timestamp,
    changeReport: serializeReport(changeReport),
    assessments: localAssessments,
    summary,
    annotatedAnalysis: annotated,
  };

  try {
    fs.writeFileSync(
      path.join(runDir, 'progress.json'),
      JSON.stringify(progressData, null, 2),
      'utf8'
    );

    const progressMd = renderProgressMarkdown({
      assessments: localAssessments,
      changeReport,
      meta: { callName, timestamp: runTs, mode: 'auto' },
    });
    fs.writeFileSync(path.join(runDir, 'progress.md'), progressMd, 'utf8');
  } catch (writeErr) {
    log.warn(`Progress tracking: failed to write output — ${writeErr.message}`);
    return;
  }

  // --- Step 7: Print compact summary ---
  const hasChanges = changeReport.totals.commits > 0 ||
    changeReport.totals.filesChanged > 0 ||
    changeReport.totals.docsChanged > 0;

  if (hasChanges || summary.done > 0 || summary.inProgress > 0) {
    console.log('');
    console.log(`  ${c.heading('Progress Tracking')} ${c.dim(`(vs ${prev.timestamp})`)}`);
    console.log(`    ${c.dim('Changes:')} ${c.highlight(changeReport.totals.commits)} commits, ${c.highlight(changeReport.totals.filesChanged)} files, ${c.highlight(changeReport.totals.docsChanged)} docs`);
    console.log(`    ${STATUS_ICONS.DONE} ${c.green(summary.done)} done  ${STATUS_ICONS.IN_PROGRESS} ${c.yellow(summary.inProgress)} in progress  ${STATUS_ICONS.NOT_STARTED} ${c.dim(summary.notStarted)} not started`);
    const pct = summary.total > 0 ? ((summary.done / summary.total) * 100).toFixed(0) : '0';
    console.log(`    ${c.dim('Completion:')} ${c.highlight(pct + '%')} (${summary.done}/${summary.total})`);
    console.log(`    ${c.dim('Report:')} ${c.cyan(path.relative(PROJECT_ROOT, path.join(runDir, 'progress.md')))}`);
  } else {
    console.log(`  ${c.info('Progress tracking:')} ${c.dim('No changes detected since last run')}`);
  }

  log.step(`Auto progress: ${summary.done} done, ${summary.inProgress} in-progress, ${summary.notStarted} not-started (since ${prev.timestamp})`);
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

  if (!opts.skipGemini && !isShuttingDown()) {
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
  const completionPct = finalSummary.total > 0 ? ((finalSummary.done / finalSummary.total) * 100).toFixed(0) : '0';
  console.log(`  Overall: ${c.highlight(completionPct + '%')} complete (${c.highlight(finalSummary.done + '/' + finalSummary.total)})`);
  console.log('');

  // Cleanup
  initCtx.progress.cleanup();
  log.close();
}

module.exports = { run, getLog };
