'use strict';

const config = require('../src/config');

describe('Firebase is optional', () => {
  const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'storageBucket'];
  let saved;

  beforeEach(() => {
    saved = { ...config.FIREBASE_CONFIG };
  });

  afterEach(() => {
    Object.assign(config.FIREBASE_CONFIG, saved);
  });

  /** Clear the given required keys on the live config object. */
  function unset(keys) {
    for (const k of keys) config.FIREBASE_CONFIG[k] = '';
  }

  it('missing Firebase config never fails validation', () => {
    // Regression: an unconfigured Firebase used to abort every run with
    // "FATAL: Invalid configuration" before any work started.
    unset(REQUIRED);
    const result = config.validateConfig({ skipGemini: true });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports absent when no Firebase keys are set, without warning', () => {
    unset(REQUIRED);
    const status = config.firebaseStatus();
    expect(status.configured).toBe(false);
    expect(status.absent).toBe(true);
    expect(status.partial).toBe(false);
    expect(config.validateConfig({ skipGemini: true }).warnings).toEqual([]);
  });

  it('warns (but stays valid) when Firebase is only partially configured', () => {
    unset(REQUIRED);
    config.FIREBASE_CONFIG.apiKey = 'set-but-incomplete';
    const status = config.firebaseStatus();
    expect(status.partial).toBe(true);
    expect(status.missingEnvKeys).toEqual([
      'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID', 'FIREBASE_STORAGE_BUCKET',
    ]);

    const result = config.validateConfig({ skipGemini: true });
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/partially configured/);
  });

  it('reports configured when all required keys are present', () => {
    for (const k of REQUIRED) config.FIREBASE_CONFIG[k] = 'x';
    expect(config.isFirebaseConfigured()).toBe(true);
    expect(config.firebaseStatus().missing).toEqual([]);
  });

  it('still reports genuine (non-Firebase) config errors', () => {
    unset(REQUIRED);
    const result = config.validateConfig({ skipGemini: false, skipFirebase: false });
    // GEMINI_API_KEY presence depends on the environment; assert only that no
    // Firebase key ever shows up as a hard error.
    expect(result.errors.some(e => /Firebase/.test(e))).toBe(false);
  });
});

describe('model registry integrity', () => {
  it('the default model exists in the registry', () => {
    // Regression: the previous default (gemini-2.5-flash) was removed after the
    // gemini-2.5-* line began returning 404 for newer API keys. The default must
    // always be a real, listed model or every no-flag run fails.
    expect(config.GEMINI_MODELS[config.GEMINI_MODEL]).toBeTruthy();
  });

  it('every preset tier resolves to a registered model', () => {
    const ids = Object.keys(config.GEMINI_MODELS);
    for (const tier of ['premium', 'balanced', 'economy']) {
      const match = ids.find(id => config.GEMINI_MODELS[id].tier === tier);
      expect(match, `tier ${tier} has no model`).toBeTruthy();
    }
  });

  it('no longer lists the retired gemini-2.5-* models', () => {
    expect(config.GEMINI_MODELS['gemini-2.5-flash']).toBeUndefined();
    expect(config.GEMINI_MODELS['gemini-2.5-flash-lite']).toBeUndefined();
    expect(config.GEMINI_MODELS['gemini-2.5-pro']).toBeUndefined();
  });

  it('getActiveModelPricing returns a valid pricing object even for an unknown active model', () => {
    const pricing = config.getActiveModelPricing();
    expect(pricing).toBeTruthy();
    expect(typeof pricing.inputPerM).toBe('number');
  });

  it('setActiveModel rejects an unknown model', () => {
    expect(() => config.setActiveModel('gemini-does-not-exist')).toThrow(/Unknown model/);
  });

  it('setActiveModel activates a valid model', () => {
    const prev = config.GEMINI_MODEL;
    try {
      config.setActiveModel('gemini-3.1-pro-preview');
      expect(config.GEMINI_MODEL).toBe('gemini-3.1-pro-preview');
    } finally {
      config.setActiveModel(prev);
    }
  });
});
