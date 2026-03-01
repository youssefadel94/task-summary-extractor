'use strict';

const fs = require('fs');
const path = require('path');

// --- Config ---
const config = require('../config');
const { VIDEO_EXTS, AUDIO_EXTS, DOC_EXTS, SPEED, SEG_TIME } = config;

// --- Utils ---
const { findDocsRecursive } = require('../utils/fs');
const { promptUser, promptUserText } = require('../utils/cli');

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
  console.log('==============================================');
  console.log(modeBanner);
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

  console.log('');
  console.log(`  User    : ${userName}`);
  console.log(`  Source  : ${targetDir}`);
  console.log(`  Input   : ${inputMode}`);
  if (inputMode === 'video') console.log(`  Videos  : ${videoFiles.length}`);
  if (inputMode === 'audio') console.log(`  Audio   : ${audioFiles.length}`);
  console.log(`  Docs    : ${allDocFiles.length}`);
  if (inputMode !== 'document') {
    console.log(`  Speed   : ${SPEED}x`);
    console.log(`  Segments: < 5 min each (${SEG_TIME}s)`);
  }
  console.log(`  Model   : ${config.GEMINI_MODEL}`);
  if (inputMode !== 'document') {
    console.log(`  Parallel: ${opts.parallel} concurrent uploads`);
  }
  console.log(`  Thinking: ${opts.thinkingBudget} tokens (analysis) / ${opts.compilationThinkingBudget} tokens (compilation)`);
  console.log('');

  // Save progress init
  progress.init(path.basename(targetDir), userName);

  if (inputMode === 'document') {
    console.log('  ℹ No video or audio files found — running in document-only mode.');
    console.log('  Tip: Use --dynamic for custom document generation.\n');
  } else {
    const mediaLabel = inputMode === 'video' ? 'video' : 'audio';
    console.log(`  Found ${mediaFiles.length} ${mediaLabel} file(s):`);
    mediaFiles.forEach((f, i) => console.log(`    [${i + 1}] ${path.basename(f)}`));

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
          console.log(`  → Processing ${selected.length} selected file(s):`);
          selected.forEach(f => console.log(`    - ${path.basename(f)}`));
        } else {
          console.log('  → Invalid selection, processing all files');
        }
      } else {
        console.log(`  → Processing all ${mediaLabel} files`);
      }
    }
    const finalMedia = inputMode === 'video' ? videoFiles : audioFiles;
    log.step(`Found ${finalMedia.length} ${mediaLabel}(s): ${finalMedia.map(f => path.basename(f)).join(', ')}`);
    console.log('');
  }

  if (allDocFiles.length > 0) {
    console.log(`  Found ${allDocFiles.length} document(s) for context (recursive):`);
    allDocFiles.forEach(f => console.log(`    - ${f.relPath}`));
    console.log('');
  }

  timer.end();
  return { ...ctx, videoFiles, audioFiles, allDocFiles, userName, inputMode };
}

module.exports = phaseDiscover;
