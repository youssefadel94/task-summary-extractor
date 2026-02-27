#!/usr/bin/env node
/**
 * Backward-compatible entry point — delegates to bin/taskex.js.
 *
 * For global installs, use the `taskex` CLI command directly.
 * This file exists for `node process_and_upload.js` and `npm start` compatibility.
 *
 * Usage:
 *   taskex [options] [folder]                      (recommended)
 *   node process_and_upload.js [options] [folder]   (legacy)
 *
 * Run `taskex --help` for full CLI reference.
 */
require('./bin/taskex');
