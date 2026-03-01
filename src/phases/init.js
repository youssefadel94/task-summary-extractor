'use strict';

const fs = require('fs');
const path = require('path');

// --- Config ---
const config = require('../config');
const {
  LOG_LEVEL, MAX_PARALLEL_UPLOADS, THINKING_BUDGET, COMPILATION_THINKING_BUDGET,
  validateConfig, GEMINI_MODELS, setActiveModel, getActiveModelPricing,
} = config;

// --- Utils ---
const { c } = require('../utils/colors');
const { parseArgs, showHelp, selectFolder, selectModel, selectRunMode, selectFormats, selectConfidence } = require('../utils/cli');
const { promptForKey } = require('../utils/global-config');
const Logger = require('../logger');
const Progress = require('../utils/checkpoint');
const CostTracker = require('../utils/cost-tracker');
const { createProgressBar } = require('../utils/progress-bar');
const { loadHistory, analyzeHistory, printLearningInsights } = require('../utils/learning-loop');

// --- Shared state ---
const { PKG_ROOT, PROJECT_ROOT, setLog, isShuttingDown, setShuttingDown } = require('./_shared');

/** Parse an integer flag, falling back to `defaultVal` only when the input is absent or NaN. */
function safeInt(raw, defaultVal) {
  if (raw === undefined || raw === null || raw === true) return defaultVal;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? defaultVal : n;
}

// ======================== PHASE: INIT ========================

/**
 * Parse CLI args, validate config, initialize logger, set up shutdown handlers.
 * Returns the pipeline context object shared by all phases.
 */
async function phaseInit() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.help || flags.h) showHelp();
  if (flags.version || flags.v) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    process.stdout.write(`v${pkg.version}\n`);
    throw Object.assign(new Error('VERSION_SHOWN'), { code: 'VERSION_SHOWN' });
  }

  const opts = {
    skipUpload: !!flags['skip-upload'],
    forceUpload: !!flags['force-upload'],
    noStorageUrl: !!flags['no-storage-url'],
    skipCompression: !!flags['skip-compression'],
    skipGemini: !!flags['skip-gemini'],
    resume: !!flags.resume,
    reanalyze: !!flags.reanalyze,
    dryRun: !!flags['dry-run'],
    userName: flags.name || null,
    parallel: safeInt(flags.parallel, MAX_PARALLEL_UPLOADS),
    logLevel: flags['log-level'] || LOG_LEVEL,
    outputDir: flags.output || null,
    thinkingBudget: safeInt(flags['thinking-budget'], THINKING_BUDGET),
    compilationThinkingBudget: safeInt(flags['compilation-thinking-budget'], COMPILATION_THINKING_BUDGET),
    parallelAnalysis: safeInt(flags['parallel-analysis'], 2), // concurrent segment analysis
    disableFocusedPass: !!flags['no-focused-pass'],
    disableLearning: !!flags['no-learning'],
    disableDiff: !!flags['no-diff'],
    noHtml: !!flags['no-html'],
    deepDive: !!flags['deep-dive'],
    dynamic: !!flags.dynamic,
    request: typeof flags.request === 'string' ? flags.request : null,
    updateProgress: !!flags['update-progress'],
    repoPath: flags.repo || null,
    model: typeof flags.model === 'string' ? flags.model : null,
    minConfidence: typeof flags['min-confidence'] === 'string' ? flags['min-confidence'].toLowerCase() : null,
    format: typeof flags.format === 'string' ? flags.format.toLowerCase() : null,
    runMode: null, // will be populated by interactive selector or inferred
  };

  // --- Determine if user provided enough flags to skip interactive mode ---
  const hasExplicitMode = opts.model || flags['no-focused-pass'] || flags['no-learning'] || flags['no-diff'] || opts.format;
  const isNonInteractive = !process.stdin.isTTY;

  // --- Interactive Run-Mode selector (only when TTY and no explicit flags) ---
  if (!hasExplicitMode && !isNonInteractive && !opts.skipGemini) {
    // Show the welcome banner
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    console.log('');
    console.log(c.heading('  ┌──────────────────────────────────────────────────────────────────────────────┐'));
    console.log(c.heading(`  │  ${c.bold('taskex')} ${c.dim(`v${pkg.version}`)}  —  AI-powered meeting analysis                              │`));
    console.log(c.heading('  └──────────────────────────────────────────────────────────────────────────────┘'));

    const mode = await selectRunMode();
    opts.runMode = mode;

    if (mode !== 'custom') {
      // Apply preset overrides
      const { selectRunMode: _ignore, ...cliModule } = require('../utils/cli');
      // Access RUN_PRESETS from the module
      const presetOverrides = {
        fast: {
          disableFocusedPass: true,
          disableLearning: true,
          disableDiff: true,
          format: 'md,json',
          formats: new Set(['md', 'json']),
          modelTier: 'economy',
        },
        balanced: {
          disableFocusedPass: false,
          disableLearning: false,
          disableDiff: false,
          format: 'all',
          formats: new Set(['md', 'html', 'json', 'pdf', 'docx']),
          modelTier: 'balanced',
        },
        detailed: {
          disableFocusedPass: false,
          disableLearning: false,
          disableDiff: false,
          format: 'all',
          formats: new Set(['md', 'html', 'json', 'pdf', 'docx']),
          modelTier: 'premium',
        },
      };
      const preset = presetOverrides[mode];
      if (preset) {
        opts.disableFocusedPass = preset.disableFocusedPass;
        opts.disableLearning = preset.disableLearning;
        opts.disableDiff = preset.disableDiff;
        opts.format = preset.format;
        opts.formats = preset.formats;
        opts._modelTier = preset.modelTier; // used later for model auto-selection
      }
    } else {
      // Custom mode: show interactive pickers for format & confidence
      const chosenFormats = await selectFormats();
      opts.formats = chosenFormats;
      opts.format = chosenFormats.size === 5 ? 'all' : [...chosenFormats].join(',');

      const chosenConfidence = await selectConfidence();
      if (chosenConfidence) {
        opts.minConfidence = chosenConfidence;
      }
    }
  }

  // --- Validate min-confidence level ---
  if (opts.minConfidence) {
    const { validateConfidenceLevel } = require('../utils/confidence-filter');
    const check = validateConfidenceLevel(opts.minConfidence);
    if (!check.valid) {
      throw new Error(check.error);
    }
    opts.minConfidence = check.normalised.toLowerCase();
  }

  // --- Validate --format flag (supports comma-separated: md,html,pdf) ---
  // If format wasn't set by interactive picker or flag, default to 'all'
  if (!opts.format) opts.format = 'all';
  if (!opts.formats) {
    const VALID_FORMATS = new Set(['md', 'html', 'json', 'pdf', 'docx', 'all']);
    const requestedFormats = opts.format.split(',').map(f => f.trim()).filter(Boolean);
    const invalidFormats = requestedFormats.filter(f => !VALID_FORMATS.has(f));
    if (invalidFormats.length > 0) {
      throw new Error(`Invalid --format "${invalidFormats.join(', ')}". Valid: md, html, json, pdf, docx, all`);
    }
    // Normalise: "all" or set of specific formats
    opts.formats = requestedFormats.includes('all')
      ? new Set(['md', 'html', 'json', 'pdf', 'docx'])
      : new Set(requestedFormats);
    // Keep opts.format as the original string for backwards compatibility
    opts.format = requestedFormats.includes('all') ? 'all' : requestedFormats.join(',');
  }

  // --- Resolve folder: positional arg or interactive selection ---
  let folderArg = positional[0];
  if (!folderArg) {
    folderArg = await selectFolder(PROJECT_ROOT);
    if (!folderArg) {
      showHelp();
    }
  }

  const targetDir = path.resolve(folderArg);
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw new Error(`"${targetDir}" is not a valid folder. Check the path and try again.`);
  }

  // --- Validate configuration (with first-run recovery) ---
  let configCheck = validateConfig({
    skipFirebase: opts.skipUpload,
    skipGemini: opts.skipGemini,
  });

  // First-run experience: if GEMINI_API_KEY is missing, prompt interactively
  if (!configCheck.valid && !opts.skipGemini && !config.GEMINI_API_KEY) {
    const key = await promptForKey('GEMINI_API_KEY');
    if (key) {
      // Re-validate after user provided the key
      configCheck = validateConfig({
        skipFirebase: opts.skipUpload,
        skipGemini: opts.skipGemini,
      });
    }
  }

  if (!configCheck.valid) {
    console.error(`\n  ${c.error('Configuration errors:')}`);
    configCheck.errors.forEach(e => console.error(`    ${c.error(e)}`));
    console.error(`\n  ${c.dim('Fix these via:')}`);
    console.error(`    ${c.dim('•')} ${c.cyan('taskex config')}          ${c.dim('(save globally for all projects)')}`);
    console.error(`    ${c.dim('•')} ${c.cyan('.env file')}              ${c.dim('(project-specific config)')}`);
    console.error(`    ${c.dim('•')} ${c.cyan('--gemini-key <key>')}     ${c.dim('(one-time inline)')}\n`);
    throw new Error('Invalid configuration. See errors above.');
  }

  // --- Initialize logger ---
  const logsDir = path.join(PROJECT_ROOT, 'logs');
  const log = new Logger(logsDir, path.basename(targetDir), { level: opts.logLevel });
  setLog(log);
  log.patchConsole();
  log.step(`START processing "${path.basename(targetDir)}"`);

  // --- Learning Loop: load historical insights ---
  let learningInsights = { hasData: false, budgetAdjustment: 0, compilationBudgetAdjustment: 0 };
  if (!opts.disableLearning) {
    const history = loadHistory(PROJECT_ROOT);
    learningInsights = analyzeHistory(history);
    if (learningInsights.hasData) {
      printLearningInsights(learningInsights);
      // Apply budget adjustments from learning (clamped to model max)
      if (learningInsights.budgetAdjustment !== 0) {
        const modelMax = config.getMaxThinkingBudget();
        opts.thinkingBudget = Math.min(modelMax, Math.max(8192, opts.thinkingBudget + learningInsights.budgetAdjustment));
        log.step(`Learning: adjusted thinking budget → ${opts.thinkingBudget}`);
      }
      if (learningInsights.compilationBudgetAdjustment !== 0) {
        const modelMax = config.getMaxThinkingBudget();
        opts.compilationThinkingBudget = Math.min(modelMax, Math.max(8192, opts.compilationThinkingBudget + learningInsights.compilationBudgetAdjustment));
        log.step(`Learning: adjusted compilation budget → ${opts.compilationThinkingBudget}`);
      }
    }
  }

  // --- Graceful shutdown handler ---
  const shutdown = (signal) => {
    if (isShuttingDown()) return;
    setShuttingDown(true);
    console.warn(`\n  ${c.warn(`Received ${signal} \u2014 shutting down gracefully...`)}`);
    log.step(`SHUTDOWN requested (${signal})`);
    log.close();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // --- Model selection ---
  if (opts.model) {
    // CLI flag: --model <id> — validate and activate
    setActiveModel(opts.model);
    log.step(`Model set via flag: ${config.GEMINI_MODEL}`);
  } else if (opts._modelTier) {
    // Preset-driven: auto-select the best model for the chosen tier
    const modelIds = Object.keys(GEMINI_MODELS);
    const tierModel = modelIds.find(id => GEMINI_MODELS[id].tier === opts._modelTier);
    if (tierModel) {
      setActiveModel(tierModel);
      console.log(c.success(`Model auto-selected: ${GEMINI_MODELS[tierModel].name} (${opts._modelTier} tier)`));
      log.step(`Model auto-selected for ${opts._modelTier} tier: ${config.GEMINI_MODEL}`);
    } else {
      // Fallback to interactive if tier not found
      const chosenModel = await selectModel(GEMINI_MODELS, config.GEMINI_MODEL);
      setActiveModel(chosenModel);
      log.step(`Model selected: ${config.GEMINI_MODEL}`);
    }
    delete opts._modelTier;
  } else {
    // Interactive model selection
    const chosenModel = await selectModel(GEMINI_MODELS, config.GEMINI_MODEL);
    setActiveModel(chosenModel);
    log.step(`Model selected: ${config.GEMINI_MODEL}`);
  }

  // --- Print run summary ---
  _printRunSummary(opts, config.GEMINI_MODEL, GEMINI_MODELS, targetDir);

  // --- Initialize progress tracking ---
  const progress = new Progress(targetDir);
  const costTracker = new CostTracker(getActiveModelPricing());
  const progressBar = createProgressBar({
    costTracker,
    callName: path.basename(targetDir),
  });

  return { opts, targetDir, progress, costTracker, progressBar };
}

/**
 * Print a compact run summary with all active settings.
 */
function _printRunSummary(opts, modelId, models, targetDir) {
  const modelName = (models[modelId] || {}).name || modelId;
  const tier = (models[modelId] || {}).tier || '?';
  const cost = (models[modelId] || {}).costEstimate || '';

  console.log('');
  console.log(c.heading('  ┌──────────────────────────────────────────────────────────────────────────────┐'));
  console.log(c.heading('  │                        📋  Run Summary                                       │'));
  console.log(c.heading('  └──────────────────────────────────────────────────────────────────────────────┘'));
  console.log('');
  console.log(`    ${c.dim('Folder:')}      ${c.bold(path.basename(targetDir))}`);
  console.log(`    ${c.dim('Model:')}       ${c.bold(modelName)} ${c.dim(`(${tier})`)} ${cost ? c.dim(cost) : ''}`);
  console.log(`    ${c.dim('Formats:')}     ${c.bold(opts.format === 'all' ? 'all (md, html, json, pdf, docx)' : opts.format)}`);

  if (opts.minConfidence) {
    console.log(`    ${c.dim('Confidence:')}  ${c.bold(opts.minConfidence)}+`);
  }

  // Feature toggles
  const features = [];
  if (!opts.disableFocusedPass) features.push(c.green('focused-pass'));
  if (!opts.disableLearning) features.push(c.green('learning'));
  if (!opts.disableDiff) features.push(c.green('diff'));
  if (opts.deepDive) features.push(c.cyan('deep-dive'));
  if (opts.dynamic) features.push(c.cyan('dynamic'));
  if (opts.resume) features.push(c.yellow('resume'));
  if (opts.dryRun) features.push(c.yellow('dry-run'));
  if (opts.skipUpload) features.push(c.dim('skip-upload'));

  const disabled = [];
  if (opts.disableFocusedPass) disabled.push(c.dim('no-focused'));
  if (opts.disableLearning) disabled.push(c.dim('no-learning'));
  if (opts.disableDiff) disabled.push(c.dim('no-diff'));

  if (features.length > 0) {
    console.log(`    ${c.dim('Features:')}    ${features.join(c.dim(' · '))}`);
  }
  if (disabled.length > 0) {
    console.log(`    ${c.dim('Disabled:')}    ${disabled.join(c.dim(' · '))}`);
  }

  if (opts.runMode) {
    console.log(`    ${c.dim('Run mode:')}    ${c.bold(opts.runMode)}`);
  }

  console.log(c.dim('  ' + '─'.repeat(78)));
  console.log('');
}

module.exports = phaseInit;