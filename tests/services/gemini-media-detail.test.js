'use strict';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-dummy-key';

const path = require('path');
const config = require('../../src/config');
const { processWithGemini } = require('../../src/services/gemini');
const { makeMockAI } = require('../helpers/mock-ai');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Run one segment analysis against a mock client, reusing an existing file URI
 * so nothing is uploaded, and hand back the request payload that was sent.
 */
async function captureRequest(segmentOpts = {}) {
  const ai = makeMockAI('{"tickets":[],"change_requests":[],"action_items":[],"blockers":[],"scope_changes":[],"file_references":[],"your_tasks":{},"summary":"ok"}');
  await processWithGemini(ai, 'segment_00.mp4', 'seg00', [], [], 'youssef', PKG_ROOT, {
    segmentIndex: 0,
    totalSegments: 1,
    existingFileUri: 'https://example.invalid/files/abc',
    existingFileMime: 'video/mp4',
    ...segmentOpts,
  });
  return ai._calls[0];
}

describe('video media detail', () => {
  const originalLevel = config.MEDIA_RESOLUTION;
  const originalFps = config.VIDEO_FPS;

  afterEach(() => {
    config.setMediaDetail({ level: originalLevel, fps: originalFps || 0 });
  });

  it('asks for high-resolution frames by default so on-screen text is readable', async () => {
    // A change request is often only legible on screen — the Swagger field, the
    // DTO name, the ticket title. At the API's default LOW (64 tokens/frame)
    // those go unread and the item never makes it into the analysis.
    const payload = await captureRequest();
    expect(payload.config.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH');
  });

  it('honours a per-request resolution override', async () => {
    const payload = await captureRequest({ mediaResolution: 'low' });
    expect(payload.config.mediaResolution).toBe('MEDIA_RESOLUTION_LOW');
  });

  it('leaves frame sampling at the API default until an fps is configured', async () => {
    const payload = await captureRequest();
    expect(payload.contents[0].parts[0].videoMetadata).toBeUndefined();
  });

  it('samples at the configured fps when one is set', async () => {
    const payload = await captureRequest({ videoFps: 2 });
    expect(payload.contents[0].parts[0].videoMetadata).toEqual({ fps: 2 });
  });
});

describe('config.setMediaDetail', () => {
  const originalLevel = config.MEDIA_RESOLUTION;
  const originalFps = config.VIDEO_FPS;

  afterEach(() => {
    config.setMediaDetail({ level: originalLevel, fps: originalFps || 0 });
  });

  it('changes what every module reads from config', () => {
    config.setMediaDetail({ level: 'medium', fps: 3 });
    expect(config.MEDIA_RESOLUTION).toBe('medium');
    expect(config.VIDEO_FPS).toBe(3);
    expect(config.resolveMediaResolution()).toBe('MEDIA_RESOLUTION_MEDIUM');
  });

  it('rejects an unknown level instead of silently ignoring it', () => {
    expect(() => config.setMediaDetail({ level: 'ultra' })).toThrow(/Unknown media resolution/);
  });

  it('treats fps 0 as "leave it to the API"', () => {
    config.setMediaDetail({ fps: 0 });
    expect(config.VIDEO_FPS).toBe(null);
  });
});
