/**
 * Git Service — wraps git CLI for change detection.
 *
 * Provides structured access to git log, diff, and status information
 * for correlating code changes with call analysis items.
 *
 * All commands use execFileSync for safety (no shell injection).
 * Windows-compatible: uses forward-slash path normalization.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ======================== HELPERS ========================

/**
 * Execute a git command and return stdout.
 * Returns null on error instead of throwing.
 *
 * @param {string[]} args - Git arguments
 * @param {string} cwd - Working directory
 * @returns {string|null}
 */
function execGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      timeout: 30000,
      windowsHide: true,
    }).trim();
  } catch (err) {
    // Common failures: not a repo, detached HEAD, no commits
    return null;
  }
}

/** Normalize path separators to forward slashes for cross-platform comparison */
function normPath(p) {
  return (p || '').replace(/\\/g, '/');
}

// ======================== AVAILABILITY ========================

/**
 * Check if git CLI is available on this system.
 * @returns {boolean}
 */
function isGitAvailable() {
  try {
    execFileSync('git', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the git repository root by walking up from startDir.
 *
 * @param {string} startDir - Directory to start searching from
 * @returns {string|null} Absolute path to git root, or null
 */
function findGitRoot(startDir) {
  const root = execGit(['rev-parse', '--show-toplevel'], startDir);
  return root ? path.resolve(root) : null;
}

/**
 * Check if a directory is inside a git repository.
 * @param {string} dir
 * @returns {boolean}
 */
function isGitRepo(dir) {
  return findGitRoot(dir) !== null;
}

/**
 * Initialize a new git repository in the given directory.
 *
 * Creates the repo, stages all existing files, and makes an initial commit.
 * If the directory is already a git repo, does nothing and returns the existing root.
 *
 * @param {string} dir - Directory to initialize
 * @returns {{ root: string, created: boolean }} Repo root path and whether it was newly created
 * @throws {Error} If git is not available or init fails
 */
function initRepo(dir) {
  if (!isGitAvailable()) {
    throw new Error('git is not installed. Install git to use progress tracking.');
  }

  // Already a repo — return existing root
  const existing = findGitRoot(dir);
  if (existing) return { root: existing, created: false };

  // Initialize
  const initResult = execGit(['init'], dir);
  if (initResult === null) {
    throw new Error(`Failed to initialize git repository in "${dir}". Check directory permissions.`);
  }

  // Stage all existing files and create initial commit
  execGit(['add', '-A'], dir);
  execGit(['commit', '-m', 'Initial commit — baseline for progress tracking', '--allow-empty'], dir);

  const root = findGitRoot(dir);
  if (!root) {
    throw new Error(`git init succeeded but repository root could not be resolved in "${dir}".`);
  }
  return { root, created: true };
}

// ======================== COMMIT LOG ========================

/**
 * Get commits since a given ISO timestamp.
 *
 * @param {string} repoPath - Repository root
 * @param {string} sinceISO - ISO 8601 timestamp (e.g. "2026-02-24T16:22:28")
 * @param {number} [maxCount=100] - Max commits to return
 * @returns {Array<{hash: string, author: string, date: string, message: string}>}
 */
function getCommitsSince(repoPath, sinceISO, maxCount = 100) {
  const SEP = '\x00'; // null byte separator — won't appear in messages
  const format = `%H${SEP}%an${SEP}%aI${SEP}%s`;

  const output = execGit(
    ['log', `--since=${sinceISO}`, `--format=${format}`, `--max-count=${maxCount}`],
    repoPath,
  );
  if (!output) return [];

  return output.split('\n').filter(Boolean).map(line => {
    const parts = line.split(SEP);
    if (parts.length < 4) return null;
    return {
      hash: parts[0].slice(0, 12),
      author: parts[1],
      date: parts[2],
      message: parts.slice(3).join(SEP), // message may contain SEP (unlikely)
    };
  }).filter(Boolean);
}

/**
 * Get commit messages with their changed file lists.
 * More expensive than getCommitsSince but gives per-commit file info.
 *
 * @param {string} repoPath
 * @param {string} sinceISO
 * @param {number} [maxCount=50]
 * @returns {Array<{hash: string, author: string, date: string, message: string, files: string[]}>}
 */
function getCommitsWithFiles(repoPath, sinceISO, maxCount = 50) {
  const output = execGit(
    ['log', `--since=${sinceISO}`, '--name-only', '--format=COMMIT:%H|%an|%aI|%s', `--max-count=${maxCount}`],
    repoPath,
  );
  if (!output) return [];

  const commits = [];
  let current = null;

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('COMMIT:')) {
      if (current) commits.push(current);
      const parts = trimmed.slice(7).split('|');
      current = {
        hash: (parts[0] || '').slice(0, 12),
        author: parts[1] || '',
        date: parts[2] || '',
        message: parts.slice(3).join('|'),
        files: [],
      };
    } else if (current) {
      current.files.push(normPath(trimmed));
    }
  }
  if (current) commits.push(current);

  return commits;
}

// ======================== CHANGED FILES ========================

/**
 * Get a deduplicated list of all files changed since a timestamp.
 * Aggregates across all commits — each file appears once with its last status.
 *
 * @param {string} repoPath
 * @param {string} sinceISO
 * @returns {Array<{path: string, status: string, changes: number}>}
 */
function getChangedFilesSince(repoPath, sinceISO) {
  const output = execGit(
    ['log', `--since=${sinceISO}`, '--name-status', '--format='],
    repoPath,
  );
  if (!output) return [];

  const fileMap = new Map();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([AMDRC])\t(.+)$/);
    if (match) {
      const status = match[1];
      const filePath = normPath(match[2]);
      const existing = fileMap.get(filePath);
      if (existing) {
        existing.changes++;
        existing.status = status; // latest status wins
      } else {
        fileMap.set(filePath, { path: filePath, status, changes: 1 });
      }
    }
  }

  return Array.from(fileMap.values());
}

// ======================== DIFF CONTENT ========================

/**
 * Get a summary of changes since a timestamp (insertions/deletions).
 *
 * @param {string} repoPath
 * @param {string} sinceISO
 * @returns {string} Human-readable diff summary
 */
function getDiffSummary(repoPath, sinceISO) {
  const commits = getCommitsSince(repoPath, sinceISO);
  if (commits.length === 0) return 'No changes';

  const oldestHash = commits[commits.length - 1].hash;
  // Try parent..HEAD first
  let output = execGit(['diff', '--shortstat', `${oldestHash}~1`, 'HEAD'], repoPath);
  if (!output) {
    output = execGit(['diff', '--shortstat', oldestHash, 'HEAD'], repoPath);
  }
  return output || 'No stat available';
}

// ======================== WORKING TREE ========================

/**
 * Get uncommitted working tree changes (staged + unstaged).
 *
 * @param {string} repoPath
 * @returns {Array<{path: string, status: string}>}
 */
function getWorkingTreeChanges(repoPath) {
  const output = execGit(['status', '--porcelain', '-u'], repoPath);
  if (!output) return [];

  return output.split('\n').filter(Boolean).map(line => {
    const status = line.slice(0, 2).trim();
    const filePath = normPath(line.slice(3));
    return { path: filePath, status };
  });
}

/**
 * Get the current branch name.
 *
 * @param {string} repoPath
 * @returns {string|null}
 */
function getCurrentBranch(repoPath) {
  return execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
}

// ======================== EXPORTS ========================

module.exports = {
  isGitAvailable,
  findGitRoot,
  isGitRepo,
  initRepo,
  getCommitsSince,
  getCommitsWithFiles,
  getChangedFilesSince,
  getDiffSummary,
  getWorkingTreeChanges,
  getCurrentBranch,
  normPath,
};
