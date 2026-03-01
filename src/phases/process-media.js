'use strict';

const fs = require('fs');
const path = require('path');

// --- Config ---
const config = require('../config');
const { AUDIO_EXTS, SPEED } = config;

// --- Services ---
const { uploadToStorage, storageExists } = require('../services/firebase');
const { processWithGemini, cleanupGeminiFiles } = require('../services/gemini');
const { compressAndSegment, compressAndSegmentAudio, probeFormat, verifySegment } = require('../services/video');

// --- Utils ---
const { fmtDuration, fmtBytes } = require('../utils/format');
const { promptUser } = require('../utils/cli');
const { parallelMap } = require('../utils/retry');
const { assessQuality, formatQualityLine, getConfidenceStats, THRESHOLDS } = require('../utils/quality-gate');
const { validateAnalysis, formatSchemaLine, schemaScore } = require('../utils/schema-validator');
const { calculateThinkingBudget } = require('../utils/adaptive-budget');
const { detectBoundaryContext, sliceVttForSegment } = require('../utils/context-manager');

// --- Modes ---
const { identifyWeaknesses, runFocusedPass, mergeFocusedResults } = require('../modes/focused-reanalysis');

// --- Shared state ---
const { c } = require('../utils/colors');
const { getLog, isShuttingDown, PKG_ROOT, PROJECT_ROOT } = require('./_shared');

// ======================== PHASE: PROCESS VIDEO ========================

/**
 * Process a single video: compress → upload segments → analyze with Gemini.
 * Returns { fileResult, segmentAnalyses }.
 */
async function phaseProcessVideo(ctx, videoPath, videoIndex) {
  const log = getLog();
  const {
    opts, callName, storage, firebaseReady, ai, contextDocs,
    progress, costTracker, userName,
  } = ctx;

  const baseName = path.basename(videoPath, path.extname(videoPath));
  const compressedDir = path.join(ctx.targetDir, 'compressed');
  const isAudio = AUDIO_EXTS.includes(path.extname(videoPath).toLowerCase());
  const mediaLabel = isAudio ? 'audio' : 'video';
  const totalMedia = (ctx.inputMode === 'audio' ? ctx.audioFiles : ctx.videoFiles).length;

  console.log(c.cyan('──────────────────────────────────────────────'));
  console.log(`${c.dim(`[${videoIndex + 1}/${totalMedia}]`)} ${c.heading(path.basename(videoPath))} ${c.dim(`(${mediaLabel})`)}`);
  console.log(c.cyan('──────────────────────────────────────────────'));

  // ---- Compress & Segment ----
  log.step(`Compressing "${path.basename(videoPath)}" (${mediaLabel})`);
  const segmentDir = path.join(compressedDir, baseName);
  const segExt = isAudio ? '.m4a' : '.mp4';
  let segments;
  const existingSegments = fs.existsSync(segmentDir)
    ? fs.readdirSync(segmentDir).filter(f => f.startsWith('segment_') && (f.endsWith('.mp4') || f.endsWith('.m4a'))).sort()
    : [];

  if (opts.skipCompression || opts.dryRun) {
    if (existingSegments.length > 0) {
      segments = existingSegments.map(f => path.join(segmentDir, f));
      console.log(`  ${c.success(`Using ${c.highlight(segments.length)} existing segment(s) (${opts.dryRun ? '--dry-run' : '--skip-compression'})`)}`);
    } else {
      console.warn(`  ${c.warn(`No existing segments found \u2014 cannot skip compression for "${baseName}"`)}`);
      if (opts.dryRun) {
        console.log(`  ${c.dim(`[DRY-RUN] Would compress "${path.basename(videoPath)}" into segments`)}`);
        return { fileResult: null, segmentAnalyses: [] };
      }
      segments = compressAndSegment(videoPath, segmentDir);
      log.step(`Compressed → ${segments.length} segment(s)`);
    }
  } else if (existingSegments.length > 0) {
    segments = existingSegments.map(f => path.join(segmentDir, f));
    log.step(`SKIP compression — ${segments.length} segment(s) already on disk`);
    console.log(`  ${c.success(`Skipped compression \u2014 ${c.highlight(segments.length)} segment(s) already exist`)}`);
  } else {
    if (isAudio) {
      segments = compressAndSegmentAudio(videoPath, segmentDir);
    } else {
      segments = compressAndSegment(videoPath, segmentDir);
    }
    log.step(`Compressed → ${segments.length} segment(s)`);
    console.log(`  \u2192 ${c.highlight(segments.length)} segment(s) created`);
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
      console.warn(`  ${c.warn(`Pre-validation: ${invalidSegs.length}/${segments.length} segment(s) are corrupt:`)}`);
      invalidSegs.forEach(s => console.warn(`    ${c.error(path.basename(s))}`));
      console.warn(`    ${c.dim(`\u2192 Corrupt segments will be skipped during analysis.`)}`);
      console.warn(`    ${c.dim(`\u2192 Delete "${segmentDir}" and re-run to re-compress.`)}`);
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
      if (isShuttingDown()) return;
      console.log(`  ${c.cyan('──')} Segment ${c.highlight(`${j + 1}/${segments.length}`)}: ${c.cyan(meta.segName)} ${c.dim('(upload)')} ${c.cyan('──')}`);
      console.log(`    Duration: ${c.yellow(fmtDuration(meta.durSec))} | Size: ${c.yellow(meta.sizeMB + ' MB')}`);

      const resumedUrl = progress.getUploadUrl(meta.storagePath);
      if (resumedUrl && opts.resume) {
        meta.storageUrl = resumedUrl;
        console.log(`    ${c.success('Upload resumed from checkpoint')}`);
        return;
      }

      try {
        if (!opts.forceUpload) {
          const existingUrl = await storageExists(storage, meta.storagePath);
          if (existingUrl) {
            meta.storageUrl = existingUrl;
            log.step(`SKIP upload — ${meta.segName} already in Storage`);
            console.log(`    ${c.success(`Already in Storage → ${c.cyan(meta.storagePath)}`)}`);
            progress.markUploaded(meta.storagePath, meta.storageUrl);
            return;
          }
        }
        console.log(`    ${c.dim(opts.forceUpload ? 'Re-uploading' : 'Uploading')} to Firebase Storage...`);
        meta.storageUrl = await uploadToStorage(storage, meta.segPath, meta.storagePath);
        console.log(`    ${c.success(`${opts.forceUpload ? 'Re-uploaded' : 'Uploaded'} → ${c.cyan(meta.storagePath)}`)}`);
        log.step(`Upload OK: ${meta.segName} → ${meta.storagePath}`);
        progress.markUploaded(meta.storagePath, meta.storageUrl);
      } catch (err) {
        console.error(`    ${c.error(`Firebase upload failed: ${err.message}`)}`);
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

      console.log(`  ${c.cyan('──')} Segment ${c.highlight(`${j + 1}/${segments.length}`)}: ${c.cyan(segName)} ${c.cyan('──')}`);
      console.log(`    Duration: ${c.yellow(fmtDuration(durSec))} | Size: ${c.yellow(sizeMB + ' MB')}`);
      if (opts.skipUpload) console.log(`    ${c.warn('Upload skipped (--skip-upload)')}`);

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
      console.log(`  Found ${c.highlight(allExistingRuns.length)} existing Gemini run file(s) in:`);
      console.log(`    ${c.cyan(geminiRunsDir)}`);
      console.log('');
      if (!opts.resume) {
        forceReanalyze = await promptUser('  Re-analyze all segments? (y/n, default: n): ');
      }
      if (forceReanalyze) {
        console.log(`  → ${c.yellow('Will re-analyze all segments')} ${c.dim('(previous runs preserved with timestamps)')}`);
        log.step('User chose to re-analyze all segments');
      } else {
        console.log(`  → ${c.dim('Using cached results where available')}`);
      }
      console.log('');
    }
  }

  const previousAnalyses = [];
  const segmentAnalyses = [];
  const segmentReports = []; // Quality reports for health dashboard

  for (let j = 0; j < segments.length; j++) {
    if (isShuttingDown()) break;

    const { segPath, segName, storagePath, storageUrl, durSec, sizeMB } = segmentMeta[j];

    console.log(`  ${c.cyan('──')} Segment ${c.highlight(`${j + 1}/${segments.length}`)}: ${c.cyan(segName)} ${c.dim('(AI)')} ${c.cyan('──')}`);

    if (opts.skipGemini) {
      console.log(`    ${c.warn('Skipped (--skip-gemini)')}`);
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
      console.log(`    ${c.dim(`[DRY-RUN] Would analyze with ${c.cyan(config.GEMINI_MODEL)}`)}`);
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

        // Schema validation on cached results
        const cachedSchema = validateAnalysis(analysis, 'segment');
        console.log(formatSchemaLine(cachedSchema));

        const ticketCount = analysis.tickets ? analysis.tickets.length : 0;
        log.step(`SKIP Gemini — ${segName} already analyzed (${ticketCount} ticket(s), quality: ${cachedQuality.score}/100, schema: ${cachedSchema.valid ? 'valid' : cachedSchema.errorCount + ' errors'})`);
        console.log(`    ${c.success(`Already analyzed — loaded from ${c.cyan(latestRunFile)}`)}`);
      } catch (err) {
        console.warn(`    ${c.warn(`Existing run file corrupt, re-analyzing: ${err.message}`)}`);
        analysis = null;
      }
    }

    if (!analysis) {
      // Pre-flight: verify segment is a valid MP4
      if (!verifySegment(segPath)) {
        console.error(`    ${c.error(`Segment "${segName}" is corrupt (missing moov atom / unreadable).`)}`);
        console.error(`      ${c.dim(`→ Delete "${path.dirname(segPath)}" and re-run to re-compress.`)}`);
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
      console.log(`    Thinking budget: ${c.highlight(adaptiveBudget.toLocaleString())} tokens ${c.dim(`(${budgetResult.reason})`)}`);
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

        // === SCHEMA VALIDATION ===
        const schemaReport = validateAnalysis(analysis, 'segment');
        console.log(formatSchemaLine(schemaReport));
        if (!schemaReport.valid && schemaReport.errorCount > 0) {
          log.warn(`Schema validation: ${schemaReport.summary}`);
        }

        // Merge schema retry hints into quality-gate retry hints
        if (schemaReport.retryHints.length > 0) {
          qualityReport.retryHints = [...(qualityReport.retryHints || []), ...schemaReport.retryHints];
        }

        // Factor schema score into shouldRetry decision
        const sScore = schemaScore(schemaReport);
        if (sScore < 50 && !qualityReport.shouldRetry) {
          qualityReport.shouldRetry = true;
          qualityReport.retryHints = qualityReport.retryHints || [];
          qualityReport.retryHints.push('Your response had significant schema violations. Follow the output_structure EXACTLY as specified.');
        }

        // === AUTO-RETRY on FAIL ===
        if (qualityReport.shouldRetry && !isShuttingDown()) {
          console.log(`    ↻ Quality below threshold (${qualityReport.score}/${THRESHOLDS.FAIL_BELOW}) — retrying with enhanced hints...`);
          log.step(`Quality gate FAIL for ${segName} (score: ${qualityReport.score}) — retrying`);
          retried = true;

          // Boost thinking budget for retry (+25%, clamped to model max)
          const retryBudget = Math.min(config.getMaxThinkingBudget(), Math.round(adaptiveBudget * 1.25));

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

            // Schema validation on retry
            const retrySchema = validateAnalysis(retryAnalysis, 'segment');
            console.log(formatSchemaLine(retrySchema));

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
              console.log(`    ${c.success(`Retry improved quality: ${qualityReport.score} → ${retryQuality.score}`)}`);
              console.log(formatQualityLine(retryQuality, segName));
              log.step(`Retry improved ${segName}: ${qualityReport.score} → ${retryQuality.score}`);
              segmentReports.push({ segmentName: segName, qualityReport: retryQuality, retried: true, retryImproved: true });
            } else {
              console.log(`    ${c.warn(`Retry did not improve (${qualityReport.score} → ${retryQuality.score}), keeping original`)}`);
              segmentReports.push({ segmentName: segName, qualityReport, retried: true, retryImproved: false });
            }
          } catch (retryErr) {
            console.warn(`    ${c.warn(`Retry failed: ${retryErr.message} — keeping original result`)}`);
            segmentReports.push({ segmentName: segName, qualityReport, retried: true, retryImproved: false });
          }
        } else {
          segmentReports.push({ segmentName: segName, qualityReport, retried: false, retryImproved: false });
        }

        // === FOCUSED RE-ANALYSIS (v6) ===
        if (!opts.disableFocusedPass && ai && !isShuttingDown()) {
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
                console.log(`    ${c.success(`Focused pass enhanced ${weakness.weakAreas.length} area(s)`)}`);
                log.step(`Focused re-analysis merged for ${segName}`);
              } else {
                console.log(`    ${c.info('Focused pass found no additional items')}`);
              }
            } catch (focErr) {
              console.warn(`    ${c.warn(`Focused re-analysis error: ${focErr.message}`)}`);
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
        console.log(`    ${c.success(`AI analysis complete (${(geminiRun.run.durationMs / 1000).toFixed(1)}s)`)}${retried ? (retryImproved ? ' [retry improved]' : ' [retried]') : ''}`);
        progress.markAnalyzed(`${baseName}_seg${j}`, geminiRunFile);
      } catch (err) {
        console.error(`    ${c.error(`Gemini failed: ${err.message}`)}`);
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

module.exports = phaseProcessVideo;
