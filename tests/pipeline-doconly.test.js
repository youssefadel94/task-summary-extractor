'use strict';

// Ensure a non-empty API key so initGemini can construct the client (no network
// is used — compileFinalResult is stubbed and only inline-text docs are loaded).
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-dummy-key';

const fs = require('fs');
const os = require('os');
const path = require('path');

const pipeline = require('../src/pipeline');
const gemini = require('../src/services/gemini');
const { setLog } = require('../src/phases/_shared');
const CostTracker = require('../src/utils/cost-tracker');
const Progress = require('../src/utils/checkpoint');

const stubLog = {
  step() {}, warn() {}, error() {}, info() {}, close() {},
  phaseStart() {}, phaseEnd() {}, elapsed() { return '0s'; }, patchConsole() {},
};

// Canned compiled analysis returned by the stubbed compilation call.
const COMPILED = {
  summary: 'Doc-only integration test summary.',
  tickets: [{ ticket_id: 'T-1', title: 'Do the thing', status: 'open', confidence: 'HIGH' }],
  action_items: [{ id: 'AI-1', description: 'Follow up', assigned_to: 'Youssef', status: 'todo', confidence: 'MEDIUM' }],
  your_tasks: { tasks_todo: [{ description: 'Review the doc' }], completed_in_call: [] },
};

describe('runDocOnly (offline integration, stubbed compilation)', () => {
  let targetDir, outDir, origCompile, callName;

  beforeEach(() => {
    setLog(stubLog);
    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-doconly-'));
    outDir = path.join(targetDir, 'out');
    callName = path.basename(targetDir);
    fs.writeFileSync(path.join(targetDir, 'notes.md'), '# Notes\n\nSome meeting notes about the project.');

    // Stub the (lazily-required) compilation call — no Gemini network traffic.
    origCompile = gemini.compileFinalResult;
    gemini.compileFinalResult = async () => ({
      compiled: JSON.parse(JSON.stringify(COMPILED)),
      run: { model: 'gemini-3-flash-preview', durationMs: 100, tokenUsage: { inputTokens: 100, outputTokens: 50, thoughtTokens: 10, totalTokens: 160 }, parseSuccess: true, timestamp: '2026-07-21T00:00:00Z' },
      raw: JSON.stringify(COMPILED),
    });
  });

  afterEach(() => {
    gemini.compileFinalResult = origCompile;
    setLog(null);
    fs.rmSync(targetDir, { recursive: true, force: true });
    // runDocOnly also writes a compilation copy under <cwd>/gemini_runs/<callName>.
    fs.rmSync(path.join(process.cwd(), 'gemini_runs', callName), { recursive: true, force: true });
  });

  function makeCtx() {
    return {
      opts: {
        skipUpload: true, skipGemini: false, dryRun: false,
        disableLearning: true, disableProgress: true,
        dynamic: false, deepDive: false, deepSummary: false,
        deepSummaryExclude: [],
        formats: new Set(['md', 'json']), format: 'md,json',
        thinkingBudget: 8192, compilationThinkingBudget: 8192,
        outputDir: outDir,
      },
      targetDir,
      allDocFiles: [{ absPath: path.join(targetDir, 'notes.md'), relPath: 'notes.md' }],
      imageFiles: [],
      userName: 'Youssef',
      progress: new Progress(targetDir),
      costTracker: new CostTracker(),
    };
  }

  it('runs the doc-only pipeline end-to-end and writes results', async () => {
    await pipeline.runDocOnly(makeCtx());

    // Output files written to the configured output dir.
    expect(fs.existsSync(path.join(outDir, 'results.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'results.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'compilation.json'))).toBe(true);

    const results = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'));
    expect(results.inputMode).toBe('document');
    expect(results.callName).toBe(callName);
    // Reaching here at all proves printHealthDashboard ran without crashing on the
    // { valid: true } compilation sentinel (the doc-only dashboard crash we fixed).

    const md = fs.readFileSync(path.join(outDir, 'results.md'), 'utf8');
    expect(md).toContain('Do the thing');     // ticket rendered
    expect(md).toContain('Follow up');        // action item rendered
  });

  it('honors the format set (no html when not requested)', async () => {
    await pipeline.runDocOnly(makeCtx());
    expect(fs.existsSync(path.join(outDir, 'results.html'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'results.md'))).toBe(true);
  });
});
