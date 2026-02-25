/**
 * Central configuration — all constants, API keys, and settings.
 *
 * Loads secrets from .env file (via dotenv) and falls back to defaults
 * for non-sensitive settings. Validates required keys at load time.
 */

'use strict';

const path = require('path');

// Load .env from project root (parent of src/)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

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
const GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-2.5-flash');
const GEMINI_CONTEXT_WINDOW = 1_048_576; // model input context limit (tokens)

// ======================== VIDEO PROCESSING ========================

const SPEED = envFloat('VIDEO_SPEED', 1.5);
const SEG_TIME = envInt('VIDEO_SEGMENT_TIME', 280); // seconds — produces segments < 5 min
const PRESET = env('VIDEO_PRESET', 'slow');
const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
const DOC_EXTS = ['.vtt', '.txt', '.pdf', '.docx', '.doc', '.srt', '.csv', '.md'];

// ======================== PIPELINE SETTINGS ========================

const LOG_LEVEL = env('LOG_LEVEL', 'info');
const MAX_PARALLEL_UPLOADS = envInt('MAX_PARALLEL_UPLOADS', 3);
const MAX_RETRIES = envInt('MAX_RETRIES', 3);
const RETRY_BASE_DELAY_MS = envInt('RETRY_BASE_DELAY_MS', 2000);

// Gemini thinking budget (tokens allocated for model reasoning)
const THINKING_BUDGET = envInt('THINKING_BUDGET', 24576);           // per-segment analysis
const COMPILATION_THINKING_BUDGET = envInt('COMPILATION_THINKING_BUDGET', 10240); // final compilation

// Gemini file API polling timeout (ms) — prevents indefinite hanging
const GEMINI_POLL_TIMEOUT_MS = envInt('GEMINI_POLL_TIMEOUT_MS', 300000); // 5 min

// ======================== GEMINI FILE HANDLING ========================

// Extensions that Gemini supports via File API for generateContent
const GEMINI_FILE_API_EXTS = ['.pdf'];
// Text-readable extensions — inlined as text parts (Gemini rejects text/vtt, text/csv etc. as fileData)
const INLINE_TEXT_EXTS = ['.vtt', '.srt', '.txt', '.md', '.csv'];
// Unsupported by Gemini — uploaded to Firebase only
const GEMINI_UNSUPPORTED = ['.docx', '.doc'];

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
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.json': 'application/json',
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

  if (SPEED <= 0 || SPEED > 10) {
    errors.push(`VIDEO_SPEED=${SPEED} is out of range. Must be between 0.1 and 10.`);
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

  return { valid: errors.length === 0, errors };
}

module.exports = {
  FIREBASE_CONFIG,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GEMINI_CONTEXT_WINDOW,
  SPEED,
  SEG_TIME,
  PRESET,
  VIDEO_EXTS,
  DOC_EXTS,
  GEMINI_FILE_API_EXTS,
  INLINE_TEXT_EXTS,
  GEMINI_UNSUPPORTED,
  MIME_MAP,
  LOG_LEVEL,
  MAX_PARALLEL_UPLOADS,
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  THINKING_BUDGET,
  COMPILATION_THINKING_BUDGET,
  GEMINI_POLL_TIMEOUT_MS,
  validateConfig,
};
