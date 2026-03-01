/**
 * Global configuration manager — persistent config stored in ~/.taskexrc
 *
 * Resolution priority (highest wins):
 *   1. CLI flags (--gemini-key, --firebase-key, etc.)
 *   2. process.env (set by user shell or CI)
 *   3. CWD .env file (project-specific)
 *   4. ~/.taskexrc (global persistent config)
 *   5. Package root .env (development fallback)
 *
 * The global config is a JSON file at ~/.taskexrc containing:
 *   { "GEMINI_API_KEY": "...", "FIREBASE_API_KEY": "...", ... }
 *
 * Use `taskex config` to interactively set/update keys.
 * Use `taskex config --show` to display current saved config.
 * Use `taskex config --clear` to remove the global config file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { c } = require('./colors');

// ── Config file path ──────────────────────────────────────────────────────
const CONFIG_FILE = path.join(os.homedir(), '.taskexrc');

// ── Known config keys ─────────────────────────────────────────────────────
// Maps config key name → description (for interactive prompts)
const CONFIG_KEYS = {
  GEMINI_API_KEY:          { label: 'Gemini API Key',          required: true,  hint: 'Get one at https://aistudio.google.com/apikey' },
  GEMINI_MODEL:            { label: 'Default Gemini Model',    required: false, hint: 'e.g. gemini-2.5-flash, gemini-2.5-pro' },
  FIREBASE_API_KEY:        { label: 'Firebase API Key',        required: false, hint: 'From Firebase Console → Project Settings' },
  FIREBASE_PROJECT_ID:     { label: 'Firebase Project ID',     required: false, hint: 'e.g. my-project-12345' },
  FIREBASE_STORAGE_BUCKET: { label: 'Firebase Storage Bucket', required: false, hint: 'e.g. my-project-12345.appspot.com' },
  FIREBASE_AUTH_DOMAIN:    { label: 'Firebase Auth Domain',    required: false, hint: 'e.g. my-project-12345.firebaseapp.com' },
};

// ── Read / Write ──────────────────────────────────────────────────────────

/**
 * Load the global config from ~/.taskexrc.
 * Returns an object of key-value pairs, or {} if file doesn't exist.
 * @returns {Record<string, string>}
 */
function loadGlobalConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    // Warn if file exists but is corrupt (not just missing)
    if (fs.existsSync(CONFIG_FILE)) {
      process.stderr.write(`  ${c.warn(`Could not parse ${CONFIG_FILE}: ${err.message}`)}\n`);
      process.stderr.write(`    Run \`taskex config\` to reconfigure, or delete the file.\n`);
    }
    return {};
  }
}

/**
 * Save the global config to ~/.taskexrc.
 * Merges new values into existing config (doesn't overwrite unrelated keys).
 * @param {Record<string, string>} newValues
 */
function saveGlobalConfig(newValues) {
  const existing = loadGlobalConfig();
  const merged = { ...existing, ...newValues };

  // Remove empty/null values
  for (const key of Object.keys(merged)) {
    if (!merged[key]) delete merged[key];
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  // Restrict permissions on config file (contains secrets)
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(CONFIG_FILE, 0o600);
    }
  } catch {
    // Best-effort — Windows doesn't support chmod
  }
}

/**
 * Delete the global config file.
 * @returns {boolean} true if file was deleted
 */
function clearGlobalConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Inject into process.env ───────────────────────────────────────────────

/**
 * Load global config and inject any values into process.env that aren't
 * already set. This respects the priority chain: env vars / CLI flags
 * that are already set take precedence over global config.
 *
 * Call this BEFORE dotenv loads (so it's lower priority than .env too — 
 * actually call it AFTER dotenv, but only inject if still missing).
 *
 * @returns {string[]} List of keys that were injected from global config
 */
function injectGlobalConfig() {
  const config = loadGlobalConfig();
  const injected = [];

  for (const [key, value] of Object.entries(config)) {
    if (value && (!process.env[key] || process.env[key] === '')) {
      process.env[key] = value;
      injected.push(key);
    }
  }

  return injected;
}

// ── Interactive setup ─────────────────────────────────────────────────────

/**
 * Mask a secret for display — shows first 4 + last 4 chars.
 * @param {string} value
 * @returns {string}
 */
function maskSecret(value) {
  if (!value || value.length < 12) return '****';
  return value.slice(0, 4) + '...' + value.slice(-4);
}

/**
 * Interactive config setup — prompts for each key and saves to ~/.taskexrc.
 * Shows current values (masked) and lets user update or keep existing.
 *
 * @param {object} [options]
 * @param {boolean} [options.showOnly=false]    Just display, don't prompt
 * @param {boolean} [options.clear=false]       Delete config file
 * @param {boolean} [options.onlyMissing=false] Only prompt for keys not yet set anywhere
 * @returns {Promise<void>}
 */
async function interactiveSetup({ showOnly = false, clear = false, onlyMissing = false } = {}) {
  const readline = require('readline');

  if (clear) {
    const removed = clearGlobalConfig();
    if (removed) {
      console.log(`\n  ${c.success('Global config cleared (~/.taskexrc deleted)')}\n`);
    } else {
      console.log('\n  No global config to clear.\n');
    }
    return;
  }

  const existing = loadGlobalConfig();

  if (showOnly) {
    console.log('');
    console.log('  Global Config (~/.taskexrc)');
    console.log('  ─────────────────────────────');

    const keys = Object.keys(CONFIG_KEYS);
    let hasAny = false;
    for (const key of keys) {
      const val = existing[key] || process.env[key];
      const source = existing[key] ? 'saved' : process.env[key] ? 'env' : '';
      if (val) {
        const display = key.includes('KEY') || key.includes('SECRET') ? maskSecret(val) : val;
        console.log(`    ${CONFIG_KEYS[key].label}: ${display}  (${source})`);
        hasAny = true;
      }
    }
    if (!hasAny) {
      console.log('    (empty — run `taskex config` to set up)');
    }
    console.log(`\n  Config file: ${CONFIG_FILE}\n`);
    return;
  }

  // Interactive prompts
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │              🔧  taskex — Global Configuration           │');
  console.log('  └──────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  Config file: ${CONFIG_FILE}`);
  console.log('  Values saved here are used whenever .env or CLI flags don\'t set them.');
  console.log('  Press Enter to keep the current value, or type a new one.');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise(resolve => {
    rl.question(question, answer => resolve((answer || '').trim()));
  });

  const updates = {};

  try {
    for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
      const current = existing[key] || process.env[key] || '';

      // If onlyMissing mode, skip keys that are already set
      if (onlyMissing && current) continue;

      const displayCurrent = current
        ? (key.includes('KEY') || key.includes('SECRET') ? maskSecret(current) : current)
        : '(not set)';

      const reqTag = meta.required ? ' *required*' : '';
      console.log(`  ${meta.label}${reqTag}`);
      if (meta.hint) console.log(`    ${meta.hint}`);
      console.log(`    Current: ${displayCurrent}`);

      const answer = await ask('    New value (Enter to keep): ');
      if (answer) {
        updates[key] = answer;
      }
      console.log('');
    }
  } finally {
    rl.close();
  }

  if (Object.keys(updates).length > 0) {
    saveGlobalConfig(updates);
    console.log(`  ${c.success(`Saved ${Object.keys(updates).length} value(s) to ${CONFIG_FILE}`)}`);
    console.log('');

    // Also inject into current process so the pipeline can proceed
    for (const [k, v] of Object.entries(updates)) {
      process.env[k] = v;
    }
  } else {
    console.log('  No changes made.');
    console.log('');
  }
}

/**
 * Quick prompt for a single missing required key.
 * Used during first-run when GEMINI_API_KEY is missing after all resolution.
 *
 * @param {string} key - The config key (e.g. 'GEMINI_API_KEY')
 * @returns {Promise<string|null>} The value entered, or null if skipped
 */
async function promptForKey(key) {
  const meta = CONFIG_KEYS[key];
  if (!meta) return null;

  const readline = require('readline');

  console.log('');
  console.log(`  ${c.warn(`${meta.label} is not configured.`)}`);
  if (meta.hint) console.log(`    ${meta.hint}`);
  console.log('');

  let value;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    value = await new Promise(resolve => {
      rl.question(`  Enter ${meta.label}: `, answer => resolve((answer || '').trim()));
    });
  } finally {
    rl.close();
  }

  if (!value) return null;

  // Ask if they want to save globally
  let save;
  const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    save = await new Promise(resolve => {
      rl2.question('  Save to global config for future use? (Y/n): ', answer => {
        const a = (answer || '').trim().toLowerCase();
        resolve(a === '' || a === 'y' || a === 'yes');
      });
    });
  } finally {
    rl2.close();
  }

  if (save) {
    saveGlobalConfig({ [key]: value });
    console.log(`  ${c.success(`Saved to ${CONFIG_FILE}`)}`);
  }

  // Inject into current process
  process.env[key] = value;
  return value;
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  CONFIG_FILE,
  CONFIG_KEYS,
  loadGlobalConfig,
  saveGlobalConfig,
  clearGlobalConfig,
  injectGlobalConfig,
  interactiveSetup,
  promptForKey,
  maskSecret,
};
