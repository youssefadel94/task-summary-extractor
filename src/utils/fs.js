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

module.exports = { findDocsRecursive };
