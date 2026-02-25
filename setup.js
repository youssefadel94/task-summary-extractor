#!/usr/bin/env node
/**
 * Task Summary Extractor — Complete Setup
 *
 * Sets up everything needed from zero to working:
 *   1. Checks prerequisites (Node.js, ffmpeg, git)
 *   2. Installs npm dependencies
 *   3. Creates .env with API key
 *   4. Sets up .gitignore for local data
 *   5. Creates sample call folder structure
 *   6. Optionally creates a local working branch
 *   7. Validates the pipeline loads
 *
 * Usage:
 *   node setup.js              Full interactive setup
 *   node setup.js --check      Validation only (no changes)
 *   node setup.js --silent     Non-interactive (skip prompts, use defaults)
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ─── Constants ────────────────────────────────────────────────────────────────

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
const GITIGNORE_FILE = path.join(ROOT, '.gitignore');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const SAMPLE_CALL = path.join(ROOT, 'sample-call');

const CHECK_ONLY = process.argv.includes('--check');
const SILENT = process.argv.includes('--silent');
const REQUIRED_NODE_VERSION = 18;

const ENV_TEMPLATE = `# ─── Required ──────────────────────────────────────────
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE

# ─── Optional: Firebase (skip if using --skip-upload) ──
# Get these from Firebase Console → Project Settings → General
# FIREBASE_API_KEY=
# FIREBASE_AUTH_DOMAIN=
# FIREBASE_PROJECT_ID=
# FIREBASE_STORAGE_BUCKET=
# FIREBASE_MESSAGING_SENDER_ID=
# FIREBASE_APP_ID=
# FIREBASE_MEASUREMENT_ID=

# ─── Optional: Tuning ─────────────────────────────────
# GEMINI_MODEL=gemini-2.5-flash
# VIDEO_SPEED=1.5
# VIDEO_SEGMENT_TIME=280
# VIDEO_PRESET=slow
# THINKING_BUDGET=24576
# COMPILATION_THINKING_BUDGET=10240
# LOG_LEVEL=info
# MAX_PARALLEL_UPLOADS=3
`;

const GITIGNORE_CONTENT = `# ─── Local Data (call folders, results, logs) ─────────
call */
logs/
gemini_runs/

# ─── Video Files ──────────────────────────────────────
**/*.mp4
**/*.mkv
**/*.avi
**/*.mov
**/*.webm

# ─── Environment & Dependencies ───────────────────────
.env
.env.local
node_modules/

# ─── OS / Editor ──────────────────────────────────────
.DS_Store
Thumbs.db
*.swp
*.swo
.vscode/settings.json
`;

const SAMPLE_README = `# Sample Meeting Folder

This is a sample folder. Replace with your actual recording.

## How to use

1. Drop your video file here (e.g., \`Meeting Recording.mp4\`)
2. Add subtitles if available (e.g., \`Meeting Recording.vtt\`)
3. Add any relevant docs in subfolders — the pipeline scans ALL subfolders recursively
4. Run: \`node process_and_upload.js --name "Your Name" "sample-call"\`

## Folder structure

\`\`\`
sample-call/
├── your-video.mp4              ← Required: your recording
├── your-video.vtt              ← Recommended: subtitles
├── agenda.md                   ← Optional: loose docs at root work too
│
├── .tasks/                     ← Optional: gets highest priority in AI prompt
│   ├── code-map.md
│   └── team.csv
├── specs/                      ← Any folder name — all are scanned
│   └── requirements.md
├── notes/                      ← Add as many context folders as you need
│   └── previous-decisions.md
│
├── compressed/                 ← Auto-generated: compressed segments
└── runs/                       ← Auto-generated: analysis results
\`\`\`

## Use case examples

- **Dev call**: .tasks/code-map.md, .tasks/current-sprint.md, docs/tech-debt.md
- **Client meeting**: requirements/scope.md, contracts/sow.md, .tasks/stakeholders.csv
- **Interview**: role/job-description.md, role/evaluation-rubric.md
- **Incident review**: systems/architecture.md, runbooks/service-x.md
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ICONS = { ok: '\u2705', fail: '\u274c', warn: '\u26a0\ufe0f', info: '\u2139\ufe0f', gear: '\u2699\ufe0f', rocket: '\ud83d\ude80', folder: '\ud83d\udcc1' };

function print(icon, msg) { console.log(`  ${icon}  ${msg}`); }
function printSub(msg) { console.log(`       ${msg}`); }

function header(num, title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Step ${num}: ${title}`);
  console.log(`${'─'.repeat(60)}\n`);
}

function commandExists(cmd) {
  try {
    const where = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${where} ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function getVersion(cmd, flag = '--version') {
  try {
    return execSync(`${cmd} ${flag}`, { stdio: 'pipe' }).toString().trim().split('\n')[0];
  } catch { return null; }
}

function ask(question) {
  if (SILENT) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

async function confirm(question, defaultYes = true) {
  if (SILENT) return defaultYes;
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await ask(`  ${question} ${suffix} `);
  if (answer === '') return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

// ─── Tracking ─────────────────────────────────────────────────────────────────

const counts = { pass: 0, fail: 0, warn: 0, action: 0 };
function pass(msg) { counts.pass++; print(ICONS.ok, msg); }
function fail(msg, hint) { counts.fail++; print(ICONS.fail, msg); if (hint) printSub(`→ ${hint}`); }
function warn(msg, hint) { counts.warn++; print(ICONS.warn, msg); if (hint) printSub(`→ ${hint}`); }
function action(msg) { counts.action++; print(ICONS.gear, msg); }

// ─── Step 1: Prerequisites ───────────────────────────────────────────────────

function checkPrerequisites() {
  header(1, 'Prerequisites');

  // Node.js
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor >= REQUIRED_NODE_VERSION) {
    pass(`Node.js v${process.versions.node} (requires ≥${REQUIRED_NODE_VERSION})`);
  } else {
    fail(`Node.js v${process.versions.node} — requires ≥${REQUIRED_NODE_VERSION}`, 'Download from https://nodejs.org/');
  }

  // ffmpeg
  if (commandExists('ffmpeg')) {
    const ver = getVersion('ffmpeg', '-version');
    const short = ver ? ver.replace(/^ffmpeg version\s+/i, '').split(' ')[0] : 'found';
    pass(`ffmpeg ${short}`);
  } else if (process.platform === 'win32' && fs.existsSync('C:\\ffmpeg\\bin\\ffmpeg.exe')) {
    pass('ffmpeg found at C:\\ffmpeg\\bin\\');
  } else {
    fail('ffmpeg not found in PATH',
      process.platform === 'win32'
        ? 'Download: https://www.gyan.dev/ffmpeg/builds/ → add to PATH or C:\\ffmpeg\\bin\\'
        : 'Install: brew install ffmpeg (macOS) / apt install ffmpeg (Linux)');
  }

  // Git
  if (commandExists('git')) {
    const ver = getVersion('git') || 'found';
    pass(`Git ${ver.replace('git version ', '')}`);
  } else {
    warn('Git not found — --update-progress feature will be unavailable',
      'Install from https://git-scm.com/downloads');
  }
}

// ─── Step 2: Dependencies ────────────────────────────────────────────────────

async function installDependencies() {
  header(2, 'Dependencies');

  if (fs.existsSync(NODE_MODULES)) {
    // Check if key packages exist
    const hasGenai = fs.existsSync(path.join(NODE_MODULES, '@google', 'genai'));
    const hasFirebase = fs.existsSync(path.join(NODE_MODULES, 'firebase'));
    const hasDotenv = fs.existsSync(path.join(NODE_MODULES, 'dotenv'));

    if (hasGenai && hasFirebase && hasDotenv) {
      pass('All dependencies installed');
      return;
    }
    warn('node_modules exists but some packages are missing');
  }

  if (CHECK_ONLY) {
    fail('Dependencies not fully installed', 'Run: node setup.js');
    return;
  }

  action('Running npm install...');
  try {
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
    pass('npm install completed');
  } catch {
    fail('npm install failed', 'Try: rm -rf node_modules && npm install');
  }
}

// ─── Step 3: Environment ─────────────────────────────────────────────────────

async function setupEnvironment() {
  header(3, 'Environment Configuration');

  if (fs.existsSync(ENV_FILE)) {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const hasKey = /GEMINI_API_KEY\s*=\s*\S+/.test(content) && !content.includes('YOUR_GEMINI_API_KEY_HERE');

    if (hasKey) {
      pass('.env file with GEMINI_API_KEY configured');
      return;
    }
    warn('.env exists but GEMINI_API_KEY not set', 'Edit .env and add your key from https://aistudio.google.com/apikey');
    return;
  }

  if (CHECK_ONLY) {
    fail('.env file not found', 'Run: node setup.js');
    return;
  }

  action('Creating .env from template...');
  let content = ENV_TEMPLATE;

  const key = await ask('  Enter your Gemini API key (or Enter to skip): ');
  if (key) {
    content = content.replace('YOUR_GEMINI_API_KEY_HERE', key);
    pass('Gemini API key saved to .env');
  } else {
    warn('Gemini API key not set — edit .env later', 'Get key: https://aistudio.google.com/apikey');
  }

  fs.writeFileSync(ENV_FILE, content, 'utf8');
  pass('.env file created');
}

// ─── Step 4: Git Ignore ──────────────────────────────────────────────────────

function setupGitignore() {
  header(4, 'Git Configuration');

  if (fs.existsSync(GITIGNORE_FILE)) {
    const content = fs.readFileSync(GITIGNORE_FILE, 'utf8');

    // Check for essential patterns
    const hasCallFolders = content.includes('call */') || content.includes('call*/');
    const hasEnv = content.includes('.env');
    const hasLogs = content.includes('logs/');
    const hasGeminiRuns = content.includes('gemini_runs/');
    const hasNodeModules = content.includes('node_modules');

    if (hasCallFolders && hasEnv && hasLogs && hasGeminiRuns && hasNodeModules) {
      pass('.gitignore properly configured');
      return;
    }
  }

  if (CHECK_ONLY) {
    warn('.gitignore needs updating', 'Run: node setup.js');
    return;
  }

  action('Writing .gitignore (local data excluded from repo)...');
  fs.writeFileSync(GITIGNORE_FILE, GITIGNORE_CONTENT, 'utf8');
  pass('.gitignore configured — call folders, .env, logs, videos excluded');
}

// ─── Step 5: Sample Meeting Folder ───────────────────────────────────────────

async function setupSampleFolder() {
  header(5, 'Sample Meeting Folder');

  // Check if any call/meeting folder exists
  const entries = fs.readdirSync(ROOT);
  const hasCallFolder = entries.some(e => {
    const fullPath = path.join(ROOT, e);
    return fs.statSync(fullPath).isDirectory() &&
      (e.startsWith('call') || e === 'sample-call') &&
      !['node_modules', '.git', 'src', 'logs', 'gemini_runs'].includes(e);
  });

  if (hasCallFolder) {
    pass('Meeting folder already exists');
    return;
  }

  if (CHECK_ONLY) {
    warn('No meeting folder found', 'Create one or run: node setup.js');
    return;
  }

  const create = await confirm('Create a sample meeting folder with README?');
  if (!create) {
    warn('Skipped — create a meeting folder manually when ready');
    return;
  }

  // Create sample-call structure
  fs.mkdirSync(SAMPLE_CALL, { recursive: true });
  fs.mkdirSync(path.join(SAMPLE_CALL, '.tasks'), { recursive: true });
  fs.writeFileSync(path.join(SAMPLE_CALL, 'README.md'), SAMPLE_README, 'utf8');
  fs.writeFileSync(path.join(SAMPLE_CALL, '.tasks', 'context.md'),
    '# Project Context\n\nDescribe your project, team, or meeting context here.\nThe AI uses this to better understand what\'s discussed in the recording.\n\n## Examples by Use Case\n\n### Dev Project\n- `src/api/` — REST API endpoints\n- `src/models/` — Database models\n- Sprint: TICKET-123 (auth), TICKET-456 (payments)\n\n### Client Project\n- Deliverable: Phase 1 UI redesign\n- Stakeholders: Jane (PM), Ahmed (Design Lead)\n- Contract scope: 6 screens, responsive, Q1 deadline\n\n### General\n- Meeting purpose: [describe]\n- Key participants: [list]\n- Relevant docs: [reference]\n', 'utf8');

  pass('sample-call/ created with README and .tasks/ templates');
  printSub('Drop your video file in sample-call/ to get started');
  printSub('See README.md for .tasks/ examples by use case (dev, client, interview, etc.)');
}

// ─── Step 6: Local Branch ────────────────────────────────────────────────────

async function setupBranch() {
  header(6, 'Working Branch');

  if (!commandExists('git')) {
    warn('Git not available — skipping branch setup');
    return;
  }

  // Check if we're in a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: ROOT, stdio: 'pipe' });
  } catch {
    warn('Not a git repository — skipping branch setup');
    return;
  }

  // Check current branch
  let currentBranch;
  try {
    currentBranch = execSync('git branch --show-current', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
  } catch {
    currentBranch = 'unknown';
  }

  if (currentBranch.startsWith('local/')) {
    pass(`Already on local branch: ${currentBranch}`);
    return;
  }

  if (CHECK_ONLY) {
    warn(`On branch ${currentBranch} — consider creating a local branch`,
      'Run: git checkout -b local/my-workspace');
    return;
  }

  print(ICONS.info, `Current branch: ${currentBranch}`);
  printSub('Recommended: create a local branch to separate your data from tool code.');
  printSub('This lets you pull updates from main without conflicts.');
  console.log('');

  const create = await confirm('Create local/my-workspace branch?');
  if (!create) {
    warn('Skipped — you can create it later: git checkout -b local/my-workspace');
    return;
  }

  try {
    execSync('git checkout -b local/my-workspace', { cwd: ROOT, stdio: 'pipe' });
    pass('Created and switched to branch: local/my-workspace');
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().trim() : '';
    if (msg.includes('already exists')) {
      try {
        execSync('git checkout local/my-workspace', { cwd: ROOT, stdio: 'pipe' });
        pass('Switched to existing branch: local/my-workspace');
      } catch {
        warn('Branch local/my-workspace exists but could not switch', 'Run: git checkout local/my-workspace');
      }
    } else {
      warn('Could not create branch', msg || 'Run: git checkout -b local/my-workspace');
    }
  }
}

// ─── Step 7: Validation ──────────────────────────────────────────────────────

function validate() {
  header(7, 'Validation');

  // Check pipeline loads
  if (!fs.existsSync(NODE_MODULES)) {
    warn('Skipping pipeline validation — no node_modules');
    return;
  }

  try {
    execSync('node -e "require(\'./src/pipeline\')"', { cwd: ROOT, stdio: 'pipe', timeout: 15000 });
    pass('Pipeline module loads successfully');
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().split('\n')[0] : '';
    fail('Pipeline failed to load', msg || 'Run: node -e "require(\'./src/pipeline\')" for details');
  }

  // Check version
  try {
    const version = execSync('node process_and_upload.js --version', { cwd: ROOT, stdio: 'pipe', timeout: 10000 })
      .toString().trim().split('\n').pop();
    pass(`Version: ${version}`);
  } catch {
    warn('Could not read version');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   Task Summary Extractor — Setup v6.1   ║');
  console.log('  ╚══════════════════════════════════════════╝');

  if (CHECK_ONLY) {
    console.log('\n  Mode: Validation only (--check)\n');
  }

  // Run all steps
  checkPrerequisites();
  await installDependencies();
  await setupEnvironment();
  setupGitignore();
  await setupSampleFolder();
  await setupBranch();
  validate();

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  Summary');
  console.log(`${'═'.repeat(60)}\n`);

  console.log(`  ${ICONS.ok} Passed: ${counts.pass}`);
  if (counts.warn > 0) console.log(`  ${ICONS.warn} Warnings: ${counts.warn}`);
  if (counts.fail > 0) console.log(`  ${ICONS.fail} Failed: ${counts.fail}`);
  if (counts.action > 0) console.log(`  ${ICONS.gear} Actions taken: ${counts.action}`);
  console.log('');

  if (counts.fail === 0) {
    console.log(`  ${ICONS.rocket}  Setup complete! You're ready to go.\n`);
    console.log('  Next steps:');
    console.log('  ──────────');
    console.log('  1. Drop a video in your call folder');
    console.log('  2. Run:  node process_and_upload.js --name "Your Name" "call 1"');
    console.log('  3. Open: call 1/runs/{timestamp}/results.md');
    console.log('');
    console.log('  Docs:  README.md  ·  QUICK_START.md  ·  ARCHITECTURE.md');
    console.log('');
  } else {
    console.log(`  ${ICONS.fail}  ${counts.fail} issue(s) need fixing.\n`);
    console.log('  Fix the issues above, then re-run:');
    console.log('    node setup.js');
    console.log('');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
