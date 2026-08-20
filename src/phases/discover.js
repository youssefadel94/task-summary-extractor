'use strict';

const fs = require('fs');
const path = require('path');

// --- Config ---
const config = require('../config');
const { VIDEO_EXTS, AUDIO_EXTS, DOC_EXTS, IMAGE_EXTS, SEG_TIME } = config;

// --- Utils ---
const { c } = require('../utils/colors');
const { findDocsRecursive, dedupeFormatTwins } = require('../utils/fs');
const { promptUserText } = require('../utils/cli');
const { selectMany } = require('../utils/interactive');
const { auditFileIntegrity, mergeAudits, excludeUnusable, printIntegrityReport } = require('../utils/file-integrity');

// --- Shared state ---
const { getLog, phaseTimer } = require('./_shared');

// ======================== PHASE: DISCOVER ========================

/**
 * Discover videos and documents, resolve user name, show banner.
 * Returns augmented ctx with videoFiles, allDocFiles, userName.
 */
async function phaseDiscover(ctx) {
  const log = getLog();
  const timer = phaseTimer('discover');
  const { opts, targetDir, progress } = ctx;

  // --- Find video files ---
  let videoFiles = fs.readdirSync(targetDir)
    .filter(f => {
      const stat = fs.statSync(path.join(targetDir, f));
      return stat.isFile() && VIDEO_EXTS.includes(path.extname(f).toLowerCase());
    })
    .map(f => path.join(targetDir, f));

  // --- Integrity: drop unreadable media before anything depends on the list ---
  // Broken files are excluded from processing but still reported below, and a
  // folder whose videos are all broken correctly falls back to audio/documents.
  const audits = [];
  const excluded = [];
  if (videoFiles.length > 0) {
    const videoAudit = auditFileIntegrity({ videoFiles });
    audits.push(videoAudit);
    const split = excludeUnusable(videoFiles, videoAudit);
    videoFiles = split.kept;
    excluded.push(...split.dropped.map(f => path.basename(f)));
  }

  // --- Find audio files (if no usable video) ---
  let audioFiles = [];
  if (videoFiles.length === 0) {
    audioFiles = fs.readdirSync(targetDir)
      .filter(f => {
        const stat = fs.statSync(path.join(targetDir, f));
        return stat.isFile() && AUDIO_EXTS.includes(path.extname(f).toLowerCase());
      })
      .map(f => path.join(targetDir, f));

    if (audioFiles.length > 0) {
      const audioAudit = auditFileIntegrity({ audioFiles });
      audits.push(audioAudit);
      const split = excludeUnusable(audioFiles, audioAudit);
      audioFiles = split.kept;
      excluded.push(...split.dropped.map(f => path.basename(f)));
    }
  }

  // --- Find ALL document files recursively ---
  let allDocFiles = findDocsRecursive(targetDir, DOC_EXTS);

  // Same document exported to several formats (foo.md + foo.html + foo.pdf)
  // costs 2-3x the context tokens for identical words — and that inflation is
  // what pushes a run over the deep-summary threshold in the first place.
  const twins = dedupeFormatTwins(allDocFiles);
  allDocFiles = twins.kept;
  if (twins.dropped.length > 0) {
    console.log(`  ${c.dim(`Skipped ${twins.dropped.length} duplicate export(s) — same content in another format:`)}`);
    for (const d of twins.dropped.slice(0, 5)) {
      console.log(`    ${c.dim(`- ${d.relPath} → using ${d.supersededBy}`)}`);
    }
    if (twins.dropped.length > 5) console.log(`    ${c.dim(`… and ${twins.dropped.length - 5} more`)}`);
    log.step(`Doc dedup: dropped ${twins.dropped.length} format twin(s)`);
  }

  if (allDocFiles.length > 0) {
    const docAudit = auditFileIntegrity({ docFiles: allDocFiles });
    audits.push(docAudit);
    const split = excludeUnusable(allDocFiles, docAudit);
    allDocFiles = split.kept;
    excluded.push(...split.dropped.map(f => f.relPath || path.basename(f.absPath)));
  }

  const integrityAudit = mergeAudits(...audits);

  // --- Find image files recursively ---
  const imageFiles = findDocsRecursive(targetDir, IMAGE_EXTS);

  // --- Determine input mode ---
  let inputMode;
  if (videoFiles.length > 0) {
    inputMode = 'video';
  } else if (audioFiles.length > 0) {
    inputMode = 'audio';
  } else if (allDocFiles.length > 0 || imageFiles.length > 0) {
    inputMode = 'document';
  } else if (excluded.length > 0) {
    printIntegrityReport(integrityAudit, log);
    throw new Error(
      `No processable files left — all ${excluded.length} file(s) in this folder were unreadable:\n` +
      excluded.map(f => `    - ${f}`).join('\n') +
      '\n  See the integrity report above; re-download or replace them and re-run.'
    );
  } else {
    throw new Error(
      'No processable files found (video, audio, documents, or images).\n' +
      '  Supported: .mp4 .mkv .avi .mov .webm (video) | .mp3 .wav .m4a .ogg .flac .aac .wma (audio) | .vtt .txt .pdf .docx .md .json .csv (docs) | .png .jpg .gif .webp .svg (images)'
    );
  }

  // Combine video + audio into mediaFiles for processing
  const mediaFiles = inputMode === 'video' ? videoFiles : audioFiles;

  const modeBanner = inputMode === 'video'  ? ' Video Compress → Upload → AI Process' :
                     inputMode === 'audio'  ? ' Audio Compress → Upload → AI Process' :
                                              ' Document Analysis → AI Process';

  console.log('');
  console.log(c.cyan('=============================================='));
  console.log(c.heading(modeBanner));
  console.log(c.cyan('=============================================='));

  // Show active flags
  const activeFlags = [];
  if (opts.skipUpload) activeFlags.push(opts.uploadDisabledReason ? 'no-upload (firebase off)' : 'skip-upload');
  if (opts.forceUpload) activeFlags.push('force-upload');
  if (opts.noStorageUrl) activeFlags.push('no-storage-url');
  if (opts.noCompress) activeFlags.push('no-compress');
  if (opts.skipCompression) activeFlags.push('skip-compression');
  if (opts.skipGemini) activeFlags.push('skip-gemini');
  if (opts.resume) activeFlags.push('resume');
  if (opts.reanalyze) activeFlags.push('reanalyze');
  if (opts.dryRun) activeFlags.push('dry-run');
  if (opts.deepSummary) activeFlags.push('deep-summary');
  if (activeFlags.length > 0) {
    console.log(`  Flags: ${c.yellow(activeFlags.join(', '))}`);
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
      console.log(`  Using saved name: ${c.cyan(userName)}`);
    } else if (!opts.dynamic && process.stdin.isTTY) {
      userName = await promptUserText('  Your name (for task assignment detection): ');
    }
  }
  if (!userName && !opts.dynamic) {
    console.log(`  ${c.yellow('⚠')} No name provided — personalized task detection will be skipped.`);
    console.log(`    ${c.dim('Tip: use --name "Your Name" for task attribution next time.')}`);
  } else if (userName) {
    log.step(`User identified as: ${userName}`);
  }

  console.log('');
  console.log(`  User    : ${userName ? c.cyan(userName) : c.dim('(anonymous)')}`);
  console.log(`  Source  : ${c.dim(targetDir)}`);
  console.log(`  Input   : ${c.yellow(inputMode)}`);
  if (inputMode === 'video') console.log(`  Videos  : ${c.highlight(videoFiles.length)}`);
  if (inputMode === 'audio') console.log(`  Audio   : ${c.highlight(audioFiles.length)}`);
  console.log(`  Docs    : ${c.highlight(allDocFiles.length)}`);
  if (imageFiles.length > 0) console.log(`  Images  : ${c.highlight(imageFiles.length)}`);
  if (inputMode !== 'document') {
    const speeds = config.resolveSpeeds(opts);
    console.log(`  Speed   : ${c.yellow(speeds.timelineSpeed + 'x')} ${c.dim('of the original')}${
      speeds.sourceSpeed !== 1 ? c.dim(` (recorded at ${speeds.sourceSpeed}x, encoding ${speeds.encodeSpeed}x)`) : ''}`);
    console.log(`  Segments: ${c.dim('< 5 min each')} (${c.yellow(SEG_TIME + 's')})`);
  }
  console.log(`  Model   : ${c.cyan(config.GEMINI_MODEL)}`);
  // Economy models are tuned for high-volume simple processing. On dense
  // meeting analysis they extract noticeably fewer tickets/actions/blockers
  // per segment, which reads as "the tool missed things" rather than "the
  // cheap model missed things".
  if (/lite/i.test(config.GEMINI_MODEL) || config.GEMINI_MODELS[config.GEMINI_MODEL]?.tier === 'economy') {
    console.log(`  ${c.warn('Economy model selected — expect noticeably less detail per segment.')}`);
    console.log(`    ${c.dim('For a thorough extraction use a balanced/premium model (--model or the model picker).')}`);
    log.warn(`Economy model in use for analysis: ${config.GEMINI_MODEL}`);
  }
  if (inputMode !== 'document') {
    console.log(`  Parallel: ${c.yellow(opts.parallel)} concurrent uploads`);
  }
  console.log(`  Thinking: ${c.yellow(opts.thinkingBudget)} tokens ${c.dim('(analysis)')} / ${c.yellow(opts.compilationThinkingBudget)} tokens ${c.dim('(compilation)')}`);
  console.log('');

  // Save progress init
  progress.init(path.basename(targetDir), userName);

  if (excluded.length > 0) {
    console.log(`  ${c.yellow('\u26a0')} Skipped ${c.highlight(excluded.length)} unreadable file(s): ${c.dim(excluded.join(', '))}`);
    console.log(`    ${c.dim('Details in the integrity report below \u2014 everything else is processed as normal.')}`);
    console.log('');
  }

  if (inputMode === 'document') {
    console.log(`  ${c.info(excluded.length > 0
      ? 'No usable video or audio left \u2014 running in document-only mode.'
      : 'No video or audio files found \u2014 running in document-only mode.')}`);
    if (!opts.dynamic) {
      console.log(`  ${c.dim('Tip: Use --dynamic for custom document generation.')}`);
    }
    console.log('');
  } else {
    const mediaLabel = inputMode === 'video' ? 'video' : 'audio';
    console.log(`  Found ${c.highlight(mediaFiles.length)} ${mediaLabel} file(s):`);
    mediaFiles.forEach((f, i) => console.log(`    ${c.dim(`[${i + 1}]`)} ${c.cyan(path.basename(f))}`));

    // If multiple media files found, let user select which to process
    if (mediaFiles.length > 1 && process.stdin.isTTY) {
      console.log('');
      const items = mediaFiles.map((f, i) => ({
        label: `${c.bold(path.basename(f))}`,
        hint: `File ${i + 1}`,
        value: i,
      }));
      const result = await selectMany({
        title: c.bold(`🎬 Select ${mediaLabel} Files to Process`),
        items,
        defaultSelected: new Set(items.map((_, i) => i)),
      });
      if (result.indices.length > 0 && result.indices.length < mediaFiles.length) {
        const selected = result.indices.map(i => mediaFiles[i]);
        if (inputMode === 'video') videoFiles = selected;
        else audioFiles = selected;
        console.log(`  → Processing ${c.highlight(selected.length)} selected file(s)`);
      } else {
        console.log(`  → Processing all ${c.highlight(mediaLabel)} files`);
      }
    }
    const finalMedia = inputMode === 'video' ? videoFiles : audioFiles;
    log.step(`Found ${finalMedia.length} ${mediaLabel}(s): ${finalMedia.map(f => path.basename(f)).join(', ')}`);
    console.log('');
  }

  if (allDocFiles.length > 0) {
    console.log(`  Found ${c.highlight(allDocFiles.length)} document(s) for context ${c.dim('(recursive)')}:`);
    allDocFiles.forEach(f => console.log(`    ${c.dim('-')} ${c.cyan(f.relPath)}`));
    console.log('');
  }

  if (imageFiles.length > 0) {
    console.log(`  Found ${c.highlight(imageFiles.length)} image(s) for context ${c.dim('(recursive)')}:`);
    imageFiles.forEach(f => console.log(`    ${c.dim('-')} ${c.cyan(f.relPath)}`));
    console.log('');
  }

  // --- File integrity report (audited above, before mode selection) ---
  if (integrityAudit.warnings.length > 0) {
    printIntegrityReport(integrityAudit, log);
    log.step(`File integrity: ${integrityAudit.warnings.length} issue(s) flagged`);
    if (excluded.length > 0) {
      log.warn(`Excluded ${excluded.length} unreadable file(s) from processing: ${excluded.join(', ')}`);
    }
    log.metric('file_integrity', {
      totalFiles: integrityAudit.totalFiles,
      warnings: integrityAudit.warnings.length,
      excluded: integrityAudit.unusable.map(u => ({ file: u.file, type: u.type, reason: u.reason })),
      issues: integrityAudit.warnings.map(w => ({ file: w.file, severity: w.severity, reason: w.message })),
    });
  }

  timer.end();
  return { ...ctx, videoFiles, audioFiles, allDocFiles, imageFiles, userName, inputMode, integrityAudit };
}

module.exports = phaseDiscover;
