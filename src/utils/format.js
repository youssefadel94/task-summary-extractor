/**
 * Formatting helpers.
 */

'use strict';

/** Format seconds → "M:SS" */
function fmtDuration(sec) {
  if (!sec && sec !== 0) return 'unknown';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format seconds → "HH:MM:SS" (used across services to avoid duplication) */
function formatHMS(sec) {
  if (sec == null) return '??:??:??';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Format bytes → human-readable "12.3 MB" */
function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

module.exports = { fmtDuration, formatHMS, fmtBytes };
