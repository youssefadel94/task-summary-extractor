const { withRetry, parallelMap, isTransientError, describeError } = require('../../src/utils/retry');

/** Build the TypeError Node's fetch throws, with the real reason in .cause. */
const fetchFailure = (code, message = code) => {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error(message), { code });
  return err;
};

describe('isTransientError', () => {
  const t = (msg, extra = {}) => isTransientError(Object.assign(new Error(msg), extra));

  it('flags real transient errors', () => {
    expect(t('429 Too Many Requests')).toBe(true);
    expect(t('got status 503 Service Unavailable')).toBe(true);
    expect(t('RESOURCE_EXHAUSTED')).toBe(true);
    expect(t('socket hang up')).toBe(true);
    expect(t('boom', { status: 500 })).toBe(true);
  });

  it('flags fetch failures by the cause hidden under "fetch failed"', () => {
    // Regression: a segment analysis died on undici's 300s headers timeout, the
    // bare "fetch failed" message matched no pattern, and the segment was
    // dropped without a single retry.
    expect(isTransientError(fetchFailure('UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error'))).toBe(true);
    expect(isTransientError(fetchFailure('ECONNRESET', 'read ECONNRESET'))).toBe(true);
    expect(isTransientError(fetchFailure('EAI_AGAIN', 'getaddrinfo EAI_AGAIN'))).toBe(true);
    expect(isTransientError(new TypeError('fetch failed'))).toBe(true);
  });

  it('flags a transient status buried in the cause chain', () => {
    const err = new Error('request failed');
    err.cause = Object.assign(new Error('upstream'), { status: 503 });
    expect(isTransientError(err)).toBe(true);
  });

  it('retries a fetch failure instead of giving up on the first attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn()
      .mockRejectedValueOnce(fetchFailure('UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error'))
      .mockResolvedValue('analysis');
    await expect(withRetry(fn, { baseDelay: 10 })).resolves.toBe('analysis');
    expect(fn).toHaveBeenCalledTimes(2);
    console.warn.mockRestore();
  });

  it('does not flag permanent errors that merely contain 5xx-like digits', () => {
    // Regression: substring /500/ used to match "5000".
    expect(t('field exceeds 5000 chars')).toBe(false);
    expect(t('invalid id ABC-4290')).toBe(false);
    expect(t('bad request: missing field')).toBe(false);
    expect(t('INVALID_ARGUMENT')).toBe(false);
  });
});

describe('describeError', () => {
  it('surfaces the cause so "fetch failed" is not the whole story', () => {
    expect(describeError(fetchFailure('UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error')))
      .toBe('fetch failed (UND_ERR_HEADERS_TIMEOUT)');
  });

  it('returns the message unchanged when there is no cause', () => {
    expect(describeError(new Error('INVALID_ARGUMENT'))).toBe('INVALID_ARGUMENT');
  });
});

describe('withRetry', () => {
  it('resolves on first try and returns result', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error (429) and succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('429 Too Many Requests');
    err.status = 429;
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { baseDelay: 10 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    console.warn.mockRestore();
  });

  it('throws after maxRetries exhausted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('503 Service Unavailable');
    err.status = 503;
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 2, baseDelay: 10 }))
      .rejects.toThrow('503 Service Unavailable');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    console.warn.mockRestore();
  });

  it('does not retry on non-transient error', async () => {
    const err = new Error('Invalid argument');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { baseDelay: 10 }))
      .rejects.toThrow('Invalid argument');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry callback before each retry', async () => {
    const err = new Error('rate limited');
    err.status = 429;
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('done');
    const onRetry = vi.fn();

    await withRetry(fn, { baseDelay: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), err);
  });

  it('does not retry when maxRetries is 0', async () => {
    const err = new Error('500 error');
    err.status = 500;
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 0, baseDelay: 10 }))
      .rejects.toThrow('500 error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects custom shouldRetry predicate', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('custom error');
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const shouldRetry = vi.fn().mockReturnValue(true);
    const result = await withRetry(fn, { baseDelay: 10, shouldRetry });
    expect(result).toBe('ok');
    expect(shouldRetry).toHaveBeenCalledWith(err);
    console.warn.mockRestore();
  });
});

describe('parallelMap', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3];
    const results = await parallelMap(items, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6]);
  });

  it('preserves order', async () => {
    const items = [30, 10, 20];
    const results = await parallelMap(items, async (x) => {
      await new Promise(r => setTimeout(r, x));
      return x;
    }, 3);
    expect(results).toEqual([30, 10, 20]);
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const items = [1, 2, 3, 4, 5, 6];

    await parallelMap(items, async (x) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 20));
      running--;
      return x;
    }, 2);

    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('returns empty array for empty input', async () => {
    const results = await parallelMap([], async (x) => x);
    expect(results).toEqual([]);
  });
});
