'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runDynamicTopics, mergeSegmentAnalysesForDynamic } = require('../src/pipeline');
const { setLog } = require('../src/phases/_shared');
const { makeMockAI } = require('./helpers/mock-ai');

// runDynamicTopics calls getLog().step/warn/error — install a no-op logger.
const stubLog = { step() {}, warn() {}, error() {}, info() {}, close() {} };

const PLAN_JSON = JSON.stringify({
  topics: [
    { id: 'DM-01', title: 'Overview', category: 'overview', description: 'Intro', estimated_length: 'short' },
    { id: 'DM-02', title: 'Details', category: 'reference', description: 'Ref', estimated_length: 'short' },
  ],
  project_summary: 'Two docs.',
});

// Route mock responses by inspecting the outgoing prompt so call ordering is irrelevant.
function router(payload) {
  const text = payload?.contents?.[0]?.parts?.map(p => p.text || '').join(' ') || '';
  if (text.includes('analyzing a batch of')) return '## shot.png\nA screenshot of a login form.';
  if (text.includes('"topics"') || text.includes('knowledge architect')) return PLAN_JSON;
  return '# Generated Document\n\nSome body content.';
}

function baseOpts(over = {}) {
  return {
    request: 'Explain the project',
    dynamicOutputMode: 'topics',
    skipUpload: true,
    thinkingBudget: 8192,
    parallelAnalysis: 2,
    ...over,
  };
}

function makeCtx(over = {}) {
  return {
    opts: baseOpts(over.opts),
    targetDir: over.targetDir,
    ai: over.ai || makeMockAI(router),
    costTracker: { addSegment() {} },
    callName: 'testproj',
    userName: 'Tester',
    contextDocs: over.contextDocs || [{ type: 'inlineText', fileName: 'notes.md', content: 'Some notes.' }],
    imageDescriptions: over.imageDescriptions,
  };
}

describe('runDynamicTopics (pipeline integration, mocked AI)', () => {
  let dir;
  beforeEach(() => {
    setLog(stubLog);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-pipe-'));
  });
  afterEach(() => {
    setLog(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('topics mode: writes INDEX.md and per-topic docs into <runDir>/dynamic', async () => {
    const compiled = { summary: 'Project summary', tickets: [{ ticket_id: 'T-1', title: 'Do it' }] };
    await runDynamicTopics(makeCtx({ targetDir: dir }), compiled, dir);

    const dynDir = path.join(dir, 'dynamic');
    expect(fs.existsSync(path.join(dynDir, 'INDEX.md'))).toBe(true);
    expect(fs.existsSync(path.join(dynDir, 'dynamic-run.json'))).toBe(true);
    const files = fs.readdirSync(dynDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
    expect(files.length).toBe(2);
  });

  it('unified mode: writes a single unified-output.md', async () => {
    const compiled = { summary: 'Project summary' };
    await runDynamicTopics(makeCtx({ targetDir: dir, opts: baseOpts({ dynamicOutputMode: 'unified' }) }), compiled, dir);

    const unified = path.join(dir, 'dynamic', 'unified-output.md');
    expect(fs.existsSync(unified)).toBe(true);
    expect(fs.readFileSync(unified, 'utf8')).toContain('# Generated Document');
  });

  it('empty request: skips generation, writes nothing', async () => {
    const compiled = { summary: 'x' };
    await runDynamicTopics(makeCtx({ targetDir: dir, opts: baseOpts({ request: '   ' }) }), compiled, dir);
    expect(fs.existsSync(path.join(dir, 'dynamic'))).toBe(false);
  });

  it('image-only context: runs on-the-fly image analysis without a ReferenceError (TDZ regression)', async () => {
    // This is the exact path that used to throw "Cannot access thinkingBudget
    // before initialization". contextDocs has an inlineData image and there are
    // no pre-analyzed descriptions.
    const ctx = makeCtx({
      targetDir: dir,
      contextDocs: [{ type: 'inlineData', fileName: 'shot.png', mimeType: 'image/png', data: 'AAAA' }],
      imageDescriptions: [],
    });
    const compiled = { summary: 'has images' };
    await expect(runDynamicTopics(ctx, compiled, dir)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'dynamic', 'INDEX.md'))).toBe(true);
  });

  it('does not duplicate combined image analysis into docSnippets', async () => {
    // contextDocs contains the synthesized _image_analysis_combined.md AND we also
    // pass imageDescriptions — the planTopics prompt must contain the image text once.
    const ai = makeMockAI(router);
    const ctx = makeCtx({
      targetDir: dir,
      ai,
      contextDocs: [{ type: 'inlineText', fileName: '_image_analysis_combined.md', content: 'UNIQUE_IMAGE_MARKER content' }],
      imageDescriptions: [{ images: ['a.png'], description: 'UNIQUE_IMAGE_MARKER content' }],
    });
    await runDynamicTopics(ctx, { summary: 's' }, dir);

    const planCall = ai._calls.find(p => {
      const t = p?.contents?.[0]?.parts?.map(x => x.text || '').join(' ') || '';
      return t.includes('"topics"') || t.includes('knowledge architect');
    });
    const planText = planCall.contents[0].parts[0].text;
    const occurrences = planText.split('UNIQUE_IMAGE_MARKER').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('mergeSegmentAnalysesForDynamic', () => {
  it('returns null for empty input', () => {
    expect(mergeSegmentAnalysesForDynamic([])).toBeNull();
    expect(mergeSegmentAnalysesForDynamic(null)).toBeNull();
  });

  it('dedups tickets by ticket_id and merges summaries', () => {
    const merged = mergeSegmentAnalysesForDynamic([
      { tickets: [{ ticket_id: 'T-1', title: 'A' }], summary: 'first' },
      { tickets: [{ ticket_id: 'T-1', title: 'A dup' }, { ticket_id: 'T-2', title: 'B' }], summary: 'second' },
    ]);
    expect(merged.tickets).toHaveLength(2);
    expect(merged.tickets.map(t => t.ticket_id).sort()).toEqual(['T-1', 'T-2']);
    expect(merged.summary).toContain('first');
    expect(merged.summary).toContain('second');
    expect(merged._segmentMergeFallback).toBe(true);
  });

  it('merges your_tasks arrays instead of overwriting', () => {
    const merged = mergeSegmentAnalysesForDynamic([
      { your_tasks: { tasks_todo: [{ description: 'a' }] } },
      { your_tasks: { tasks_todo: [{ description: 'b' }] } },
    ]);
    expect(merged.your_tasks.tasks_todo).toHaveLength(2);
  });
});
