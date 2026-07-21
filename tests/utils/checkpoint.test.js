'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Progress = require('../../src/utils/checkpoint');

describe('Progress (checkpoint)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsx-ckpt-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('starts in the init phase with no resumable state', () => {
    const p = new Progress(dir);
    expect(p.state.phase).toBe('init');
    expect(p.hasResumableState()).toBe(false);
  });

  it('persists state to disk and reloads it', () => {
    const p = new Progress(dir);
    p.init('call-1', 'Youssef');
    p.setPhase('analyze');
    p.markCompressed('video.mp4', 3);
    p.markAnalyzed('seg_0', 'run_0.json');

    // A fresh instance on the same dir reloads the persisted state.
    const p2 = new Progress(dir);
    expect(p2.state.callName).toBe('call-1');
    expect(p2.state.phase).toBe('analyze');
    expect(p2.isCompressed('video.mp4')).toBe(true);
    expect(p2.isAnalyzed('seg_0')).toBe(true);
    expect(p2.hasResumableState()).toBe(true);
  });

  it('tracks uploads and returns the stored URL', () => {
    const p = new Progress(dir);
    expect(p.getUploadUrl('calls/x/seg0')).toBeNull();
    p.markUploaded('calls/x/seg0', 'https://example/seg0');
    expect(p.getUploadUrl('calls/x/seg0')).toBe('https://example/seg0');
  });

  it('tracks compilation completion', () => {
    const p = new Progress(dir);
    expect(p.isCompilationDone()).toBe(false);
    p.markCompilationDone();
    expect(p.isCompilationDone()).toBe(true);
  });

  it('cleanup removes the state file', () => {
    const p = new Progress(dir);
    p.init('c', 'u');
    expect(fs.existsSync(path.join(dir, '.pipeline-state.json'))).toBe(true);
    p.cleanup();
    expect(fs.existsSync(path.join(dir, '.pipeline-state.json'))).toBe(false);
  });

  it('recovers from a corrupt state file by starting fresh', () => {
    fs.writeFileSync(path.join(dir, '.pipeline-state.json'), '{corrupt');
    const p = new Progress(dir);
    expect(p.state.phase).toBe('init');
    expect(p.state.compilationDone).toBe(false);
  });
});
