'use strict';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-dummy-key';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadPrompt, buildDocBridgeText, prepareDocsForGemini, analyzeImageBatches, compileFinalResult,
} = require('../../src/services/gemini');
const { makeMockAI } = require('../helpers/mock-ai');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// loadPrompt
// ---------------------------------------------------------------------------

describe('loadPrompt', () => {
  it('loads and assembles prompt.json into systemInstruction + promptText', () => {
    const p = loadPrompt(PKG_ROOT);
    expect(typeof p.systemInstruction).toBe('string');
    expect(p.systemInstruction.length).toBeGreaterThan(0);
    expect(p.promptText).toContain('Task:');
    expect(p.promptText).toContain('valid JSON');
  });

  it('throws a clear error when prompt.json is missing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-noprompt-'));
    try {
      expect(() => loadPrompt(empty)).toThrow(/prompt\.json not found/);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// buildDocBridgeText
// ---------------------------------------------------------------------------

describe('buildDocBridgeText', () => {
  it('returns null for no docs', () => {
    expect(buildDocBridgeText([])).toBeNull();
  });

  it('describes the doc set and lists filenames', () => {
    const text = buildDocBridgeText([
      { type: 'inlineText', fileName: 'notes.md', content: 'hi' },
      { type: 'inlineText', fileName: '.tasks/execution-plan.md', content: '**Status**: In progress\n- [x] done\n- [ ] todo' },
    ]);
    expect(text).toContain('2 supporting document(s)');
    expect(text).toContain('execution-plan.md');
    // Pre-extracted checklist stats from the tier-1 execution plan.
    expect(text).toContain('1 done');
  });
});

// ---------------------------------------------------------------------------
// prepareDocsForGemini (offline paths only: inline text, image, unknown)
// ---------------------------------------------------------------------------

describe('prepareDocsForGemini (offline)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-prep-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function file(name, content) {
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, content);
    return { absPath: abs, relPath: name };
  }

  it('returns [] for an empty list', async () => {
    expect(await prepareDocsForGemini(null, [])).toEqual([]);
  });

  it('inlines text docs (.md, .json) and strips a BOM', async () => {
    const docs = await prepareDocsForGemini(null, [
      file('a.md', '﻿# Title\nbody'),
      file('b.json', '{"k":1}'),
    ]);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ type: 'inlineText', fileName: 'a.md' });
    expect(docs[0].content.startsWith('#')).toBe(true); // BOM stripped
    expect(docs[1].content).toContain('"k":1');
  });

  it('reads an image as inlineData base64', async () => {
    // 1x1 transparent PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const abs = path.join(dir, 'pic.png');
    fs.writeFileSync(abs, png);
    const docs = await prepareDocsForGemini(null, [{ absPath: abs, relPath: 'pic.png' }]);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ type: 'inlineData', fileName: 'pic.png', mimeType: 'image/png' });
    expect(typeof docs[0].data).toBe('string');
  });

  it('skips unknown extensions without throwing', async () => {
    const docs = await prepareDocsForGemini(null, [file('weird.xyz', 'data')]);
    expect(docs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeImageBatches (mock AI)
// ---------------------------------------------------------------------------

describe('analyzeImageBatches', () => {
  const img = (n) => ({ fileName: `img${n}.png`, mimeType: 'image/png', data: 'AAAA' });

  it('returns [] for no images', async () => {
    expect(await analyzeImageBatches(makeMockAI('x'), [])).toEqual([]);
  });

  it('batches images and returns a description per batch', async () => {
    const ai = makeMockAI(() => 'Description of the batch');
    const images = [img(1), img(2), img(3)];
    const results = await analyzeImageBatches(ai, images, { batchSize: 2 });
    // 3 images, batchSize 2 → 2 batches.
    expect(results).toHaveLength(2);
    expect(results[0].description).toContain('Description');
    expect(results[0].images).toEqual(['img1.png', 'img2.png']);
    expect(results[1].images).toEqual(['img3.png']);
  });
});

// ---------------------------------------------------------------------------
// compileFinalResult (doc-only, mock AI) — core compilation used by both flows
// ---------------------------------------------------------------------------

describe('compileFinalResult (mock AI)', () => {
  const ANALYSIS = JSON.stringify({
    summary: 'Compiled summary.',
    tickets: [{ ticket_id: 'T-1', title: 'A', status: 'open' }],
    action_items: [], change_requests: [], blockers: [], scope_changes: [],
  });

  it('parses a valid compiled analysis and reports success + token usage', async () => {
    const ai = makeMockAI([ANALYSIS]);
    const res = await compileFinalResult(ai, [], 'Youssef', 'call', PKG_ROOT, {
      contextDocs: [{ type: 'inlineText', fileName: 'notes.md', content: 'notes' }],
      docOnlyMode: true,
    });
    expect(res.compiled).toBeTruthy();
    expect(res.compiled.tickets[0].ticket_id).toBe('T-1');
    expect(res.run.parseSuccess).toBe(true);
    expect(res.run.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(res.run.type).toBe('compilation');
  });

  it('reports parseSuccess=false when the model returns unparseable text', async () => {
    const ai = makeMockAI(['not json at all']);
    const res = await compileFinalResult(ai, [], 'Y', 'call', PKG_ROOT, { docOnlyMode: true });
    expect(res.compiled).toBeNull();
    expect(res.run.parseSuccess).toBe(false);
  });

  it('sends the context documents in the request payload (doc-only mode)', async () => {
    const ai = makeMockAI([ANALYSIS]);
    await compileFinalResult(ai, [], 'Y', 'call', PKG_ROOT, {
      contextDocs: [{ type: 'inlineText', fileName: 'spec.md', content: 'UNIQUE_DOC_MARKER body' }],
      docOnlyMode: true,
    });
    const parts = ai._calls[0].contents[0].parts;
    const joined = parts.map(p => p.text || '').join('\n');
    expect(joined).toContain('UNIQUE_DOC_MARKER');
  });
});
