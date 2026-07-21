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

let ffmpegOk = true;
try { video.getFFmpeg(); video.getFFprobe(); } catch { ffmpegOk = false; }
const d = ffmpegOk ? describe : describe.skip;

// No-op logger: any method call returns '' (works for void calls and string interp).
const stubLog = new Proxy({}, { get: () => () => '' });

function makeClip(dir, name = 'meeting.mp4') {
  const out = path.join(dir, name);
  const r = spawnSync(video.getFFmpeg(), [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
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
