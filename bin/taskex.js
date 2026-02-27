#!/usr/bin/env node
/**
 * taskex — AI-powered meeting analysis & document generation.
 *
 * Global CLI entry point for the task-summary-extractor package.
 * Install: npm i -g task-summary-extractor
 * Usage:   taskex [options] [folder]
 *
 * Subcommands:
 *   taskex config              Interactive global config setup (~/.taskexrc)
 *   taskex config --show       Show saved config (masked secrets)
 *   taskex config --clear      Remove global config file
 *
 * Config flags (override .env and global config):
 *   --gemini-key <key>          Gemini API key
 *   --firebase-key <key>        Firebase API key
 *   --firebase-project <id>     Firebase project ID
 *   --firebase-bucket <bucket>  Firebase storage bucket
 *   --firebase-domain <domain>  Firebase auth domain
 *
 * Config resolution (highest wins):
 *   CLI flags → process.env → CWD .env → ~/.taskexrc → package .env
 */

'use strict';

// ── Handle `taskex config` subcommand before anything else ────────────────
const rawArgs = process.argv.slice(2);
if (rawArgs[0] === 'config') {
  const hasShow  = rawArgs.includes('--show');
  const hasClear = rawArgs.includes('--clear');
  const { interactiveSetup } = require('../src/utils/global-config');
  interactiveSetup({ showOnly: hasShow, clear: hasClear }).then(() => {
    process.exit(0);
  }).catch(err => {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.exit(1);
  });
} else {
  // ── Inject CLI config flags into process.env ────────────────────────────
  // Must run BEFORE any require() that touches config.js / dotenv
  const { injectCliFlags } = require('../src/utils/inject-cli-flags');
  injectCliFlags();

  // ── Delegate to pipeline ────────────────────────────────────────────────
  const { run, getLog } = require('../src/pipeline');

  run().catch(err => {
    if (err.code === 'HELP_SHOWN' || err.code === 'VERSION_SHOWN') {
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
}
