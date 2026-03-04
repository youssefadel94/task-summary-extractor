/**
 * Tests for change-detector.js — item extraction, keyword extraction,
 * document change detection, correlation engine.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  extractTrackableItems,
  extractKeywords,
  detectDocumentChanges,
  correlateItemsWithChanges,
  serializeReport,
} = require('../../src/modes/change-detector');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cd-test-'));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── extractTrackableItems ───────────────────────────────────────────────────

describe('extractTrackableItems', () => {
  it('returns empty array for null analysis', () => {
    expect(extractTrackableItems(null)).toEqual([]);
  });

  it('returns empty array for empty analysis', () => {
    expect(extractTrackableItems({})).toEqual([]);
  });

  it('extracts tickets', () => {
    const analysis = {
      tickets: [
        { ticket_id: 'T1', title: 'Fix bug', status: 'open' },
        { ticket_id: 'T2', title: 'Add feature' },
      ],
    };
    const items = extractTrackableItems(analysis);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('T1');
    expect(items[0].type).toBe('ticket');
    expect(items[1].id).toBe('T2');
  });

  it('extracts change requests', () => {
    const analysis = {
      change_requests: [
        { id: 'CR1', title: 'Refactor module', what: 'Split into microservices' },
      ],
    };
    const items = extractTrackableItems(analysis);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('change_request');
  });

  it('extracts action items', () => {
    const items = extractTrackableItems({
      action_items: [{ id: 'AI1', description: 'Write tests' }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('action_item');
    expect(items[0].title).toBe('Write tests');
  });

  it('extracts blockers', () => {
    const items = extractTrackableItems({
      blockers: [{ id: 'B1', description: 'Waiting for infra' }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('blocker');
  });

  it('extracts scope changes', () => {
    const items = extractTrackableItems({
      scope_changes: [{ id: 'SC1', original_scope: 'A', new_scope: 'B' }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('scope_change');
  });

  it('extracts all types from a complete analysis', () => {
    const analysis = {
      tickets: [{ ticket_id: 'T1', title: 'X' }],
      change_requests: [{ id: 'CR1', title: 'Y' }],
      action_items: [{ id: 'AI1', description: 'Z' }],
      blockers: [{ id: 'B1', description: 'W' }],
      scope_changes: [{ id: 'SC1', new_scope: 'V' }],
    };
    const items = extractTrackableItems(analysis);
    expect(items).toHaveLength(5);
    const types = items.map(i => i.type);
    expect(types).toContain('ticket');
    expect(types).toContain('change_request');
    expect(types).toContain('action_item');
    expect(types).toContain('blocker');
    expect(types).toContain('scope_change');
  });

  it('attaches file references from code_changes', () => {
    const analysis = {
      tickets: [{
        ticket_id: 'T1',
        title: 'Fix',
        code_changes: [{ file_path: 'src/app.js' }],
      }],
    };
    const items = extractTrackableItems(analysis);
    expect(items[0].fileRefs).toContain('src/app.js');
  });
});

// ─── extractKeywords ─────────────────────────────────────────────────────────

describe('extractKeywords', () => {
  it('returns empty for null/empty text', () => {
    expect(extractKeywords(null)).toEqual([]);
    expect(extractKeywords('')).toEqual([]);
  });

  it('filters stop words', () => {
    const kw = extractKeywords('the quick brown fox is running');
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('is');
    expect(kw).toContain('quick');
    expect(kw).toContain('brown');
    expect(kw).toContain('running');
  });

  it('removes very short words (<=2 chars)', () => {
    const kw = extractKeywords('a b cd efg');
    expect(kw).not.toContain('a');
    expect(kw).not.toContain('b');
    expect(kw).not.toContain('cd');
    expect(kw).toContain('efg');
  });

  it('deduplicates keywords', () => {
    const kw = extractKeywords('login login login handler');
    expect(kw.filter(k => k === 'login')).toHaveLength(1);
  });
});

// ─── detectDocumentChanges ───────────────────────────────────────────────────

describe('detectDocumentChanges', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => cleanup(tmpDir));

  it('returns empty for invalid timestamp', () => {
    expect(detectDocumentChanges(tmpDir, 'invalid')).toEqual([]);
  });

  it('detects recently modified doc files', () => {
    const docFile = path.join(tmpDir, 'notes.md');
    fs.writeFileSync(docFile, 'hello');
    // File was just created, so it's newer than any past timestamp
    const changes = detectDocumentChanges(tmpDir, '2020-01-01T00:00:00Z');
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0].relPath).toBe('notes.md');
  });

  it('ignores files older than sinceISO', () => {
    const futureISO = new Date(Date.now() + 100000).toISOString();
    const docFile = path.join(tmpDir, 'old.txt');
    fs.writeFileSync(docFile, 'old');
    const changes = detectDocumentChanges(tmpDir, futureISO);
    expect(changes).toEqual([]);
  });

  it('skips non-doc extensions', () => {
    fs.writeFileSync(path.join(tmpDir, 'binary.exe'), 'data');
    const changes = detectDocumentChanges(tmpDir, '2020-01-01T00:00:00Z');
    expect(changes).toEqual([]);
  });

  it('skips infrastructure directories', () => {
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, 'config.json'), '{}');
    const changes = detectDocumentChanges(tmpDir, '2020-01-01T00:00:00Z');
    expect(changes).toEqual([]);
  });
});

// ─── correlateItemsWithChanges ───────────────────────────────────────────────

describe('correlateItemsWithChanges', () => {
  it('returns empty map for empty items', () => {
    const result = correlateItemsWithChanges([], { commits: [], changedFiles: [], workingChanges: [] });
    expect(result.size).toBe(0);
  });

  it('matches item by file path', () => {
    const items = [{
      id: 'T1', type: 'ticket', title: 'Fix', description: '',
      keywords: [], fileRefs: ['src/app.js'],
    }];
    const gitData = {
      commits: [],
      changedFiles: [{ path: 'src/app.js', status: 'M', changes: 3 }],
      workingChanges: [],
    };
    const corr = correlateItemsWithChanges(items, gitData);
    expect(corr.get('T1').score).toBeGreaterThan(0);
    expect(corr.get('T1').evidence.some(e => e.type === 'file_match')).toBe(true);
  });

  it('matches item ID in commit message', () => {
    const items = [{
      id: 'CR-123', type: 'change_request', title: 'Update',
      description: '', keywords: [], fileRefs: [],
    }];
    const gitData = {
      commits: [{ hash: 'abc', message: 'Fix CR-123: refactor', date: '2026-03-01', files: [] }],
      changedFiles: [],
      workingChanges: [],
    };
    const corr = correlateItemsWithChanges(items, gitData);
    expect(corr.get('CR-123').score).toBeGreaterThan(0);
    expect(corr.get('CR-123').evidence.some(e => e.type === 'id_in_commit')).toBe(true);
  });

  it('matches keywords in commit messages', () => {
    const items = [{
      id: 'AI1', type: 'action_item', title: 'Implement authentication',
      description: '', keywords: ['authentication', 'implement', 'login'],
      fileRefs: [],
    }];
    const gitData = {
      commits: [{ hash: 'def', message: 'implement authentication module', date: '2026-03-01', files: [] }],
      changedFiles: [],
      workingChanges: [],
    };
    const corr = correlateItemsWithChanges(items, gitData);
    expect(corr.get('AI1').score).toBeGreaterThan(0);
  });

  it('clamps score to max 1.0', () => {
    const items = [{
      id: 'T1', type: 'ticket', title: 'Big change', description: '',
      keywords: ['refactor', 'migration', 'service', 'deploy'],
      fileRefs: ['src/a.js', 'src/b.js', 'src/c.js'],
    }];
    const gitData = {
      commits: [
        { hash: 'a', message: 'T1 refactor migration service', date: '2026-03-01', files: ['src/a.js', 'src/b.js', 'src/c.js'] },
        { hash: 'b', message: 'T1 deploy service migration', date: '2026-03-01', files: ['src/a.js'] },
      ],
      changedFiles: [
        { path: 'src/a.js', status: 'M', changes: 10 },
        { path: 'src/b.js', status: 'M', changes: 5 },
        { path: 'src/c.js', status: 'A', changes: 20 },
      ],
      workingChanges: [],
    };
    const corr = correlateItemsWithChanges(items, gitData);
    expect(corr.get('T1').score).toBeLessThanOrEqual(1.0);
  });

  it('assigns NOT_STARTED for zero-score items', () => {
    const items = [{
      id: 'B1', type: 'blocker', title: 'Unrelated',
      description: '', keywords: ['zzzzz'], fileRefs: [],
    }];
    const gitData = {
      commits: [{ hash: 'x', message: 'fix something else', date: '2026-03-01', files: [] }],
      changedFiles: [],
      workingChanges: [],
    };
    const corr = correlateItemsWithChanges(items, gitData);
    expect(corr.get('B1').localAssessment).toBe('NOT_STARTED');
  });
});

// ─── serializeReport ──────────────────────────────────────────────────────────────────

describe('serializeReport', () => {
  it('converts Map correlations to a plain object', () => {
    const report = {
      items: [{ id: 'T1', type: 'ticket' }],
      correlations: new Map([['T1', { score: 0.5, evidence: [] }]]),
      totals: { commits: 1, filesChanged: 2, docsChanged: 0, itemsWithMatches: 1 },
    };
    const serialized = serializeReport(report);
    expect(serialized.correlations).toEqual({ T1: { score: 0.5, evidence: [] } });
    expect(serialized.items).toEqual(report.items);
    expect(serialized.totals).toEqual(report.totals);
  });

  it('handles empty correlations Map', () => {
    const report = {
      items: [],
      correlations: new Map(),
      totals: { commits: 0 },
    };
    const serialized = serializeReport(report);
    expect(serialized.correlations).toEqual({});
  });
});
