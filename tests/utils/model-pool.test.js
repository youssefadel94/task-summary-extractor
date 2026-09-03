const config = require('../../src/config');
const {
  isOverloadError,
  markOverloaded,
  isCoolingDown,
  resetCooldowns,
  fallbackChain,
  assignSegmentModels,
  clampThinkingBudget,
  pricingFor,
  generateWithFallback,
} = require('../../src/utils/model-pool');

const PRO = 'gemini-3.1-pro-preview';
const FLASH = 'gemini-3-flash-preview';
const LITE = 'gemini-3.1-flash-lite-preview';

/** The 503 the Gemini API returns during a demand spike. */
const overload = () => new Error(
  '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'
);

beforeEach(() => {
  resetCooldowns();
});

describe('isOverloadError', () => {
  it('flags capacity failures', () => {
    expect(isOverloadError(overload())).toBe(true);
    expect(isOverloadError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isOverloadError(new Error('RESOURCE_EXHAUSTED'))).toBe(true);
    expect(isOverloadError(Object.assign(new Error('boom'), { status: 503 }))).toBe(true);
  });

  it('does NOT flag failures that every model would reject the same way', () => {
    // Switching models on a malformed request just pays twice for one bug.
    expect(isOverloadError(new Error('INVALID_ARGUMENT: unsupported file uri'))).toBe(false);
    expect(isOverloadError(new Error('PERMISSION_DENIED'))).toBe(false);
    expect(isOverloadError(new Error('moov atom not found'))).toBe(false);
    expect(isOverloadError(null)).toBe(false);
  });
});

describe('fallbackChain', () => {
  it('keeps the chosen model first', () => {
    expect(fallbackChain(FLASH)[0]).toBe(FLASH);
    expect(fallbackChain(PRO)[0]).toBe(PRO);
  });

  it('covers every registered model exactly once', () => {
    const chain = fallbackChain(PRO);
    expect([...new Set(chain)]).toHaveLength(chain.length);
    expect(chain).toHaveLength(Object.keys(config.GEMINI_MODELS).length);
  });

  it('prefers the cheaper model when two are equally close in tier', () => {
    // From the balanced tier, pro and flash-lite are both one tier away — an
    // outage must not silently upgrade the run to the premium tier.
    expect(fallbackChain(FLASH)[1]).toBe(LITE);
  });

  it('sinks a contended model to the back', () => {
    markOverloaded(LITE);
    expect(fallbackChain(FLASH).indexOf(LITE)).toBe(2);
    expect(isCoolingDown(LITE)).toBe(true);
  });

  it('falls back to the active model when given an unknown id', () => {
    expect(fallbackChain('gemini-does-not-exist')[0]).toBe(config.GEMINI_MODEL);
  });
});

describe('assignSegmentModels', () => {
  it('gives concurrent segments different models', () => {
    const models = assignSegmentModels(3, { primary: FLASH });
    expect(models[0]).toBe(FLASH);
    expect(new Set(models).size).toBe(3);
  });

  it('honours a pool-size cap and wraps around', () => {
    const models = assignSegmentModels(5, { primary: FLASH, poolSize: 2 });
    expect(new Set(models).size).toBe(2);
    expect(models[0]).toBe(models[2]);
    expect(models[1]).toBe(models[3]);
  });

  it('returns an empty list for no segments', () => {
    expect(assignSegmentModels(0, { primary: FLASH })).toEqual([]);
  });
});

describe('clampThinkingBudget', () => {
  it('trims a budget the target model would reject', () => {
    expect(clampThinkingBudget(32768, FLASH)).toBe(24576);
    expect(clampThinkingBudget(32768, PRO)).toBe(32768);
  });

  it('leaves "thinking off" alone', () => {
    expect(clampThinkingBudget(0, FLASH)).toBe(0);
  });
});

describe('generateWithFallback', () => {
  const payload = () => ({
    model: FLASH,
    contents: [],
    config: { thinkingConfig: { thinkingBudget: 32768 } },
  });

  it('carries a segment to the next model when one stays overloaded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generateContent = vi.fn()
      .mockRejectedValueOnce(overload())
      .mockRejectedValueOnce(overload())
      .mockResolvedValueOnce({ text: 'ok' });
    const ai = { models: { generateContent } };
    const p = payload();
    const switches = [];

    const res = await generateWithFallback(ai, p, {
      maxRetries: 1,
      baseDelay: 1,
      onModelSwitch: (from, to) => switches.push([from, to]),
    });

    expect(res.text).toBe('ok');
    expect(switches).toEqual([[FLASH, LITE]]);
    // The payload reports the model that answered, so the run record is honest.
    expect(p.model).toBe(LITE);
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it('re-clamps the thinking budget for each model it moves to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budgets = [];
    const generateContent = vi.fn().mockImplementation((req) => {
      budgets.push([req.model, req.config.thinkingConfig.thinkingBudget]);
      if (req.model !== PRO) return Promise.reject(overload());
      return Promise.resolve({ text: 'ok' });
    });

    await generateWithFallback({ models: { generateContent } }, payload(), { maxRetries: 0, baseDelay: 1 });

    // Requested 32768: the flash line caps at 24576, pro accepts it in full —
    // and pro must not inherit the earlier model's reduced budget.
    expect(budgets).toEqual([[FLASH, 24576], [LITE, 24576], [PRO, 32768]]);
  });

  it('does not switch models on a request error', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('INVALID_ARGUMENT: bad file'));
    await expect(
      generateWithFallback({ models: { generateContent } }, payload(), { maxRetries: 0, baseDelay: 1 })
    ).rejects.toThrow('INVALID_ARGUMENT');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('stays on one model when fallback is disabled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generateContent = vi.fn().mockRejectedValue(overload());
    await expect(
      generateWithFallback({ models: { generateContent } }, payload(), {
        maxRetries: 1, baseDelay: 1, fallback: false,
      })
    ).rejects.toThrow();
    expect(generateContent).toHaveBeenCalledTimes(2); // 1 attempt + 1 retry, no switch
  });

  it('switches after two capacity failures instead of burning the retry budget', async () => {
    // Five backoffs on a model with no capacity is ~10 minutes of waiting that
    // still ends in a dropped segment.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen = [];
    const generateContent = vi.fn().mockImplementation((req) => {
      seen.push(req.model);
      return req.model === FLASH ? Promise.reject(overload()) : Promise.resolve({ text: 'ok' });
    });

    await generateWithFallback({ models: { generateContent } }, payload(), { maxRetries: 4, baseDelay: 1 });

    expect(seen).toEqual([FLASH, FLASH, LITE]);
  });

  it('keeps the full retry budget for failures that are not about capacity', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen = [];
    const generateContent = vi.fn().mockImplementation((req) => {
      seen.push(req.model);
      return seen.length < 4
        ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
        : Promise.resolve({ text: 'ok' });
    });

    await generateWithFallback({ models: { generateContent } }, payload(), { maxRetries: 4, baseDelay: 1 });

    // A reset socket says nothing about the model — retry it where it is.
    expect(seen).toEqual([FLASH, FLASH, FLASH, FLASH]);
  });

  it('marks a model contended once it runs out of attempts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generateContent = vi.fn().mockRejectedValue(overload());
    await expect(
      generateWithFallback({ models: { generateContent } }, payload(), { maxRetries: 0, baseDelay: 1 })
    ).rejects.toThrow();
    expect(isCoolingDown(FLASH)).toBe(true);
  });
});

describe('pricingFor', () => {
  it('returns the model rates used to cost a mixed-model run', () => {
    expect(pricingFor(PRO)).toBe(config.GEMINI_MODELS[PRO].pricing);
    expect(pricingFor('nope')).toBe(null);
  });
});
