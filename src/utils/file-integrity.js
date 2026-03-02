/**
 * File integrity checker — detects corrupt, truncated, or suspicious files
 * before pipeline processing begins.
 *
 * Checks:
 *  - Video/Audio: zero-byte, unreadable, missing streams, suspiciously low
 *    bitrate (metadata duration vs file size), duration mismatch
 *  - Documents: zero-byte, unreadable/unparseable, empty content after parsing
 *
 * All checks are non-blocking — issues are flagged as warnings so the user
 * can audit before or after processing. The pipeline continues regardless.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { c } = require('./colors');

// ======================== CONSTANTS ========================

/**
 * Minimum expected bitrate thresholds (bits per second).
 * Files below these are flagged as potentially corrupt/truncated.
 *
 * Videos: Even at the lowest quality (240p, CRF 51), a meeting recording with
 * audio typically yields ≥ 100 kbps. We use 50 kbps as a generous floor.
 * Audio: Minimum voice quality is ~16 kbps (narrow-band). We use 8 kbps floor.
 */
const MIN_VIDEO_BITRATE_BPS = 80_000;  // 80 kbps
const MIN_AUDIO_BITRATE_BPS = 8_000;   // 8 kbps

/**
 * Maximum allowed discrepancy between container-level and stream-level duration.
 * If the ratio (shorter / longer) is below this, file is likely truncated.
 */
const DURATION_MISMATCH_RATIO = 0.50; // 50% — e.g. container says 60 min but stream has 30 min

/**
 * Severity levels for integrity issues.
 */
const SEVERITY = {
  ERROR: 'error',    // File almost certainly broken (zero-byte, unreadable)
  WARNING: 'warning', // Likely corrupt (bitrate anomaly, duration mismatch)
  INFO: 'info',       // Suspicious but may be fine (unusually small, empty doc)
};

// ======================== VIDEO / AUDIO PROBING ========================

/**
 * Probe a media file for integrity issues using ffprobe only (fast).
 *
 * @param {string} filePath - Absolute path to video/audio file
 * @param {'video'|'audio'} type - File type category
 * @returns {{ file: string, type: string, issues: Array<{severity: string, message: string, detail?: string}>, meta: object }}
 */
function probeMediaIntegrity(filePath, type = 'video') {
  const fileName = path.basename(filePath);
  const issues = [];
  const meta = { fileName, type, filePath };

  // 1. Check file exists and is non-zero
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    issues.push({ severity: SEVERITY.ERROR, message: 'File not found or unreadable', detail: err.message });
    return { file: fileName, type, issues, meta };
  }

  meta.sizeBytes = stat.size;

  if (stat.size === 0) {
    issues.push({ severity: SEVERITY.ERROR, message: 'File is empty (0 bytes)' });
    return { file: fileName, type, issues, meta };
  }

  // 2. Try ffprobe — get format-level metadata
  let probeResult;
  try {
    const { spawnSync } = require('child_process');
    const { getFFprobe } = require('../services/video');
    probeResult = spawnSync(getFFprobe(), [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate,nb_streams,format_name',
      '-show_entries', 'stream=codec_type,duration,bit_rate,nb_frames',
      '-of', 'json',
      filePath,
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  } catch (err) {
    issues.push({ severity: SEVERITY.ERROR, message: 'ffprobe failed to execute', detail: err.message });
    return { file: fileName, type, issues, meta };
  }

  if (probeResult.status !== 0) {
    const stderr = (probeResult.stderr || '').slice(0, 200);
    issues.push({ severity: SEVERITY.ERROR, message: 'ffprobe could not read file', detail: stderr || 'Unknown error' });
    return { file: fileName, type, issues, meta };
  }

  let probeData;
  try {
    probeData = JSON.parse(probeResult.stdout);
  } catch {
    issues.push({ severity: SEVERITY.ERROR, message: 'ffprobe returned invalid JSON' });
    return { file: fileName, type, issues, meta };
  }

  const format = probeData.format || {};
  const streams = probeData.streams || [];

  meta.formatDuration = format.duration ? parseFloat(format.duration) : null;
  meta.formatBitRate = format.bit_rate ? parseInt(format.bit_rate, 10) : null;
  meta.streamCount = streams.length;
  meta.formatName = format.format_name || null;

  // 3. Check for missing streams
  const videoStreams = streams.filter(s => s.codec_type === 'video');
  const audioStreams = streams.filter(s => s.codec_type === 'audio');
  meta.hasVideoStream = videoStreams.length > 0;
  meta.hasAudioStream = audioStreams.length > 0;

  if (type === 'video' && videoStreams.length === 0) {
    issues.push({ severity: SEVERITY.WARNING, message: 'No video stream found in video file', detail: `Streams: ${streams.map(s => s.codec_type).join(', ') || 'none'}` });
  }
  if (audioStreams.length === 0) {
    issues.push({ severity: SEVERITY.INFO, message: 'No audio stream found', detail: 'File may be a silent recording or screen capture' });
  }

  // 4. Check container duration
  if (meta.formatDuration == null || meta.formatDuration <= 0) {
    issues.push({ severity: SEVERITY.ERROR, message: 'Container reports zero or missing duration', detail: 'File header may be corrupt' });
    return { file: fileName, type, issues, meta };
  }

  // 5. Bitrate analysis — the key corruption detector
  // Calculate actual bitrate from file size and container duration
  const actualBitrate = (stat.size * 8) / meta.formatDuration;
  meta.calculatedBitrateBps = Math.round(actualBitrate);

  const threshold = type === 'video' ? MIN_VIDEO_BITRATE_BPS : MIN_AUDIO_BITRATE_BPS;
  if (actualBitrate < threshold) {
    const kbps = (actualBitrate / 1000).toFixed(1);
    const minKbps = (threshold / 1000).toFixed(0);
    issues.push({
      severity: SEVERITY.WARNING,
      message: `Suspiciously low bitrate: ${kbps} kbps (expected ≥${minKbps} kbps for ${type})`,
      detail: `File may be truncated or corrupt — metadata says ${fmtDur(meta.formatDuration)} but the actual data may be much shorter. Re-download recommended.`,
    });
  }

  // 6. Stream duration vs container duration mismatch
  const primaryStream = type === 'video' ? videoStreams[0] : audioStreams[0];
  if (primaryStream && primaryStream.duration) {
    const streamDuration = parseFloat(primaryStream.duration);
    meta.streamDuration = streamDuration;

    if (streamDuration > 0 && meta.formatDuration > 0) {
      const ratio = Math.min(streamDuration, meta.formatDuration) / Math.max(streamDuration, meta.formatDuration);
      meta.durationMatchRatio = parseFloat(ratio.toFixed(3));

      if (ratio < DURATION_MISMATCH_RATIO) {
        issues.push({
          severity: SEVERITY.WARNING,
          message: `Duration mismatch: container says ${fmtDur(meta.formatDuration)} but stream is ${fmtDur(streamDuration)}`,
          detail: `File may be truncated — only ${(ratio * 100).toFixed(0)}% of expected content is present`,
        });
      }
    }
  }

  // 7. Unusually small file for its duration
  // Meeting recordings typically ≥ 0.5 MB/min for video, ≥ 0.1 MB/min for audio
  const durationMinutes = meta.formatDuration / 60;
  if (durationMinutes > 1) {
    const mbPerMin = (stat.size / 1048576) / durationMinutes;
    meta.mbPerMinute = parseFloat(mbPerMin.toFixed(2));

    const minMbPerMin = type === 'video' ? 0.5 : 0.06;
    if (mbPerMin < minMbPerMin) {
      issues.push({
        severity: SEVERITY.INFO,
        message: `Unusually small: ${mbPerMin.toFixed(2)} MB/min (typical ${type} ≥ ${minMbPerMin} MB/min)`,
        detail: 'May indicate low quality, corrupt data, or incomplete download',
      });
    }
  }

  return { file: fileName, type, issues, meta };
}

// ======================== DOCUMENT INTEGRITY ========================

/**
 * Check a document file for basic integrity issues.
 *
 * @param {{ absPath: string, relPath: string }} docFile - Document file info
 * @returns {{ file: string, type: string, issues: Array<{severity: string, message: string, detail?: string}>, meta: object }}
 */
function probeDocIntegrity(docFile) {
  const fileName = docFile.relPath || path.basename(docFile.absPath);
  const issues = [];
  const meta = { fileName, type: 'document', filePath: docFile.absPath };

  // 1. Check file exists and size
  let stat;
  try {
    stat = fs.statSync(docFile.absPath);
  } catch (err) {
    issues.push({ severity: SEVERITY.ERROR, message: 'File not found or unreadable', detail: err.message });
    return { file: fileName, type: 'document', issues, meta };
  }

  meta.sizeBytes = stat.size;

  if (stat.size === 0) {
    issues.push({ severity: SEVERITY.ERROR, message: 'File is empty (0 bytes)' });
    return { file: fileName, type: 'document', issues, meta };
  }

  // 2. For text-like files, check if they have actual content
  const ext = path.extname(docFile.absPath).toLowerCase();
  const textExts = new Set(['.vtt', '.txt', '.csv', '.md', '.srt', '.json', '.xml', '.html', '.htm']);

  if (textExts.has(ext)) {
    try {
      const content = fs.readFileSync(docFile.absPath, 'utf8');
      const trimmed = content.trim();
      if (trimmed.length === 0) {
        issues.push({ severity: SEVERITY.WARNING, message: 'File has no text content (whitespace only)' });
      } else if (trimmed.length < 10) {
        issues.push({ severity: SEVERITY.INFO, message: `File has very little content (${trimmed.length} chars)` });
      }
    } catch (err) {
      issues.push({ severity: SEVERITY.ERROR, message: 'File could not be read as text', detail: err.message });
    }
  }

  // 3. For binary formats, try to detect obviously broken files
  const binaryExts = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.epub']);
  if (binaryExts.has(ext)) {
    try {
      const header = Buffer.alloc(8);
      const fd = fs.openSync(docFile.absPath, 'r');
      fs.readSync(fd, header, 0, 8, 0);
      fs.closeSync(fd);

      // PDF should start with %PDF
      if (ext === '.pdf' && !header.toString('ascii', 0, 4).startsWith('%PDF')) {
        issues.push({ severity: SEVERITY.WARNING, message: 'File does not start with %PDF header — may not be a valid PDF' });
      }

      // DOCX/XLSX/PPTX/ODT/EPUB are ZIP archives — should start with PK (0x504B)
      const zipExts = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.odp', '.ods', '.epub']);
      if (zipExts.has(ext) && header[0] !== 0x50 && header[1] !== 0x4B) {
        issues.push({ severity: SEVERITY.WARNING, message: 'File does not have ZIP header — may not be a valid Office/ODF document' });
      }

      // DOC should start with D0 CF 11 E0 (OLE compound file)
      if (ext === '.doc' && !(header[0] === 0xD0 && header[1] === 0xCF && header[2] === 0x11 && header[3] === 0xE0)) {
        issues.push({ severity: SEVERITY.WARNING, message: 'File does not have OLE header — may not be a valid DOC file' });
      }
    } catch {
      // Can't read header — already caught by size check above
    }
  }

  return { file: fileName, type: 'document', issues, meta };
}

// ======================== BATCH AUDIT ========================

/**
 * Run integrity checks on all discovered files (videos, audio, documents).
 * Returns a report with all flagged issues.
 *
 * @param {object} params
 * @param {string[]} params.videoFiles - Absolute paths to video files
 * @param {string[]} params.audioFiles - Absolute paths to audio files
 * @param {Array<{absPath: string, relPath: string}>} params.docFiles - Document file objects
 * @returns {{ warnings: Array, hasErrors: boolean, hasSuspicious: boolean, report: Array }}
 */
function auditFileIntegrity({ videoFiles = [], audioFiles = [], docFiles = [] } = {}) {
  const report = [];

  // Check videos
  for (const vf of videoFiles) {
    report.push(probeMediaIntegrity(vf, 'video'));
  }

  // Check audio
  for (const af of audioFiles) {
    report.push(probeMediaIntegrity(af, 'audio'));
  }

  // Check documents
  for (const df of docFiles) {
    report.push(probeDocIntegrity(df));
  }

  // Aggregate
  const flagged = report.filter(r => r.issues.length > 0);
  const hasErrors = flagged.some(r => r.issues.some(i => i.severity === SEVERITY.ERROR));
  const hasSuspicious = flagged.some(r =>
    r.issues.some(i => i.severity === SEVERITY.WARNING || i.severity === SEVERITY.ERROR)
  );

  // Build flat warnings list
  const warnings = [];
  for (const entry of flagged) {
    for (const issue of entry.issues) {
      warnings.push({
        file: entry.file,
        type: entry.type,
        severity: issue.severity,
        message: issue.message,
        detail: issue.detail || null,
      });
    }
  }

  return { warnings, hasErrors, hasSuspicious, report };
}

// ======================== CONSOLE OUTPUT ========================

/**
 * Print integrity audit results to the console.
 * Only prints if there are issues to report.
 *
 * @param {{ warnings: Array, hasErrors: boolean, hasSuspicious: boolean }} audit
 * @param {object} [log] - Logger instance
 */
function printIntegrityReport(audit, log) {
  const { warnings, hasErrors, hasSuspicious } = audit;
  if (warnings.length === 0) return;

  console.log('');
  console.log(`  ${c.warn('⚠ File Integrity Check')} — ${warnings.length} issue(s) found:`);

  // Group by file
  const byFile = {};
  for (const w of warnings) {
    if (!byFile[w.file]) byFile[w.file] = [];
    byFile[w.file].push(w);
  }

  for (const [file, issues] of Object.entries(byFile)) {
    const worstSeverity = issues.some(i => i.severity === SEVERITY.ERROR) ? 'error'
      : issues.some(i => i.severity === SEVERITY.WARNING) ? 'warning' : 'info';

    const icon = worstSeverity === 'error' ? c.error('✗')
      : worstSeverity === 'warning' ? c.warn('⚠')
      : c.dim('ℹ');

    console.log(`    ${icon} ${c.cyan(file)}`);
    for (const issue of issues) {
      const sevLabel = issue.severity === 'error' ? c.error(issue.severity.toUpperCase())
        : issue.severity === 'warning' ? c.warn(issue.severity.toUpperCase())
        : c.dim(issue.severity.toUpperCase());

      console.log(`      ${sevLabel}: ${issue.message}`);
      if (issue.detail) {
        console.log(`        ${c.dim(issue.detail)}`);
      }
    }
  }

  if (hasErrors) {
    console.log('');
    console.log(`  ${c.error('Some files may be broken.')} Processing will continue, but results may be incomplete.`);
    console.log(`  ${c.dim('Re-download or replace broken files and re-run for best results.')}`);
  } else if (hasSuspicious) {
    console.log('');
    console.log(`  ${c.warn('Some files look suspicious.')} Processing will continue — check results.json for details.`);
  }

  console.log('');

  // Log to structured log
  if (log) {
    for (const w of warnings) {
      const logFn = w.severity === 'error' ? 'error' : 'warn';
      if (log[logFn]) {
        log[logFn](`File integrity: [${w.severity}] ${w.file} — ${w.message}`);
      }
    }
  }
}

// ======================== HELPERS ========================

/** Format seconds → "M:SS" or "H:MM:SS" */
function fmtDur(sec) {
  if (!sec && sec !== 0) return '?';
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = {
  probeMediaIntegrity,
  probeDocIntegrity,
  auditFileIntegrity,
  printIntegrityReport,
  SEVERITY,
  // Exported for testing
  MIN_VIDEO_BITRATE_BPS,
  MIN_AUDIO_BITRATE_BPS,
  DURATION_MISMATCH_RATIO,
};
