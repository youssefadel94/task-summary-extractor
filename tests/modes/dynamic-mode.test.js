'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  planTopics,
  generateDynamicDocument,
  generateUnifiedDocument,
  generateAllDynamicDocuments,
  writeDynamicOutput,
  compiledToContext,
  compiledToVideoSummaries,
} = require('../../src/modes/dynamic-mode');
const { makeMockAI } = require('../helpers/mock-ai');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAN_JSON = JSON.stringify({
  topics: [
    { id: 'DM-01', title: 'Overview', category: 'overview', description: 'Intro', target_audience: 'All', estimated_length: 'short', depends_on: [] },
    { id: 'DM-02', title: 'Migration Plan', category: 'plan', description: 'Steps', target_audience: 'Eng', estimated_length: 'medium', depends_on: ['DM-01'] },
  ],
  project_summary: 'A two-doc set.',
});

function makeTopic(over = {}) {
  return {
    id: 'DM-01', title: 'Overview', category: 'overview',
    description: 'Intro', target_audience: 'All', estimated_length: 'short',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// planTopics
// ---------------------------------------------------------------------------

describe('planTopics', () => {
  it('parses topics + summary from plain JSON and returns token usage', async () => {
    const ai = makeMockAI([PLAN_JSON]);
    const res = await planTopics(ai, 'Plan a migration', ['[spec.md]\nsome context'], { folderName: 'proj' });

    expect(res.topics).toHaveLength(2);
    expect(res.topics[0].id).toBe('DM-01');
    expect(res.projectSummary).toBe('A two-doc set.');
    expect(res.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('parses topics wrapped in a ```json fence', async () => {
    const ai = makeMockAI(['```json\n' + PLAN_JSON + '\n```']);
    const res = await planTopics(ai, 'req', []);
    expect(res.topics).toHaveLength(2);
  });

  it('returns empty topics on unparseable output (no throw)', async () => {
    const ai = makeMockAI(['not json at all']);
    const res = await planTopics(ai, 'req', []);
    expect(res.topics).toEqual([]);
    expect(res.projectSummary).toBe('');
  });

  it('includes video + docs context in the prompt', async () => {
    const ai = makeMockAI([PLAN_JSON]);
    await planTopics(ai, 'req', ['[a.md]\nDoc A body'], {
      videoSummaries: [{ videoFile: 'call.mp4', segmentIndex: 0, totalSegments: 1, summary: 'Video summary text' }],
    });
    const prompt = ai._calls[0].contents[0].parts[0].text;
    expect(prompt).toContain('Doc A body');
    expect(prompt).toContain('Video summary text');
    expect(prompt).toContain('call.mp4');
  });
});

// ---------------------------------------------------------------------------
// generateDynamicDocument / generateUnifiedDocument — fence stripping
// ---------------------------------------------------------------------------

describe('generateDynamicDocument', () => {
  it('strips a ```markdown fence wrapper', async () => {
    const ai = makeMockAI(['```markdown\n# Title\n\nBody\n```']);
    const res = await generateDynamicDocument(ai, makeTopic(), 'req', []);
    expect(res.markdown).toBe('# Title\n\nBody');
    expect(res.markdown).not.toContain('```');
  });

  it('strips a bare ``` fence wrapper', async () => {
    const ai = makeMockAI(['```\n# Title\n```']);
    const res = await generateDynamicDocument(ai, makeTopic(), 'req', []);
    expect(res.markdown).toBe('# Title');
  });

  it('leaves un-fenced markdown intact', async () => {
    const ai = makeMockAI(['# Real Title\n\nContent here.']);
    const res = await generateDynamicDocument(ai, makeTopic(), 'req', []);
    expect(res.markdown).toBe('# Real Title\n\nContent here.');
  });
});

describe('generateUnifiedDocument', () => {
  it('produces one unified markdown doc with token usage', async () => {
    const ai = makeMockAI(['```md\n# Unified\n\nAll of it.\n```']);
    const res = await generateUnifiedDocument(ai, 'req', ['[x.md]\nctx'], { folderName: 'proj' });
    expect(res.markdown).toBe('# Unified\n\nAll of it.');
    expect(res.tokenUsage.totalTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generateAllDynamicDocuments — batching + partial failure
// ---------------------------------------------------------------------------

describe('generateAllDynamicDocuments', () => {
  it('generates all docs and reports progress', async () => {
    const topics = [makeTopic({ id: 'DM-01' }), makeTopic({ id: 'DM-02', title: 'Two' })];
    const ai = makeMockAI(['# Doc one', '# Doc two']);
    const progress = [];
    const docs = await generateAllDynamicDocuments(ai, topics, 'req', [], {
      concurrency: 2,
      onProgress: (done, total, topic) => progress.push({ done, total, id: topic.id }),
    });
    expect(docs).toHaveLength(2);
    expect(docs.every(d => d.markdown)).toBe(true);
    expect(progress).toHaveLength(2);
    expect(progress[progress.length - 1].done).toBe(2);
  });

  it('captures per-topic failures without aborting the batch', async () => {
    const topics = [makeTopic({ id: 'DM-01' }), makeTopic({ id: 'DM-02', title: 'Two' })];
    // First call succeeds, second rejects.
    let n = 0;
    const ai = makeMockAI(() => {
      n++;
      return n === 1 ? '# Good' : new Error('model exploded');
    });
    const docs = await generateAllDynamicDocuments(ai, topics, 'req', [], { concurrency: 1 });
    const ok = docs.filter(d => d.markdown);
    const bad = docs.filter(d => !d.markdown);
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].error).toContain('model exploded');
  });
});

// ---------------------------------------------------------------------------
// writeDynamicOutput
// ---------------------------------------------------------------------------

describe('writeDynamicOutput', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-dyn-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function docFor(topic, markdown, extra = {}) {
    return {
      topic,
      markdown,
      raw: markdown,
      durationMs: 100,
      tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, thoughtTokens: 5 },
      ...extra,
    };
  }

  it('writes INDEX.md, per-topic files, and dynamic-run.json with correct stats', () => {
    const documents = [
      docFor(makeTopic({ id: 'DM-01', title: 'Overview', category: 'overview' }), '# Overview\n\nBody'),
      docFor(makeTopic({ id: 'DM-02', title: 'Migration Plan', category: 'plan' }), '# Plan\n\nBody'),
    ];
    const { indexPath, stats } = writeDynamicOutput(dir, documents, {
      folderName: 'proj', userRequest: 'Plan it', projectSummary: 'summary', timestamp: '2026-07-21',
    });

    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dm-01-overview.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dm-02-migration-plan.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dynamic-run.json'))).toBe(true);

    expect(stats.total).toBe(2);
    expect(stats.successful).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.totalTokens).toBe(60);

    const index = fs.readFileSync(indexPath, 'utf8');
    expect(index).toContain('Overview');
    expect(index).toContain('Migration Plan');
    // category grouping labels
    expect(index).toContain('Plans & Strategy');

    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'dynamic-run.json'), 'utf8'));
    expect(meta.topicCount).toBe(2);
    expect(meta.topics).toHaveLength(2);
    expect(meta.topics[0].fileName).toBe('dm-01-overview.md');
  });

  it('lists failed documents in the index and counts them', () => {
    const documents = [
      docFor(makeTopic({ id: 'DM-01', title: 'Good' }), '# Good\n\nBody'),
      docFor(makeTopic({ id: 'DM-02', title: 'Broken' }), null, { error: 'timeout' }),
    ];
    const { stats } = writeDynamicOutput(dir, documents, { folderName: 'p', userRequest: 'r', timestamp: 't' });
    expect(stats.successful).toBe(1);
    expect(stats.failed).toBe(1);

    const index = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
    expect(index).toContain('failed to generate');
    expect(index).toContain('Broken');
    expect(index).toContain('timeout');
    // Failed doc must NOT have produced a file.
    expect(fs.existsSync(path.join(dir, 'dm-02-broken.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compiledToContext / compiledToVideoSummaries
// ---------------------------------------------------------------------------

describe('compiledToContext', () => {
  it('returns empty string for null/empty compiled analysis', () => {
    expect(compiledToContext(null)).toBe('');
    expect(compiledToContext({})).toBe('');
  });

  it('renders sections that are present and skips absent ones', () => {
    const compiled = {
      summary: 'Exec summary here',
      tickets: [{ ticket_id: 'T-1', title: 'Fix bug', status: 'open', assignee: 'Alice' }],
      action_items: [{ id: 'AI-1', description: 'Do the thing', assigned_to: 'Bob', status: 'todo' }],
    };
    const out = compiledToContext(compiled);
    expect(out).toContain('Exec summary here');
    expect(out).toContain('T-1');
    expect(out).toContain('Fix bug');
    expect(out).toContain('AI-1');
    expect(out).not.toContain('## Blockers');
  });
});

describe('compiledToVideoSummaries', () => {
  it('wraps compiled context into a single video-summary entry', () => {
    const vs = compiledToVideoSummaries({ summary: 'Hello' });
    expect(vs).toHaveLength(1);
    expect(vs[0].videoFile).toBe('Source Analysis');
    expect(vs[0].summary).toContain('Hello');
  });

  it('returns empty array when there is no content', () => {
    expect(compiledToVideoSummaries(null)).toEqual([]);
    expect(compiledToVideoSummaries({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeDynamicOutput — robustness against malformed topic metadata (regression)
// ---------------------------------------------------------------------------

describe('writeDynamicOutput — malformed topics do not lose documents', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-dyn2-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('fills fallback id/title when a topic is missing them (does not throw or drop docs)', () => {
    const documents = [
      { topic: { title: 'Has Title' }, markdown: '# One', durationMs: 1, tokenUsage: { totalTokens: 1 } },  // no id
      { topic: { id: 'DM-99' }, markdown: '# Two', durationMs: 1, tokenUsage: { totalTokens: 1 } },          // no title
      { topic: {}, markdown: '# Three', durationMs: 1, tokenUsage: { totalTokens: 1 } },                      // neither
    ];
    let result;
    expect(() => { result = writeDynamicOutput(dir, documents, { folderName: 'p', userRequest: 'r', timestamp: 't' }); }).not.toThrow();
    expect(result.stats.successful).toBe(3);
    // All three markdown files must have been written.
    const mdFiles = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
    expect(mdFiles).toHaveLength(3);
  });

  it('disambiguates colliding filenames', () => {
    const documents = [
      { topic: { id: 'DM-01', title: 'Same' }, markdown: '# a', durationMs: 1, tokenUsage: { totalTokens: 1 } },
      { topic: { id: 'DM-01', title: 'Same' }, markdown: '# b', durationMs: 1, tokenUsage: { totalTokens: 1 } },
    ];
    writeDynamicOutput(dir, documents, { folderName: 'p', userRequest: 'r', timestamp: 't' });
    const mdFiles = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
    expect(mdFiles).toHaveLength(2); // no overwrite
  });

  it('shows a real reason (not "undefined") for empty-output failures', () => {
    const documents = [
      { topic: { id: 'DM-01', title: 'Empty One' }, markdown: null, durationMs: 0, tokenUsage: { totalTokens: 0 } }, // no error field
    ];
    writeDynamicOutput(dir, documents, { folderName: 'p', userRequest: 'r', timestamp: 't' });
    const index = fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8');
    expect(index).toContain('Empty One');
    expect(index).not.toContain('Empty One: undefined');
  });
});
