/**
 * Filesystem utilities — recursive doc finder, etc.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Directories to always skip when scanning recursively */
const SKIP_DIRS = new Set(['node_modules', '.git', 'compressed', 'logs', 'gemini_runs', 'runs']);

/**
 * Recursively find all files matching given extensions under a directory.
 * Returns array of { absPath, relPath } where relPath is relative to baseDir.
 * Skips node_modules, .git, compressed, and other build directories.
 */
function findDocsRecursive(baseDir, exts, _relBase = '') {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(baseDir, _relBase), { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = _relBase ? path.join(_relBase, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        results.push(...findDocsRecursive(baseDir, exts, rel));
      }
    } else if (exts.includes(path.extname(entry.name).toLowerCase())) {
      results.push({ absPath: path.join(baseDir, rel), relPath: rel.replace(/\\/g, '/') });
    }
  }
  return results;
}

/**
 * Export formats that are re-renderings of a source document rather than
 * content of their own. When `notes.md` and `notes.pdf` sit side by side, the
 * PDF is the same words in a heavier wrapper.
 *
 * Ranked best-first: the earliest form present for a given path wins and the
 * rest are dropped. Text beats markup beats print formats — parsing a PDF or
 * stripping HTML only adds extraction noise to identical content.
 */
const FORMAT_PREFERENCE = ['.md', '.txt', '.docx', '.html', '.htm', '.pdf'];

/**
 * Drop redundant format twins of the same document.
 *
 * Only files sharing a full path-and-stem are considered twins, so `db.md` and
 * `exports/db.pdf` are left alone — different folders usually mean different
 * content. Formats outside FORMAT_PREFERENCE (.csv, .json, .vtt, …) are never
 * dropped: they carry structure the prose copy may not.
 *
 * @returns {{ kept: Array, dropped: Array }} dropped entries carry `.supersededBy`
 */
function dedupeFormatTwins(docFiles) {
  const groups = new Map();
  for (const doc of docFiles) {
    const ext = path.extname(doc.relPath).toLowerCase();
    if (!FORMAT_PREFERENCE.includes(ext)) continue;
    const stem = doc.relPath.slice(0, -ext.length).toLowerCase();
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push({ doc, ext });
  }

  const superseded = new Map(); // relPath -> winning relPath
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    const rank = e => FORMAT_PREFERENCE.indexOf(e.ext);
    const winner = entries.reduce((best, e) => (rank(e) < rank(best) ? e : best));
    for (const e of entries) {
      if (e !== winner) superseded.set(e.doc.relPath, winner.doc.relPath);
    }
  }

  const kept = [];
  const dropped = [];
  for (const doc of docFiles) {
    const winner = superseded.get(doc.relPath);
    if (winner) dropped.push({ ...doc, supersededBy: winner });
    else kept.push(doc);
  }
  return { kept, dropped };
}

module.exports = { findDocsRecursive, dedupeFormatTwins, FORMAT_PREFERENCE };
