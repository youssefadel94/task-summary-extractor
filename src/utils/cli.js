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
const { selectOne, selectMany } = require('./interactive');

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
    'skip-compression', 'skip-gemini', 'no-compress',
    'resume', 'reanalyze', 'dry-run',
    'dynamic', 'deep-dive', 'deep-summary', 'update-progress',
    'no-focused-pass', 'no-learning', 'no-diff',
    'no-html', 'no-batch',
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
  const folders = discoverFolders(projectRoot);

  if (folders.length === 0) {
    console.log('');
    console.log(c.warn('No call/project folders found in the current directory.'));
    console.log(c.muted('  Create a folder with your recording or documents, then run again.'));
    console.log('');
    return null;
  }

  const items = folders.map(f => {
    const icon = f.hasVideo ? '🎥' : f.hasAudio ? '🎵' : '📄';
    const mode = (!f.hasVideo && !f.hasAudio) ? c.yellow(' (docs only)') : '';
    return {
      label: `${icon} ${c.bold(f.name)}${mode}`,
      hint: f.description,
      value: f.name,
    };
  });

  const result = await selectOne({
    title: c.bold('📂 Select Folder'),
    items,
    default: 0,
    footer: '↑↓ navigate · Enter select',
  });

  return result.value;
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
  const modelIds = Object.keys(GEMINI_MODELS);

  // Build items with tier grouping info in hints
  const items = [];
  let defaultIdx = 0;

  for (const id of modelIds) {
    const m = GEMINI_MODELS[id];
    const thinkTag = m.thinking ? c.magenta(' [thinking]') : '';
    const ctxStr = fmtContext(m.contextWindow);
    const tierIcon = m.tier === 'premium' ? '🏆' : m.tier === 'balanced' ? '⚡' : '💰';
    const costLabel = m.costEstimate || '';

    if (id === currentModel) defaultIdx = items.length;

    items.push({
      label: `${tierIcon} ${c.bold(m.name)}${thinkTag}`,
      hint: `${ctxStr} ctx · ${costLabel} · ${m.description}`,
      value: id,
    });
  }

  console.log('');
  console.log(c.heading('  ┌──────────────────────────────────────────────────────────────────────────────┐'));
  console.log(c.heading('  │                        🤖  Gemini Model Selection                            │'));
  console.log(c.heading('  └──────────────────────────────────────────────────────────────────────────────┘'));

  const result = await selectOne({
    title: null, // banner already printed
    items,
    default: defaultIdx,
    footer: '↑↓ navigate · Enter select',
  });

  return result.value;
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
${f('--skip-compression', 'Use existing segments from previous run (deprecated: auto-detected)')}
${f('--skip-gemini', 'Skip AI analysis')}
${f('--resume', 'Resume from last checkpoint')}
${f('--reanalyze', 'Force re-analysis of all segments')}
${f('--dry-run', 'Preview without executing')}

  ${h('VIDEO PROCESSING')}
${f('--no-compress', 'Skip re-encoding — pass raw video to Gemini (fast, no quality loss)')}
${f2('Auto-splits at 20 min (1200s) if needed. --speed and --segment-time are ignored.')}
${f2('Gemini File API: up to 2 GB/file, ~300 tok/sec at default resolution.')}
${f('--speed <n>', 'Playback speed multiplier for compression mode (default: 1.6)')}
${f('--segment-time <n>', 'Segment duration in seconds for compression mode (default: 280)')}
${f2('Duration constraints (per Google Gemini docs):')}
${f2('  • Default res: ~300 tok/sec → max ~55 min/segment (safe: ≤20 min)')}
${f2('  • File API limit: 2 GB (free) / 20 GB (paid) per file')}

  ${h('TUNING')}
${f('--parallel <n>', 'Max parallel uploads (default: 3)')}
${f('--parallel-analysis <n>', 'Concurrent analysis batches (default: 2)')}
${f('--thinking-budget <n>', 'Thinking tokens per segment (default: 24576)')}
${f('--compilation-thinking-budget <n>', 'Thinking tokens for compilation (default: 10240)')}
${f('--no-focused-pass', 'Disable focused re-analysis')}
${f('--no-learning', 'Disable learning loop')}
${f('--no-diff', 'Disable diff comparison')}
${f('--no-batch', 'Disable multi-segment batching')}
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
  selectDocsToExclude, selectFeatureFlags,
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
  dynamic: {
    label: 'Dynamic',
    icon: '📄',
    description: 'Generate custom documents from your files — enter a request prompt',
    overrides: {
      disableFocusedPass: true, // no segments to re-analyze for dynamic
      format: 'md,json',
      formats: new Set(['md', 'json']),
      modelTier: 'balanced',
    },
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
  const presetKeys = Object.keys(RUN_PRESETS);

  console.log('');
  console.log(c.heading('  ┌──────────────────────────────────────────────────────────────────────────────┐'));
  console.log(c.heading('  │                        🚀  Run Mode                                          │'));
  console.log(c.heading('  └──────────────────────────────────────────────────────────────────────────────┘'));

  const defaultIdx = presetKeys.indexOf('balanced');

  const items = presetKeys.map(key => {
    const p = RUN_PRESETS[key];
    return {
      label: `${p.icon} ${c.bold(p.label)}`,
      hint: p.description,
      value: key,
    };
  });

  const result = await selectOne({
    title: null, // banner already printed
    items,
    default: defaultIdx >= 0 ? defaultIdx : 0,
    footer: '↑↓ navigate · Enter select',
  });

  return result.value;
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
  const items = ALL_FORMATS.map(f => ({
    label: `${f.icon} ${c.bold(f.label)}`,
    hint: f.desc,
    value: f.key,
  }));

  // Default: all selected
  const defaultSelected = new Set(items.map((_, i) => i));

  const result = await selectMany({
    title: c.bold('📦 Output Formats'),
    items,
    defaultSelected,
  });

  // If none selected, default to all
  if (result.values.length === 0) {
    return new Set(ALL_FORMATS.map(f => f.key));
  }

  return new Set(result.values);
}

// ======================== CONFIDENCE PICKER ========================

/**
 * Interactive confidence-level selector.
 * Returns null (keep all) or a string like 'high' or 'medium'.
 *
 * @returns {Promise<string|null>}
 */
async function selectConfidence() {
  const levels = [
    { key: null,     icon: '🌐', label: 'All',     desc: 'Keep everything — no filtering' },
    { key: 'low',    icon: '🟡', label: 'Low+',    desc: 'Keep low, medium & high confidence' },
    { key: 'medium', icon: '🟠', label: 'Medium+', desc: 'Keep medium & high confidence' },
    { key: 'high',   icon: '🔴', label: 'High',    desc: 'Only high-confidence items' },
  ];

  const items = levels.map(l => ({
    label: `${l.icon} ${c.bold(l.label)}`,
    hint: l.desc,
    value: l.key,
  }));

  const result = await selectOne({
    title: c.bold('🎯 Confidence Filter'),
    items,
    default: 0,
    footer: '↑↓ navigate · Enter select',
  });

  return result.value;
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
  const { isTranscriptFile } = require('../modes/deep-summary');

  // Show docs with text content (inlineText + fileData with extracted text),
  // excluding transcript files (VTT/SRT are auto-excluded from summarization)
  const eligible = contextDocs
    .filter(d => d.content && d.content.length > 0 && !isTranscriptFile(d.fileName))
    .map(d => ({
      fileName: d.fileName,
      chars: d.content.length,
      tokensEst: Math.ceil(d.content.length * 0.3),
      isFileApi: d.type === 'fileData',
    }));

  // Identify binary-only docs that bypass the picker (no text extracted — can't summarize)
  const binaryOnlyDocs = contextDocs.filter(d => d.type === 'fileData' && !d.content);

  if (eligible.length === 0) {
    if (binaryOnlyDocs.length > 0) {
      console.log('');
      console.log(`  ${c.dim('ℹ')} ${c.cyan(binaryOnlyDocs.length)} file(s) included at full fidelity (no text extractable):`);
      binaryOnlyDocs.forEach(d => console.log(`    ${c.dim('-')} ${c.cyan(d.fileName)} ${c.dim(`(${d.mimeType})`)}`));
      console.log('');
    }
    return [];
  }

  console.log('');
  if (binaryOnlyDocs.length > 0) {
    console.log(`  ${c.dim('ℹ')} ${c.cyan(binaryOnlyDocs.length)} file(s) included at full fidelity (no text extractable):`);
    binaryOnlyDocs.forEach(d => console.log(`    ${c.dim('-')} ${c.cyan(d.fileName)} ${c.dim(`(${d.mimeType})`)}`));
    console.log('');
  }
  console.log(`  ${c.dim('Deep Summary will create short summaries of your reference documents.')}`);
  console.log(`  ${c.bold('Select documents to keep in FULL')} ${c.dim('(the rest will be condensed).')}`);
  console.log('');

  const items = eligible.map(d => {
    const size = d.tokensEst >= 1000
      ? `~${(d.tokensEst / 1000).toFixed(0)}K tokens`
      : `~${d.tokensEst} tokens`;
    const tag = d.isFileApi ? ` ${c.dim('(File API)')}` : '';
    return {
      label: c.bold(d.fileName) + tag,
      hint: size,
      value: d.fileName,
    };
  });

  // Default: none selected (all will be condensed)
  const result = await selectMany({
    title: c.bold('📋 Deep Summary — Keep in Full'),
    items,
    defaultSelected: new Set(),
    footer: '↑↓ navigate · Space toggle · A all/none · Enter confirm (Enter = condense all)',
  });

  return result.values;
}

// ======================== FEATURE FLAGS SELECTOR ========================

/**
 * Feature flag definitions for the interactive toggle picker.
 * Each item maps to its corresponding CLI flag and opts key.
 */
const FEATURE_FLAGS = [
  {
    key: 'deepSummary',
    flag: '--deep-summary',
    icon: '📦',
    label: 'Deep Summary',
    desc: 'Pre-summarize context docs to save tokens per segment',
    category: 'enhance',
    default: false,
    applicableModes: ['custom', 'dynamic'],
  },
  {
    key: 'deepDive',
    flag: '--deep-dive',
    icon: '🔬',
    label: 'Deep Dive',
    desc: 'Generate explanatory documents from compiled results',
    category: 'enhance',
    default: false,
    applicableModes: ['custom'], // dynamic generates its own docs
  },
  {
    key: 'disableFocusedPass',
    flag: '--no-focused-pass',
    icon: '🎯',
    label: 'Focused Pass',
    desc: 'Second-pass analysis on weak segments for better quality',
    category: 'quality',
    default: true, // enabled by default — toggle OFF to disable
    inverted: true,  // UI shows "enabled" when opts value is false
    applicableModes: ['custom'], // dynamic has no segments to re-analyze
  },
  {
    key: 'disableLearning',
    flag: '--no-learning',
    icon: '🧠',
    label: 'Learning Loop',
    desc: 'Learn from past runs to improve future budget & quality',
    category: 'quality',
    default: true,
    inverted: true,
    applicableModes: ['custom', 'dynamic'],
  },
  {
    key: 'disableDiff',
    flag: '--no-diff',
    icon: '📝',
    label: 'Diff Engine',
    desc: 'Show changes between runs (new/removed/changed items)',
    category: 'quality',
    default: true,
    inverted: true,
    applicableModes: ['custom', 'dynamic'],
  },
  {
    key: 'noBatch',
    flag: '--no-batch',
    icon: '📦',
    label: 'Batch Processing',
    desc: 'Group short segments into batches for efficiency',
    category: 'processing',
    default: true,
    inverted: true,
    applicableModes: ['custom'], // dynamic has no video segments to batch
  },
];

/**
 * Interactive feature flags selector — multi-select toggle for optional features.
 * Filters flags to only show options applicable to the current run mode.
 *
 * @param {object} currentOpts - Current options (to show existing state)
 * @param {string} runMode - The selected run mode ('custom' | 'dynamic')
 * @returns {Promise<object>} Object with flag keys and their boolean values
 */
async function selectFeatureFlags(currentOpts = {}, runMode = 'custom') {
  // Filter to flags applicable for this run mode
  const applicableFlags = FEATURE_FLAGS.filter(
    f => f.applicableModes.includes(runMode)
  );

  if (applicableFlags.length === 0) return {};

  console.log('');
  console.log(c.heading('  ┌──────────────────────────────────────────────────────────────────────────────┐'));
  console.log(c.heading('  │                     ⚙️   Feature Flags                                       │'));
  console.log(c.heading('  └──────────────────────────────────────────────────────────────────────────────┘'));

  // Group flags by category for visual separation
  const enhanceFlags = applicableFlags.filter(f => f.category === 'enhance');
  const qualityFlags = applicableFlags.filter(f => f.category === 'quality');
  const processingFlags = applicableFlags.filter(f => f.category === 'processing');

  const orderedFlags = [
    ...enhanceFlags,
    ...qualityFlags,
    ...processingFlags,
  ];

  const items = orderedFlags.map(f => ({
    label: `${f.icon} ${c.bold(f.label)}`,
    hint: f.desc,
    value: f.key,
  }));

  // Determine which flags are currently "on" (for pre-selection)
  const preSelected = new Set();
  orderedFlags.forEach((f, idx) => {
    // Check current opts value
    const currentValue = currentOpts[f.key];
    if (f.inverted) {
      // Inverted: feature is ON when opts value is false/undefined
      if (currentValue === undefined || currentValue === false) {
        preSelected.add(idx);
      }
    } else {
      // Normal: feature is ON when opts value is true
      if (currentValue === true) {
        preSelected.add(idx);
      } else if (currentValue === undefined && f.default) {
        preSelected.add(idx);
      }
    }
  });

  const result = await selectMany({
    title: null, // banner already printed
    items,
    defaultSelected: preSelected,
    footer: '↑↓ navigate · Space toggle · A all/none · Enter confirm',
  });

  // Build result object
  const selectedKeys = new Set(result.values);
  const flagResults = {};
  for (const f of orderedFlags) {
    const isOn = selectedKeys.has(f.key);
    flagResults[f.key] = f.inverted ? !isOn : isOn;
  }

  return flagResults;
}
