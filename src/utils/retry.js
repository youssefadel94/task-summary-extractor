/**
 * Retry utility — exponential backoff with jitter for transient failures.
 *
 * Used for Gemini API calls and Firebase operations that may fail
 * due to rate limits, network issues, or temporary outages.
 *
 * Defaults are self-contained (no upward dependency on config).
 * Callers can override via opts.maxRetries and opts.baseDelay.
 */

'use strict';

const { c } = require('./colors');

/** Default retry attempts — overridable via opts.maxRetries */
const DEFAULT_MAX_RETRIES = 3;
/** Default base delay in ms — overridable via opts.baseDelay */
const DEFAULT_BASE_DELAY_MS = 2000;

/**
 * Known transient error patterns that should be retried.
 */
const TRANSIENT_PATTERNS = [
  /\b429\b/,                    // Rate limited (word-bounded so "4290" doesn't match)
  /too many requests/i,
  /quota exceeded/i,
  /resource[ _]exhausted/i,     // matches both "resource exhausted" and Gemini's RESOURCE_EXHAUSTED
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EPIPE/i,
  /socket hang up/i,
  /network/i,
  // Transient HTTP status codes as standalone tokens (word-bounded) so we don't
  // treat "exceeds 5000 chars" or an id containing "500" as a retryable 5xx.
  /\b(?:500|502|503|504)\b/,
  /UNAVAILABLE/i,
  /INTERNAL/i,
  /overloaded/i,
  /capacity/i,
  // Node/undici fetch failures. fetch() throws a bare "fetch failed" TypeError and
  // hides the real reason (socket reset, DNS, the 300s headers timeout) in
  // err.cause — without these a dropped connection looked permanent, so a segment
  // was abandoned on the first blip instead of being retried.
  /fetch failed/i,
  /UND_ERR_/i,
  /headers timeout/i,
  /body timeout/i,
  /other side closed/i,
  /premature close/i,
  /socket disconnected/i,
  /terminated/i,
  /ECONNABORTED/i,
  /ECONNREFUSED/i,
  /EAI_AGAIN/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /ENETDOWN/i,
  /timed? ?out/i,
  /deadline exceeded/i,
  /operation was aborted/i,
  /AbortError/i,
];

/**
 * Flatten an error and its `cause` chain into one searchable string.
 *
 * Node's fetch reports "fetch failed" and puts the actual reason one or two
 * levels down in err.cause, so anything reading only err.message misclassifies it.
 *
 * @param {any} err
 * @returns {{ text: string, statuses: number[] }}
 */
function flattenError(err) {
  const parts = [];
  const statuses = [];
  const seen = new Set();
  let cur = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 6; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    parts.push(cur.message || '', cur.code || '', cur.errno || '', cur.name || '');
    const st = cur.status || cur.statusCode || 0;
    if (st) statuses.push(Number(st));
    cur = cur.cause;
  }
  return { text: parts.filter(Boolean).join(' '), statuses };
}

/**
 * Human-readable error text that keeps the underlying cause.
 * "fetch failed" alone says nothing; "fetch failed (UND_ERR_HEADERS_TIMEOUT)" does.
 *
 * @param {any} err
 * @returns {string}
 */
function describeError(err) {
  if (!err) return 'unknown error';
  const msg = err.message || String(err);
  const causes = [];
  let cur = err.cause;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 4; depth++) {
    const part = cur.code || cur.message || '';
    if (part && !msg.includes(part) && !causes.includes(part)) causes.push(part);
    cur = cur.cause;
  }
  return causes.length > 0 ? `${msg} (${causes.join(' → ')})` : msg;
}

/**
 * Determine if an error is likely transient and worth retrying.
 * @param {Error} err
 * @returns {boolean}
 */
function isTransientError(err) {
  if (!err) return false;
  const { text, statuses } = flattenError(err);

  // HTTP status codes that are transient (anywhere in the cause chain)
  if (statuses.some(s => [429, 500, 502, 503, 504].includes(s))) return true;

  // Check the flattened message/code chain against known patterns
  return TRANSIENT_PATTERNS.some(p => p.test(text));
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
  const { isShuttingDown } = require('../phases/_shared');
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts.baseDelay ?? DEFAULT_BASE_DELAY_MS;
  const label = opts.label || 'operation';
  const shouldRetry = opts.shouldRetry || isTransientError;
  const onRetry = opts.onRetry || null;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && isShuttingDown()) {
      throw lastError || new Error('Aborted: process shutting down');
    }
    try {
      // Long calls (a segment analysis runs 25s+) print nothing while in
      // flight. The heartbeat proves the pipeline is alive, and its absence
      // during a stall points at the terminal rather than the run.
      const { withHeartbeat } = require('./heartbeat');
      return await withHeartbeat(label, fn);
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !shouldRetry(err) || isShuttingDown()) {
        throw err;
      }

      // Exponential backoff with jitter: baseDelay * 2^attempt * (0.5-1.5)
      const jitter = 0.5 + Math.random();
      const delay = Math.min(baseDelay * Math.pow(2, attempt) * jitter, 60000);

      if (onRetry) {
        onRetry(attempt + 1, delay, err);
      } else {
        const msg = describeError(err);
        console.warn(`  ${c.warn(`${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.slice(0, 160)}`)}`);
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
  const { isShuttingDown } = require('../phases/_shared');
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length && !isShuttingDown()) {
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

module.exports = { withRetry, parallelMap, isTransientError, describeError };
