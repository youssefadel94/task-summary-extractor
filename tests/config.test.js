'use strict';

const config = require('../src/config');

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
