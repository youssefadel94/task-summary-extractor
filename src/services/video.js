/**
 * Video processing — compression, segmentation, ffmpeg/ffprobe wrappers.
 *
 * Improvements:
 *  - No process.exit() — throws descriptive errors instead
 *  - Lazy binary detection (not at module load time)
 *  - Better error messages
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SPEED, SEG_TIME, PRESET } = require('../config');
const { fmtDuration } = require('../utils/format');

// ======================== BINARY DETECTION ========================

let _ffmpeg = null;
let _ffprobe = null;

/** Auto-detect a binary from PATH or common locations. Throws if not found. */
function findBin(name) {
  try {
    const where = execSync(`where ${name} 2>nul`, { encoding: 'utf8' }).trim().split('\n')[0];
    if (where) return where.trim();
  } catch { /* ignore */ }
  const common = `C:\\ffmpeg\\bin\\${name}.exe`;
  if (fs.existsSync(common)) return common;
  throw new Error(
    `${name} not found in PATH or C:\\ffmpeg\\bin. ` +
    `Install ffmpeg from https://ffmpeg.org/download.html and add it to your PATH.`
  );
}

/** Get ffmpeg path (lazy, cached). */
function getFFmpeg() {
  if (!_ffmpeg) _ffmpeg = findBin('ffmpeg');
  return _ffmpeg;
}

/** Get ffprobe path (lazy, cached). */
function getFFprobe() {
  if (!_ffprobe) _ffprobe = findBin('ffprobe');
  return _ffprobe;
}

// ======================== PROBING ========================

/** Run ffprobe and return a single value from a stream */
function probe(filePath, streamSelect, entry) {
  try {
    const cmd = `"${getFFprobe()}" -v error -select_streams ${streamSelect} -show_entries stream=${entry} -of csv=p=0 "${filePath}"`;
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
}

/** Run ffprobe for format-level entries */
function probeFormat(filePath, entry) {
  try {
    const cmd = `"${getFFprobe()}" -v error -show_entries format=${entry} -of csv=p=0 "${filePath}"`;
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
}

// ======================== COMPRESSION ========================

/**
 * Verify a segment file is a valid MP4 (has moov atom, readable by ffprobe).
 * Returns true if valid, false if corrupt.
 */
function verifySegment(segPath) {
  try {
    const dur = probeFormat(segPath, 'duration');
    return dur !== null && parseFloat(dur) > 0;
  } catch {
    return false;
  }
}

/**
 * Build the common ffmpeg encoding args (video + audio filters/codecs).
 * Returns { encodingArgs, effectiveDuration }.
 */
function buildEncodingArgs(inputFile) {
  const width = parseInt(probe(inputFile, 'v:0', 'width') || '0');
  const channels = parseInt(probe(inputFile, 'a:0', 'channels') || '1');
  const sampleRate = probe(inputFile, 'a:0', 'sample_rate') || '16000';
  const duration = probeFormat(inputFile, 'duration');
  const durationSec = duration ? parseFloat(duration) : null;
  const effectiveDuration = durationSec ? durationSec / SPEED : null;

  let vf = `setpts=PTS/${SPEED}`;
  let crf = 24;
  let tune = ['-tune', 'stillimage'];
  let profile = ['-profile:v', 'main'];
  let audioBr = '64k';
  let x264p = 'aq-mode=3:deblock=-1,-1:psy-rd=1.0,0.0';

  if (width > 1920) {
    // 4K+ → scale to 1080p
    vf = `scale=1920:1080,unsharp=3:3:0.3,setpts=PTS/${SPEED}`;
    crf = 20;
    tune = [];
    profile = ['-profile:v', 'high'];
    audioBr = '128k';
  } else if (width > 0) {
    // Meeting / screenshare
    vf = `unsharp=3:3:0.3,setpts=PTS/${SPEED}`;
  }

  if (channels === 2) audioBr = '128k';

  const encodingArgs = [
    '-vf', vf,
    '-af', `atempo=${SPEED}`,
    '-c:v', 'libx264', '-crf', String(crf), '-preset', PRESET,
    ...tune,
    '-x264-params', x264p,
    ...profile,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', audioBr, '-ar', sampleRate, '-ac', String(channels),
    '-movflags', '+faststart',
  ];

  return { encodingArgs, effectiveDuration, width, crf, audioBr, duration };
}

/**
 * Compress and segment a video file using ffmpeg.
 * - Short videos (effective duration ≤ SEG_TIME) → single MP4 output (avoids segment muxer issues).
 * - Long videos → segment muxer for splitting.
 * - Post-compression validation: verifies each output has a valid moov atom.
 *   Corrupt segments are re-encoded individually with the regular MP4 muxer.
 * Returns sorted array of segment file paths.
 */
function compressAndSegment(inputFile, outputDir) {
  const { encodingArgs, effectiveDuration, width, crf, audioBr, duration } = buildEncodingArgs(inputFile);

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`  Resolution : ${width > 0 ? width + 'p' : 'unknown'}`);
  console.log(`  Duration   : ${duration ? fmtDuration(parseFloat(duration)) : 'unknown'}${effectiveDuration ? ` (${fmtDuration(effectiveDuration)} at ${SPEED}x)` : ''}`);
  console.log(`  CRF ${crf} | ${audioBr} audio | ${SPEED}x speed`);

  // Decide: single output vs segmented
  const needsSegmentation = effectiveDuration === null || effectiveDuration > SEG_TIME;

  if (needsSegmentation) {
    console.log(`  Compressing (segmented, ${SEG_TIME}s chunks)...`);
    const args = [
      '-y', '-err_detect', 'ignore_err', '-fflags', '+genpts+discardcorrupt',
      '-i', inputFile,
      ...encodingArgs,
      '-f', 'segment', '-segment_time', String(SEG_TIME), '-reset_timestamps', '1',
      '-map', '0:v:0', '-map', '0:a:0',
      path.join(outputDir, 'segment_%02d.mp4'),
    ];

    const result = spawnSync(getFFmpeg(), args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.warn(`  ⚠ ffmpeg exited with code ${result.status} (output may still be usable)`);
    }
  } else {
    console.log(`  Compressing (single output, ${effectiveDuration ? fmtDuration(effectiveDuration) : '?'} effective)...`);
    const outPath = path.join(outputDir, 'segment_00.mp4');
    const args = [
      '-y', '-err_detect', 'ignore_err', '-fflags', '+genpts+discardcorrupt',
      '-i', inputFile,
      ...encodingArgs,
      '-map', '0:v:0', '-map', '0:a:0',
      outPath,
    ];

    const result = spawnSync(getFFmpeg(), args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.warn(`  ⚠ ffmpeg exited with code ${result.status}`);
    }
  }

  // Collect segments
  let segments = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('segment_') && f.endsWith('.mp4'))
    .sort()
    .map(f => path.join(outputDir, f));

  // Post-compression integrity check — verify each segment
  const valid = [];
  const corrupt = [];
  for (const seg of segments) {
    if (verifySegment(seg)) {
      valid.push(seg);
    } else {
      corrupt.push(seg);
      console.warn(`  ⚠ Corrupt segment detected: ${path.basename(seg)} (missing moov atom)`);
    }
  }

  // Attempt to re-encode corrupt segments from original source
  if (corrupt.length > 0 && needsSegmentation) {
    console.log(`  Retrying ${corrupt.length} corrupt segment(s) with regular MP4 muxer...`);
    // Fallback: re-compress the entire video as a single file, then re-segment if needed
    const fallbackPath = path.join(outputDir, '_fallback_full.mp4');
    const fbArgs = [
      '-y', '-err_detect', 'ignore_err', '-fflags', '+genpts+discardcorrupt',
      '-i', inputFile,
      ...encodingArgs,
      '-map', '0:v:0', '-map', '0:a:0',
      fallbackPath,
    ];
    const fbResult = spawnSync(getFFmpeg(), fbArgs, { stdio: 'inherit' });
    if (fbResult.status === 0 && verifySegment(fallbackPath)) {
      // Remove all corrupt segments and replace with the fallback
      for (const seg of corrupt) { try { fs.unlinkSync(seg); } catch {} }
      // If this was the only segment, just rename it
      if (segments.length === 1) {
        const dest = path.join(outputDir, 'segment_00.mp4');
        fs.renameSync(fallbackPath, dest);
        segments = [dest];
        console.log(`  ✓ Re-encoded successfully as single segment`);
      } else {
        // Re-segment the fallback
        const reSegDir = path.join(outputDir, '_reseg');
        fs.mkdirSync(reSegDir, { recursive: true });
        const rsArgs = [
          '-y', '-i', fallbackPath,
          '-c', 'copy',
          '-f', 'segment', '-segment_time', String(SEG_TIME), '-reset_timestamps', '1',
          '-movflags', '+faststart',
          path.join(reSegDir, 'segment_%02d.mp4'),
        ];
        spawnSync(getFFmpeg(), rsArgs, { stdio: 'inherit' });
        // Move re-segmented files back, overwriting corrupt ones
        const reSegs = fs.readdirSync(reSegDir).filter(f => f.endsWith('.mp4')).sort();
        for (const f of reSegs) {
          fs.renameSync(path.join(reSegDir, f), path.join(outputDir, f));
        }
        try { fs.rmSync(reSegDir, { recursive: true }); } catch {}
        try { fs.unlinkSync(fallbackPath); } catch {}
        // Re-collect
        segments = fs.readdirSync(outputDir)
          .filter(f => f.startsWith('segment_') && f.endsWith('.mp4'))
          .sort()
          .map(f => path.join(outputDir, f));
        console.log(`  ✓ Re-segmented from fallback: ${segments.length} segment(s)`);
      }
    } else {
      console.error(`  ✗ Fallback re-encode also failed`);
      try { fs.unlinkSync(fallbackPath); } catch {}
    }
  } else if (corrupt.length > 0 && !needsSegmentation) {
    // Single-output mode also failed — try once more without segment muxer flags
    console.log(`  Retrying single-output compression...`);
    const retryPath = path.join(outputDir, 'segment_00.mp4');
    try { fs.unlinkSync(retryPath); } catch {}
    const retryArgs = [
      '-y',
      '-i', inputFile,
      ...encodingArgs,
      '-map', '0:v:0', '-map', '0:a:0',
      retryPath,
    ];
    const retryResult = spawnSync(getFFmpeg(), retryArgs, { stdio: 'inherit' });
    if (retryResult.status === 0 && verifySegment(retryPath)) {
      segments = [retryPath];
      console.log(`  ✓ Retry succeeded`);
    } else {
      console.error(`  ✗ Retry also produced invalid output`);
    }
  }

  return segments;
}

module.exports = {
  findBin,
  probe,
  probeFormat,
  compressAndSegment,
  verifySegment,
  getFFmpeg,
  getFFprobe,
};
