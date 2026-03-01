const { withRetry, parallelMap } = require('../../src/utils/retry');

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
