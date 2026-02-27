/**
 * CLI config flag injection — maps --flag values to process.env before
 * any module touches config.js / dotenv.
 *
 * Shared between bin/taskex.js and process_and_upload.js to avoid
 * duplicated flag-parsing logic.
 */

'use strict';

/** Map of CLI flag names → environment variable names */
const CONFIG_FLAG_MAP = {
  'gemini-key':        'GEMINI_API_KEY',
  'firebase-key':      'FIREBASE_API_KEY',
  'firebase-project':  'FIREBASE_PROJECT_ID',
  'firebase-bucket':   'FIREBASE_STORAGE_BUCKET',
  'firebase-domain':   'FIREBASE_AUTH_DOMAIN',
};

/**
 * Scan process.argv for config flags and inject their values into process.env.
 * Must be called BEFORE any require() that touches config.js / dotenv.
 *
 * Supports both `--key value` and `--key=value` forms.
 *
 * @param {string[]} [argv] - Arguments (defaults to process.argv.slice(2))
 * @returns {string[]} List of env var names that were injected
 */
function injectCliFlags(argv) {
  if (!argv) argv = process.argv.slice(2);
  const injected = [];

  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;

    const eqIdx = argv[i].indexOf('=');
    let key, val;

    if (eqIdx !== -1) {
      key = argv[i].slice(2, eqIdx);
      val = argv[i].slice(eqIdx + 1);
    } else {
      key = argv[i].slice(2);
      if (CONFIG_FLAG_MAP[key] && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        val = argv[i + 1];
      }
    }

    if (key && val && CONFIG_FLAG_MAP[key]) {
      process.env[CONFIG_FLAG_MAP[key]] = val;
      injected.push(CONFIG_FLAG_MAP[key]);
    }
  }

  return injected;
}

module.exports = { injectCliFlags, CONFIG_FLAG_MAP };
