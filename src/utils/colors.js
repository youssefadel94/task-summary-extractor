'use strict';

// ---------------------------------------------------------------------------
// ANSI color utility – zero dependencies
// Auto-detects color support via NO_COLOR / FORCE_COLOR / isTTY.
// ---------------------------------------------------------------------------

const env = process.env;
const enabled =
  env.FORCE_COLOR !== undefined
    ? env.FORCE_COLOR !== '0'
    : !env.NO_COLOR && (process.stdout.isTTY === true);

/** Whether ANSI colors are currently active. */
const isColorEnabled = () => enabled;

// -- helpers ----------------------------------------------------------------

const esc = (open, close) =>
  enabled ? (s) => `\x1b[${open}m${s}\x1b[${close}m` : (s) => String(s);

const noop = (s) => String(s);

// -- ANSI escape code regex (for stripping) ---------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Remove all ANSI escape codes from a string. */
const strip = (s) => String(s).replace(ANSI_RE, '');

// -- style / color functions ------------------------------------------------

const bold      = esc(1, 22);
const dim       = esc(2, 22);
const italic    = esc(3, 23);
const underline = esc(4, 24);

const red       = esc(31, 39);
const green     = esc(32, 39);
const yellow    = esc(33, 39);
const blue      = esc(34, 39);
const magenta   = esc(35, 39);
const cyan      = esc(36, 39);
const white     = esc(97, 39);
const gray      = esc(90, 39);

const bgRed     = esc(41, 49);
const bgGreen   = esc(42, 49);
const bgYellow  = esc(43, 49);
const bgBlue    = esc(44, 49);

// -- semantic aliases -------------------------------------------------------

const compose = (...fns) =>
  enabled ? (s) => fns.reduce((v, fn) => fn(v), s) : noop;

const success   = enabled ? (s) => green(`✓ ${s}`)  : (s) => `✓ ${s}`;
const error     = enabled ? (s) => red(`✗ ${s}`)    : (s) => `✗ ${s}`;
const warn      = enabled ? (s) => yellow(`⚠ ${s}`) : (s) => `⚠ ${s}`;
const info      = enabled ? (s) => blue(`ℹ ${s}`)   : (s) => `ℹ ${s}`;

const heading   = compose(bold, cyan);
const muted     = dim;
const highlight = compose(bold, yellow);
const link      = compose(underline, blue);

// -- public API -------------------------------------------------------------

/** Colour helper object – every function is a safe no-op when colours are off. */
const c = {
  // styles
  bold, dim, italic, underline,
  // foreground
  red, green, yellow, blue, cyan, magenta, gray, white,
  // background
  bgRed, bgGreen, bgYellow, bgBlue,
  // semantic
  success, error, warn, info,
  heading, muted, highlight, link,
};

module.exports = { c, isColorEnabled, strip };
