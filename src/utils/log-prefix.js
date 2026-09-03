/**
 * Per-task console prefixing.
 *
 * Segment analysis prints a dozen lines per segment — budget, upload, model,
 * tokens, quality, schema. Run three segments at once and those lines arrive
 * shuffled, with nothing saying which segment each belongs to.
 *
 * This tags every console line written inside a task with a short label, using
 * an AsyncLocalStorage so the label follows the task across every await and
 * every module it calls into — no plumbing through processWithGemini and back.
 *
 * Lines still stream as they happen (buffering until a segment finished would
 * hide the heartbeat that proves a long request is alive).
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

/** The console methods as they were before patching. */
const original = {};
let installed = false;

const METHODS = ['log', 'warn', 'error'];

/**
 * Prefix every line of the first (format) argument.
 * A blank line stays blank — a bare prefix on its own is just noise.
 */
function applyPrefix(prefix, args) {
  if (args.length === 0) return args;
  const first = args[0];
  if (typeof first !== 'string') return [prefix, ...args];
  if (first.trim() === '') return args;
  return [first.split('\n').map(line => (line.trim() === '' ? line : prefix + line)).join('\n'), ...args.slice(1)];
}

/** Patch console once; without an active prefix it behaves exactly as before. */
function install() {
  if (installed) return;
  installed = true;
  for (const m of METHODS) {
    original[m] = console[m];
    console[m] = (...args) => {
      const prefix = store.getStore();
      original[m](...(prefix ? applyPrefix(prefix, args) : args));
    };
  }
}

/** Undo install() — for tests, and for any caller that wants the plain console. */
function uninstall() {
  if (!installed) return;
  for (const m of METHODS) console[m] = original[m];
  installed = false;
}

/**
 * Run fn with every console line inside it prefixed.
 *
 * @param {string} prefix - Label, e.g. "[seg 3] "
 * @param {Function} fn - Async task
 * @returns {Promise<any>} fn's result
 */
function withLogPrefix(prefix, fn) {
  if (!prefix) return fn();
  install();
  return store.run(prefix, fn);
}

module.exports = { withLogPrefix, install, uninstall };
