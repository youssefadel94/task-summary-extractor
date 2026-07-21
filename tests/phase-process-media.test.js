'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const phaseProcessVideo = require('../src/phases/process-media');
const video = require('../src/services/video');
const { setLog } = require('../src/phases/_shared');
const CostTracker = require('../src/utils/cost-tracker');
const Progress = require('../src/utils/checkpoint');
const { makeMockAI } = require('./helpers/mock-ai');

// Mock AI that also stubs the File API used to upload the video segment, so the
// REAL processWithGemini runs end-to-end (upload → generateContent → parse).
function makeVideoMockAI(responder) {
  const ai = makeMockAI(responder);
  ai.files = {
    upload: async () => ({ name: 'files/mock-seg', uri: 'https://gen/files/mock-seg', mimeType: 'video/mp4', state: 'ACTIVE' }),
    get: async () => ({ name: 'files/mock-seg', state: 'ACTIVE' }),
    delete: async () => ({}),
  };
  return ai;
}

const SEGMENT_ANALYSIS = JSON.stringify(require('./fixtures/sample-analysis.json'));

let ffmpegOk = true;
try { video.getFFmpeg(); video.getFFprobe(); } catch { ffmpegOk = false; }
const d = ffmpegOk ? describe : describe.skip;

// No-op logger: any method call returns '' (works for void calls and string interp).
const stubLog = new Proxy({}, { get: () => () => '' });

function makeClip(dir, name = 'meeting.mp4', durationSec = 2) {
  const out = path.join(dir, name);
  const r = spawnSync(video.getFFmpeg(), [
    '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${durationSec}:size=320x240:rate=10`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
    // Keyframe every ~1s so stream-copy splitting can produce multiple segments.
    '-c:v', 'libx264', '-g', '10', '-keyint_min', '10', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', out,
  ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error('fixture gen failed');
  return out;
}

function makeCtx(targetDir, videoPath, overrides = {}) {
  return {
    opts: {
      skipGemini: true, skipUpload: true, dryRun: false, noBatch: false,
      noCompress: false, thinkingBudget: 8192,
      ...overrides,
    },
    callName: path.basename(targetDir),
    storage: null, firebaseReady: false, ai: null, contextDocs: [],
    progress: new Progress(targetDir), costTracker: new CostTracker(),
    userName: 'Youssef', targetDir,
    inputMode: 'video', videoFiles: [videoPath], audioFiles: [],
  };
}

d('phaseProcessVideo (real ffmpeg, skipGemini)', () => {
  let dir, clip;
  beforeAll(() => {
    setLog(stubLog);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-pm-'));
    clip = makeClip(dir);
  }, 60000);
  afterAll(() => { setLog(null); fs.rmSync(dir, { recursive: true, force: true }); });

  it('compresses, segments, and assembles a fileResult (AI skipped)', async () => {
    const ctx = makeCtx(dir, clip);
    const { fileResult, segmentAnalyses } = await phaseProcessVideo(ctx, clip, 0);

    expect(fileResult).toBeTruthy();
    expect(Array.isArray(fileResult.segments)).toBe(true);
    expect(fileResult.segments.length).toBeGreaterThanOrEqual(1);
    // skipGemini → no analyses produced, segments carry null analysis.
    expect(segmentAnalyses).toEqual([]);
    expect(fileResult.segments[0].analysis).toBeNull();
    expect(fileResult.segments[0]).toHaveProperty('segmentIndex', 0);

    // A compressed segment file was actually produced and is a valid MP4.
    const segDir = path.join(dir, 'compressed', 'meeting');
    const segFiles = fs.readdirSync(segDir).filter(f => f.startsWith('segment_') && f.endsWith('.mp4'));
    expect(segFiles.length).toBeGreaterThanOrEqual(1);
    expect(video.verifySegment(path.join(segDir, segFiles[0]))).toBe(true);

    // Progress checkpoint recorded the compression.
    expect(ctx.progress.isCompressed(path.basename(clip, '.mp4'))).toBe(true);
  }, 120000);

  it('runs the full AI analysis loop with a mock Gemini (real processWithGemini)', async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-pm3-'));
    const callName = path.basename(dir3);
    try {
      const clip3 = makeClip(dir3);
      const ctx = makeCtx(dir3, clip3, {
        skipGemini: false, skipUpload: true, disableFocusedPass: true,
        noStorageUrl: true, noBatch: true,
      });
      ctx.ai = makeVideoMockAI(() => SEGMENT_ANALYSIS);

      const { fileResult, segmentAnalyses, segmentReports } = await phaseProcessVideo(ctx, clip3, 0);

      // One segment analyzed; the fixture's tickets survived parsing/normalization.
      expect(segmentAnalyses.length).toBe(1);
      expect(segmentAnalyses[0].tickets.length).toBeGreaterThan(0);
      expect(fileResult.segments[0].analysis).toBeTruthy();
      expect(segmentReports.length).toBe(1);
      expect(segmentReports[0].qualityReport).toBeTruthy();
      // Cost was tracked from the mock token usage.
      expect(ctx.costTracker.getSummary().totalTokens).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir3, { recursive: true, force: true });
      fs.rmSync(path.join(process.cwd(), 'gemini_runs', callName), { recursive: true, force: true });
    }
  }, 120000);

  it('low-quality response triggers quality-gate retry + focused re-analysis', async () => {
    const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-pmf-'));
    const callName = path.basename(fdir);
    try {
      const clipf = makeClip(fdir, 'meeting.mp4', 2);
      // A "weak but not sparse" analysis (4 bare tickets, no actions/blockers/
      // scopes) scores <60 with ≥2 weak areas → identifyWeaknesses.shouldReanalyze
      // is true → the runFocusedPass integration fires. The focused follow-up
      // returns the rich fixture, which mergeFocusedResults folds back in.
      const WEAK = JSON.stringify({
        summary: 'Sparse.', tickets: [1, 2, 3, 4].map(i => ({ ticket_id: 'T' + i, status: 'open' })),
        action_items: [], change_requests: [], blockers: [], scope_changes: [],
        file_references: [], your_tasks: {},
      });
      let n = 0;
      const ctx = makeCtx(fdir, clipf, {
        skipGemini: false, skipUpload: true, noBatch: true,
        disableFocusedPass: false, noStorageUrl: true,
      });
      ctx.ai = makeVideoMockAI(() => { n++; return n === 1 ? WEAK : SEGMENT_ANALYSIS; });

      // Must complete without crashing through the focused-pass branch.
      const { fileResult, segmentAnalyses } = await phaseProcessVideo(ctx, clipf, 0);
      expect(fileResult.segments.length).toBe(1);
      expect(segmentAnalyses.length).toBe(1);
      // The focused pass fired → a second AI call was made and merged in.
      expect(ctx.ai.callCount).toBeGreaterThan(1);
    } finally {
      fs.rmSync(fdir, { recursive: true, force: true });
      fs.rmSync(path.join(process.cwd(), 'gemini_runs', callName), { recursive: true, force: true });
    }
  }, 120000);

  it('multi-segment batching path runs processSegmentBatch for real', async () => {
    const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-pmb-'));
    const callName = path.basename(bdir);
    try {
      const longClip = makeClip(bdir, 'meeting.mp4', 6);
      // Pre-split into the segment dir phaseProcessVideo reuses, so it skips
      // compression and sees >1 segment → the batching path runs. (noCompress
      // ignores segmentTime and short clips don't re-encode into multiple parts.)
      const segDir = path.join(bdir, 'compressed', 'meeting');
      const pre = video.splitOnly(longClip, segDir, { segTime: 2 });
      expect(pre.length).toBeGreaterThan(1); // fixture sanity

      const ctx = makeCtx(bdir, longClip, {
        skipGemini: false, skipUpload: true, noBatch: false,
        disableFocusedPass: true, noStorageUrl: true,
      });
      ctx.ai = makeVideoMockAI(() => SEGMENT_ANALYSIS);

      const { fileResult, segmentAnalyses } = await phaseProcessVideo(ctx, longClip, 0);

      // Multiple segments → the batching path (processSegmentBatch) ran. A batch
      // yields ONE merged analysis covering its segments, so segmentAnalyses holds
      // one entry per batch (≥1), fileResult.segments one entry per segment (>1).
      expect(fileResult.segments.length).toBeGreaterThan(1);
      expect(segmentAnalyses.length).toBeGreaterThanOrEqual(1);
      for (const a of segmentAnalyses) expect(a.tickets.length).toBeGreaterThan(0);
      for (const s of fileResult.segments) expect(s.analysis).toBeTruthy();
    } finally {
      fs.rmSync(bdir, { recursive: true, force: true });
      fs.rmSync(path.join(process.cwd(), 'gemini_runs', callName), { recursive: true, force: true });
    }
  }, 120000);

  it('raw mode (--no-compress) stream-copies without re-encoding', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-pm2-'));
    try {
      const clip2 = makeClip(dir2);
      const ctx = makeCtx(dir2, clip2, { noCompress: true });
      const { fileResult } = await phaseProcessVideo(ctx, clip2, 0);
      expect(fileResult.segments.length).toBeGreaterThanOrEqual(1);
      const segDir = path.join(dir2, 'compressed', 'meeting');
      const segFiles = fs.readdirSync(segDir).filter(f => f.startsWith('segment_'));
      expect(segFiles.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }, 120000);
});
