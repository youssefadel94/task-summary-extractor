'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { findDocsRecursive } = require('../../src/utils/fs');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-fs-'));
  fs.writeFileSync(path.join(root, 'a.md'), 'a');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b');
  fs.writeFileSync(path.join(root, 'skip.png'), 'x');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'c.md'), 'c');
  // Directories that must be skipped:
  for (const d of ['node_modules', '.git', 'runs', 'compressed', 'logs', 'gemini_runs']) {
    fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, d, 'ignored.md'), 'nope');
  }
  return root;
}

describe('findDocsRecursive', () => {
  let root;
  beforeEach(() => { root = makeTree(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('finds matching files recursively and skips build/infra dirs', () => {
    const found = findDocsRecursive(root, ['.md', '.txt']);
    const rels = found.map(f => f.relPath).sort();
    expect(rels).toEqual(['a.md', 'b.txt', 'sub/c.md']);
  });

  it('matches extensions case-insensitively and returns absolute paths', () => {
    fs.writeFileSync(path.join(root, 'UPPER.MD'), 'u');
    const found = findDocsRecursive(root, ['.md']);
    expect(found.some(f => f.relPath === 'UPPER.MD')).toBe(true);
    for (const f of found) {
      expect(path.isAbsolute(f.absPath)).toBe(true);
      expect(fs.existsSync(f.absPath)).toBe(true);
    }
  });

  it('normalises relPath to forward slashes', () => {
    const found = findDocsRecursive(root, ['.md']);
    const sub = found.find(f => f.relPath.includes('c.md'));
    expect(sub.relPath).toBe('sub/c.md');
    expect(sub.relPath).not.toContain('\\');
  });

  it('returns [] for a nonexistent directory (no throw)', () => {
    expect(findDocsRecursive(path.join(root, 'nope'), ['.md'])).toEqual([]);
  });

  it('returns [] when nothing matches', () => {
    expect(findDocsRecursive(root, ['.pdf'])).toEqual([]);
  });
});
