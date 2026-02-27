#!/usr/bin/env node
/**
 * taskex — AI-powered meeting analysis & document generation.
 *
 * Backward-compatible entry point — delegates to src/pipeline.js.
 * For global installs, use the `taskex` command directly.
 *
 * Usage:
 *   taskex [options] [folder]
 *   node process_and_upload.js [options] "C:\path\to\call folder"
 *
 * Config flags (override .env):
 *   --gemini-key <key>          Gemini API key
 *   --firebase-key <key>        Firebase API key
 *   --firebase-project <id>     Firebase project ID
 *   --firebase-bucket <bucket>  Firebase storage bucket
 *   --firebase-domain <domain>  Firebase auth domain
 *
 * Options:
 *   --name <name>              Your name (skips interactive prompt)
 *   --model <id>               Gemini model (default: gemini-2.5-flash)
 *   --skip-upload              Skip Firebase Storage uploads
 *   --force-upload             Upload even if remote file exists
 *   --no-storage-url           Disable Storage URL strategy for Gemini
 *   --skip-compression         Skip video compression (use existing segments)
 *   --skip-gemini              Skip Gemini AI analysis
 *   --resume                   Resume from last checkpoint
 *   --reanalyze                Force re-analysis of all segments
 *   --parallel <n>             Max parallel uploads (default: 3)
 *   --parallel-analysis <n>    Max concurrent Gemini analyses (default: 2)
 *   --thinking-budget <n>      Gemini thinking token budget
 *   --compilation-thinking-budget <n>  Compilation thinking budget
 *   --log-level <level>        Log level: debug, info, warn, error
 *   --output <dir>             Custom output directory
 *   --dry-run                  Show what would be done without executing
 *   --dynamic                  Document-only mode (no video required)
 *   --deep-dive                Generate deep-dive documents after analysis
 *   --request <text>           Custom research prompt for deep-dive/dynamic
 *   --update-progress          Smart change detection & progress update
 *   --repo <path>              Git repo path for progress tracking
 *   --no-focused-pass          Disable focused re-analysis pass
 *   --no-learning              Disable learning loop
 *   --no-diff                  Disable diff against previous run
 *   --help, -h                 Show help
 *   --version, -v              Show version
 *
 * Project structure:
 *   src/
 *     config.js               — Environment-based config with validation
 *     logger.js               — Buffered dual-file logger with levels
 *     pipeline.js             — Main orchestrator with CLI flags & progress
 *     services/
 *       firebase.js           — Firebase init, upload with retry, exists checks
 *       gemini.js             — Gemini init, segment analysis with retry
 *       git.js                — Git CLI wrapper for change detection
 *       video.js              — ffmpeg compression, segmentation, probing
 *     renderers/
 *       markdown.js           — Action-focused Markdown renderer
 *     utils/
 *       adaptive-budget.js    — Transcript complexity → thinking budget
 *       change-detector.js    — Git + document change correlation engine
 *       cli.js                — CLI argument parser & interactive prompts
 *       context-manager.js    — Smart context prioritization for Gemini
 *       cost-tracker.js       — Model-specific token cost tracking
 *       deep-dive.js          — AI topic discovery & document generation
 *       diff-engine.js        — Compilation diff between runs
 *       dynamic-mode.js       — Document-only analysis mode
 *       focused-reanalysis.js — Second-pass extraction for weak dimensions
 *       format.js             — Duration/size formatting helpers
 *       fs.js                 — Recursive file discovery
 *       health-dashboard.js   — Quality report builder
 *       json-parser.js        — Robust JSON extraction from AI output
 *       learning-loop.js      — Cross-run history & trend analysis
 *       progress.js           — Pipeline checkpoint/resume persistence
 *       progress-updater.js   — Smart progress assessment & rendering
 *       prompt.js             — Interactive CLI prompts (stdin/stdout)
 *       quality-gate.js       — Multi-dimension confidence scoring
 *       retry.js              — Exponential backoff retry with parallelMap
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
const { run, getLog } = require('./src/pipeline');

run().catch(err => {
  // showHelp() throws with code HELP_SHOWN — clean exit, not an error
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
