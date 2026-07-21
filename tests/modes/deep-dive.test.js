'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  discoverTopics, generateDocument, generateAllDocuments,
  writeDeepDiveOutput, extractRelevantItems,
} = require('../../src/modes/deep-dive');
const { makeMockAI } = require('../helpers/mock-ai');

const TOPICS_JSON = JSON.stringify({
  topics: [
    { id: 'DD-01', title: 'OAuth Architecture', category: 'concept', description: 'How auth works', source_items: ['T-1'] },
    { id: 'DD-02', title: 'Migration Decision', category: 'decision', description: 'Why we chose X', source_items: [] },
  ],
});

const COMPILED = {
  summary: 'A meeting about auth.',
  tickets: [{ ticket_id: 'T-1', title: 'Add OAuth', status: 'open' }, { ticket_id: 'T-2', title: 'Other', status: 'done' }],
  action_items: [{ id: 'AI-3', description: 'Wire up PKCE' }],
};

describe('discoverTopics', () => {
  it('parses topics from model JSON with token usage', async () => {
    const ai = makeMockAI([TOPICS_JSON]);
    const res = await discoverTopics(ai, COMPILED, { callName: 'call' });
    expect(res.topics).toHaveLength(2);
    expect(res.topics[0].id).toBe('DD-01');
    expect(res.tokenUsage.totalTokens).toBeGreaterThan(0);
  });

  it('returns [] on unparseable output', async () => {
    const ai = makeMockAI(['garbage']);
    const res = await discoverTopics(ai, COMPILED);
    expect(res.topics).toEqual([]);
  });
});

describe('generateDocument', () => {
  it('strips markdown fences from the generated doc', async () => {
    const ai = makeMockAI(['```markdown\n# Doc\n\nBody\n```']);
    const topic = { id: 'DD-01', title: 'X', category: 'concept', description: 'y', source_items: [] };
    const res = await generateDocument(ai, topic, COMPILED);
    expect(res.markdown).toBe('# Doc\n\nBody');
  });
});

describe('generateAllDocuments', () => {
  it('handles partial failures without aborting', async () => {
    const topics = [
      { id: 'DD-01', title: 'A', category: 'concept', description: 'a' },
      { id: 'DD-02', title: 'B', category: 'decision', description: 'b' },
    ];
    let n = 0;
    const ai = makeMockAI(() => { n++; return n === 1 ? '# Good' : new Error('boom'); });
    const docs = await generateAllDocuments(ai, topics, COMPILED, { concurrency: 1 });
    expect(docs.filter(d => d.markdown)).toHaveLength(1);
    expect(docs.filter(d => !d.markdown)).toHaveLength(1);
  });
});

describe('extractRelevantItems', () => {
  it('returns the full analysis when no source items given', () => {
    expect(extractRelevantItems(COMPILED, [])).toBe(COMPILED);
  });

  it('filters tickets to matching ids (case-insensitive)', () => {
    const rel = extractRelevantItems(COMPILED, ['t-1']);
    expect(rel.tickets).toHaveLength(1);
    expect(rel.tickets[0].ticket_id).toBe('T-1');
  });
});

describe('writeDeepDiveOutput', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-dd-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function docFor(topic, markdown) {
    return { topic, markdown, durationMs: 10, tokenUsage: { totalTokens: 5 } };
  }

  it('writes INDEX.md, per-topic docs, and deep-dive.json', () => {
    const documents = [
      docFor({ id: 'DD-01', title: 'OAuth Architecture', category: 'concept', description: 'x' }, '# OAuth'),
      docFor({ id: 'DD-02', title: 'Migration Decision', category: 'decision', description: 'y' }, '# Decision'),
    ];
    const { indexPath, stats } = writeDeepDiveOutput(dir, documents, { callName: 'call', timestamp: 't' });
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dd-01-oauth-architecture.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'deep-dive.json'))).toBe(true);
    expect(stats.successful).toBe(2);
    const index = fs.readFileSync(indexPath, 'utf8');
    expect(index).toContain('Concepts & Architecture');
  });

  it('does not throw or lose docs when a topic lacks id/title (regression)', () => {
    const documents = [
      docFor({ title: 'Only title' }, '# One'),
      docFor({}, '# Two'),
    ];
    let res;
    expect(() => { res = writeDeepDiveOutput(dir, documents, { callName: 'c' }); }).not.toThrow();
    expect(res.stats.successful).toBe(2);
    const mdFiles = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
    expect(mdFiles).toHaveLength(2);
  });
});
