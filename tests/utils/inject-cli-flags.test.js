'use strict';

const { injectCliFlags, CONFIG_FLAG_MAP } = require('../../src/utils/inject-cli-flags');

describe('injectCliFlags', () => {
  const touched = Object.values(CONFIG_FLAG_MAP);
  let saved;
  beforeEach(() => {
    saved = {};
    for (const k of touched) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('injects --key value form into the mapped env var', () => {
    const injected = injectCliFlags(['--gemini-key', 'AIzaTest', 'call 1']);
    expect(process.env.GEMINI_API_KEY).toBe('AIzaTest');
    expect(injected).toContain('GEMINI_API_KEY');
  });

  it('injects --key=value form', () => {
    injectCliFlags(['--firebase-project=my-proj']);
    expect(process.env.FIREBASE_PROJECT_ID).toBe('my-proj');
  });

  it('injects multiple flags and reports all', () => {
    const injected = injectCliFlags(['--gemini-key=k1', '--firebase-bucket=b1']);
    expect(process.env.GEMINI_API_KEY).toBe('k1');
    expect(process.env.FIREBASE_STORAGE_BUCKET).toBe('b1');
    expect(injected.sort()).toEqual(['FIREBASE_STORAGE_BUCKET', 'GEMINI_API_KEY']);
  });

  it('ignores unmapped flags', () => {
    const injected = injectCliFlags(['--name', 'Jane', '--dry-run']);
    expect(injected).toEqual([]);
  });

  it('does not consume the next token as a value for a bare non-config flag', () => {
    // --gemini-key with no following value (next is a flag) injects nothing.
    const injected = injectCliFlags(['--gemini-key', '--skip-upload']);
    expect(injected).toEqual([]);
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
  });
});
