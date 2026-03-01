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
const { c } = require('./colors');

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
    'dynamic', 'deep-dive', 'deep-summary', 'update-progress',
    'no-focused-pass', 'no-learning', 'no-diff',
    'no-html',
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
  const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma']);
  const DOC_EXTS = new Set([
    '.vtt', '.txt', '.pdf', '.docx', '.doc', '.srt', '.csv', '.md',
    '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.odp', '.ods', '.rtf', '.epub',
    '.html', '.htm',
  ]);
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
    let hasAudio = false;
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
          if (AUDIO_EXTS.has(ext)) hasAudio = true;
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
    if (hasVideo || hasAudio || docCount > 0) {
      const parts = [];
      if (hasVideo) parts.push('video');
      if (hasAudio) parts.push('audio');
      if (docCount > 0) parts.push(`${docCount} doc(s)`);
      if (hasRuns) parts.push('has runs');
      folders.push({
        name: entry.name,
        absPath,
        hasVideo,
        hasAudio,
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
    console.log('');
    console.log(c.warn('No call/project folders found in the current directory.'));
    console.log(c.muted('  Create a folder with your recording or documents, then run again.'));
    console.log('');
    return null;
  }

  console.log('');
  console.log(c.heading('  📂 Available Folders'));
  console.log(c.dim('  ' + '─'.repeat(50)));
  folders.forEach((f, i) => {
    const icon = f.hasVideo ? '🎥' : f.hasAudio ? '🎵' : '📄';
    const num = c.cyan(`[${i + 1}]`);
    const name = c.bold(f.name);
    const desc = c.dim(f.description);
    const mode = (!f.hasVideo && !f.hasAudio) ? c.yellow(' (docs only)') : '';
    console.log(`    ${num} ${icon} ${name}  ${desc}${mode}`);
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
    const tier = tiers[m.tier] || tiers.economy;
    idx++;
    indexMap[idx] = id;
    tier.models.push({ idx, id, ...m });
  }

  console.log('');
  console.log(c.heading('  ┌──────────────────────────────────────────────────────────────────────────────┐'));
  console.log(c.heading('  │                        🤖  Gemini Model Selection                            │'));
  console.log(c.heading('  └──────────────────────────────────────────────────────────────────────────────┘'));

  for (const [, tier] of Object.entries(tiers)) {
    if (tier.models.length === 0) continue;
    console.log('');
    console.log(`  ${tier.icon} ${c.bold(tier.label)}`);
    console.log(c.dim('  ' + '─'.repeat(76)));

    for (const m of tier.models) {
      const isDefault = m.id === currentModel;
      const marker = isDefault ? c.green(' ← default') : '';
      const thinkTag = m.thinking ? c.magenta(' [thinking]') : '';

      // Line 1: number, name, description
      console.log(`    ${c.cyan(`[${m.idx}]`)} ${c.bold(m.name)}${thinkTag}${marker}`);
      console.log(`        ${c.dim(m.description)}`);

      // Line 2: specs
      const ctxStr = fmtContext(m.contextWindow);
      const outStr = fmtContext(m.maxOutput);
      const inPrice = `$${m.pricing.inputPerM.toFixed(m.pricing.inputPerM < 0.1 ? 4 : 2)}/1M in`;
      const outPrice = `$${m.pricing.outputPerM.toFixed(m.pricing.outputPerM < 1 ? 2 : 2)}/1M out`;
      const thinkPrice = m.thinking ? ` · $${m.pricing.thinkingPerM.toFixed(2)}/1M think` : '';
      console.log(`        ${c.dim('Context:')} ${ctxStr} · ${c.dim('Max output:')} ${outStr} · ${c.highlight(m.costEstimate)}`);
      console.log(`        ${c.dim('Pricing:')} ${inPrice} · ${outPrice}${thinkPrice}`);
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
        console.log(c.success(`Using ${GEMINI_MODELS[currentModel].name}`));
        resolve(currentModel);
        return;
      }

      // Number selection
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && indexMap[num]) {
        const chosen = indexMap[num];
        console.log(c.success(`Selected ${GEMINI_MODELS[chosen].name}`));
        resolve(chosen);
        return;
      }

      // Direct model ID input
      if (GEMINI_MODELS[trimmed]) {
        console.log(c.success(`Selected ${GEMINI_MODELS[trimmed].name}`));
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
        console.log(c.success(`Matched ${GEMINI_MODELS[match].name}`));
        resolve(match);
        return;
      }

      console.log(c.warn(`Unknown selection "${trimmed}" — using default (${currentModel})`));
      resolve(currentModel);
    });
  });
}

/**
 * Display help text and signal an early exit by throwing.
 * Callers should catch this and exit cleanly (no process.exit in library code).
 */
function showHelp() {
  const h = (s) => c.heading(s);
  const f = (flag, desc) => `    ${c.green(flag.padEnd(38))}${desc}`;
  const f2 = (desc) => `    ${''.padEnd(38)}${c.dim(desc)}`;

  const pkg = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')); }
    catch { return { version: '?.?.?' }; }
  })();

  console.log(`
  ${c.bold(c.cyan('taskex'))} ${c.dim(`v${pkg.version}`)} — AI-powered meeting analysis & document generation

  ${h('USAGE')}
    ${c.bold('taskex')} ${c.dim('[options]')} ${c.cyan('[folder]')}
    ${c.bold('taskex setup')} ${c.dim('[--check | --silent]')}
    ${c.bold('taskex config')} ${c.dim('[--show | --clear]')}

  ${h('INTERACTIVE MODE')}
${f('taskex', 'Launch interactive wizard — choose run mode, model, format, confidence')}
${f2('Run modes: ⚡ Fast · ⚖️ Balanced · 🔬 Detailed · ⚙️ Custom')}
${f2('When flags are provided, interactive prompts are skipped automatically.')}

  ${h('SUBCOMMANDS')}
${f('setup', 'Full interactive setup (prerequisites, deps, .env)')}
${f('setup --check', 'Validation only — verify environment')}
${f('config', 'Interactive global config (~/.taskexrc)')}
${f('config --show', 'Show saved config (masked secrets)')}
${f('config --clear', 'Remove global config')}

  ${h('MODES')}
${f('(default)', 'Video/audio analysis — compress, analyze, compile')}
${f('--dynamic', 'Document generation — no media required')}
${f('--update-progress', 'Track item completion via git changes')}
${f('--deep-dive', 'Generate explanatory docs per topic')}
${f('--deep-summary', 'Pre-summarize context docs (saves ~60-80% input tokens)')}
${f('--exclude-docs <list>', 'Comma-separated doc names to keep full (use with --deep-summary)')}

  ${h('CORE OPTIONS')}
${f('--name <name>', 'Your name (skip interactive prompt)')}
${f('--model <id>', 'Gemini model (skip interactive selector)')}
${f('--format <type>', 'Output: md, html, json, pdf, docx, all — comma-separated (default: all)')}
${f('--min-confidence <level>', 'Filter: high, medium, low (default: all)')}
${f('--output <dir>', 'Custom output directory for results')}
${f('--skip-upload', 'Skip Firebase Storage uploads')}
${f('--skip-compression', 'Use existing segments (no re-compress)')}
${f('--skip-gemini', 'Skip AI analysis')}
${f('--resume', 'Resume from last checkpoint')}
${f('--reanalyze', 'Force re-analysis of all segments')}
${f('--dry-run', 'Preview without executing')}

  ${h('TUNING')}
${f('--parallel <n>', 'Max parallel uploads (default: 3)')}
${f('--parallel-analysis <n>', 'Concurrent analysis batches (default: 2)')}
${f('--thinking-budget <n>', 'Thinking tokens per segment (default: 24576)')}
${f('--compilation-thinking-budget <n>', 'Thinking tokens for compilation (default: 10240)')}
${f('--no-focused-pass', 'Disable focused re-analysis')}
${f('--no-learning', 'Disable learning loop')}
${f('--no-diff', 'Disable diff comparison')}
${f('--no-html', 'Skip HTML output (Markdown only)')}
${f('--log-level <level>', 'debug, info, warn, error (default: info)')}

  ${h('DYNAMIC MODE')}
${f('--dynamic', 'Enable document generation mode')}
${f('--request <text>', 'What to generate (prompted if omitted)')}

  ${h('PROGRESS TRACKING')}
${f('--update-progress', 'Detect changes via git since last analysis')}
${f('--repo <path>', 'Path to project git repo')}

  ${h('UPLOAD & STORAGE')}
${f('--skip-upload', 'Skip all Firebase uploads')}
${f('--force-upload', 'Re-upload even if files exist')}
${f('--no-storage-url', 'Force Gemini File API (no storage URLs)')}

  ${h('CONFIGURATION')}
${f('--gemini-key <key>', 'Gemini API key (overrides .env)')}
${f('--firebase-key <key>', 'Firebase API key')}
${f('--firebase-project <id>', 'Firebase project ID')}
${f('--firebase-bucket <bucket>', 'Firebase storage bucket')}
${f('--firebase-domain <domain>', 'Firebase auth domain')}
${f2('Resolution: CLI flags → env → .env → ~/.taskexrc')}

  ${h('INFO')}
${f('--help, -h', 'Show this help message')}
${f('--version, -v', 'Show version')}

  ${h('EXAMPLES')}
    ${c.dim('$')} taskex ${c.dim('# Interactive wizard — choose mode, model, format')}
    ${c.dim('$')} taskex "call 1" ${c.dim('# Analyze a call (interactive wizard)')}
    ${c.dim('$')} taskex --model gemini-2.5-pro "call 1" ${c.dim('# Skip wizard, use specific model')}
    ${c.dim('$')} taskex --format md,html "call 1" ${c.dim('# Skip wizard, specific formats')}
    ${c.dim('$')} taskex --name "Jane" --skip-upload "call 1"
    ${c.dim('$')} taskex --model gemini-2.5-pro --deep-dive "call 1"
    ${c.dim('$')} taskex --dynamic --request "Plan API migration" "specs"
    ${c.dim('$')} taskex --min-confidence medium "call 1" ${c.dim('# Filter low-confidence')}
    ${c.dim('$')} taskex --format md "call 1" ${c.dim('# Markdown only')}
    ${c.dim('$')} taskex --format md,html,pdf "call 1" ${c.dim('# Multiple formats')}
    ${c.dim('$')} taskex --format pdf "call 1" ${c.dim('# PDF report')}
    ${c.dim('$')} taskex --format docx "call 1" ${c.dim('# Word document')}
    ${c.dim('$')} taskex --resume "call 1" ${c.dim('# Resume interrupted run')}
    ${c.dim('$')} taskex --deep-summary "call 1" ${c.dim('# Pre-summarize docs, save tokens')}
    ${c.dim('$')} taskex --deep-summary --exclude-docs "board.md,spec.md" "call 1" ${c.dim('# Keep specific docs full')}
    ${c.dim('$')} taskex --update-progress --repo ./my-project "call 1"
  `);
  // Signal early exit — pipeline checks for help flag before calling this
  throw Object.assign(new Error('HELP_SHOWN'), { code: 'HELP_SHOWN' });
}

module.exports = {
  parseArgs, showHelp, discoverFolders, selectFolder, selectModel,
  promptUser, promptUserText, selectRunMode, selectFormats, selectConfidence,
  selectDocsToExclude,
};

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

// ======================== RUN MODE SELECTOR ========================

/**
 * Run-mode presets. Each key maps to a set of opts overrides.
 * 'custom' triggers the interactive per-setting prompts.
 */
const RUN_PRESETS = {
  fast: {
    label: 'Fast',
    icon: '⚡',
    description: 'Economy model, skip extras, Markdown + JSON only — fastest & cheapest',
    overrides: {
      disableFocusedPass: true,
      disableLearning: true,
      disableDiff: true,
      format: 'md,json',
      formats: new Set(['md', 'json']),
      modelTier: 'economy',
    },
  },
  balanced: {
    label: 'Balanced',
    icon: '⚖️',
    description: 'Balanced model, learning enabled, all formats — recommended default',
    overrides: {
      disableFocusedPass: false,
      disableLearning: false,
      disableDiff: false,
      format: 'all',
      formats: new Set(['md', 'html', 'json', 'pdf', 'docx']),
      modelTier: 'balanced',
    },
  },
  detailed: {
    label: 'Detailed',
    icon: '🔬',
    description: 'Premium model, all features, all formats — highest quality analysis',
    overrides: {
      disableFocusedPass: false,
      disableLearning: false,
      disableDiff: false,
      format: 'all',
      formats: new Set(['md', 'html', 'json', 'pdf', 'docx']),
      modelTier: 'premium',
    },
  },
  custom: {
    label: 'Custom',
    icon: '⚙️',
    description: 'Choose each setting interactively',
    overrides: {},
  },
};

// Attach RUN_PRESETS to exports (defined after module.exports due to const ordering)
module.exports.RUN_PRESETS = RUN_PRESETS;

/**
 * Interactive run-mode selector. Shows preset options and returns the chosen
 * preset key. The caller applies overrides to opts.
 *
 * @returns {Promise<string>} Preset key: 'fast' | 'balanced' | 'detailed' | 'custom'
 */
async function selectRunMode() {
  const readline = require('readline');
  const presetKeys = Object.keys(RUN_PRESETS);

  console.log('');
  console.log(c.heading('  ┌──────────────────────────────────────────────────────────────────────────────┐'));
  console.log(c.heading('  │                        🚀  Run Mode                                          │'));
  console.log(c.heading('  └──────────────────────────────────────────────────────────────────────────────┘'));
  console.log('');

  presetKeys.forEach((key, i) => {
    const p = RUN_PRESETS[key];
    const num = c.cyan(`[${i + 1}]`);
    const label = c.bold(`${p.icon} ${p.label}`);
    const desc = c.dim(p.description);
    const marker = key === 'balanced' ? c.green(' ← default') : '';
    console.log(`    ${num} ${label}${marker}`);
    console.log(`        ${desc}`);
  });
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('  Select run mode [1-4] (Enter = balanced): ', answer => {
      rl.close();
      const trimmed = (answer || '').trim();

      if (!trimmed) {
        console.log(c.success('Using balanced mode'));
        resolve('balanced');
        return;
      }

      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= presetKeys.length) {
        const key = presetKeys[num - 1];
        console.log(c.success(`Using ${RUN_PRESETS[key].label} mode`));
        resolve(key);
        return;
      }

      // Try matching by name
      const lower = trimmed.toLowerCase();
      const match = presetKeys.find(k => k === lower || RUN_PRESETS[k].label.toLowerCase() === lower);
      if (match) {
        console.log(c.success(`Using ${RUN_PRESETS[match].label} mode`));
        resolve(match);
        return;
      }

      console.log(c.warn(`Unknown "${trimmed}" — using balanced mode`));
      resolve('balanced');
    });
  });
}

// ======================== FORMAT PICKER ========================

const ALL_FORMATS = [
  { key: 'md',   icon: '📝', label: 'Markdown',  desc: 'Human-readable report' },
  { key: 'html', icon: '🌐', label: 'HTML',      desc: 'Styled web page' },
  { key: 'pdf',  icon: '📄', label: 'PDF',       desc: 'Portable document' },
  { key: 'docx', icon: '📘', label: 'Word',      desc: 'Editable Word document' },
  { key: 'json', icon: '🔧', label: 'JSON',      desc: 'Machine-readable data' },
];

/**
 * Interactive format picker — user enters comma-separated numbers or "all".
 * Returns a Set of chosen format keys.
 *
 * @returns {Promise<Set<string>>}
 */
async function selectFormats() {
  const readline = require('readline');

  console.log('');
  console.log(`  ${c.bold('📦 Output Formats')} ${c.dim('(select one or more)')}`);
  console.log(c.dim('  ' + '─'.repeat(50)));

  ALL_FORMATS.forEach((f, i) => {
    const num = c.cyan(`[${i + 1}]`);
    console.log(`    ${num} ${f.icon} ${c.bold(f.label.padEnd(12))} ${c.dim(f.desc)}`);
  });
  console.log(`    ${c.cyan('[A]')} ${c.bold('All formats')}`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('  Formats (e.g. 1,2,3 or A for all) [Enter = all]: ', answer => {
      rl.close();
      const trimmed = (answer || '').trim().toLowerCase();

      if (!trimmed || trimmed === 'a' || trimmed === 'all') {
        const all = new Set(ALL_FORMATS.map(f => f.key));
        console.log(c.success('All formats selected'));
        resolve(all);
        return;
      }

      const parts = trimmed.split(/[\s,]+/).filter(Boolean);
      const chosen = new Set();
      for (const p of parts) {
        const num = parseInt(p, 10);
        if (num >= 1 && num <= ALL_FORMATS.length) {
          chosen.add(ALL_FORMATS[num - 1].key);
        } else {
          // Try matching format key by name
          const match = ALL_FORMATS.find(f => f.key === p || f.label.toLowerCase() === p);
          if (match) chosen.add(match.key);
        }
      }

      if (chosen.size === 0) {
        console.log(c.warn('No valid formats selected — using all'));
        resolve(new Set(ALL_FORMATS.map(f => f.key)));
        return;
      }

      const labels = [...chosen].map(k => ALL_FORMATS.find(f => f.key === k)?.label || k);
      console.log(c.success(`Formats: ${labels.join(', ')}`));
      resolve(chosen);
    });
  });
}

// ======================== CONFIDENCE PICKER ========================

/**
 * Interactive confidence-level selector.
 * Returns null (keep all) or a string like 'high' or 'medium'.
 *
 * @returns {Promise<string|null>}
 */
async function selectConfidence() {
  const readline = require('readline');

  const levels = [
    { key: null,     icon: '🌐', label: 'All',    desc: 'Keep everything — no filtering' },
    { key: 'low',    icon: '🟡', label: 'Low+',   desc: 'Keep low, medium & high confidence' },
    { key: 'medium', icon: '🟠', label: 'Medium+', desc: 'Keep medium & high confidence' },
    { key: 'high',   icon: '🔴', label: 'High',   desc: 'Only high-confidence items' },
  ];

  console.log('');
  console.log(`  ${c.bold('🎯 Confidence Filter')}`);
  console.log(c.dim('  ' + '─'.repeat(50)));

  levels.forEach((l, i) => {
    const num = c.cyan(`[${i + 1}]`);
    const marker = i === 0 ? c.green(' ← default') : '';
    console.log(`    ${num} ${l.icon} ${c.bold(l.label.padEnd(10))} ${c.dim(l.desc)}${marker}`);
  });
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('  Confidence filter [1-4] (Enter = keep all): ', answer => {
      rl.close();
      const trimmed = (answer || '').trim();

      if (!trimmed) {
        console.log(c.success('Keeping all confidence levels'));
        resolve(null);
        return;
      }

      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= levels.length) {
        const chosen = levels[num - 1];
        console.log(c.success(`Confidence filter: ${chosen.label}`));
        resolve(chosen.key);
        return;
      }

      // Try matching by name
      const lower = trimmed.toLowerCase();
      const match = levels.find(l => l.key === lower || l.label.toLowerCase() === lower);
      if (match) {
        console.log(c.success(`Confidence filter: ${match.label}`));
        resolve(match.key);
        return;
      }

      console.log(c.warn(`Unknown "${trimmed}" — keeping all`));
      resolve(null);
    });
  });
}

// ======================== DEEP SUMMARY DOC EXCLUSION PICKER ========================

/**
 * Interactive picker: let user select documents to EXCLUDE from deep summary.
 * Excluded docs stay at full fidelity; the summary pass focuses on their topics.
 *
 * @param {Array<{fileName: string, type: string, content?: string}>} contextDocs - Prepared docs
 * @returns {Promise<string[]>} Array of excluded fileName strings
 */
async function selectDocsToExclude(contextDocs) {
  const readline = require('readline');

  // Only show inlineText docs with actual content
  const eligible = contextDocs
    .filter(d => d.type === 'inlineText' && d.content && d.content.length > 0)
    .map(d => ({
      fileName: d.fileName,
      chars: d.content.length,
      tokensEst: Math.ceil(d.content.length * 0.3),
    }));

  if (eligible.length === 0) return [];

  console.log('');
  console.log(`  ${c.bold('📋 Deep Summary — Choose What to Keep in Full')}`);
  console.log(c.dim('  ' + '─'.repeat(60)));
  console.log('');
  console.log(`  ${c.dim('To save processing time, we can create short summaries of your')}`);
  console.log(`  ${c.dim('reference documents. The AI will still read them — just faster.')}`);
  console.log('');
  console.log(`  ${c.bold('If a document is especially important to you, select it below')}`);
  console.log(`  ${c.bold('to keep it in full.')} The rest will be smartly condensed.`);
  console.log('');

  eligible.forEach((d, i) => {
    const num = c.cyan(`[${i + 1}]`);
    const size = d.tokensEst >= 1000
      ? c.dim(`~${(d.tokensEst / 1000).toFixed(0)}K words`)
      : c.dim(`~${d.tokensEst} words`);
    console.log(`    ${num} ${c.bold(d.fileName)} ${size}`);
  });
  console.log('');
  console.log(c.dim('  Tip: Enter = condense all · Type numbers to keep full (e.g. 1,3)'));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('  Keep full (e.g. 1,3 or Enter = condense all): ', answer => {
      rl.close();
      const trimmed = (answer || '').trim();

      if (!trimmed) {
        console.log(c.success('Got it — all documents will be condensed for faster processing'));
        resolve([]);
        return;
      }

      const parts = trimmed.split(/[\s,]+/).filter(Boolean);
      const excluded = [];

      for (const p of parts) {
        const num = parseInt(p, 10);
        if (num >= 1 && num <= eligible.length) {
          excluded.push(eligible[num - 1].fileName);
        }
      }

      if (excluded.length === 0) {
        console.log(c.warn('No valid selections — condensing all documents'));
        resolve([]);
        return;
      }

      console.log(c.success(`Keeping ${excluded.length} doc(s) in full — the rest will be condensed:`));
      excluded.forEach(f => console.log(`    ${c.dim('•')} ${c.cyan(f)}`));
      resolve(excluded);
    });
  });
}
