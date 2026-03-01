/**
 * CLI utilities — argument parser, interactive prompts, folder/model selection.
 *
 * Supports:
 *   --flag              Boolean flag
 *   --key=value         Key-value pairs
 *   --key value         Key-value (next arg)
 *   positional args     Collected separately
 *
 * Also includes interactive prompts, folder selection, and model selection.
 *
 * Usage:
 *   const { flags, positional } = parseArgs(process.argv.slice(2));
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse command-line arguments into flags and positional args.
 *
 * @param {string[]} argv - Arguments (typically process.argv.slice(2))
 * @returns {{ flags: object, positional: string[] }}
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];

  // Boolean flags that should never consume the next argument as a value
  const BOOLEAN_FLAGS = new Set([
    'help', 'h', 'version', 'v',
    'skip-upload', 'force-upload', 'no-storage-url',
    'skip-compression', 'skip-gemini',
    'resume', 'reanalyze', 'dry-run',
    'dynamic', 'deep-dive', 'update-progress',
    'no-focused-pass', 'no-learning', 'no-diff',
  ]);

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
        // Boolean flags never consume the next argument
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          // Value flag: consume next argument
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

// ======================== INTERACTIVE FOLDER SELECTOR ========================

/** Directories to exclude when scanning for call/project folders */
const SKIP_FOLDER_NAMES = new Set([
  'node_modules', '.git', 'src', 'logs', 'gemini_runs', 'compressed', 'runs',
]);

/**
 * Discover folders in the project root that look like call/project folders.
 * A valid folder is any directory that is NOT a known infrastructure folder
 * and contains at least one file (video, doc, or subdirectory with docs).
 *
 * @param {string} projectRoot - Root directory of the tool
 * @returns {Array<{name: string, absPath: string, hasVideo: boolean, docCount: number, description: string}>}
 */
function discoverFolders(projectRoot) {
  const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);
  const DOC_EXTS = new Set(['.vtt', '.txt', '.pdf', '.docx', '.doc', '.srt', '.csv', '.md']);
  const folders = [];

  let entries;
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return folders;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || SKIP_FOLDER_NAMES.has(entry.name)) continue;

    const absPath = path.join(projectRoot, entry.name);
    let hasVideo = false;
    let docCount = 0;
    let hasRuns = false;

    // Quick scan top level + one depth
    const scan = (dir, depth = 0) => {
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const item of items) {
        if (item.isFile()) {
          const ext = path.extname(item.name).toLowerCase();
          if (VIDEO_EXTS.has(ext)) hasVideo = true;
          if (DOC_EXTS.has(ext)) docCount++;
        } else if (item.isDirectory() && depth === 0) {
          if (item.name === 'runs') hasRuns = true;
          if (!SKIP_FOLDER_NAMES.has(item.name) && item.name !== 'runs') {
            scan(path.join(dir, item.name), depth + 1);
          }
        }
      }
    };
    scan(absPath);

    // Only include folders with at least some content
    if (hasVideo || docCount > 0) {
      const parts = [];
      if (hasVideo) parts.push('video');
      if (docCount > 0) parts.push(`${docCount} doc(s)`);
      if (hasRuns) parts.push('has runs');
      folders.push({
        name: entry.name,
        absPath,
        hasVideo,
        docCount,
        hasRuns,
        description: parts.join(', '),
      });
    }
  }

  return folders;
}

/**
 * Interactive folder selection — shows discovered folders and lets user pick.
 * Returns the selected folder name as a string, or null if cancelled.
 *
 * @param {string} projectRoot - Root directory
 * @returns {Promise<string|null>} - Folder name or null
 */
async function selectFolder(projectRoot) {
  const readline = require('readline');
  const folders = discoverFolders(projectRoot);

  if (folders.length === 0) {
    console.log('\n  No call/project folders found in the current directory.');
    console.log('  Create a folder with your recording or documents, then run again.\n');
    return null;
  }

  console.log('');
  console.log('  Available folders:');
  console.log('  ─────────────────');
  folders.forEach((f, i) => {
    const icon = f.hasVideo ? '🎥' : '📄';
    const mode = f.hasVideo ? '' : ' (docs only → use --dynamic)';
    console.log(`    [${i + 1}] ${icon} ${f.name}  — ${f.description}${mode}`);
  });
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('  Select folder (number, or type a path): ', answer => {
      rl.close();
      const trimmed = (answer || '').trim();
      if (!trimmed) { resolve(null); return; }

      // Number selection
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= folders.length) {
        resolve(folders[num - 1].name);
        return;
      }

      // Direct path input
      resolve(trimmed);
    });
  });
}

// ======================== INTERACTIVE MODEL SELECTOR ========================

/**
 * Format a token count as a human-readable context window size.
 * @param {number} tokens
 * @returns {string}
 */
function fmtContext(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return String(tokens);
}

/**
 * Interactive model selector — shows all available Gemini models with
 * context window sizes, pricing, and descriptions. Returns the model ID.
 *
 * @param {object} GEMINI_MODELS - Model registry from config.js
 * @param {string} currentModel  - Currently active model ID (shown as default)
 * @returns {Promise<string>} Selected model ID
 */
async function selectModel(GEMINI_MODELS, currentModel) {
  const readline = require('readline');
  const modelIds = Object.keys(GEMINI_MODELS);

  // Group by tier for organized display
  const tiers = {
    premium:  { label: 'Premium (highest quality)',  icon: '🏆', models: [] },
    balanced: { label: 'Balanced (recommended)',      icon: '⚡', models: [] },
    economy:  { label: 'Economy (lowest cost)',       icon: '💰', models: [] },
  };

  let idx = 0;
  const indexMap = {}; // index → modelId
  for (const id of modelIds) {
    const m = GEMINI_MODELS[id];
    const tier = tiers[m.tier] || tiers.fast;
    idx++;
    indexMap[idx] = id;
    tier.models.push({ idx, id, ...m });
  }

  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────────────────────────┐');
  console.log('  │                        🤖  Gemini Model Selection                            │');
  console.log('  └──────────────────────────────────────────────────────────────────────────────┘');

  for (const [, tier] of Object.entries(tiers)) {
    if (tier.models.length === 0) continue;
    console.log('');
    console.log(`  ${tier.icon} ${tier.label}`);
    console.log('  ' + '─'.repeat(76));

    for (const m of tier.models) {
      const isDefault = m.id === currentModel;
      const marker = isDefault ? ' ← default' : '';
      const thinkTag = m.thinking ? ' [thinking]' : '';

      // Line 1: number, name, description
      console.log(`    [${m.idx}] ${m.name}${thinkTag}${marker}`);
      console.log(`        ${m.description}`);

      // Line 2: specs
      const ctxStr = fmtContext(m.contextWindow);
      const outStr = fmtContext(m.maxOutput);
      const inPrice = `$${m.pricing.inputPerM.toFixed(m.pricing.inputPerM < 0.1 ? 4 : 2)}/1M in`;
      const outPrice = `$${m.pricing.outputPerM.toFixed(m.pricing.outputPerM < 1 ? 2 : 2)}/1M out`;
      const thinkPrice = m.thinking ? ` · $${m.pricing.thinkingPerM.toFixed(2)}/1M think` : '';
      console.log(`        Context: ${ctxStr} tokens · Max output: ${outStr} · ${m.costEstimate}`);
      console.log(`        Pricing: ${inPrice} · ${outPrice}${thinkPrice}`);
    }
  }

  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`  Select model [1-${idx}] (Enter = keep default): `, answer => {
      rl.close();
      const trimmed = (answer || '').trim();

      // Enter = keep default
      if (!trimmed) {
        console.log(`  → Using ${GEMINI_MODELS[currentModel].name}`);
        resolve(currentModel);
        return;
      }

      // Number selection
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && indexMap[num]) {
        const chosen = indexMap[num];
        console.log(`  → Selected ${GEMINI_MODELS[chosen].name}`);
        resolve(chosen);
        return;
      }

      // Direct model ID input
      if (GEMINI_MODELS[trimmed]) {
        console.log(`  → Selected ${GEMINI_MODELS[trimmed].name}`);
        resolve(trimmed);
        return;
      }

      // Fuzzy match: partial name
      const lower = trimmed.toLowerCase();
      const match = modelIds.find(id =>
        id.toLowerCase().includes(lower) ||
        GEMINI_MODELS[id].name.toLowerCase().includes(lower)
      );
      if (match) {
        console.log(`  → Matched ${GEMINI_MODELS[match].name}`);
        resolve(match);
        return;
      }

      console.log(`  ⚠ Unknown selection "${trimmed}" — using default (${currentModel})`);
      resolve(currentModel);
    });
  });
}

/**
 * Display help text and signal an early exit by throwing.
 * Callers should catch this and exit cleanly (no process.exit in library code).
 */
function showHelp() {
  console.log(`
  Usage: taskex [options] [folder]
         taskex setup [--check | --silent]
         taskex config [--show | --clear]
         node process_and_upload.js [options] [folder]

  AI-powered meeting analysis & document generation pipeline.
  If no folder is specified, shows an interactive folder selector.
  If you cd into a folder, just run: taskex

  Subcommands:
    setup                             Full interactive setup (prerequisites, deps, .env, sample folder)
    setup --check                     Validation only — verify environment without changes
    setup --silent                    Non-interactive setup (use defaults, no prompts)
    config                            Interactive global config setup (~/.taskexrc)
    config --show                     Show saved config (masked secrets)
    config --clear                    Remove global config file

  Arguments:
    [folder]                          Path to the call/project folder (optional — interactive if omitted)

  Modes:
    (default)                         Video analysis — compress, analyze, extract, compile
    --dynamic                         Document-only mode — no video required, generates docs from context + request
    --update-progress                 Track item completion via git since last analysis
    --deep-dive                       (after video analysis) Generate explanatory docs per topic discussed

  Core Options:
    --name <name>                     Your name (skips interactive prompt)
    --model <id>                      Gemini model to use (skips interactive selector)
                                      Models: gemini-3.1-pro-preview, gemini-3-flash-preview,
                                      gemini-2.5-pro, gemini-2.5-flash (default), gemini-2.5-flash-lite
    --skip-upload                     Skip all Firebase Storage uploads
    --force-upload                    Re-upload files even if they already exist in Storage
    --no-storage-url                  Disable Storage URL optimization (force Gemini File API)
    --skip-compression                Skip video compression (use existing segments)
    --skip-gemini                     Skip Gemini AI analysis
    --resume                          Resume from last checkpoint (skip completed steps)
    --reanalyze                       Force re-analysis of all segments
    --dry-run                         Show what would be done without executing

  Dynamic Mode:
    --dynamic                         Enable document-only mode (no video required)
    --request <text>                  What to generate — e.g. "Plan migration from X to Y"
                                      (prompted interactively if omitted)

  Progress Tracking:
    --repo <path>                     Path to the project git repo (for change detection)

  Configuration:
    --gemini-key <key>                Gemini API key (overrides .env / ~/.taskexrc)
    --firebase-key <key>              Firebase API key (overrides .env / ~/.taskexrc)
    --firebase-project <id>           Firebase project ID (overrides .env / ~/.taskexrc)
    --firebase-bucket <bucket>        Firebase storage bucket (overrides .env / ~/.taskexrc)
    --firebase-domain <domain>        Firebase auth domain (overrides .env / ~/.taskexrc)

    Config resolution (highest wins):
      CLI flags → env vars → CWD .env → ~/.taskexrc → package .env

  Tuning:
    --parallel <n>                    Max parallel uploads (default: 3)
    --parallel-analysis <n>           Concurrent segment analysis batches (default: 2)
    --thinking-budget <n>             Thinking token budget per segment (default: 24576)
    --compilation-thinking-budget <n> Thinking tokens for final compilation (default: 10240)
    --log-level <level>               Log level: debug, info, warn, error (default: info)
    --output <dir>                    Custom output directory for results
    --no-focused-pass                 Disable focused re-analysis for weak segments
    --no-learning                     Disable learning loop (historical budget adjustments)
    --no-diff                         Disable diff comparison against previous runs

  Info:
    --help, -h                        Show this help message
    --version, -v                     Show version

  Examples:
    taskex                                                                  Interactive (cd into folder first)
    taskex "call 1"                                                         Analyze a call (with video)
    taskex --name "Jane" --skip-upload "call 1"                             Skip Firebase, set name
    taskex --gemini-key "AIza..." --skip-upload "call 1"                    Pass API key inline (no .env)
    taskex --model gemini-2.5-pro "call 1"                                  Use Gemini 2.5 Pro model
    taskex --resume "call 1"                                                Resume interrupted run
    taskex --deep-dive "call 1"                                             Video analysis + deep dive docs
    taskex --dynamic "my-project"                                           Doc-only mode (prompted for request)
    taskex --dynamic --request "Plan API migration" "specs"                 Dynamic with request
    taskex --update-progress --repo "C:\\my-project" "call 1"               Progress tracking via git

  First-time setup:
    taskex setup                                                            Full setup wizard (Node, ffmpeg, deps, .env)
    taskex setup --check                                                    Validate environment only
    taskex config                                                           Save API keys globally (~/.taskexrc)
    taskex config --show                                                    View saved config
    taskex config --clear                                                   Remove saved config
  `);
  // Signal early exit — pipeline checks for help flag before calling this
  throw Object.assign(new Error('HELP_SHOWN'), { code: 'HELP_SHOWN' });
}

module.exports = { parseArgs, showHelp, discoverFolders, selectFolder, selectModel, promptUser, promptUserText };

// ======================== INTERACTIVE PROMPTS ========================

/** Prompt user for a yes/no question on stdin. Returns true for yes. */
function promptUser(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

/** Prompt user for free text input. Returns trimmed string. */
function promptUserText(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}
