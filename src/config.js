/**
 * Central configuration — all constants, API keys, and settings.
 *
 * Resolution priority (highest wins):
 *   1. CLI flags (--gemini-key etc. — injected in bin/taskex.js before require)
 *   2. process.env (set by user shell or CI)
 *   3. CWD .env file (project-specific)
 *   4. ~/.taskexrc (global persistent config)
 *   5. Package root .env (development fallback)
 */

'use strict';

const path = require('path');
const fs_ = require('fs');

// ── Step 1: Load .env (CWD first, then package root — both with override: false) ──
// dotenv's default: only sets vars that aren't already set.
// Load CWD .env first (higher priority), then package root .env (fills gaps).
const cwd = process.cwd();
const cwdEnv = path.join(cwd, '.env');
const pkgEnv = path.resolve(__dirname, '..', '.env');
if (fs_.existsSync(cwdEnv)) require('dotenv').config({ path: cwdEnv });
if (fs_.existsSync(pkgEnv)) require('dotenv').config({ path: pkgEnv });

// ── Step 2: Inject global config (~/.taskexrc) for keys still missing ─────
const { injectGlobalConfig } = require('./utils/global-config');
injectGlobalConfig();

// ======================== HELPERS ========================

/** Read an env var, returning defaultVal if missing. */
function env(key, defaultVal = undefined) {
  const val = process.env[key];
  if (val !== undefined && val !== '') return val;
  return defaultVal;
}

/** Read an env var as a number, with default. */
function envInt(key, defaultVal) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultVal;
  const n = parseInt(raw, 10);
  return isNaN(n) ? defaultVal : n;
}

/** Read an env var as a float, with default. */
function envFloat(key, defaultVal) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultVal;
  const n = parseFloat(raw);
  return isNaN(n) ? defaultVal : n;
}

// ======================== FIREBASE ========================

const FIREBASE_CONFIG = {
  apiKey: env('FIREBASE_API_KEY'),
  authDomain: env('FIREBASE_AUTH_DOMAIN'),
  projectId: env('FIREBASE_PROJECT_ID'),
  storageBucket: env('FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: env('FIREBASE_MESSAGING_SENDER_ID'),
  appId: env('FIREBASE_APP_ID'),
  measurementId: env('FIREBASE_MEASUREMENT_ID'),
};

// ======================== GEMINI AI ========================

const GEMINI_API_KEY = env('GEMINI_API_KEY');

/**
 * Complete Gemini model registry — specs, context windows, pricing, and descriptions.
 *
 * Pricing source: Google AI for Developers — https://ai.google.dev/gemini-api/docs/pricing
 * Last verified: April 2026
 *
 * Rates are per 1 million tokens. Output pricing INCLUDES thinking tokens
 * (unified rate). Some models have tiered pricing based on context length
 * (short = under threshold, long = over threshold).
 *
 * NOTE: gemini-2.0-flash, gemini-2.0-flash-lite, and all gemini-1.5-* models
 * are deprecated/removed. Use 2.5+ models only.
 */
const GEMINI_MODELS = {
  'gemini-3.1-pro-preview': {
    name: 'Gemini 3.1 Pro Preview',
    description: 'Latest & most capable — best reasoning, agentic workflows, vibe-coding',
    contextWindow: 1_048_576,
    maxOutput: 65536,
    maxThinkingBudget: 32768,
    thinking: true,
    tier: 'premium',
    pricing: {
      inputPerM: 2.00,
      inputLongPerM: 4.00,
      outputPerM: 12.00,      // includes thinking tokens
      outputLongPerM: 18.00,
      thinkingPerM: 12.00,    // same rate as output (unified pricing)
      longContextThreshold: 200_000,
    },
    costEstimate: '~$0.30/segment',
  },
  'gemini-3-flash-preview': {
    name: 'Gemini 3 Flash Preview',
    description: 'Frontier intelligence at flash speed — rivals larger models at fraction of cost',
    contextWindow: 1_048_576,
    maxOutput: 65536,
    maxThinkingBudget: 24576,
    thinking: true,
    tier: 'balanced',
    pricing: {
      inputPerM: 0.50,
      inputLongPerM: 0.50,    // flat rate (no long context tier)
      outputPerM: 3.00,       // includes thinking tokens
      outputLongPerM: 3.00,
      thinkingPerM: 3.00,
      longContextThreshold: 200_000,
    },
    costEstimate: '~$0.07/segment',
  },
  'gemini-2.5-pro': {
    name: 'Gemini 2.5 Pro',
    description: 'Stable premium — deep reasoning, coding, math, STEM, long context',
    contextWindow: 1_048_576,
    maxOutput: 65536,
    maxThinkingBudget: 32768,
    thinking: true,
    tier: 'premium',
    pricing: {
      inputPerM: 1.25,
      inputLongPerM: 2.50,
      outputPerM: 10.00,      // includes thinking tokens
      outputLongPerM: 15.00,
      thinkingPerM: 10.00,
      longContextThreshold: 200_000,
    },
    costEstimate: '~$0.20/segment',
  },
  'gemini-2.5-flash': {
    name: 'Gemini 2.5 Flash',
    description: 'Best price-performance — thinking, 1M context, high throughput',
    contextWindow: 1_048_576,
    maxOutput: 65536,
    maxThinkingBudget: 24576,
    thinking: true,
    tier: 'balanced',
    pricing: {
      inputPerM: 0.30,
      inputLongPerM: 0.30,    // flat rate
      outputPerM: 2.50,       // includes thinking tokens
      outputLongPerM: 2.50,
      thinkingPerM: 2.50,
      longContextThreshold: 200_000,
    },
    costEstimate: '~$0.05/segment',
  },
  'gemini-2.5-flash-lite': {
    name: 'Gemini 2.5 Flash-Lite',
    description: 'Cheapest available — fastest, most cost-efficient for high-volume tasks',
    contextWindow: 1_048_576,
    maxOutput: 65536,
    maxThinkingBudget: 24576,
    thinking: true,
    tier: 'economy',
    pricing: {
      inputPerM: 0.10,
      inputLongPerM: 0.10,    // flat rate
      outputPerM: 0.40,       // includes thinking tokens
      outputLongPerM: 0.40,
      thinkingPerM: 0.40,
      longContextThreshold: 200_000,
    },
    costEstimate: '~$0.01/segment',
  },
  'gemini-3.1-flash-lite-preview': {
    name: 'Gemini 3.1 Flash-Lite Preview',
    description: 'Most cost-efficient Gemini 3 — optimized for high-volume agentic tasks, translation, and simple data processing',
    contextWindow: 1_048_576,
    maxOutput: 65536,
    maxThinkingBudget: 24576,
    thinking: true,
    tier: 'economy',
    pricing: {
      inputPerM: 0.25,
      inputLongPerM: 0.25,    // flat rate (no long context tier)
      outputPerM: 1.50,       // includes thinking tokens
      outputLongPerM: 1.50,
      thinkingPerM: 1.50,
      longContextThreshold: 200_000,
    },
    costEstimate: '~$0.02/segment',
  },
};

// Active model — defaults from env or 'gemini-2.5-flash'
let GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-2.5-flash');
let GEMINI_CONTEXT_WINDOW = (GEMINI_MODELS[GEMINI_MODEL] || {}).contextWindow || 1_048_576;

/**
 * Set the active model at runtime. Updates GEMINI_MODEL and GEMINI_CONTEXT_WINDOW
 * on module.exports so all modules that reference config.GEMINI_MODEL see the change.
 *
 * @param {string} modelId - Model ID (key from GEMINI_MODELS)
 * @returns {{ id: string, specs: object }} The selected model
 */
function setActiveModel(modelId) {
  const specs = GEMINI_MODELS[modelId];
  if (!specs) {
    const valid = Object.keys(GEMINI_MODELS).join(', ');
    throw new Error(`Unknown model "${modelId}". Valid models: ${valid}`);
  }
  GEMINI_MODEL = modelId;
  GEMINI_CONTEXT_WINDOW = specs.contextWindow;
  // Update module.exports so modules accessing config.GEMINI_MODEL see the new value
  module.exports.GEMINI_MODEL = modelId;
  module.exports.GEMINI_CONTEXT_WINDOW = specs.contextWindow;
  return { id: modelId, specs };
}

/**
 * Get the pricing config for the currently active model.
 * @returns {object} Pricing object compatible with CostTracker
 */
function getActiveModelPricing() {
  const specs = GEMINI_MODELS[module.exports.GEMINI_MODEL];
  return specs ? specs.pricing : GEMINI_MODELS['gemini-2.5-flash'].pricing;
}

/**
 * Get the maximum thinking budget allowed by the currently active model.
 * Used to clamp adaptive budgets before sending API requests.
 * @returns {number} Maximum thinking budget in tokens
 */
function getMaxThinkingBudget() {
  const specs = GEMINI_MODELS[module.exports.GEMINI_MODEL];
  return (specs && specs.maxThinkingBudget) || 24576;
}

// ======================== VIDEO PROCESSING ========================

const SPEED = envFloat('VIDEO_SPEED', 1.6);
const SEG_TIME = envInt('VIDEO_SEGMENT_TIME', 280); // seconds — produces segments < 5 min
const PRESET = env('VIDEO_PRESET', 'slow');
const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg'];
const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS];
const DOC_EXTS = [
  '.vtt', '.txt', '.pdf', '.docx', '.doc', '.srt', '.csv', '.md', '.json',
  '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.odp', '.ods', '.rtf', '.epub',
  '.html', '.htm',
];

// ======================== PIPELINE SETTINGS ========================

const LOG_LEVEL = env('LOG_LEVEL', 'info');
const MAX_PARALLEL_UPLOADS = envInt('MAX_PARALLEL_UPLOADS', 3);
const MAX_RETRIES = envInt('MAX_RETRIES', 3);
const RETRY_BASE_DELAY_MS = envInt('RETRY_BASE_DELAY_MS', 2000);

// Gemini thinking budget (tokens allocated for model reasoning)
const THINKING_BUDGET = envInt('THINKING_BUDGET', 24576);           // per-segment analysis
const COMPILATION_THINKING_BUDGET = envInt('COMPILATION_THINKING_BUDGET', 10240); // final compilation
const DEEP_DIVE_THINKING_BUDGET = envInt('DEEP_DIVE_THINKING_BUDGET', 16384);    // deep-dive document generation

// Gemini file API polling timeout (ms) — prevents indefinite hanging
const GEMINI_POLL_TIMEOUT_MS = envInt('GEMINI_POLL_TIMEOUT_MS', 300000); // 5 min

// ======================== GEMINI FILE HANDLING ========================

// Extensions that Gemini supports via File API for generateContent
const GEMINI_FILE_API_EXTS = ['.pdf'];
// Text-readable extensions — inlined as text parts (Gemini rejects text/vtt, text/csv etc. as fileData)
const INLINE_TEXT_EXTS = ['.vtt', '.srt', '.txt', '.md', '.csv', '.json'];
// Extensions where doc-parser extracts text before sending to Gemini
// (previously unsupported — now converted to inline text automatically)
const DOC_PARSER_EXTS = [
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.odt', '.odp', '.ods', '.rtf', '.epub', '.html', '.htm',
];
// Unsupported by Gemini — uploaded to Firebase only (empty now — doc-parser handles everything)
const GEMINI_UNSUPPORTED = [];

// ======================== MIME TYPES ========================

const MIME_MAP = {
  '.vtt': 'text/vtt',
  '.srt': 'application/x-subrip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.json': 'application/json',
  // Image types
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.svg': 'image/svg+xml',
};

// ======================== VALIDATION ========================

/**
 * Validate that all required configuration is present.
 * Returns { valid: boolean, errors: string[] }.
 */
function validateConfig({ skipFirebase = false, skipGemini = false } = {}) {
  const errors = [];

  if (!skipGemini && !GEMINI_API_KEY) {
    errors.push('GEMINI_API_KEY is missing. Set it in .env or as an environment variable.');
  }

  if (!skipFirebase) {
    const fbRequired = ['apiKey', 'authDomain', 'projectId', 'storageBucket'];
    for (const key of fbRequired) {
      if (!FIREBASE_CONFIG[key]) {
        const envKey = `FIREBASE_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
        errors.push(`Firebase ${key} is missing. Set ${envKey} in .env or as an environment variable.`);
      }
    }
  }

  if (SPEED < 0.5 || SPEED > 10) {
    errors.push(`VIDEO_SPEED=${SPEED} is out of range. Must be between 0.5 and 10.`);
  }

  if (SEG_TIME < 30 || SEG_TIME > 3600) {
    errors.push(`VIDEO_SEGMENT_TIME=${SEG_TIME} is out of range. Must be between 30 and 3600.`);
  }

  const validPresets = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
  if (!validPresets.includes(PRESET)) {
    errors.push(`VIDEO_PRESET="${PRESET}" is invalid. Must be one of: ${validPresets.join(', ')}`);
  }

  const validLogLevels = ['debug', 'info', 'warn', 'error'];
  if (!validLogLevels.includes(LOG_LEVEL)) {
    errors.push(`LOG_LEVEL="${LOG_LEVEL}" is invalid. Must be one of: ${validLogLevels.join(', ')}`);
  }

  // Validate model name against registry
  if (GEMINI_MODEL && !GEMINI_MODELS[GEMINI_MODEL]) {
    const validModels = Object.keys(GEMINI_MODELS).join(', ');
    errors.push(`GEMINI_MODEL="${GEMINI_MODEL}" is not in the model registry. Valid models: ${validModels}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  FIREBASE_CONFIG,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GEMINI_CONTEXT_WINDOW,
  GEMINI_MODELS,
  setActiveModel,
  getActiveModelPricing,
  getMaxThinkingBudget,
  SPEED,
  SEG_TIME,
  PRESET,
  VIDEO_EXTS,
  AUDIO_EXTS,
  IMAGE_EXTS,
  MEDIA_EXTS,
  DOC_EXTS,
  GEMINI_FILE_API_EXTS,
  INLINE_TEXT_EXTS,
  DOC_PARSER_EXTS,
  GEMINI_UNSUPPORTED,
  MIME_MAP,
  LOG_LEVEL,
  MAX_PARALLEL_UPLOADS,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  THINKING_BUDGET,
  COMPILATION_THINKING_BUDGET,
  DEEP_DIVE_THINKING_BUDGET,
  GEMINI_POLL_TIMEOUT_MS,
  validateConfig,
};
