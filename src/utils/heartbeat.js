/**
 * Liveness heartbeat for long, silent operations.
 *
 * A Gemini call can run for a minute with nothing printed. Silence is
 * indistinguishable from a hang — or from a Windows console that has stopped
 * flushing because the window is in selection mode (QuickEdit), where output
 * only resumes after a keypress. A periodic line makes the difference obvious:
 * ticking = working, no ticks = the terminal is blocked, not the pipeline.
 */

'use strict';

const { c } = require('./colors');

/** Silence tolerated before the first heartbeat line (ms). */
const DEFAULT_INTERVAL_MS = 20_000;

/**
 * Print a periodic "still working" line until stopped.
 *
 * @param {string} label - What is being waited on, e.g. "Gemini: segment_01.mp4"
 * @param {{ intervalMs?: number }} [opts]
 * @returns {() => void} stop function — always call it (use try/finally)
 */
function startHeartbeat(label, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    console.log(`    ${c.dim(`… still working — ${label} (${secs}s)`)}`);
  }, intervalMs);

  // Never hold the process open just for a heartbeat.
  if (timer.unref) timer.unref();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Run an async operation with a heartbeat attached.
 * The heartbeat is cleared whether the operation resolves or throws.
 */
async function withHeartbeat(label, fn, opts) {
  const stop = startHeartbeat(label, opts);
  try {
    return await fn();
  } finally {
    stop();
  }
}

module.exports = { startHeartbeat, withHeartbeat, DEFAULT_INTERVAL_MS };
