#!/usr/bin/env node
/**
 * taskex — AI-powered meeting analysis & document generation.
 *
 * Global CLI entry point for the task-summary-extractor package.
 * Install: npm i -g task-summary-extractor
 * Usage:   taskex [options] [folder]
 *
 * Config flags (override .env):
 *   --gemini-key <key>          Gemini API key
 *   --firebase-key <key>        Firebase API key
 *   --firebase-project <id>     Firebase project ID
 *   --firebase-bucket <bucket>  Firebase storage bucket
 *   --firebase-domain <domain>  Firebase auth domain
 *
 * These are injected into process.env before config loads,
 * so all downstream modules see them transparently.
 */

'use strict';

// ── Inject CLI config flags into process.env ──────────────────────────────
// Must run BEFORE any require() that touches config.js / dotenv
const configFlagMap = {
  'gemini-key':        'GEMINI_API_KEY',
  'firebase-key':      'FIREBASE_API_KEY',
  'firebase-project':  'FIREBASE_PROJECT_ID',
  'firebase-bucket':   'FIREBASE_STORAGE_BUCKET',
  'firebase-domain':   'FIREBASE_AUTH_DOMAIN',
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const eqIdx = argv[i].indexOf('=');
    let key, val;
    if (eqIdx !== -1) {
      key = argv[i].slice(2, eqIdx);
      val = argv[i].slice(eqIdx + 1);
    } else {
      key = argv[i].slice(2);
      if (configFlagMap[key] && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        val = argv[i + 1];
      }
    }
    if (key && val && configFlagMap[key]) {
      process.env[configFlagMap[key]] = val;
    }
  }
}

// ── Delegate to pipeline ──────────────────────────────────────────────────
const { run, getLog } = require('../src/pipeline');

run().catch(err => {
  if (err.code === 'HELP_SHOWN') {
    process.exit(0);
  }

  const log = getLog();
  if (log) {
    log.error(`FATAL: ${err.message || err}`);
    log.error(err.stack || '');
    log.step('FAILED');
    log.close();
  }
  process.stderr.write(`\nFATAL: ${err.message || err}\n`);
  process.stderr.write(`${err.stack || ''}\n`);
  process.exit(1);
});
