'use strict';

const fs = require('fs');
const path = require('path');

// --- Config ---
const config = require('../config');
const { VIDEO_EXTS, AUDIO_EXTS, DOC_EXTS, SPEED, SEG_TIME } = config;

// --- Utils ---
const { c } = require('../utils/colors');
const { findDocsRecursive } = require('../utils/fs');
const { promptUserText } = require('../utils/cli');
const { auditFileIntegrity, printIntegrityReport } = require('../utils/file-integrity');

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

  // --- Find audio files (if no video) ---
  let audioFiles = [];
  if (videoFiles.length === 0) {
    audioFiles = fs.readdirSync(targetDir)
      .filter(f => {
        const stat = fs.statSync(path.join(targetDir, f));
        return stat.isFile() && AUDIO_EXTS.includes(path.extname(f).toLowerCase());
      })
      .map(f => path.join(targetDir, f));
  }

  // --- Find ALL document files recursively ---
  const allDocFiles = findDocsRecursive(targetDir, DOC_EXTS);

  // --- Determine input mode ---
  let inputMode;
  if (videoFiles.length > 0) {
    inputMode = 'video';
  } else if (audioFiles.length > 0) {
    inputMode = 'audio';
  } else if (allDocFiles.length > 0) {
    inputMode = 'document';
  } else {
    throw new Error(
      'No processable files found (video, audio, or documents).\n' +
      '  Supported: .mp4 .mkv .avi .mov .webm (video) | .mp3 .wav .m4a .ogg .flac .aac .wma (audio) | .vtt .txt .pdf .docx .md (docs)'
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
  if (opts.skipUpload) activeFlags.push('skip-upload');
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
    } else if (!opts.dynamic) {
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
  if (inputMode !== 'document') {
    console.log(`  Speed   : ${c.yellow(SPEED + 'x')}`);
    console.log(`  Segments: ${c.dim('< 5 min each')} (${c.yellow(SEG_TIME + 's')})`);
  }
  console.log(`  Model   : ${c.cyan(config.GEMINI_MODEL)}`);
  if (inputMode !== 'document') {
    console.log(`  Parallel: ${c.yellow(opts.parallel)} concurrent uploads`);
  }
  console.log(`  Thinking: ${c.yellow(opts.thinkingBudget)} tokens ${c.dim('(analysis)')} / ${c.yellow(opts.compilationThinkingBudget)} tokens ${c.dim('(compilation)')}`);
  console.log('');

  // Save progress init
  progress.init(path.basename(targetDir), userName);

  if (inputMode === 'document') {
    console.log(`  ${c.info('No video or audio files found \u2014 running in document-only mode.')}`);
    if (!opts.dynamic) {
      console.log(`  ${c.dim('Tip: Use --dynamic for custom document generation.')}`);
    }
    console.log('');
  } else {
    const mediaLabel = inputMode === 'video' ? 'video' : 'audio';
    console.log(`  Found ${c.highlight(mediaFiles.length)} ${mediaLabel} file(s):`);
    mediaFiles.forEach((f, i) => console.log(`    ${c.dim(`[${i + 1}]`)} ${c.cyan(path.basename(f))}`));

    // If multiple media files found, let user select which to process
    if (mediaFiles.length > 1) {
      console.log('');
      const selectionInput = await promptUserText(`  Which files to process? (comma-separated numbers, or "all", default: all): `);
      const trimmed = (selectionInput || '').trim().toLowerCase();
      if (trimmed && trimmed !== 'all') {
        const indices = trimmed.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0 && n < mediaFiles.length);
        if (indices.length > 0) {
          const selected = indices.map(i => mediaFiles[i]);
          if (inputMode === 'video') videoFiles = selected;
          else audioFiles = selected;
          console.log(`  \u2192 Processing ${c.highlight(selected.length)} selected file(s):`);
          selected.forEach(f => console.log(`    ${c.dim('-')} ${c.cyan(path.basename(f))}`));
        } else {
          console.log(`  \u2192 ${c.dim('Invalid selection, processing all files')}`);
        }
      } else {
        console.log(`  \u2192 Processing all ${c.highlight(mediaLabel)} files`);
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

  // --- File integrity audit (non-blocking) ---
  const integrityAudit = auditFileIntegrity({ videoFiles, audioFiles, docFiles: allDocFiles });
  if (integrityAudit.warnings.length > 0) {
    printIntegrityReport(integrityAudit, log);
    log.step(`File integrity: ${integrityAudit.warnings.length} issue(s) flagged`);
    log.metric('file_integrity', {
      totalFiles: integrityAudit.totalFiles,
      warnings: integrityAudit.warnings.length,
      issues: integrityAudit.warnings.map(w => ({ file: w.file, severity: w.severity, reason: w.reason })),
    });
  }

  timer.end();
  return { ...ctx, videoFiles, audioFiles, allDocFiles, userName, inputMode, integrityAudit };
}

module.exports = phaseDiscover;
