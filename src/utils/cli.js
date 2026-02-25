/**
 * CLI argument parser — simple, zero-dependency flag parser.
 *
 * Supports:
 *   --flag              Boolean flag
 *   --key=value         Key-value pairs
 *   --key value         Key-value (next arg)
 *   positional args     Collected separately
 *
 * Usage:
 *   const { flags, positional } = parseArgs(process.argv.slice(2));
 */

'use strict';

/**
 * Parse command-line arguments into flags and positional args.
 *
 * @param {string[]} argv - Arguments (typically process.argv.slice(2))
 * @returns {{ flags: object, positional: string[] }}
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        // Check if next arg is a value (not another flag)
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          flags[key] = argv[i + 1];
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short flag: -v, -q, etc.
      const key = arg.slice(1);
      flags[key] = true;
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

/**
 * Display help text and signal an early exit by throwing.
 * Callers should catch this and exit cleanly (no process.exit in library code).
 */
function showHelp() {
  console.log(`
  Usage: node process_and_upload.js [options] <folder>

  Compress videos, upload to Firebase Storage, and process with Gemini AI.

  Arguments:
    <folder>                          Path to the call folder (relative or absolute)

  Options:
    --name <name>                     Your name (skips interactive prompt)
    --skip-upload                     Skip Firebase Storage uploads
    --skip-compression                Skip video compression (use existing segments)
    --skip-gemini                     Skip Gemini AI analysis
    --resume                          Resume from last checkpoint (skip completed steps)
    --reanalyze                       Force re-analysis of all segments
    --parallel <n>                    Max parallel uploads (default: 3)
    --parallel-analysis <n>           Concurrent segment analysis batches (default: 2)
    --log-level <level>               Log level: debug, info, warn, error (default: info)
    --output <dir>                    Custom output directory for results
    --thinking-budget <n>             Thinking token budget per segment (default: 24576)
    --compilation-thinking-budget <n> Thinking tokens for final compilation (default: 10240)
    --no-focused-pass                 Disable focused re-analysis for weak segments
    --no-learning                     Disable learning loop (historical budget adjustments)
    --no-diff                         Disable diff comparison against previous runs
    --dry-run                         Show what would be done without executing
    --update-progress                 Detect changes since last analysis & assess item progress
    --repo <path>                     Path to the project git repo (for change detection)
    --help, -h                        Show this help message
    --version, -v                     Show version

  Examples:
    node process_and_upload.js "call 1"
    node process_and_upload.js --name "Youssef" --skip-upload "call 1"
    node process_and_upload.js --resume "call 1"
    node process_and_upload.js --parallel 5 --log-level debug "call 1"
    node process_and_upload.js --output ./my-output --thinking-budget 32768 "call 1"
    node process_and_upload.js --update-progress --repo "C:\\my-project" "call 1"
    node process_and_upload.js --update-progress --skip-gemini "call 1"
  `);
  // Signal early exit — pipeline checks for help flag before calling this
  throw Object.assign(new Error('HELP_SHOWN'), { code: 'HELP_SHOWN' });
}

module.exports = { parseArgs, showHelp };
