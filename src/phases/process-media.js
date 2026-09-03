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
const { parallelMap, describeError } = require('../utils/retry');
const { assignSegmentModels, pricingFor } = require('../utils/model-pool');
const { withLogPrefix } = require('../utils/log-prefix');
const { assessQuality, formatQualityLine, getConfidenceStats, THRESHOLDS } = require('../utils/quality-gate');
const { validateAnalysis, formatSchemaLine, schemaScore, normalizeAnalysis } = require('../utils/schema-validator');
const { calculateThinkingBudget } = require('../utils/adaptive-budget');
const { detectBoundaryContext, sliceVttForSegment, planSegmentBatches, estimateTokens, buildProgressiveContext, partitionTranscripts } = require('../utils/context-manager');

// --- Modes ---
const { identifyWeaknesses, runFocusedPass, mergeFocusedResults } = require('../modes/focused-reanalysis');

// --- Shared state ---
const { c } = require('../utils/colors');
const { getLog, isShuttingDown, PKG_ROOT, PROJECT_ROOT, uploadSkipReason } = require('./_shared');

// ======================== SEGMENT CACHE VALIDITY ========================

/** Sidecar recording the settings a segment folder was produced with. */
const SEGMENT_MANIFEST = '.segment-params.json';

/** The settings and source facts that determine whether segments are reusable. */
function segmentParams(videoPath, videoOpts, opts) {
  let size = null;
  let mtimeMs = null;
  try {
    const st = fs.statSync(videoPath);
    size = st.size;
    mtimeMs = Math.floor(st.mtimeMs);
  } catch { /* source unreadable — treated as unknown below */ }

  return {
    // The ENCODE speed, not the target — that is what determines the bytes on
    // disk. Two runs that reach a different final speed from different sources
    // but encode identically produce identical segments, and reusing them is
    // correct: timestamps are recomputed from the timeline speed every run.
    speed: opts.noCompress ? 1 : (videoOpts.speed ?? SPEED),
    segTime: videoOpts.segTime ?? null,
    noCompress: !!opts.noCompress,
    sourceSize: size,
    sourceMtimeMs: mtimeMs,
  };
}

/**
 * Why the cached segments cannot be trusted — or null when they can.
 *
 * A folder with no manifest predates this check: those are reused as before and
 * a manifest is written for next time, so nobody is forced into a re-encode by
 * the upgrade itself.
 */
function segmentCacheStaleReason(segmentDir, videoPath, videoOpts, opts) {
  const manifestPath = path.join(segmentDir, SEGMENT_MANIFEST);
  const current = segmentParams(videoPath, videoOpts, opts);

  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    writeSegmentManifest(segmentDir, current); // adopt existing segments once
    return null;
  }

  if (saved.noCompress !== current.noCompress) {
    return saved.noCompress ? 'made with --no-compress' : 'made with compression';
  }
  if (!current.noCompress && saved.speed !== current.speed) {
    return `speed changed ${saved.speed}x → ${current.speed}x`;
  }
  if (!current.noCompress && saved.segTime !== current.segTime) {
    return `segment time changed ${saved.segTime ?? 'default'} → ${current.segTime ?? 'default'}`;
  }
  if (saved.sourceSize != null && current.sourceSize != null && saved.sourceSize !== current.sourceSize) {
    return 'source recording changed on disk';
  }
  return null;
}

/** Record the settings used, so a later run can tell whether they still apply. */
function writeSegmentManifest(segmentDir, params) {
  try {
    fs.mkdirSync(segmentDir, { recursive: true });
    fs.writeFileSync(path.join(segmentDir, SEGMENT_MANIFEST), JSON.stringify(params, null, 2));
  } catch { /* cache metadata is best-effort */ }
}

// ======================== PHASE: PREPARE MEDIA ========================

/**
 * Stage 1 of media processing: everything that must happen before a single AI
 * token is spent — compress/segment, validate, upload.
 *
 * Split out from analysis so preparation can run *ahead of* the AI stage: the
 * pipeline chains all prep work immediately, and each file's analysis simply
 * waits for its own prep to land. That keeps ffmpeg (CPU) and Gemini (network)
 * busy at the same time, and surfaces an unencodable file early.
 *
 * Returns the handoff object consumed by phaseAnalyzeMedia.
 */
async function phasePrepareMedia(ctx, videoPath, videoIndex) {
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
  //
  // `speeds.encodeSpeed` is what ffmpeg gets — for a recording that was already
  // captured sped up, that is only the remainder needed to reach the target, so
  // the two speeds never compound.
  const speeds = config.resolveSpeeds(opts);
  const videoOpts = {};
  if (!opts.noCompress && opts.segmentTime) videoOpts.segTime = opts.segmentTime;
  if (!opts.noCompress) {
    videoOpts.speed = speeds.encodeSpeed;
    videoOpts.sourceSpeed = speeds.sourceSpeed;
  }

  // Cached segments are only valid for the settings and source they were made
  // from. Reusing 1.6x segments after --speed 2 (or after the recording was
  // re-downloaded) silently produces analysis with wrong timings.
  const staleReason = existingSegments.length > 0
    ? segmentCacheStaleReason(segmentDir, videoPath, videoOpts, opts)
    : null;
  if (staleReason) {
    console.log(`  ${c.warn(`Existing segments are stale (${staleReason}) — re-encoding.`)}`);
    log.step(`Segment cache invalidated for ${baseName}: ${staleReason}`);
    existingSegments.length = 0;
  }

  if (opts.skipCompression || opts.dryRun) {
    if (existingSegments.length > 0) {
      segments = existingSegments.map(f => path.join(segmentDir, f));
      console.log(`  ${c.success(`Using ${c.highlight(segments.length)} existing segment(s) (${opts.dryRun ? '--dry-run' : '--skip-compression'})`)}`);
    } else {
      console.warn(`  ${c.warn(`No existing segments found \u2014 cannot skip compression for "${baseName}"`)}`);
      if (opts.dryRun) {
        console.log(`  ${c.dim(`[DRY-RUN] Would compress "${path.basename(videoPath)}" into segments`)}`);
        return { skipped: true, videoPath, videoIndex };
      }
      segments = await compressAndSegment(videoPath, segmentDir, videoOpts);
      log.step(`Compressed → ${segments.length} segment(s)`);
    }
  } else if (existingSegments.length > 0) {
    segments = existingSegments.map(f => path.join(segmentDir, f));
    log.step(`SKIP compression — ${segments.length} segment(s) already on disk`);
    console.log(`  ${c.success(`Skipped compression \u2014 ${c.highlight(segments.length)} segment(s) already exist`)}`);
  } else if (opts.noCompress) {
    // --no-compress: split raw video at keyframes, no re-encoding
    segments = await splitOnly(videoPath, segmentDir, videoOpts);
    log.step(`Split (raw) → ${segments.length} segment(s)`);
    console.log(`  \u2192 ${c.highlight(segments.length)} raw segment(s) created`);
  } else {
    if (isAudio) {
      segments = await compressAndSegmentAudio(videoPath, segmentDir, videoOpts);
    } else {
      segments = await compressAndSegment(videoPath, segmentDir, videoOpts);
    }
    log.step(`Compressed → ${segments.length} segment(s)`);
    console.log(`  \u2192 ${c.highlight(segments.length)} segment(s) created`);
  }

  // Stamp the folder so a later run can tell whether these segments still match
  // the requested settings and the source file.
  writeSegmentManifest(segmentDir, segmentParams(videoPath, videoOpts, opts));

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
      if (opts.skipUpload) console.log(`    ${c.dim(`Upload skipped (${uploadSkipReason(opts)})`)}`);

      segmentMeta.push({ segPath, segName, storagePath, storageUrl: null, durSec, sizeMB });
    }
  }

  // Calculate cumulative time offsets for VTT time-slicing.
  // These are ORIGINAL-meeting seconds, so the multiplier is the full timeline
  // speed: the capture speed times whatever ffmpeg applied. With --no-compress
  // nothing is re-encoded, so it collapses to the capture speed alone.
  const effectiveSpeed = speeds.timelineSpeed;
  let cumulativeTimeSec = 0;
  for (const meta of segmentMeta) {
    meta.startTimeSec = cumulativeTimeSec;
    meta.endTimeSec = cumulativeTimeSec + (meta.durSec || 0) * effectiveSpeed;
    cumulativeTimeSec = meta.endTimeSec;
  }

  console.log('');
  log.step(`Prepared "${path.basename(videoPath)}": ${segments.length} segment(s) ready for analysis`);

  return {
    videoPath, videoIndex, baseName, segmentDir, isAudio, mediaLabel,
    segments, segmentMeta, fileResult, origSize,
  };
}

// ======================== PHASE: ANALYZE MEDIA ========================

/**
 * Stage 2: send a prepared file's segments to Gemini.
 * Takes the handoff object from phasePrepareMedia — by the time this runs, the
 * file is already compressed, validated and uploaded.
 *
 * Returns { fileResult, segmentAnalyses, segmentReports }.
 */
/**
 * Stamp source_segment / source_video onto every item a segment analysis holds.
 *
 * Shared by the main loop and the rescue pass so a rescued segment's items are
 * attributed exactly like the ones that succeeded first time round.
 *
 * @param {object} analysis - Normalized segment analysis (mutated in place)
 * @param {number} segNum - 1-based segment number
 * @param {string} videoName - Source video file name
 */
function tagSegmentSources(analysis, segNum, videoName) {
  const tagSeg = (arr) => (arr || []).forEach(item => {
    // Some arrays (e.g. ticket comments/code_changes) legitimately contain
    // plain strings — skip non-objects or we'd throw "cannot create property
    // 'source_segment' on string" and crash the whole segment tagging step.
    if (!item || typeof item !== 'object') return;
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
}

async function phaseAnalyzeMedia(ctx, prep) {
  const log = getLog();
  const {
    opts, callName, ai,
    progress, costTracker, userName,
  } = ctx;
  const { videoPath, baseName, segments, segmentMeta, fileResult } = prep;

  // A folder can hold several recordings but a transcript for only one of them.
  // Keep this recording's transcript and drop the others: slicing a foreign
  // transcript by this video's timestamps invents speakers, quotes and times.
  const allMediaPaths = [...(ctx.videoFiles || []), ...(ctx.audioFiles || [])];
  const { transcript: ownTranscript, docs: contextDocs, dropped: foreignTranscripts } =
    partitionTranscripts(videoPath, ctx.contextDocs, allMediaPaths);

  if (foreignTranscripts.length > 0) {
    const names = foreignTranscripts.map(d => d.fileName).join(', ');
    console.log(`  ${c.dim(`Transcript(s) belonging to other recordings excluded: ${names}`)}`);
    log.step(`Excluded ${foreignTranscripts.length} foreign transcript(s) for ${baseName}: ${names}`);
  }
  if (ownTranscript) {
    log.step(`Transcript for ${baseName}: ${ownTranscript.fileName}`);
  } else if (ctx.contextDocs.some(d => /\.(vtt|srt)$/i.test(d.fileName || ''))) {
    console.log(`  ${c.dim('No transcript matches this recording — analyzing from audio/video only.')}`);
    log.step(`No transcript matched ${baseName}`);
  }

  console.log('');
  log.step(`Analyzing "${path.basename(videoPath)}" — ${segments.length} segment(s)`);
  console.log('');

  // ---- Analyze all segments with Gemini ----
  progress.setPhase('analyze');
  const geminiRunsDir = path.join(PROJECT_ROOT, 'gemini_runs', callName, baseName);
  fs.mkdirSync(geminiRunsDir, { recursive: true });

  // Whether to ignore cached runs is decided once up front, in
  // promptReanalyzeCached() — asking here would land in the middle of the
  // analyze stage while media prep is still logging in the background.
  const forceReanalyze = opts.reanalyze;
  if (!forceReanalyze && !opts.skipGemini && !opts.dryRun) {
    const allExistingRuns = fs.readdirSync(geminiRunsDir).filter(f => f.endsWith('.json'));
    if (allExistingRuns.length > 0) {
      console.log(`  ${c.dim(`Using cached results where available (${allExistingRuns.length} previous run file(s))`)}`);
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
          let batchRunPath = path.join(geminiRunsDir, batchRunFileName);
          fs.writeFileSync(batchRunPath, JSON.stringify(batchRun, null, 2), 'utf8');

          // Detect unrecovered thinking drain — fall back to single-segment mode
          const batchTU = batchRun.run.tokenUsage || {};
          if (batchTU.outputTokens === 0 && batchTU.thoughtTokens > 0) {
            console.warn(`    ${c.warn('Thinking budget drain not recovered — falling back to single-segment processing')}`);
            log.warn(`Batch ${bIdx} thinking drain (${batchTU.thoughtTokens} thinking, 0 output) — falling back to single-segment`);
            costTracker.addSegment(`batch_${bIdx}_drain`, batchTU, batchRun.run.durationMs, false);
            batchedSuccessfully = false;
            break;
          }

          let analysis = normalizeAnalysis(batchRun.output.parsed || { rawResponse: batchRun.output.raw });
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
          if (sScore < 50 && !qualityReport.shouldRetry && qualityReport.score < THRESHOLDS.PASS_ABOVE) {
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

  // Segments already analyzed by earlier successful batches (before a later batch
  // failed and triggered this fallback) are recorded in fileResult.segments with
  // an `analysis`. Skip them here — the single-segment cache lookup only sees
  // `segment_NN_*.json` files, not the `batch_*_segs_*.json` those batches wrote,
  // so without this guard they'd be re-analyzed (duplicate items + double cost).
  const alreadyDone = new Set(
    fileResult.segments.filter(s => s.analysis).map(s => s.segmentIndex)
  );

  // ── Parallel segment analysis ─────────────────────────────────────────────
  // One model's demand spike stalls every segment queued behind it. Running
  // segments concurrently on DIFFERENT models turns that into one retry
  // instead of a stalled run, and cuts wall-clock time by roughly the pool
  // size. The cost is context: concurrent segments cannot read each other's
  // analyses, so the progressive context that lets segment 4 resolve a ticket
  // segment 2 opened is only partially available. Hence opt-in.
  const requestedConcurrency = opts.segmentConcurrency > 0
    ? opts.segmentConcurrency
    : (opts.parallelSegments ? 3 : 1);
  const segmentConcurrency = Math.max(1, Math.min(requestedConcurrency, segments.length));
  const parallelSegments = segmentConcurrency > 1;
  const modelFallback = !opts.noModelFallback;

  // Model per segment. Sequential runs keep the chosen model throughout;
  // parallel runs rotate so concurrent requests hit separate capacity pools.
  const segmentModels = parallelSegments
    ? assignSegmentModels(segments.length, {
        primary: config.GEMINI_MODEL,
        poolSize: segmentConcurrency,
      })
    : segments.map(() => config.GEMINI_MODEL);

  // Analyses keyed by segment index. previousAnalyses records completion order,
  // which is meaningless once segments run concurrently — this keeps the
  // "everything before segment j" view the context builder expects.
  const analysisByIndex = new Map();
  const recordAnalysis = (index, analysis) => {
    if (analysis && !analysis.error) analysisByIndex.set(index, analysis);
  };
  // Seed with anything an earlier batch already analyzed, so a segment running
  // here still sees the segments before it even on the batch-fallback path.
  for (const seg of fileResult.segments) recordAnalysis(seg.segmentIndex, seg.analysis);
  /** Prior-segment context for segment j — in order, and only what is ready. */
  const contextFor = (j) => {
    if (!parallelSegments) return previousAnalyses;
    const prior = [];
    for (let k = 0; k < j; k++) {
      const a = analysisByIndex.get(k);
      if (a) prior.push(a);
    }
    return prior;
  };

  if (parallelSegments) {
    const distinct = [...new Set(segmentModels)];
    console.log(`  ${c.cyan('⚡ Parallel segments:')} ${segmentConcurrency} at a time across ${distinct.length} model(s)`);
    for (const m of distinct) {
      const owned = segmentModels.reduce((n, id, i) => n + (id === m && !alreadyDone.has(i) ? 1 : 0), 0);
      console.log(`    ${c.dim(`${m} → ${owned} segment(s)`)}`);
    }
    console.log(`  ${c.dim('Cross-segment context is reduced in this mode — compilation still deduplicates.')}`);
    console.log('');
  }

  const analyzeSegment = async (j) => {
    if (isShuttingDown()) return;
    if (alreadyDone.has(j)) return;

    const { segPath, segName, storagePath, storageUrl, durSec, sizeMB } = segmentMeta[j];
    const segModel = segmentModels[j] || config.GEMINI_MODEL;

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
      return;
    }

    if (opts.dryRun) {
      console.log(`    ${c.dim(`[DRY-RUN] Would analyze with ${c.cyan(segModel)}`)}`);
      fileResult.segments.push({
        segmentFile: segName, segmentIndex: j,
        storagePath, storageUrl,
        duration: fmtDuration(durSec), durationSeconds: durSec,
        fileSizeMB: parseFloat(sizeMB), geminiRunFile: null, analysis: null,
      });
      console.log('');
      return;
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
        recordAnalysis(j, analysis);
        // Track cached run costs too
        if (existingRun.run.tokenUsage) {
          costTracker.addSegment(segName, existingRun.run.tokenUsage, existingRun.run.durationMs, true, pricingFor(existingRun.run.model));
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
        return;
      }

      // === ADAPTIVE THINKING BUDGET ===
      // Transcript text for this segment — only ever this recording's own
      // transcript, sliced to the segment's time range.
      let vttContentForAnalysis = '';
      if (ownTranscript && ownTranscript.content) {
        vttContentForAnalysis = (segmentMeta[j].startTimeSec != null && segmentMeta[j].endTimeSec != null)
          ? sliceVttForSegment(ownTranscript.content, segmentMeta[j].startTimeSec, segmentMeta[j].endTimeSec)
          : ownTranscript.content;
      }

      const budgetResult = calculateThinkingBudget({
        segmentIndex: j,
        totalSegments: segments.length,
        previousAnalyses: contextFor(j),
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
      const prevAnalysis = parallelSegments
        ? (analysisByIndex.get(j - 1) || null)
        : (previousAnalyses.length > 0 ? previousAnalyses[previousAnalyses.length - 1] : null);
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
          contextFor(j),
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
            modelId: segModel,
            modelFallback,
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
        costTracker.addSegment(segName, geminiRun.run.tokenUsage, geminiRun.run.durationMs, false, pricingFor(geminiRun.run.model));

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
        if (sScore < 50 && !qualityReport.shouldRetry && qualityReport.score < THRESHOLDS.PASS_ABOVE) {
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
              contextFor(j),
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
                modelId: segModel,
                modelFallback,
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
            costTracker.addSegment(`${segName}_retry`, retryRun.run.tokenUsage, retryRun.run.durationMs, false, pricingFor(retryRun.run.model));

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
        recordAnalysis(j, analysis);

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
        const why = describeError(err);
        console.error(`    ${c.error(`Gemini failed: ${why}`)}`);
        console.warn(`    ${c.dim('→ Queued for the rescue pass — this segment is re-analyzed before compilation.')}`);
        log.error(`Gemini FAIL: ${segName} — ${why}`);
        analysis = { error: why };
        segmentReports.push({ segmentName: segName, qualityReport: { grade: 'FAIL', score: 0, issues: [why] }, retried: false, retryImproved: false });
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
      tagSegmentSources(analysis, j + 1, path.basename(videoPath));
      segmentAnalyses.push(analysis);
    }

    console.log('');
  };

  const segmentQueue = Array.from({ length: segments.length }, (_, j) => j)
    .filter(j => !alreadyDone.has(j));

  if (parallelSegments) {
    // Concurrent segments write to the same console, so each one's lines are
    // tagged with its segment number — otherwise the log reads as one garbled
    // segment and a failure cannot be traced to the segment it belongs to.
    await parallelMap(
      segmentQueue,
      (j) => withLogPrefix(c.dim(`[seg ${j + 1}] `), () => analyzeSegment(j)),
      segmentConcurrency
    );

    // Concurrent workers finish out of order, so both the per-file record and
    // the compilation input are re-sorted into segment order — a later segment
    // that finished first must not be compiled as if it came earlier.
    fileResult.segments.sort((a, b) => a.segmentIndex - b.segmentIndex);
    segmentAnalyses.length = 0;
    for (const seg of fileResult.segments) {
      if (seg.analysis && !seg.analysis.error) segmentAnalyses.push(seg.analysis);
    }
    // previousAnalyses feeds the rescue pass below; give it the same order.
    const ordered = [];
    for (let j = 0; j < segments.length; j++) {
      const a = analysisByIndex.get(j);
      if (a) ordered.push(a);
    }
    previousAnalyses.length = 0;
    previousAnalyses.push(...ordered);
  } else {
    for (const j of segmentQueue) {
      if (isShuttingDown()) break;
      await analyzeSegment(j);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Rescue Pass — a dropped segment is lost work, not a warning
  // ════════════════════════════════════════════════════════════
  // Each segment carries tickets and action items nobody recovers by
  // re-watching the call. When an outage eats every in-call retry, the segment
  // gets independent attempts here — fresh upload, halved thinking budget, long
  // cool-off between tries — before the run compiles without it.
  const RESCUE_ATTEMPTS = 3;
  const RESCUE_WAIT_MS = 30000;
  // Attempt 1 retries the model the run was configured with; later attempts
  // move down the chain rather than queueing behind the same outage.
  const rescueChain = assignSegmentModels(RESCUE_ATTEMPTS, { primary: config.GEMINI_MODEL });

  const rescueTargets = fileResult.segments
    .filter(seg => seg.analysis && seg.analysis.error && segmentMeta[seg.segmentIndex])
    .sort((a, b) => a.segmentIndex - b.segmentIndex);

  if (rescueTargets.length > 0 && ai && !opts.skipGemini && !opts.dryRun && !isShuttingDown()) {
    console.log(`  ${c.warn(`Rescue pass: ${rescueTargets.length} segment(s) failed — re-analyzing before compilation`)}`);
    log.step(`Rescue pass starting for ${rescueTargets.length} failed segment(s)`);

    for (const target of rescueTargets) {
      const j = target.segmentIndex;
      const { segPath, segName } = segmentMeta[j];

      for (let attempt = 1; attempt <= RESCUE_ATTEMPTS && target.analysis.error; attempt++) {
        if (isShuttingDown()) break;

        // A corrupt segment fails for a reason no wait will fix — check first.
        if (!verifySegment(segPath)) {
          console.error(`  ${c.error(`Cannot rescue ${segName} — the segment file is unreadable. Delete the segment folder and re-run to re-compress.`)}`);
          break;
        }

        const waitMs = RESCUE_WAIT_MS * attempt;
        console.log(`  ${c.cyan('──')} Rescue ${c.highlight(`${attempt}/${RESCUE_ATTEMPTS}`)}: ${c.cyan(segName)} ${c.dim(`(waiting ${(waitMs / 1000).toFixed(0)}s first)`)} ${c.cyan('──')}`);
        // Wait in 1s slices so Ctrl-C still lands during the cool-off.
        for (let waited = 0; waited < waitMs && !isShuttingDown(); waited += 1000) {
          await new Promise(r => setTimeout(r, 1000));
        }
        if (isShuttingDown()) break;

        try {
          // Halved budget: a stalled request is usually one that thought for
          // longer than the connection was willing to wait.
          const rescueBudget = Math.max(4096, Math.floor((opts.thinkingBudget || config.THINKING_BUDGET) / 2));
          const rescueRun = await processWithGemini(
            ai, segPath,
            `${callName}_${baseName}_seg${String(j).padStart(2, '0')}_rescue${attempt}`,
            contextDocs,
            previousAnalyses,
            userName,
            PKG_ROOT,
            {
              segmentIndex: j,
              totalSegments: segments.length,
              segmentStartSec: segmentMeta[j].startTimeSec,
              segmentEndSec: segmentMeta[j].endTimeSec,
              thinkingBudget: rescueBudget,
              storageDownloadUrl: opts.noStorageUrl ? null : (segmentMeta[j].storageUrl || null),
              // Each rescue attempt starts on a different model: the one that
              // dropped this segment is the least likely to answer next.
              modelId: rescueChain[(attempt - 1) % rescueChain.length],
              modelFallback: !opts.noModelFallback,
            }
          );

          const rescueTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const rescueFileName = `segment_${String(j).padStart(2, '0')}_rescue_${rescueTs}.json`;
          const rescuePath = path.join(geminiRunsDir, rescueFileName);
          fs.writeFileSync(rescuePath, JSON.stringify(rescueRun, null, 2), 'utf8');
          const rescueRunFile = path.relative(PROJECT_ROOT, rescuePath);

          const rescued = normalizeAnalysis(rescueRun.output.parsed || { rawResponse: rescueRun.output.raw });
          rescued._geminiMeta = {
            model: rescueRun.run.model,
            processedAt: rescueRun.run.timestamp,
            durationMs: rescueRun.run.durationMs,
            tokenUsage: rescueRun.run.tokenUsage || null,
            runFile: rescueRunFile,
            parseSuccess: rescueRun.output.parseSuccess,
            rescuedOnAttempt: attempt,
          };

          costTracker.addSegment(`${segName}_rescue`, rescueRun.run.tokenUsage, rescueRun.run.durationMs, false, pricingFor(rescueRun.run.model));

          const rescueQuality = assessQuality(rescued, {
            parseSuccess: rescueRun.output.parseSuccess,
            rawLength: (rescueRun.output.raw || '').length,
            segmentIndex: j,
            totalSegments: segments.length,
          });
          console.log(formatQualityLine(rescueQuality, segName));
          console.log(formatSchemaLine(validateAnalysis(rescued, 'segment')));

          tagSegmentSources(rescued, j + 1, path.basename(videoPath));

          target.analysis = rescued;
          target.geminiRunFile = rescueRunFile;
          previousAnalyses.push(rescued);

          const report = segmentReports.find(r => r.segmentName === segName);
          if (report) {
            report.qualityReport = rescueQuality;
            report.retried = true;
            report.retryImproved = true;
          } else {
            segmentReports.push({ segmentName: segName, qualityReport: rescueQuality, retried: true, retryImproved: true });
          }

          progress.markAnalyzed(`${baseName}_seg${j}`, rescueRunFile);
          const ticketCount = rescued.tickets ? rescued.tickets.length : 0;
          console.log(`    ${c.success(`Rescued on attempt ${attempt} — ${ticketCount} ticket(s)`)}`);
          log.step(`Rescue OK: ${segName} on attempt ${attempt} (${ticketCount} ticket(s))`);
        } catch (err) {
          const why = describeError(err);
          console.error(`    ${c.error(`Rescue attempt ${attempt} failed: ${why}`)}`);
          log.error(`Rescue FAIL: ${segName} attempt ${attempt} — ${why}`);
          target.analysis = { error: why };
        }
      }
      console.log('');
    }

    // Rebuild the compilation input in segment order — a rescued segment must
    // land in its own slot, not appended after the ones that came later.
    const seenAnalyses = new Set();
    segmentAnalyses.length = 0;
    for (const seg of fileResult.segments.slice().sort((a, b) => a.segmentIndex - b.segmentIndex)) {
      if (!seg.analysis || seg.analysis.error || seenAnalyses.has(seg.analysis)) continue;
      seenAnalyses.add(seg.analysis);
      segmentAnalyses.push(seg.analysis);
    }

    const stillFailed = fileResult.segments.filter(seg => seg.analysis && seg.analysis.error);
    if (stillFailed.length > 0) {
      fileResult.failedSegments = stillFailed.map(seg => ({
        segmentFile: seg.segmentFile,
        segmentIndex: seg.segmentIndex,
        durationSeconds: seg.durationSeconds,
        error: seg.analysis.error,
      }));
      console.error(`  ${c.error(`⚠ ${stillFailed.length} segment(s) could NOT be analyzed after ${RESCUE_ATTEMPTS} rescue attempt(s):`)}`);
      for (const seg of stillFailed) {
        console.error(`    ${c.error(`• ${seg.segmentFile}`)} ${c.dim(`(${fmtDuration(seg.durationSeconds)}) — ${seg.analysis.error}`)}`);
      }
      console.error(`  ${c.error('Those minutes are missing from the output. Re-run with --resume once the connection is stable — analyzed segments are cached, only the failed ones re-run.')}`);
      log.error(`${stillFailed.length} segment(s) unanalyzed after rescue pass`);
    } else {
      console.log(`  ${c.success('Rescue pass recovered every failed segment.')}`);
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

// ======================== CACHED-RUN DECISION ========================

/**
 * Ask once, up front, whether cached Gemini runs should be reused.
 *
 * Must run before any media prep is queued: prep works in the background and
 * writes to the console, so a question asked later gets buried under its output
 * (and under progress-bar repaints) while the run waits on invisible input.
 *
 * Sets `ctx.opts.reanalyze` and returns it.
 */
async function promptReanalyzeCached(ctx, mediaFiles) {
  const { opts, callName } = ctx;
  const log = getLog();

  if (opts.reanalyze || opts.skipGemini || opts.dryRun) return !!opts.reanalyze;

  // Count cached runs across every file being processed.
  let totalRuns = 0;
  const dirs = [];
  for (const mediaFile of mediaFiles) {
    const baseName = path.basename(mediaFile, path.extname(mediaFile));
    const runsDir = path.join(PROJECT_ROOT, 'gemini_runs', callName, baseName);
    if (!fs.existsSync(runsDir)) continue;
    const runs = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    if (runs.length > 0) {
      totalRuns += runs.length;
      dirs.push({ baseName, count: runs.length });
    }
  }

  if (totalRuns === 0) return false;

  console.log('');
  console.log(`  Found ${c.highlight(totalRuns)} existing Gemini run file(s) from previous runs:`);
  for (const d of dirs) console.log(`    ${c.dim(`- ${d.baseName}: ${d.count} file(s)`)}`);

  if (!opts.resume) {
    // Unanswered → reuse the cached runs: the cheap, non-destructive choice.
    opts.reanalyze = await promptUser('  Re-analyze all segments? (y/n, default: n): ', { defaultYes: false });
  }

  if (opts.reanalyze) {
    console.log(`  → ${c.yellow('Will re-analyze all segments')} ${c.dim('(previous runs preserved with timestamps)')}`);
    log.step('User chose to re-analyze all segments');
  } else {
    console.log(`  → ${c.dim('Using cached results where available')}`);
  }
  console.log('');
  return !!opts.reanalyze;
}

// ======================== PHASE: PROCESS MEDIA (combined) ========================

/**
 * Prepare then analyze one file, back to back.
 * The pipeline drives the two stages separately so prep can run ahead; this
 * wrapper keeps the simple sequential form for callers that just want one file
 * processed end to end.
 */
async function phaseProcessVideo(ctx, videoPath, videoIndex) {
  await promptReanalyzeCached(ctx, [videoPath]);
  const prep = await phasePrepareMedia(ctx, videoPath, videoIndex);
  if (!prep || prep.skipped) return { fileResult: null, segmentAnalyses: [], segmentReports: [] };
  return await phaseAnalyzeMedia(ctx, prep);
}

module.exports = phaseProcessVideo;
module.exports.phasePrepareMedia = phasePrepareMedia;
module.exports.phaseAnalyzeMedia = phaseAnalyzeMedia;
module.exports.phaseProcessVideo = phaseProcessVideo;
module.exports.promptReanalyzeCached = promptReanalyzeCached;
module.exports.segmentCacheStaleReason = segmentCacheStaleReason;
module.exports.writeSegmentManifest = writeSegmentManifest;
module.exports.segmentParams = segmentParams;
