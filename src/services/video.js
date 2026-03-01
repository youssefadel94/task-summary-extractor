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
const { fmtDuration, fmtBytes } = require('../utils/format');
const { c } = require('../utils/colors');

// ======================== BINARY DETECTION ========================

let _ffmpeg = null;
let _ffprobe = null;

/** Auto-detect a binary from PATH or common locations. Throws if not found. */
function findBin(name) {
  // Cross-platform PATH lookup: 'where' on Windows, 'which' on Linux/Mac
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  const suppressStderr = process.platform === 'win32' ? '2>nul' : '2>/dev/null';
  try {
    const found = execSync(`${lookupCmd} ${name} ${suppressStderr}`, { encoding: 'utf8' }).trim().split('\n')[0];
    if (found) return found.trim();
  } catch { /* ignore */ }

  // Windows-specific fallback location
  if (process.platform === 'win32') {
    const common = `C:\\ffmpeg\\bin\\${name}.exe`;
    if (fs.existsSync(common)) return common;
  }

  const installHint = process.platform === 'win32'
    ? `Install ffmpeg from https://www.gyan.dev/ffmpeg/builds/ and add to PATH, or place in C:\\ffmpeg\\bin\\`
    : `Install ffmpeg: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)`;
  throw new Error(
    `${name} not found in PATH. ${installHint}`
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

/** Run ffprobe and return a single value from a stream (safe: no shell interpolation) */
function probe(filePath, streamSelect, entry) {
  try {
    const result = spawnSync(getFFprobe(), [
      '-v', 'error',
      '-select_streams', streamSelect,
      '-show_entries', `stream=${entry}`,
      '-of', 'csv=p=0',
      filePath,
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.status === 0 ? (result.stdout || '').trim() || null : null;
  } catch { return null; }
}

/** Run ffprobe for format-level entries (safe: no shell interpolation) */
function probeFormat(filePath, entry) {
  try {
    const result = spawnSync(getFFprobe(), [
      '-v', 'error',
      '-show_entries', `format=${entry}`,
      '-of', 'csv=p=0',
      filePath,
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.status === 0 ? (result.stdout || '').trim() || null : null;
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
 * @param {string} inputFile
 * @param {{ speed?: number }} [overrides]
 * Returns { encodingArgs, effectiveDuration }.
 */
function buildEncodingArgs(inputFile, { speed = SPEED } = {}) {
  const width = parseInt(probe(inputFile, 'v:0', 'width') || '0');
  const channels = parseInt(probe(inputFile, 'a:0', 'channels') || '1');
  const sampleRate = probe(inputFile, 'a:0', 'sample_rate') || '16000';
  const duration = probeFormat(inputFile, 'duration');
  const durationSec = duration ? parseFloat(duration) : null;
  const effectiveDuration = durationSec ? durationSec / speed : null;

  let vf = `setpts=PTS/${speed}`;
  let crf = 24;
  let tune = ['-tune', 'stillimage'];
  let profile = ['-profile:v', 'main'];
  let audioBr = '64k';
  let x264p = 'aq-mode=3:deblock=-1,-1:psy-rd=1.0,0.0';

  if (width > 1920) {
    // 4K+ → scale to 1080p
    vf = `scale=1920:1080,unsharp=3:3:0.3,setpts=PTS/${speed}`;
    crf = 20;
    tune = [];
    profile = ['-profile:v', 'high'];
    audioBr = '128k';
  } else if (width > 0) {
    // Meeting / screenshare
    vf = `unsharp=3:3:0.3,setpts=PTS/${speed}`;
  }

  if (channels === 2) audioBr = '128k';

  const encodingArgs = [
    '-vf', vf,
    '-af', `atempo=${speed}`,
    '-c:v', 'libx264', '-crf', String(crf), '-preset', PRESET,
    ...tune,
    '-x264-params', x264p,
    ...profile,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', audioBr, '-ar', sampleRate, '-ac', String(channels),
    '-movflags', '+faststart',
  ];

  return { encodingArgs, effectiveDuration, width, crf, audioBr, duration, speed };
}

/**
 * Compress and segment a video file using ffmpeg.
 * - Short videos (effective duration ≤ SEG_TIME) → single MP4 output (avoids segment muxer issues).
 * - Long videos → segment muxer for splitting.
 * - Post-compression validation: verifies each output has a valid moov atom.
 *   Corrupt segments are re-encoded individually with the regular MP4 muxer.
 * @param {{ segTime?: number, speed?: number }} [opts]
 * Returns sorted array of segment file paths.
 */
function compressAndSegment(inputFile, outputDir, { segTime = SEG_TIME, speed = SPEED } = {}) {
  const { encodingArgs, effectiveDuration, width, crf, audioBr, duration } = buildEncodingArgs(inputFile, { speed });

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`  Resolution : ${width > 0 ? width + 'p' : 'unknown'}`);
  console.log(`  Duration   : ${duration ? fmtDuration(parseFloat(duration)) : 'unknown'}${effectiveDuration ? ` (${fmtDuration(effectiveDuration)} at ${speed}x)` : ''}`);
  console.log(`  CRF ${crf} | ${audioBr} audio | ${speed}x speed`);

  // Decide: single output vs segmented
  const needsSegmentation = effectiveDuration === null || effectiveDuration > segTime;

  if (needsSegmentation) {
    console.log(`  Compressing (segmented, ${segTime}s chunks)...`);
    const args = [
      '-y', '-err_detect', 'ignore_err', '-fflags', '+genpts+discardcorrupt',
      '-i', inputFile,
      ...encodingArgs,
      '-f', 'segment', '-segment_time', String(segTime), '-reset_timestamps', '1',
      '-map', '0:v:0', '-map', '0:a:0',
      path.join(outputDir, 'segment_%02d.mp4'),
    ];

    const result = spawnSync(getFFmpeg(), args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.warn(`  ${c.warn(`ffmpeg exited with code ${result.status} (output may still be usable)`)}`);
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
      console.warn(`  ${c.warn(`ffmpeg exited with code ${result.status}`)}`);
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
      console.warn(`  ${c.warn(`Corrupt segment detected: ${path.basename(seg)} (missing moov atom)`)}`);
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
      for (const seg of corrupt) { try { fs.unlinkSync(seg); } catch { /* best-effort cleanup */ } }
      // If this was the only segment, just rename it
      if (segments.length === 1) {
        const dest = path.join(outputDir, 'segment_00.mp4');
        fs.renameSync(fallbackPath, dest);
        segments = [dest];
        console.log(`  ${c.success('Re-encoded successfully as single segment')}`);
      } else {
        // Re-segment the fallback
        const reSegDir = path.join(outputDir, '_reseg');
        fs.mkdirSync(reSegDir, { recursive: true });
        const rsArgs = [
          '-y', '-i', fallbackPath,
          '-c', 'copy',
          '-f', 'segment', '-segment_time', String(segTime), '-reset_timestamps', '1',
          '-movflags', '+faststart',
          path.join(reSegDir, 'segment_%02d.mp4'),
        ];
        spawnSync(getFFmpeg(), rsArgs, { stdio: 'inherit' });
        // Move re-segmented files back, overwriting corrupt ones
        const reSegs = fs.readdirSync(reSegDir).filter(f => f.endsWith('.mp4')).sort();
        for (const f of reSegs) {
          fs.renameSync(path.join(reSegDir, f), path.join(outputDir, f));
        }
        try { fs.rmSync(reSegDir, { recursive: true }); } catch { /* best-effort cleanup */ }
        try { fs.unlinkSync(fallbackPath); } catch { /* best-effort cleanup */ }
        // Re-collect
        segments = fs.readdirSync(outputDir)
          .filter(f => f.startsWith('segment_') && f.endsWith('.mp4'))
          .sort()
          .map(f => path.join(outputDir, f));
        console.log(`  ${c.success(`Re-segmented from fallback: ${segments.length} segment(s)`)}`);
      }
    } else {
      console.error(`  ${c.error('Fallback re-encode also failed')}`);
      try { fs.unlinkSync(fallbackPath); } catch { /* best-effort cleanup */ }
    }
  } else if (corrupt.length > 0 && !needsSegmentation) {
    // Single-output mode also failed — try once more without segment muxer flags
    console.log(`  Retrying single-output compression...`);
    const retryPath = path.join(outputDir, 'segment_00.mp4');
    try { fs.unlinkSync(retryPath); } catch { /* best-effort cleanup */ }
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
      console.log(`  ${c.success('Retry succeeded')}`);
    } else {
      console.error(`  ${c.error('Retry also produced invalid output')}`);
    }
  }

  return segments;
}

/**
 * Compress and segment an audio-only file using ffmpeg.
 * No video stream — just audio compression + segmentation in MP4/M4A container
 * (for Gemini File API compatibility).
 *
 * Returns sorted array of segment file paths.
 */
function compressAndSegmentAudio(inputFile, outputDir, { segTime = SEG_TIME, speed = SPEED } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });

  const duration = probeFormat(inputFile, 'duration');
  const durationSec = duration ? parseFloat(duration) : null;
  const effectiveDuration = durationSec ? durationSec / speed : null;
  const channels = parseInt(probe(inputFile, 'a:0', 'channels') || '1', 10);
  const sampleRate = probe(inputFile, 'a:0', 'sample_rate') || '16000';
  const audioBr = channels >= 2 ? '128k' : '64k';

  console.log(`  Duration : ${duration ? fmtDuration(parseFloat(duration)) : 'unknown'}${effectiveDuration ? ` (${fmtDuration(effectiveDuration)} at ${speed}x)` : ''}`);
  console.log(`  Audio-only mode | ${speed}x speed | ${audioBr} bitrate`);

  const encodingArgs = [
    '-af', `atempo=${speed}`,
    '-c:a', 'aac', '-b:a', audioBr, '-ar', sampleRate, '-ac', String(channels),
    '-vn',  // no video
    '-movflags', '+faststart',
  ];

  const needsSegmentation = effectiveDuration === null || effectiveDuration > segTime;

  if (needsSegmentation) {
    console.log(`  Compressing (segmented, ${segTime}s chunks)...`);
    const args = [
      '-y', '-i', inputFile,
      ...encodingArgs,
      '-f', 'segment', '-segment_time', String(segTime), '-reset_timestamps', '1',
      path.join(outputDir, 'segment_%02d.m4a'),
    ];
    const result = spawnSync(getFFmpeg(), args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.warn(`  ${c.warn(`ffmpeg exited with code ${result.status} (output may still be usable)`)}`);
    }
  } else {
    console.log(`  Compressing (single output, ${effectiveDuration ? fmtDuration(effectiveDuration) : '?'} effective)...`);
    const outPath = path.join(outputDir, 'segment_00.m4a');
    const args = ['-y', '-i', inputFile, ...encodingArgs, outPath];
    const result = spawnSync(getFFmpeg(), args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.warn(`  ${c.warn(`ffmpeg exited with code ${result.status}`)}`);
    }
  }

  // Collect segments (both .mp4 and .m4a)
  let segments = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('segment_') && (f.endsWith('.m4a') || f.endsWith('.mp4')))
    .sort()
    .map(f => path.join(outputDir, f));

  // Validate segments
  const valid = [];
  const corrupt = [];
  for (const seg of segments) {
    if (verifySegment(seg)) {
      valid.push(seg);
    } else {
      corrupt.push(seg);
      console.warn(`  ${c.warn(`Corrupt audio segment: ${path.basename(seg)}`)}`);
    }
  }

  if (corrupt.length > 0) {
    console.log(`  Retrying ${corrupt.length} corrupt segment(s)...`);
    const fallbackPath = path.join(outputDir, '_fallback_full.m4a');
    const fbArgs = ['-y', '-i', inputFile, ...encodingArgs, fallbackPath];
    const fbResult = spawnSync(getFFmpeg(), fbArgs, { stdio: 'inherit' });
    if (fbResult.status === 0 && verifySegment(fallbackPath)) {
      for (const seg of corrupt) { try { fs.unlinkSync(seg); } catch { /* best-effort cleanup */ } }
      if (segments.length === 1) {
        const dest = path.join(outputDir, 'segment_00.m4a');
        fs.renameSync(fallbackPath, dest);
        segments = [dest];
        console.log(`  ${c.success('Re-encoded as single segment')}`);
      } else {
        // Re-segment
        const reSegDir = path.join(outputDir, '_reseg');
        fs.mkdirSync(reSegDir, { recursive: true });
        const rsArgs = [
          '-y', '-i', fallbackPath,
          '-c', 'copy', '-vn',
          '-f', 'segment', '-segment_time', String(segTime), '-reset_timestamps', '1',
          path.join(reSegDir, 'segment_%02d.m4a'),
        ];
        spawnSync(getFFmpeg(), rsArgs, { stdio: 'inherit' });
        const reSegs = fs.readdirSync(reSegDir).filter(f => f.endsWith('.m4a')).sort();
        for (const f of reSegs) {
          fs.renameSync(path.join(reSegDir, f), path.join(outputDir, f));
        }
        try { fs.rmSync(reSegDir, { recursive: true }); } catch { /* best-effort cleanup */ }
        try { fs.unlinkSync(fallbackPath); } catch { /* best-effort cleanup */ }
        segments = fs.readdirSync(outputDir)
          .filter(f => f.startsWith('segment_') && (f.endsWith('.m4a') || f.endsWith('.mp4')))
          .sort()
          .map(f => path.join(outputDir, f));
        console.log(`  ${c.success(`Re-segmented from fallback: ${segments.length} segment(s)`)}`);
      }
    } else {
      console.error(`  ${c.error('Fallback audio re-encode failed')}`);
      try { fs.unlinkSync(fallbackPath); } catch { /* best-effort cleanup */ }
    }
  }

  return segments;
}

/**
 * Split a media file into segments WITHOUT re-encoding (stream copy).
 * No compression, no speed-up — just fast keyframe-aligned splitting.
 * For use with --no-compress: passes raw video to Gemini via File API.
 *
 * @param {string} inputFile - Path to input media file
 * @param {string} outputDir - Directory for output segments
 * @param {{ segTime?: number }} opts - Options (segTime defaults to 1200s for raw mode)
 * @returns {string[]} Sorted array of segment file paths
 */
function splitOnly(inputFile, outputDir, { segTime = 1200 } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });

  const duration = probeFormat(inputFile, 'duration');
  const durationSec = duration ? parseFloat(duration) : null;
  const ext = path.extname(inputFile).toLowerCase();
  const isAudio = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma'].includes(ext);
  const outExt = isAudio ? '.m4a' : '.mp4';
  const width = isAudio ? 0 : parseInt(probe(inputFile, 'v:0', 'width') || '0');

  console.log(`  Mode     : ${c.cyan('raw split')} (no re-encoding, no speed-up)`);
  if (!isAudio) console.log(`  Resolution : ${width > 0 ? width + 'p' : 'unknown'}`);
  console.log(`  Duration : ${duration ? fmtDuration(durationSec) : 'unknown'}`);
  console.log(`  File size: ${fmtBytes(fs.statSync(inputFile).size)}`);

  const needsSegmentation = durationSec === null || durationSec > segTime;

  if (needsSegmentation) {
    console.log(`  Splitting at keyframes (~${segTime}s chunks)...`);
    const args = [
      '-y', '-err_detect', 'ignore_err', '-fflags', '+genpts+discardcorrupt',
      '-i', inputFile,
      '-c', 'copy',
      '-f', 'segment', '-segment_time', String(segTime), '-reset_timestamps', '1',
      ...(isAudio ? ['-vn'] : ['-map', '0:v:0', '-map', '0:a:0']),
      '-movflags', '+faststart',
      path.join(outputDir, `segment_%02d${outExt}`),
    ];
    const result = spawnSync(getFFmpeg(), args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.warn(`  ${c.warn(`ffmpeg exited with code ${result.status} (output may still be usable)`)}`);
    }
  } else {
    console.log(`  Single segment (duration ${fmtDuration(durationSec)} ≤ ${segTime}s) — copying...`);
    const outPath = path.join(outputDir, `segment_00${outExt}`);
    const args = [
      '-y', '-err_detect', 'ignore_err', '-fflags', '+genpts+discardcorrupt',
      '-i', inputFile,
      '-c', 'copy',
      ...(isAudio ? ['-vn'] : ['-map', '0:v:0', '-map', '0:a:0']),
      '-movflags', '+faststart',
      outPath,
    ];
    const result = spawnSync(getFFmpeg(), args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.warn(`  ${c.warn(`ffmpeg exited with code ${result.status}`)}`);
    }
  }

  // Collect segments
  const segments = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('segment_') && (f.endsWith('.mp4') || f.endsWith('.m4a')))
    .sort()
    .map(f => path.join(outputDir, f));

  // Validate
  const corrupt = segments.filter(s => !verifySegment(s));
  if (corrupt.length > 0) {
    console.warn(`  ${c.warn(`${corrupt.length} segment(s) may be corrupt (no moov atom):`)}`);
    corrupt.forEach(s => console.warn(`    ${c.error(path.basename(s))}`));
    console.warn(`  ${c.dim('Stream-copy splits at keyframes — some containers may need re-mux.')}`);
    console.warn(`  ${c.dim('Remove --no-compress to re-encode instead.')}`);
  }

  // Duration validation: warn if any segment exceeds 1 hour (Gemini sweet spot)
  for (const seg of segments) {
    const dur = probeFormat(seg, 'duration');
    if (dur && parseFloat(dur) > 3600) {
      console.warn(`  ${c.warn(`${path.basename(seg)} is ${fmtDuration(parseFloat(dur))} — very long segments use more Gemini tokens.`)}`);
      console.warn(`  ${c.dim('  Consider removing --no-compress to re-encode into shorter segments.')}`);
      break; // warn once
    }
  }

  return segments;
}

module.exports = {
  findBin,
  probe,
  probeFormat,
  compressAndSegment,
  compressAndSegmentAudio,
  splitOnly,
  verifySegment,
  getFFmpeg,
  getFFprobe,
};
