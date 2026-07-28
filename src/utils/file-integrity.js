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
 * Measure real duration by scanning packet timestamps.
 *
 * Live-written containers (browser MediaRecorder .webm, OBS captures, any
 * recording whose writer was killed before finalizing) never get a Duration
 * element in the header. The media itself is perfectly playable — only the
 * header lookup fails — so a missing container duration is not by itself
 * evidence of corruption. This resolves the ambiguity by reading the stream.
 *
 * Returns { packets, duration } — duration is null when it cannot be measured.
 */
function measureDurationByScan(filePath, type = 'video') {
  try {
    const { spawnSync } = require('child_process');
    const { getFFprobe } = require('../services/video');
    const result = spawnSync(getFFprobe(), [
      '-v', 'error',
      '-select_streams', type === 'audio' ? 'a:0' : 'v:0',
      '-show_entries', 'packet=pts_time',
      '-of', 'csv=p=0',
      filePath,
    ], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024, // long recordings emit one line per packet
    });

    if (result.status !== 0 || !result.stdout) return { packets: 0, duration: null };

    const lines = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return { packets: 0, duration: null };

    // Packets are not always in presentation order — take the largest timestamp.
    let maxPts = null;
    for (const line of lines) {
      const pts = parseFloat(line);
      if (Number.isFinite(pts) && (maxPts === null || pts > maxPts)) maxPts = pts;
    }
    return { packets: lines.length, duration: maxPts !== null && maxPts > 0 ? maxPts : null };
  } catch {
    return { packets: 0, duration: null };
  }
}

/**
 * Sniff a container's magic bytes to explain *why* ffprobe rejected a file.
 * Returns a human-readable detail string, or null when nothing conclusive.
 */
function sniffContainerHeader(filePath) {
  let header;
  try {
    header = Buffer.alloc(16);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();

  // MP4/MOV: bytes 4-8 must be a box type, normally 'ftyp' at the very start.
  if (['.mp4', '.mov', '.m4a'].includes(ext)) {
    const boxType = header.toString('ascii', 4, 8);
    if (!['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(boxType)) {
      return "No 'ftyp' box at the start — this is not a real MP4. "
        + 'Usually a failed or partial download (or an error page saved with a .mp4 name). Re-download it.';
    }
    return 'MP4 boxes present but the moov index is missing — the download stopped before the file was finished.';
  }

  // Matroska/WebM magic: 1A 45 DF A3
  if (['.webm', '.mkv'].includes(ext)) {
    if (!(header[0] === 0x1A && header[1] === 0x45 && header[2] === 0xDF && header[3] === 0xA3)) {
      return 'Missing Matroska/WebM signature — the file is not a valid WebM container.';
    }
  }

  return null;
}

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
    // Keep ffprobe's first diagnostic line only — later lines just repeat the
    // full path, which is noise next to the plain-language hint below.
    const firstLine = (probeResult.stderr || '').split('\n').map(s => s.trim()).find(Boolean) || '';
    const stderr = firstLine.replace(/^\[[^\]]*\]\s*/, '').slice(0, 160);
    // Explain the cause where the container header makes it obvious.
    const hint = sniffContainerHeader(filePath);
    issues.push({
      severity: SEVERITY.ERROR,
      message: 'ffprobe could not read file',
      detail: hint ? `${hint}${stderr ? ` (ffprobe: ${stderr})` : ''}` : (stderr || 'Unknown error'),
    });
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
  // A missing duration usually means the recording was never finalized, not
  // that it is broken — confirm against the actual stream before crying wolf.
  if (meta.formatDuration == null || meta.formatDuration <= 0) {
    const scan = measureDurationByScan(filePath, type);
    meta.scannedPackets = scan.packets;

    if (scan.packets === 0) {
      issues.push({
        severity: SEVERITY.ERROR,
        message: 'No duration in the container and no readable packets',
        detail: 'File header is corrupt and the stream could not be read.',
      });
      return { file: fileName, type, issues, meta };
    }

    if (scan.duration == null) {
      issues.push({
        severity: SEVERITY.INFO,
        message: `Container reports no duration (${scan.packets.toLocaleString()} packets readable)`,
        detail: 'Recording was likely not finalized. The stream is readable, so processing continues normally.',
      });
      return { file: fileName, type, issues, meta };
    }

    // Duration recovered — carry on with the remaining checks using it.
    meta.formatDuration = scan.duration;
    meta.durationSource = 'packet-scan';
    issues.push({
      severity: SEVERITY.INFO,
      message: `Container reports no duration — measured ${fmtDur(scan.duration)} by scanning the stream`,
      detail: 'Typical of a recording that was not finalized (browser/OBS capture). The media is readable; processing continues normally.',
    });
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
      if (zipExts.has(ext) && (header[0] !== 0x50 || header[1] !== 0x4B)) {
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

  // ERROR means the file cannot be read at all — processing it would only waste
  // time and pollute the analysis, so callers drop these and carry on with the
  // rest. WARNING/INFO files are still processed.
  const unusable = flagged
    .filter(r => r.issues.some(i => i.severity === SEVERITY.ERROR))
    .map(r => ({
      file: r.file,
      type: r.type,
      filePath: r.meta.filePath,
      reason: r.issues.find(i => i.severity === SEVERITY.ERROR).message,
    }));
  const unusablePaths = new Set(unusable.map(u => u.filePath));

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
        excluded: unusablePaths.has(entry.meta.filePath),
      });
    }
  }

  return { warnings, hasErrors, hasSuspicious, report, unusable, totalFiles: report.length };
}

/**
 * Combine audits run at different points (media before mode selection,
 * documents after) into one report for display and for results.json.
 */
function mergeAudits(...audits) {
  const merged = audits.filter(Boolean);
  const report = merged.flatMap(a => a.report || []);
  const unusable = merged.flatMap(a => a.unusable || []);
  return {
    warnings: merged.flatMap(a => a.warnings || []),
    hasErrors: merged.some(a => a.hasErrors),
    hasSuspicious: merged.some(a => a.hasSuspicious),
    report,
    unusable,
    totalFiles: report.length,
  };
}

/**
 * Drop files the audit found unreadable.
 * Accepts plain paths (media) or { absPath } objects (documents).
 * Returns { kept, dropped }.
 */
function excludeUnusable(files, audit) {
  const unusablePaths = new Set((audit?.unusable || []).map(u => u.filePath));
  const kept = [];
  const dropped = [];
  for (const f of files) {
    const filePath = typeof f === 'string' ? f : f.absPath;
    (unusablePaths.has(filePath) ? dropped : kept).push(f);
  }
  return { kept, dropped };
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
  // c.warn/c.error already prefix their own glyph — never add another here.
  console.log(`  ${c.warn('File Integrity Check')} — ${warnings.length} issue(s) found:`);

  // Group by file
  const byFile = {};
  for (const w of warnings) {
    if (!byFile[w.file]) byFile[w.file] = [];
    byFile[w.file].push(w);
  }

  for (const [file, issues] of Object.entries(byFile)) {
    const worstSeverity = issues.some(i => i.severity === SEVERITY.ERROR) ? 'error'
      : issues.some(i => i.severity === SEVERITY.WARNING) ? 'warning' : 'info';

    const icon = worstSeverity === 'error' ? c.red('✗')
      : worstSeverity === 'warning' ? c.yellow('⚠')
      : c.dim('ℹ');

    console.log(`    ${icon} ${c.cyan(file)}`);
    for (const issue of issues) {
      const sevLabel = issue.severity === 'error' ? c.red(issue.severity.toUpperCase())
        : issue.severity === 'warning' ? c.yellow(issue.severity.toUpperCase())
        : c.dim(issue.severity.toUpperCase());

      console.log(`      ${sevLabel}: ${issue.message}`);
      if (issue.detail) {
        console.log(`        ${c.dim(issue.detail)}`);
      }
    }
    if (issues.some(i => i.excluded)) {
      console.log(`        ${c.dim('→ Skipped — the rest of the files are processed as normal.')}`);
    }
  }

  if (hasErrors) {
    console.log('');
    console.log(`  ${c.error('Unreadable files were skipped.')} Everything else is processed as normal.`);
    console.log(`  ${c.dim('Re-download or replace the skipped files and re-run to include them.')}`);
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
  mergeAudits,
  excludeUnusable,
  printIntegrityReport,
  SEVERITY,
  measureDurationByScan,
  sniffContainerHeader,
  // Exported for testing
  MIN_VIDEO_BITRATE_BPS,
  MIN_AUDIO_BITRATE_BPS,
  DURATION_MISMATCH_RATIO,
};
