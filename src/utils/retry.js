/**
 * Retry utility — exponential backoff with jitter for transient failures.
 *
 * Used for Gemini API calls and Firebase operations that may fail
 * due to rate limits, network issues, or temporary outages.
 */

'use strict';

const { MAX_RETRIES, RETRY_BASE_DELAY_MS } = require('../config');

/**
 * Known transient error patterns that should be retried.
 */
const TRANSIENT_PATTERNS = [
  /429/i,                       // Rate limited
  /too many requests/i,
  /quota exceeded/i,
  /resource exhausted/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EPIPE/i,
  /socket hang up/i,
  /network/i,
  /503/i,                       // Service unavailable
  /502/i,                       // Bad gateway
  /500/i,                       // Internal server error (sometimes transient)
  /UNAVAILABLE/i,
  /INTERNAL/i,
  /overloaded/i,
  /capacity/i,
];

/**
 * Determine if an error is likely transient and worth retrying.
 * @param {Error} err
 * @returns {boolean}
 */
function isTransientError(err) {
  const msg = err.message || '';
  const code = err.code || '';
  const status = err.status || err.statusCode || 0;

  // HTTP status codes that are transient
  if ([429, 500, 502, 503, 504].includes(status)) return true;

  // Check message against known patterns
  const combined = `${msg} ${code}`;
  return TRANSIENT_PATTERNS.some(p => p.test(combined));
}

/**
 * Execute an async function with exponential backoff retry.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} [opts]
 * @param {number} [opts.maxRetries] - Max retry attempts (default from config)
 * @param {number} [opts.baseDelay] - Base delay in ms (default from config)
 * @param {string} [opts.label] - Human-readable label for log messages
 * @param {Function} [opts.onRetry] - Called with (attempt, delay, err) before each retry
 * @param {Function} [opts.shouldRetry] - Custom predicate (err) → boolean
 * @returns {Promise<any>} Result of fn()
 */
async function withRetry(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const baseDelay = opts.baseDelay ?? RETRY_BASE_DELAY_MS;
  const label = opts.label || 'operation';
  const shouldRetry = opts.shouldRetry || isTransientError;
  const onRetry = opts.onRetry || null;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !shouldRetry(err)) {
        throw err;
      }

      // Exponential backoff with jitter: baseDelay * 2^attempt * (0.5-1.5)
      const jitter = 0.5 + Math.random();
      const delay = Math.min(baseDelay * Math.pow(2, attempt) * jitter, 60000);

      if (onRetry) {
        onRetry(attempt + 1, delay, err);
      } else {
        const msg = err.message || String(err);
        console.warn(`  ⚠ ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.slice(0, 120)}`);
        console.warn(`    → Retrying in ${(delay / 1000).toFixed(1)}s...`);
      }

      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError;
}

/**
 * Run multiple async tasks with a concurrency limit.
 *
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function (item, index) → result
 * @param {number} [concurrency=3] - Max concurrent tasks
 * @returns {Promise<Array>} Results in original order
 */
async function parallelMap(items, fn, concurrency = 3) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

module.exports = { withRetry, parallelMap, isTransientError };
