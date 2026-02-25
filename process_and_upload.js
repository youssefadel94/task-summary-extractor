#!/usr/bin/env node
/**
 * Video Compression → Firebase Upload → Gemini AI Processing
 *
 * Backward-compatible entry point — delegates to src/pipeline.js.
 * The monolith has been refactored into modular files under src/.
 *
 * Usage:
 *   node process_and_upload.js [options] "C:\path\to\call folder"
 *   npm run process -- "C:\path\to\call folder"
 *
 * Options:
 *   --name <name>         Your name (skips interactive prompt)
 *   --skip-upload         Skip Firebase Storage uploads
 *   --skip-compression    Skip video compression (use existing segments)
 *   --skip-gemini         Skip Gemini AI analysis
 *   --resume              Resume from last checkpoint
 *   --reanalyze           Force re-analysis of all segments
 *   --parallel <n>        Max parallel uploads (default: 3)
 *   --log-level <level>   Log level: debug, info, warn, error
 *   --dry-run             Show what would be done without executing
 *   --help, -h            Show help
 *
 * Project structure:
 *   src/
 *     config.js          — Environment-based config with validation
 *     logger.js          — Buffered dual-file logger with levels
 *     pipeline.js        — Main orchestrator with CLI flags & progress
 *     services/
 *       firebase.js      — Firebase init, upload with retry, exists checks
 *       gemini.js        — Gemini init, segment analysis with retry
 *       video.js         — ffmpeg compression, segmentation, probing
 *     renderers/
 *       markdown.js      — Action-focused Markdown renderer (from compiled result)
 *     utils/
 *       cli.js           — CLI argument parser
 *       fs.js            — Recursive file discovery
 *       format.js        — Duration/size formatting helpers
 *       json-parser.js   — Robust JSON extraction from AI output
 *       progress.js      — Pipeline checkpoint/resume persistence
 *       prompt.js        — Interactive CLI prompts (stdin/stdout)
 *       retry.js         — Exponential backoff retry with parallelMap
 *       context-manager.js — Smart context prioritization for Gemini
 */

'use strict';

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
