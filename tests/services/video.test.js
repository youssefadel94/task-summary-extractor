'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const video = require('../../src/services/video');

// Only run when ffmpeg/ffprobe are actually available.
let ffmpegOk = true;
try { video.getFFmpeg(); video.getFFprobe(); } catch { ffmpegOk = false; }
const d = ffmpegOk ? describe : describe.skip;

// Generate a tiny 2s synthetic MP4 (video + audio) with ffmpeg.
function makeClip(dir, name = 'clip.mp4', size = '320x240') {
  const out = path.join(dir, name);
  const r = spawnSync(video.getFFmpeg(), [
    '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=2:size=${size}:rate=10`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    out,
  ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error('ffmpeg fixture generation failed: ' + (r.stderr || '').slice(-300));
  return out;
}

d('video service (real ffmpeg)', () => {
  let dir, clip;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-vid-'));
    clip = makeClip(dir);
  }, 60000);
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('findBin locates ffmpeg and throws for a missing binary', () => {
    expect(typeof video.findBin('ffmpeg')).toBe('string');
    expect(() => video.findBin('definitely-not-a-real-bin-xyz')).toThrow(/not found/);
  });

  it('probe reads the video width', () => {
    expect(video.probe(clip, 'v:0', 'width')).toBe('320');
  });

  it('probeFormat reads the duration (~2s)', () => {
    const dur = parseFloat(video.probeFormat(clip, 'duration'));
    expect(dur).toBeGreaterThan(1.5);
    expect(dur).toBeLessThan(3.5);
  });

  it('verifySegment accepts a valid file and rejects corrupt/missing ones', () => {
    expect(video.verifySegment(clip)).toBe(true);
    const bad = path.join(dir, 'corrupt.mp4');
    fs.writeFileSync(bad, Buffer.from('not a real mp4 file'));
    expect(video.verifySegment(bad)).toBe(false);
    expect(video.verifySegment(path.join(dir, 'nope.mp4'))).toBe(false);
  });

  it('compressAndSegment produces a single valid segment for a short clip', () => {
    const outDir = path.join(dir, 'compressed');
    const segments = video.compressAndSegment(clip, outDir, { segTime: 1200, speed: 1.6 });
    expect(segments.length).toBeGreaterThanOrEqual(1);
    for (const s of segments) {
      expect(fs.existsSync(s)).toBe(true);
      expect(video.verifySegment(s)).toBe(true);
    }
  }, 60000);

  it('splitOnly stream-copies into a valid segment (raw mode)', () => {
    const outDir = path.join(dir, 'raw');
    const segments = video.splitOnly(clip, outDir, { segTime: 1200 });
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(video.verifySegment(segments[0])).toBe(true);
    expect(segments[0].endsWith('.mp4')).toBe(true);
  }, 60000);
});
