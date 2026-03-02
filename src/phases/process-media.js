'use strict';

const fs = require('fs');
const path = require('path');

// --- Config ---
const config = require('../config');
const { AUDIO_EXTS, SPEED } = config;

// --- Services ---
const { uploadToStorage, storageExists } = require('../services/firebase');
const { processWithGemini, processSegmentBatch, cleanupGeminiFiles } = require('../services/gemini');
const { compressAndSegment, compressAndSegmentAudio, splitOnly, probeFormat, verifySegment } = require('../services/video');

// --- Utils ---
const { fmtDuration, fmtBytes } = require('../utils/format');
const { promptUser } = require('../utils/cli');
const { parallelMap } = require('../utils/retry');
const { assessQuality, formatQualityLine, getConfidenceStats, THRESHOLDS } = require('../utils/quality-gate');
const { validateAnalysis, formatSchemaLine, schemaScore, normalizeAnalysis } = require('../utils/schema-validator');
const { calculateThinkingBudget } = require('../utils/adaptive-budget');
const { detectBoundaryContext, sliceVttForSegment, planSegmentBatches, estimateTokens, buildProgressiveContext } = require('../utils/context-manager');

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

  // Build video processing options from CLI flags
  // --no-compress uses hardcoded 1200s (splitOnly default); --segment-time only for compress mode
  const videoOpts = {};
  if (!opts.noCompress && opts.segmentTime) videoOpts.segTime = opts.segmentTime;
  if (!opts.noCompress && opts.speed) videoOpts.speed = opts.speed;

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
      segments = compressAndSegment(videoPath, segmentDir, videoOpts);
      log.step(`Compressed → ${segments.length} segment(s)`);
    }
  } else if (existingSegments.length > 0) {
    segments = existingSegments.map(f => path.join(segmentDir, f));
    log.step(`SKIP compression — ${segments.length} segment(s) already on disk`);
    console.log(`  ${c.success(`Skipped compression \u2014 ${c.highlight(segments.length)} segment(s) already exist`)}`);
  } else if (opts.noCompress) {
    // --no-compress: split raw video at keyframes, no re-encoding
    segments = splitOnly(videoPath, segmentDir, videoOpts);
    log.step(`Split (raw) → ${segments.length} segment(s)`);
    console.log(`  \u2192 ${c.highlight(segments.length)} raw segment(s) created`);
  } else {
    if (isAudio) {
      segments = compressAndSegmentAudio(videoPath, segmentDir, videoOpts);
    } else {
      segments = compressAndSegment(videoPath, segmentDir, videoOpts);
    }
    log.step(`Compressed → ${segments.length} segment(s)`);
    console.log(`  \u2192 ${c.highlight(segments.length)} segment(s) created`);
  }

  progress.markCompressed(baseName, segments.length);
  const origSize = fs.statSync(videoPath).size;
  const compressedSize = segments.reduce((s, p) => s + fs.statSync(p).size, 0);
  log.step(`original=${(origSize / 1048576).toFixed(2)}MB (${fmtBytes(origSize)}) | ${segments.length} segment(s)`);
  log.metric('compression', {
    file: baseName,
    originalBytes: origSize,
    compressedBytes: compressedSize,
    ratio: origSize > 0 ? ((1 - compressedSize / origSize) * 100).toFixed(1) + '%' : 'N/A',
    segments: segments.length,
    isAudio,
  });

  // Duration-aware warnings for raw segments
  if (opts.noCompress && segments.length > 0) {
    const totalSegSize = segments.reduce((s, p) => s + fs.statSync(p).size, 0);
    const avgSegMB = totalSegSize / segments.length / 1048576;
    if (avgSegMB > 500) {
      console.warn(`  ${c.warn(`Avg segment ~${avgSegMB.toFixed(0)} MB — large raw segments take longer to upload.`)}`);
      console.warn(`  ${c.dim('  Tip: remove --no-compress to re-encode into smaller segments.')}`);
    }
    // All raw segments must use Gemini File API (>20 MB external URL limit)
    if (avgSegMB > 20) {
      console.log(`  ${c.dim('Raw segments >20 MB — will use Gemini File API upload (not storage URLs).')}`);
    }
  }
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
  // When --no-compress is active, segments play at real time (speed = 1.0)
  const effectiveSpeed = opts.noCompress ? 1.0 : (opts.speed || SPEED);
  let cumulativeTimeSec = 0;
  for (const meta of segmentMeta) {
    meta.startTimeSec = cumulativeTimeSec;
    meta.endTimeSec = cumulativeTimeSec + (meta.durSec || 0) * effectiveSpeed;
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

  // ════════════════════════════════════════════════════════════
  //  Multi-Segment Batching — pass multiple segments per call
  //  when the context window has enough headroom.
  // ════════════════════════════════════════════════════════════
  const useBatching = !opts.noBatch && !opts.skipGemini && !opts.dryRun && segments.length > 1;
  let batchedSuccessfully = false;

  if (useBatching) {
    const prevTokens = estimateTokens(buildProgressiveContext(previousAnalyses, userName) || '');
    const { batches, batchSize, reason } = planSegmentBatches(
      segmentMeta, contextDocs,
      {
        contextWindow: config.GEMINI_CONTEXT_WINDOW || 1_048_576,
        previousAnalysesTokens: prevTokens,
      }
    );

    if (batchSize > 1) {
      console.log(`  ${c.cyan('⚡ Multi-segment batching:')} ${batches.length} batch(es), up to ${batchSize} segments/batch`);
      console.log(`    ${c.dim(reason)}`);
      console.log('');
      batchedSuccessfully = true; // will be set false if we need to fall back

      for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        if (isShuttingDown()) break;
        let batchIndices = batches[bIdx];
        let batchSegs = batchIndices.map(i => ({
          segPath: segmentMeta[i].segPath,
          segName: segmentMeta[i].segName,
          durSec: segmentMeta[i].durSec,
          storageUrl: segmentMeta[i].storageUrl,
        }));
        let batchTimes = batchIndices.map(i => ({
          startTimeSec: segmentMeta[i].startTimeSec,
          endTimeSec: segmentMeta[i].endTimeSec,
        }));

        const batchLabel = batchIndices.length === 1
          ? `seg ${batchIndices[0] + 1}`
          : `segs ${batchIndices[0] + 1}–${batchIndices[batchIndices.length - 1] + 1}`;
        console.log(`  ${c.cyan('══')} Batch ${c.highlight(`${bIdx + 1}/${batches.length}`)} (${batchLabel}) ${c.cyan('══')}`);

        // Partial-cache support: load cached segments individually, only re-analyze uncached
        if (!forceReanalyze) {
          const dirFiles = fs.readdirSync(geminiRunsDir).filter(f => f.endsWith('.json'));
          const cachedSegs = [];
          const uncachedSegs = [];

          for (const i of batchIndices) {
            const prefix = `segment_${String(i).padStart(2, '0')}_`;
            const segHits = dirFiles.filter(f => f.startsWith(prefix)).sort();
            if (segHits.length > 0) {
              cachedSegs.push({ i, file: segHits[segHits.length - 1] });
            } else {
              // Also check batch files whose segment range includes this index
              const batchHits = dirFiles.filter(f => {
                const m = f.match(/^batch_\d+_segs_(\d+)-(\d+)_/);
                return m && i >= parseInt(m[1]) && i <= parseInt(m[2]);
              }).sort();
              if (batchHits.length > 0) {
                cachedSegs.push({ i, file: batchHits[batchHits.length - 1], isBatch: true });
              } else {
                uncachedSegs.push(i);
              }
            }
          }

          // Load all cached segments
          for (const { i, file, isBatch } of cachedSegs) {
            try {
              const cached = JSON.parse(fs.readFileSync(path.join(geminiRunsDir, file), 'utf8'));
              const analysis = normalizeAnalysis(cached.output.parsed || { rawResponse: cached.output.raw });
              analysis._geminiMeta = {
                model: cached.run.model,
                processedAt: cached.run.timestamp,
                durationMs: cached.run.durationMs,
                tokenUsage: cached.run.tokenUsage || null,
                runFile: path.relative(PROJECT_ROOT, path.join(geminiRunsDir, file)),
                parseSuccess: cached.output.parseSuccess,
                skipped: true,
                ...(isBatch ? { batchMode: true } : {}),
              };
              if (cached.run.tokenUsage) {
                costTracker.addSegment(segmentMeta[i].segName, cached.run.tokenUsage, cached.run.durationMs, true);
              }
              const cachedQuality = assessQuality(analysis, { parseSuccess: cached.output.parseSuccess, rawLength: (cached.output.raw || '').length });
              segmentReports.push({ segmentName: segmentMeta[i].segName, qualityReport: cachedQuality, retried: false, retryImproved: false });
              previousAnalyses.push(analysis);
              segmentAnalyses.push(analysis);

              fileResult.segments.push({
                segmentFile: segmentMeta[i].segName, segmentIndex: i,
                storagePath: segmentMeta[i].storagePath, storageUrl: segmentMeta[i].storageUrl,
                duration: fmtDuration(segmentMeta[i].durSec), durationSeconds: segmentMeta[i].durSec,
                fileSizeMB: parseFloat(segmentMeta[i].sizeMB),
                geminiRunFile: path.relative(PROJECT_ROOT, path.join(geminiRunsDir, file)),
                analysis,
              });
              console.log(`    ${c.success(`seg ${i + 1}: loaded from cache (${file})`)}`);
            } catch (err) {
              console.warn(`    ${c.warn(`seg ${i + 1}: cache corrupt — will re-analyze`)}`);
              uncachedSegs.push(i);
            }
          }

          if (uncachedSegs.length === 0) {
            console.log('');
            continue; // All segments in batch cached — skip
          }

          // Trim batch to only uncached segments
          uncachedSegs.sort((a, b) => a - b);
          batchIndices = uncachedSegs;
          batchSegs = uncachedSegs.map(i => ({
            segPath: segmentMeta[i].segPath,
            segName: segmentMeta[i].segName,
            durSec: segmentMeta[i].durSec,
            storageUrl: segmentMeta[i].storageUrl,
          }));
          batchTimes = uncachedSegs.map(i => ({
            startTimeSec: segmentMeta[i].startTimeSec,
            endTimeSec: segmentMeta[i].endTimeSec,
          }));
          const uncachedLabel = uncachedSegs.map(i => i + 1).join(', ');
          console.log(`    ${c.dim(`${cachedSegs.length} cached, ${uncachedSegs.length} to analyze (segs ${uncachedLabel})`)}`);
        }

        // Verify all segments in batch
        const invalidInBatch = batchIndices.filter(i => !verifySegment(segmentMeta[i].segPath));
        if (invalidInBatch.length > 0) {
          console.warn(`    ${c.warn(`${invalidInBatch.length} corrupt segment(s) in batch — falling back to single-segment mode`)}`);
          batchedSuccessfully = false;
          break;
        }

        try {
          let batchRun;
          try {
            batchRun = await processSegmentBatch(
              ai, batchSegs,
              `${callName}_${baseName}_batch${bIdx}`,
              contextDocs, previousAnalyses, userName, PKG_ROOT,
              {
                segmentIndices: batchIndices,
                totalSegments: segments.length,
                segmentTimes: batchTimes,
                thinkingBudget: opts.thinkingBudget || 24576,
                noStorageUrl: !!opts.noStorageUrl,
              }
            );
          } catch (batchErr) {
            const msg = batchErr.message || '';
            // If Storage URL was rejected, retry batch with forced File API uploads
            if (!opts.noStorageUrl && msg.includes('INVALID_ARGUMENT') && batchSegs.some(s => s.storageUrl)) {
              console.log(`    ${c.warn('Storage URL rejected — retrying batch with File API uploads...')}`);
              log.warn(`Batch ${bIdx} Storage URL rejected — retrying with noStorageUrl=true`);
              batchRun = await processSegmentBatch(
                ai, batchSegs,
                `${callName}_${baseName}_batch${bIdx}`,
                contextDocs, previousAnalyses, userName, PKG_ROOT,
                {
                  segmentIndices: batchIndices,
                  totalSegments: segments.length,
                  segmentTimes: batchTimes,
                  thinkingBudget: opts.thinkingBudget || 24576,
                  noStorageUrl: true,
                }
              );
              console.log(`    ${c.success('File API batch retry succeeded')}`);
            } else {
              throw batchErr;
            }
          }

          // Save batch run file
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const batchRunFileName = `batch_${bIdx}_segs_${batchIndices[0]}-${batchIndices[batchIndices.length - 1]}_${ts}.json`;
          const batchRunPath = path.join(geminiRunsDir, batchRunFileName);
          fs.writeFileSync(batchRunPath, JSON.stringify(batchRun, null, 2), 'utf8');

          const analysis = normalizeAnalysis(batchRun.output.parsed || { rawResponse: batchRun.output.raw });
          analysis._geminiMeta = {
            model: batchRun.run.model,
            processedAt: batchRun.run.timestamp,
            durationMs: batchRun.run.durationMs,
            tokenUsage: batchRun.run.tokenUsage || null,
            runFile: path.relative(PROJECT_ROOT, batchRunPath),
            parseSuccess: batchRun.output.parseSuccess,
            batchMode: true,
            segmentIndices: batchIndices,
          };

          // Track cost
          costTracker.addSegment(`batch_${bIdx}`, batchRun.run.tokenUsage, batchRun.run.durationMs, false);

          // Quality gate
          let qualityReport = assessQuality(analysis, {
            parseSuccess: batchRun.output.parseSuccess,
            rawLength: (batchRun.output.raw || '').length,
          });
          console.log(formatQualityLine(qualityReport, `batch ${bIdx + 1}`));

          // Schema validation
          let schemaReport = validateAnalysis(analysis, 'segment');
          console.log(formatSchemaLine(schemaReport));

          // Merge schema retry hints
          if (schemaReport.retryHints.length > 0) {
            qualityReport.retryHints = [...(qualityReport.retryHints || []), ...schemaReport.retryHints];
          }
          const sScore = schemaScore(schemaReport);
          if (sScore < 50 && !qualityReport.shouldRetry) {
            qualityReport.shouldRetry = true;
            qualityReport.retryHints = qualityReport.retryHints || [];
            qualityReport.retryHints.push('Your response had significant schema violations. Follow the output_structure EXACTLY as specified.');
          }

          // === BATCH AUTO-RETRY on FAIL ===
          let retried = false;
          let retryImproved = false;
          if (qualityReport.shouldRetry && !isShuttingDown()) {
            console.log(`    \u21bb Quality below threshold (${qualityReport.score}/${THRESHOLDS.FAIL_BELOW}) \u2014 retrying batch with enhanced hints...`);
            log.step(`Quality gate FAIL for batch ${bIdx} (score: ${qualityReport.score}) \u2014 retrying`);
            retried = true;

            const retryBudget = Math.min(config.getMaxThinkingBudget(), Math.round((opts.thinkingBudget || 24576) * 1.25));
            try {
              let retryRun;
              try {
                retryRun = await processSegmentBatch(
                  ai, batchSegs,
                  `${callName}_${baseName}_batch${bIdx}_retry`,
                  contextDocs, previousAnalyses, userName, PKG_ROOT,
                  {
                    segmentIndices: batchIndices,
                    totalSegments: segments.length,
                    segmentTimes: batchTimes,
                    thinkingBudget: retryBudget,
                    noStorageUrl: !!opts.noStorageUrl,
                    retryHints: qualityReport.retryHints,
                  }
                );
              } catch (retryBatchErr) {
                const msg = retryBatchErr.message || '';
                if (!opts.noStorageUrl && msg.includes('INVALID_ARGUMENT') && batchSegs.some(s => s.storageUrl)) {
                  retryRun = await processSegmentBatch(
                    ai, batchSegs,
                    `${callName}_${baseName}_batch${bIdx}_retry`,
                    contextDocs, previousAnalyses, userName, PKG_ROOT,
                    {
                      segmentIndices: batchIndices,
                      totalSegments: segments.length,
                      segmentTimes: batchTimes,
                      thinkingBudget: retryBudget,
                      noStorageUrl: true,
                      retryHints: qualityReport.retryHints,
                    }
                  );
                } else {
                  throw retryBatchErr;
                }
              }

              // Save retry run
              const retryTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              const retryRunFileName = `batch_${bIdx}_segs_${batchIndices[0]}-${batchIndices[batchIndices.length - 1]}_retry_${retryTs}.json`;
              const retryRunPath = path.join(geminiRunsDir, retryRunFileName);
              fs.writeFileSync(retryRunPath, JSON.stringify(retryRun, null, 2), 'utf8');

              const retryAnalysis = normalizeAnalysis(retryRun.output.parsed || { rawResponse: retryRun.output.raw });
              const retryQuality = assessQuality(retryAnalysis, {
                parseSuccess: retryRun.output.parseSuccess,
                rawLength: (retryRun.output.raw || '').length,
              });
              const retrySchema = validateAnalysis(retryAnalysis, 'segment');
              console.log(formatSchemaLine(retrySchema));

              costTracker.addSegment(`batch_${bIdx}_retry`, retryRun.run.tokenUsage, retryRun.run.durationMs, false);

              if (retryQuality.score > qualityReport.score) {
                retryImproved = true;
                // Replace original with retry result
                analysis = retryAnalysis;
                analysis._geminiMeta = {
                  model: retryRun.run.model,
                  processedAt: retryRun.run.timestamp,
                  durationMs: retryRun.run.durationMs,
                  tokenUsage: retryRun.run.tokenUsage || null,
                  runFile: path.relative(PROJECT_ROOT, retryRunPath),
                  parseSuccess: retryRun.output.parseSuccess,
                  batchMode: true,
                  segmentIndices: batchIndices,
                  retryOf: path.relative(PROJECT_ROOT, batchRunPath),
                };
                batchRunPath = retryRunPath;
                qualityReport = retryQuality;
                schemaReport = retrySchema;
                console.log(`    ${c.success(`Retry improved quality: ${qualityReport.score} \u2192 ${retryQuality.score}`)}`);
                console.log(formatQualityLine(retryQuality, `batch ${bIdx + 1}`));
                log.step(`Batch ${bIdx} retry improved: ${qualityReport.score} \u2192 ${retryQuality.score}`);
              } else {
                console.log(`    ${c.warn(`Retry did not improve (${qualityReport.score} \u2192 ${retryQuality.score}), keeping original`)}`);
              }
            } catch (retryErr) {
              console.warn(`    ${c.warn(`Batch retry failed: ${retryErr.message} \u2014 keeping original result`)}`);
            }
          }

          // Assign batch analysis to each segment in the batch
          for (const i of batchIndices) {
            segmentReports.push({ segmentName: segmentMeta[i].segName, qualityReport, retried, retryImproved });
            fileResult.segments.push({
              segmentFile: segmentMeta[i].segName, segmentIndex: i,
              storagePath: segmentMeta[i].storagePath, storageUrl: segmentMeta[i].storageUrl,
              duration: fmtDuration(segmentMeta[i].durSec), durationSeconds: segmentMeta[i].durSec,
              fileSizeMB: parseFloat(segmentMeta[i].sizeMB),
              geminiRunFile: path.relative(PROJECT_ROOT, batchRunPath),
              analysis,
            });
          }

          // Source-segment + source-video tagging
          const videoName = path.basename(videoPath);
          const tagSeg = (arr, segNum) => (arr || []).forEach(item => {
            if (!item.source_segment) item.source_segment = segNum;
            if (!item.source_video) item.source_video = videoName;
          });
          for (const i of batchIndices) {
            tagSeg(analysis.action_items, i + 1);
            tagSeg(analysis.change_requests, i + 1);
            tagSeg(analysis.blockers, i + 1);
            tagSeg(analysis.scope_changes, i + 1);
          }

          previousAnalyses.push(analysis);
          segmentAnalyses.push(analysis);

          // Cleanup Gemini File API uploads
          if (batchRun._geminiFileNames && batchRun._geminiFileNames.length > 0 && ai) {
            cleanupGeminiFiles(ai, batchRun._geminiFileNames).catch(() => {});
          }

          const dur = (batchRun.run.durationMs / 1000).toFixed(1);
          console.log(`    ${c.success(`Batch analysis complete (${dur}s, ${batchIndices.length} segments)`)}`);
          progress.markAnalyzed(`${baseName}_batch${bIdx}`, path.relative(PROJECT_ROOT, batchRunPath));
        } catch (err) {
          console.error(`    ${c.error(`Batch analysis failed: ${err.message}`)}`);
          console.warn(`    ${c.warn('Falling back to single-segment processing for remaining segments')}`);
          console.warn(`    ${c.dim('Tip: use --no-batch to disable batching if this persists.')}`);
          log.error(`Batch ${bIdx} failed — ${err.message}`);
          batchedSuccessfully = false;
          break;
        }
        console.log('');
      }

      if (batchedSuccessfully) {
        const totalSegs = batches.reduce((s, b) => s + b.length, 0);
        console.log(`  ${c.success(`All ${batches.length} batch(es) complete: ${totalSegs} segments analyzed`)}`);
        console.log('');
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Single-Segment Processing (original path / fallback)
  // ════════════════════════════════════════════════════════════
  if (!batchedSuccessfully) {

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
        analysis = normalizeAnalysis(existingRun.output.parsed || { rawResponse: existingRun.output.raw });
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

        analysis = normalizeAnalysis(geminiRun.output.parsed || { rawResponse: geminiRun.output.raw });
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

            const retryAnalysis = normalizeAnalysis(retryRun.output.parsed || { rawResponse: retryRun.output.raw });
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
              analysis = normalizeAnalysis(retryAnalysis);
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
        log.metric('segment_analysis', {
          segment: segName,
          source: sourceLabel,
          tickets: ticketCount,
          durationMs: geminiRun.run.durationMs,
          tokens: { input: tok.inputTokens || 0, output: tok.outputTokens || 0, thinking: tok.thoughtTokens || 0, total: tok.totalTokens || 0 },
          quality: qualityReport ? qualityReport.score : null,
          schemaValid: schemaReport ? schemaReport.valid : null,
          retried,
          retryImproved,
        });
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
      const videoName = path.basename(videoPath);
      const tagSeg = (arr) => (arr || []).forEach(item => {
        item.source_segment = segNum;
        if (!item.source_video) item.source_video = videoName;
      });
      tagSeg(analysis.action_items);
      tagSeg(analysis.change_requests);
      tagSeg(analysis.blockers);
      tagSeg(analysis.scope_changes);
      tagSeg(analysis.file_references);
      if (analysis.tickets) {
        analysis.tickets.forEach(t => {
          t.source_segment = segNum;
          t.source_video = videoName;
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

  } // end if (!batchedSuccessfully) — single-segment fallback

  // Compute totals for this file
  fileResult.compressedTotalMB = fileResult.segments
    .reduce((sum, s) => sum + s.fileSizeMB, 0).toFixed(2);
  fileResult.compressionRatio = (
    (1 - parseFloat(fileResult.compressedTotalMB) / parseFloat(fileResult.originalSizeMB)) * 100
  ).toFixed(1) + '% reduction';

  return { fileResult, segmentAnalyses, segmentReports };
}

module.exports = phaseProcessVideo;
