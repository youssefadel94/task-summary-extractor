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
const { parseArgs, showHelp, selectFolder, selectModel } = require('../utils/cli');
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
    format: typeof flags.format === 'string' ? flags.format.toLowerCase() : 'all',
  };

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
  } else {
    // Interactive model selection
    const chosenModel = await selectModel(GEMINI_MODELS, config.GEMINI_MODEL);
    setActiveModel(chosenModel);
    log.step(`Model selected: ${config.GEMINI_MODEL}`);
  }

  // --- Initialize progress tracking ---
  const progress = new Progress(targetDir);
  const costTracker = new CostTracker(getActiveModelPricing());
  const progressBar = createProgressBar({
    costTracker,
    callName: path.basename(targetDir),
  });

  return { opts, targetDir, progress, costTracker, progressBar };
}

module.exports = phaseInit;
