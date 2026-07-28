'use strict';

const config = require('../../src/config');
const { initFirebase } = require('../../src/services/firebase');

describe('initFirebase with Firebase unconfigured', () => {
  const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'storageBucket'];
  let saved;

  beforeEach(() => {
    saved = { ...config.FIREBASE_CONFIG };
    for (const k of REQUIRED) config.FIREBASE_CONFIG[k] = '';
  });

  afterEach(() => {
    Object.assign(config.FIREBASE_CONFIG, saved);
  });

  it('bypasses instead of throwing, so callers skip uploads', async () => {
    // Every upload call site gates on `authenticated && storage`, so returning
    // this pair makes the whole pipeline degrade to local-only output.
    const result = await initFirebase();
    expect(result.storage).toBeNull();
    expect(result.authenticated).toBe(false);
  });

  it('names the missing env keys so the fix is discoverable', async () => {
    const logged = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(msg => logged.push(String(msg)));
    try {
      await initFirebase();
    } finally {
      spy.mockRestore();
    }
    const out = logged.join('\n');
    expect(out).toMatch(/FIREBASE_API_KEY/);
    expect(out).toMatch(/FIREBASE_STORAGE_BUCKET/);
  });
});
