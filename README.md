# Task Summary Extractor

> **v10.2.3** — AI-powered content analysis CLI — meetings, recordings, documents, or any mix. Install globally, run anywhere.

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-green" alt="Node.js" />
  <img src="https://img.shields.io/badge/gemini-2.5%2B-blue" alt="Gemini" />
  <img src="https://img.shields.io/badge/firebase-12.x-orange" alt="Firebase" />
  <img src="https://img.shields.io/badge/version-10.2.3-brightgreen" alt="Version" />
  <img src="https://img.shields.io/badge/tests-423%20passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/npm-task--summary--extractor-red" alt="npm" />
</p>

**Analyze any content → get a structured task document.** Feed it meeting recordings, audio files, documents, or any mix — it extracts work items, action items, blockers, and more. Or point it at any folder and generate docs from context.

📖 **New here?** Jump to [Setup (3 steps)](#setup-3-steps) — you'll be running in under 5 minutes.

---

## What It Does

### 🎥 Content Analysis (default mode)

Drop a recording (video/audio) or documents in a folder → run the tool → get a Markdown task document with:

- **Tickets** — ID, title, status, assignee, confidence score
- **Change Requests** — what changed, where, how, why
- **Action Items** — who does what, by when
- **Blockers** — severity, owner, proposed resolution
- **Scope Changes** — added, removed, deferred items
- **Your Tasks** — personalized list scoped to your name

```bash
taskex --name "Jane" "my-meeting"
```

### 📝 Dynamic Mode (`--dynamic`)

No video needed. Point at a folder with docs, tell it what you want:

```bash
taskex --dynamic --request "Plan migration from MySQL to Postgres" "db-specs"
```

Generates 3–15 Markdown documents: overviews, guides, checklists, decision records, etc.

### 🔍 Deep Dive (`--deep-dive`)

After video analysis, generate standalone docs for every topic discussed:

```bash
taskex --deep-dive --name "Jane" "my-meeting"
```

### 📊 Progress Tracking (`--update-progress`)

Check which items from a previous analysis have been completed, using git evidence:

```bash
taskex --update-progress --repo "C:\my-project" "my-meeting"
```

> **v7.2.3**: If the call folder isn't a git repo, the tool auto-initializes one for baseline tracking.

### ⚡ Deep Summary (`--deep-summary`)

Pre-summarize context documents to reduce per-segment token usage by 60-80%:

```bash
taskex --deep-summary --name "Jane" "my-meeting"
```

Exclude specific docs from summarization (keep at full fidelity):

```bash
taskex --deep-summary --exclude-docs "code-map.md,sprint.md" "my-meeting"
```

> See all modes explained with diagrams → [ARCHITECTURE.md](ARCHITECTURE.md#pipeline-phases)

---

## Setup (3 Steps)

### What You Need First

| Requirement | How to Check | Get It |
|-------------|-------------|--------|
| **Node.js ≥ 18** | `node --version` | [nodejs.org](https://nodejs.org/) |
| **ffmpeg** | `ffmpeg -version` | [gyan.dev/ffmpeg](https://www.gyan.dev/ffmpeg/builds/) — add to PATH |
| **Gemini API Key** | — | [Google AI Studio](https://aistudio.google.com/apikey) — free tier available |

> **Git** is optional — only needed for `--update-progress` mode.

### Step 1: Install

**Option A — npm global install (recommended):**

```bash
npm install -g task-summary-extractor
```

Now `taskex` is available system-wide. Done.

**Option B — Clone & install (development):**

```bash
git clone https://github.com/youssefadel94/task-summary-extractor.git
cd task-summary-extractor
node setup.js
```

The setup script does everything: installs dependencies, creates your `.env`, prompts for your API key, validates the pipeline. **Follow the prompts — it takes 1 minute.**

### Step 2: Add your recording

Create a folder and drop your video in it:

```
my-meeting/
├── Recording.mp4          ← your video file
└── Recording.vtt          ← subtitles (optional, improves quality a lot)
```

> You can also add docs (`.md`, `.pdf`, `.txt`, `.csv`) in any subfolders — the tool finds everything automatically. More context → better results.

### Step 3: Run

```bash
taskex --name "Your Name" "my-meeting"
```

Or just run `taskex` inside a folder — it'll walk you through everything interactively.

**First time? Save your API key globally (one time):**

```bash
taskex config
```

This saves your Gemini key to `~/.taskexrc` — you'll never need to pass it again.

**Or pass it inline (no setup needed):**

```bash
taskex --gemini-key "YOUR_KEY" --name "Your Name" "my-meeting"
```

**Done.** Your results are in `my-meeting/runs/{timestamp}/results.md`.

> 🎓 **Full walkthrough** with examples, folder structures, and troubleshooting → [QUICK_START.md](QUICK_START.md)

---

## CLI Flags

Every flag is optional. Run with no flags for fully interactive mode.

### Configuration Flags

Pass API keys and config directly — no `.env` file needed:

| Flag | What It Does | Example |
|------|-------------|---------|
| `--gemini-key <key>` | Gemini API key | `--gemini-key "AIza..."` |
| `--firebase-key <key>` | Firebase API key | `--firebase-key "AIza..."` |
| `--firebase-project <id>` | Firebase project ID | `--firebase-project "my-proj"` |
| `--firebase-bucket <bucket>` | Firebase storage bucket | `--firebase-bucket "my-proj.appspot.com"` |
| `--firebase-domain <domain>` | Firebase auth domain | `--firebase-domain "my-proj.firebaseapp.com"` |

> Config flags override `.env` values. You can mix both — flags take priority.

### Everyday Flags

These are the ones you'll actually use:

| Flag | What It Does | Example |
|------|-------------|---------|
| `--name <name>` | Set your name (skips prompt) | `--name "Jane"` |
| `--model <id>` | Pick a Gemini model (skips selector) | `--model gemini-2.5-pro` |
| `--skip-upload` | Don't upload to Firebase (local only) | `--skip-upload` |
| `--force-upload` | Re-upload files even if they already exist | `--force-upload` |
| `--resume` | Continue an interrupted run | `--resume` |
| `--reanalyze` | Force fresh analysis (ignore cache) | `--reanalyze` |
| `--dry-run` | Preview what would run, without running | `--dry-run` |
| `--format <type>` | Output format: `md`, `html`, `json`, `pdf`, `docx`, `all` (default: `all`) | `--format html` |
| `--min-confidence <level>` | Filter items by confidence: `high`, `medium`, `low` | `--min-confidence high` |
| `--no-html` | Suppress HTML report generation | `--no-html` |
| `--deep-summary` | Pre-summarize context docs (60-80% token savings) | `--deep-summary` |
| `--exclude-docs <list>` | Docs to keep full during deep-summary (comma-separated) | `--exclude-docs "code-map.md"` |

**Typical usage:**

```bash
# Interactive — picks folder, model, prompts for name
taskex

# Specify everything upfront
taskex --name "Jane" --model gemini-2.5-pro --skip-upload "my-meeting"

# Resume a run that crashed halfway
taskex --resume "my-meeting"

# Pass API key directly (no .env needed)
taskex --gemini-key "AIza..." --name "Jane" "my-meeting"
```

### Mode Flags

Choose what the tool does. Only use one at a time:

| Flag | Mode | What You Get |
|------|------|-------------|
| *(none)* | **Content analysis** | `results.md` + `results.html` + `results.json` + `results.pdf` + `results.docx` — structured task document (all formats by default) |
| `--dynamic` | **Doc generation** | `INDEX.md` + 3–15 topic documents |
| `--deep-dive` | **Topic explainers** | `INDEX.md` + per-topic deep-dive docs |
| `--deep-summary` | **Token-efficient analysis** | Same as content analysis, but context docs pre-summarized (60-80% savings) |
| `--update-progress` | **Progress check** | `progress.md` — item status via git |

**Dynamic mode** also uses:

| Flag | Purpose | Example |
|------|---------|---------|
| `--request <text>` | Tell the AI what to generate | `--request "Create onboarding guide"` |

**Progress tracking** also uses:

| Flag | Purpose | Example |
|------|---------|---------|
| `--repo <path>` | Git repo to check for evidence | `--repo "C:\my-project"` |

### Skip Flags

Skip parts of the pipeline you don't need:

| Flag | What It Skips | When to Use |
|------|--------------|-------------|
| `--skip-upload` | Firebase upload | Running locally, no Firebase configured |
| `--force-upload` | Skip-existing checks | Re-upload files that already exist in Storage |
| `--no-storage-url` | Storage URL optimization | Force Gemini File API upload (debugging) |
| `--skip-compression` | Video compression | You already compressed/segmented the video |
| `--skip-gemini` | AI analysis entirely | You just want to compress & upload |

### Video Processing Flags

Control how video is processed before AI analysis:

| Flag | Default | Description |
|------|---------|-------------|
| `--no-compress` | off | Skip re-encoding — pass raw video to Gemini (auto-splits at 20 min) |
| `--speed <n>` | `1.6` | Playback speed multiplier (compress mode only) |
| `--segment-time <n>` | `280` | Segment duration in seconds, compress mode only (30–3600) |

**Duration constraints** (per [Google Gemini docs](https://ai.google.dev/gemini-api/docs/vision#video)):
- Default resolution: ~300 tokens/sec → max ~55 min/segment (recommended: ≤20 min)
- File API limit: 2 GB/file (free) / 20 GB (paid)
- Supported formats: mp4, mpeg, mov, avi, x-flv, mpg, webm, wmv, 3gpp

> **Tip:** Use `--no-compress` for large, high-quality recordings that you want to analyze at original quality. Raw video is auto-split at 20-minute intervals via `ffmpeg -c copy` (stream-copy). `--speed` and `--segment-time` only apply to compression mode.

### Tuning Flags

**You probably don't need these.** The defaults work well. These are for power users:

| Flag | Default | What It Controls |
|------|---------|-----------------|
| `--thinking-budget <n>` | `24576` | AI thinking tokens per segment — higher = more thorough, slower, costlier |
| `--compilation-thinking-budget <n>` | `10240` | AI thinking tokens for the final cross-segment compilation |
| `--parallel <n>` | `3` | Max concurrent Firebase uploads |
| `--parallel-analysis <n>` | `2` | Max concurrent AI segment analyses |
| `--log-level <level>` | `info` | `debug` / `info` / `warn` / `error` |
| `--output <dir>` | auto | Custom output directory (default: `runs/{timestamp}`) |
| `--no-focused-pass` | enabled | Disable targeted re-analysis of weak segments |
| `--no-learning` | enabled | Disable auto-tuning from historical run data |
| `--no-diff` | enabled | Disable diff comparison with the previous run |
| `--no-batch` | enabled | Disable multi-segment batching (force 1 segment per API call) |

### Available Models

Use `--model <id>` or run without it for an interactive picker:

| Model ID | Speed | Cost | Best For |
|----------|-------|------|----------|
| `gemini-2.5-flash` | ⚡ Fast | $ | **Default** — best price-performance |
| `gemini-2.5-flash-lite` | ⚡⚡ Fastest | ¢ | High volume, budget runs |
| `gemini-2.5-pro` | 🧠 Slower | $$ | Deep reasoning, complex meetings |
| `gemini-3-flash-preview` | ⚡ Fast | $ | Latest flash model |
| `gemini-3.1-pro-preview` | 🧠 Slower | $$$ | Most capable overall |

### Cheat Sheet

```
taskex [flags] [folder]

CONFIG     --gemini-key  --firebase-key  --firebase-project
           --firebase-bucket  --firebase-domain
MODES      --dynamic  --deep-dive  --deep-summary  --update-progress
CORE       --name  --model  --skip-upload  --resume  --reanalyze  --dry-run
OUTPUT     --format <md|html|json|pdf|docx|all>  --min-confidence <high|medium|low>
           --no-html
UPLOAD     --force-upload  --no-storage-url
SKIP       --skip-compression  --skip-gemini
VIDEO      --no-compress  --speed <n>  --segment-time <n>
DYNAMIC    --request <text>
PROGRESS   --repo <path>
TUNING     --thinking-budget  --compilation-thinking-budget  --parallel
           --parallel-analysis  --log-level  --output
           --no-focused-pass  --no-learning  --no-diff  --no-batch
INFO       --help (-h)  --version (-v)
```

---

## Output

### Content Analysis

```
my-meeting/runs/{timestamp}/
├── results.md            ← Open this — your task document
├── results.html          ← Interactive HTML report (self-contained)
├── results.json          ← Full pipeline data
└── compilation.json      ← All extracted items (JSON)
```

### Dynamic Mode

```
my-project/runs/{timestamp}/
├── INDEX.md              ← Open this — document index
├── dm-01-overview.md
├── dm-02-guide.md
└── dynamic-run.json
```

### Deep Dive

```
my-meeting/runs/{timestamp}/deep-dive/
├── INDEX.md              ← Open this — topic index
├── dd-01-topic.md
├── dd-02-topic.md
└── deep-dive.json
```

### Progress Update

```
my-meeting/runs/{timestamp}/
├── progress.md           ← Status report with git evidence
└── progress.json
```

---

## Folder Setup Tips

Drop content files and supporting docs in a folder. **More context = better extraction.**

```
my-meeting/
├── Recording.mp4                  ← Video recording (primary for video mode)
├── Recording.vtt                  ← Subtitles (highly recommended for recordings)
├── agenda.md                      ← Loose docs at root are fine
│
├── .tasks/                        ← Gets priority weighting (optional)
│   ├── code-map.md                ← What each module/component does
│   └── current-sprint.md          ← Current sprint goals and tickets
│
└── specs/                         ← Any subfolder name works
    └── requirements.md
```

**Supported formats:** `.mp4` `.mkv` `.webm` `.avi` `.mov` (video) · `.mp3` `.wav` `.ogg` `.m4a` `.flac` `.aac` `.wma` (audio) · `.vtt` `.srt` `.txt` `.md` `.csv` `.pdf` (docs)

The tool **recursively scans all subfolders**. `.tasks/` gets highest priority weighting but everything is included.

| What Helps Most | Why |
|-----------------|-----|
| **Subtitles** (`.vtt`/`.srt`) | Dramatically improves name/ID extraction |
| **Team roster** (`.csv`) | Accurate attribution of action items |
| **Code map / architecture docs** | AI matches changes to actual files |
| **Sprint / board exports** | Status context for discussed items |

---

## Configuration

### Global Config (recommended)

Save your API keys once — they persist across all projects:

```bash
taskex config              # Interactive setup — saves to ~/.taskexrc
taskex config --show       # View saved config (secrets masked)
taskex config --clear      # Delete saved config
```

**First-run experience:** If no Gemini key is found anywhere, the tool prompts you to enter one and offers to save it globally.

### Config Resolution Priority

Highest wins:

1. **CLI flags** — `--gemini-key`, `--firebase-key`, etc.
2. **Environment variables** — `export GEMINI_API_KEY=...`
3. **CWD `.env` file** — project-specific config
4. **`~/.taskexrc`** — global persistent config
5. **Package root `.env`** — development fallback

All methods are fully backward-compatible.

### CLI Config Flags

Pass keys directly — no files needed:

```bash
taskex --gemini-key "AIza..." --name "Jane" "my-meeting"
```

### `.env` File

For repeated use, create a `.env` in your **working directory**. Run `node setup.js` (from the cloned repo) to generate one automatically.

Only `GEMINI_API_KEY` is required — everything else has defaults:

```env
# Required
GEMINI_API_KEY=your-key-here

# Optional — uncomment to customize
# GEMINI_MODEL=gemini-2.5-flash
# VIDEO_SPEED=1.6
# THINKING_BUDGET=24576
# LOG_LEVEL=info

# Optional — Firebase (or just use --skip-upload)
# FIREBASE_API_KEY=...
# FIREBASE_AUTH_DOMAIN=...
# FIREBASE_PROJECT_ID=...
# FIREBASE_STORAGE_BUCKET=...
```

> Full variable list + video encoding parameters → [ARCHITECTURE.md](ARCHITECTURE.md#tech-stack)

---

## Features

| Feature | Description |
|---------|-------------|
| **Video/Audio Compression** | H.264 CRF 24, text-optimized sharpening, 1.6× speed |
| **Smart Segmentation** | ≤5 min chunks with boundary-aware splitting |
| **Cross-Segment Continuity** | Ticket IDs, names, and context carry forward |
| **Document Discovery** | Auto-finds docs in all subfolders |
| **Storage URL Optimization** | Firebase download URLs reused as Gemini External URLs — skips separate File API upload |
| **Upload Control Flags** | `--force-upload` to re-upload, `--no-storage-url` to force File API — full control over upload behavior |
| **3-Strategy File Resolution** | Reuse URI → Storage URL → File API upload (zero redundant uploads) |
| **Gemini File Cleanup** | Auto-deletes File API uploads after analysis completes |
| **Quality Gate** | 4-dimension scoring with auto-retry |
| **Focused Re-Analysis** | Targeted second pass on weak areas |
| **Learning Loop** | Auto-tunes budgets from past run quality |
| **Diff Engine** | Shows what changed between runs |
| **Confidence Scoring** | Every item rated HIGH/MEDIUM/LOW with evidence |
| **Model Selection** | 5 Gemini models — interactive picker or `--model` |
| **Git Progress Tracking** | Correlates commits with extracted items |
| **Deep Dive** | Explanatory docs per topic discussed |
| **Dynamic Mode** | Generate docs from any content mix |
| **Progress Bar** | Real-time visual progress with phase tracking, ETA, and cost display |
| **HTML Report** | Self-contained HTML report with collapsible sections, filtering, dark mode |
| **JSON Schema Validation** | Validates AI output against JSON Schema (segment + compiled) |
| **Confidence Filter** | `--min-confidence` flag to exclude low-confidence items from output |
| **Deep Summary** | `--deep-summary` pre-summarizes context docs, 60-80% token savings per segment — auto-splits failed batches and retries |
| **Deep Summary Batch Recovery** | When a batch returns 0 output (model exhausts thinking budget), splits in half and retries each sub-batch |
| **Compilation Auto-Retry** | Phase 5 auto-retries with 1.5× thinking budget on parse failure or quality FAIL |
| **Dynamic Mode Fallback** | If compilation fails in dynamic mode, merges segment analyses directly — prevents silent 0-output |
| **Interactive Feature Flags** | Run `taskex` → select Custom or Dynamic mode → checkbox UI to toggle deep-summary, deep-dive, focused pass, learning loop, diff engine, batch processing |
| **Run Mode Presets** | Fast, Balanced, Detailed, Custom, or Dynamic — preconfigured flag combinations for common workflows |
| **File Integrity Probing** | Pre-flight ffprobe check detects corrupt, truncated, or suspicious media files before processing |
| **Context Window Safety** | Auto-truncation, pre-flight token checks, RESOURCE_EXHAUSTED recovery |
| **Multi-Format Output** | `--format` flag: Markdown, HTML, JSON, PDF, DOCX, or all formats at once |
| **Multi-Segment Batching** | Groups consecutive segments into single API calls when context window has headroom — fewer calls, better cross-segment awareness. `--no-batch` to disable |
| **Interactive CLI** | Run with no args → guided experience |
| **Resume / Checkpoint** | `--resume` continues interrupted runs |
| **Firebase Upload** | Team access via cloud (optional) |

> Technical details on each feature → [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Updating

**npm global install:**

```bash
npm update -g task-summary-extractor
```

**Git clone:**

```bash
git checkout main && git pull
```

Your call folders, `.env`, logs, and videos are all `.gitignore`d — nothing gets lost.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ffmpeg not found` | [Download](https://www.gyan.dev/ffmpeg/builds/) → add to PATH |
| `GEMINI_API_KEY not set` | Run `taskex config` to save globally, or edit `.env` → paste key from [AI Studio](https://aistudio.google.com/apikey) |
| `ECONNREFUSED` | Check your internet — Gemini API needs network |
| Videos are slow | Normal — ~30-60s per 5-min segment |
| JSON parse warnings | Expected — the parser has 5 fallback strategies |
| Something else broken | `node setup.js --check` validates everything |

---

## Project Structure

```
task-summary-extractor/
├── bin/
│   └── taskex.js               Global CLI entry point
├── process_and_upload.js       Backward-compatible entry (delegates to bin/taskex)
├── setup.js                    First-time setup & validation
├── package.json                Dependencies, scripts, bin config
├── prompt.json                 Gemini extraction prompt
├── vitest.config.js            Test configuration
│
├── src/
│   ├── config.js               Config, model registry, env vars
│   ├── logger.js               Structured JSONL logger (triple output)
│   ├── pipeline.js             Multi-mode orchestrator (~920 lines)
│   ├── phases/                 Decomposed pipeline phases (9 modules)
│   │   ├── _shared.js          Shared phase utilities
│   │   ├── init.js             Phase 1: CLI parsing, config validation
│   │   ├── discover.js         Phase 2: Find videos, docs, resolve user
│   │   ├── services.js         Phase 3: Firebase auth, Gemini init
│   │   ├── process-media.js    Phase 4: Compress, upload, analyze
│   │   ├── compile.js          Phase 5: Cross-segment compilation
│   │   ├── output.js           Phase 6: Write JSON, render MD + HTML
│   │   ├── summary.js          Phase 8: Save learning, print summary
│   │   └── deep-dive.js        Phase 9: Optional deep-dive generation
│   ├── services/
│   │   ├── gemini.js           Gemini AI — 3-strategy file resolution + External URL support
│   │   ├── firebase.js         Firebase Storage (async I/O)
│   │   ├── video.js            ffmpeg compression
│   │   ├── git.js              Git CLI wrapper
│   │   └── doc-parser.js       Document text extraction (DOCX, XLSX, PPTX, etc.)
│   ├── modes/                  AI-heavy pipeline phase modules
│   │   ├── deep-summary.js     Pre-summarize context docs (deep-summary feature)
│   │   ├── deep-dive.js        Topic discovery & deep-dive doc generation
│   │   ├── dynamic-mode.js     Dynamic document planning & generation
│   │   ├── focused-reanalysis.js  Targeted reanalysis of weak segments
│   │   ├── progress-updater.js Git-based progress assessment
│   │   └── change-detector.js  Git change correlation engine
│   ├── renderers/
│   │   ├── markdown.js         Markdown report renderer
│   │   ├── html.js             HTML report renderer (self-contained)
│   │   ├── pdf.js              PDF report renderer (HTML → PDF via puppeteer)
│   │   ├── docx.js             DOCX report renderer (programmatic Word document)
│   │   └── shared.js           Shared renderer utilities
│   ├── schemas/
│   │   ├── analysis-segment.schema.json   Segment analysis JSON Schema
│   │   └── analysis-compiled.schema.json  Compiled analysis JSON Schema
│   └── utils/                  Pure utilities — parsing, retry, budget, config
│       ├── colors.js           Zero-dep ANSI color utility
│       ├── progress-bar.js     Visual progress bar (TTY-aware)
│       ├── confidence-filter.js  Confidence level filtering
│       ├── schema-validator.js JSON Schema validation (ajv)
│       └── ... (15 more utility modules)
│
├── tests/                      Test suite — 423 tests across 18 files (vitest)
│   ├── utils/                  Utility module tests
│   ├── modes/                  Mode module tests (deep-summary, focused-reanalysis)
│   ├── renderers/              Renderer tests
│   └── logger.test.js          Structured logger tests
│
├── QUICK_START.md              Step-by-step setup guide
└── ARCHITECTURE.md             Technical deep dive
```

---

## npm Scripts

> If installed globally, just use `taskex` directly. These scripts are for development use with the cloned repo.

| Script | What |
|--------|------|
| `npm run setup` | First-time setup |
| `npm run setup:check` | Validate environment |
| `npm start` | Run the pipeline |
| `npm run help` | Show CLI help |
| `npm test` | Run test suite (423 tests) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |

---

## Version History

| Version | Highlights |
|---------|-----------|
| **v10.2.3** | **Unified feature flags** — Custom and Dynamic modes show the same 6 feature flags, removed mode-specific filtering |
| **v10.2.2** | **CLI flow fixes** — removed Dynamic Mode, Progress Tracker, HTML Output from feature flags (they are mode/format choices), dynamic preset defaults, non-TTY guard, source label fix |
| **v10.2.1** | **Docs & release polish** — README/ARCHITECTURE/QUICK_START fully updated with all v10.x features, test counts, and corrected constants |
| **v10.2.0** | **Deep summary batch-split retry** — failed batches auto-split in half and retry sub-batches (fixes 0-output on large batches), compilation auto-retry with 1.5× budget, dynamic mode fallback via segment merge, interactive feature flags (checkbox UI for deep-summary/deep-dive/etc.), prompt enum sync (blocker types + ticket types match schemas), 423 tests |
| **v10.1.0** | **Batch quality-gate retry** — auto-retry failing segment batches, deep summary caching, compact doc UX |
| **v10.0.1** | **Batch caching fix** — corrected segment batch cache key computation |
| **v10.0.0** | **Dynamic mode restructure** — HTML parity for dynamic mode output, restructured mode modules |
| **v9.8.2** | **Windowed interactive picker** — `selectOne()` and `selectMany()` now use viewport scrolling with ↑↓ indicators, prevents garbled display when doc list exceeds terminal height, stable redraw with fixed slot count, 378 tests |
| **v9.8.1** | `--name` is now optional — warns instead of fatal error, personalized task attribution skipped gracefully when no name provided, all prompts guard empty userName |
| **v9.8.0** | **Schema hardening & transcript handling** — VTT/SRT auto-excluded from deep-summary (transcripts routed to workflow, not summarizer), `normalizeAnalysis()` fills missing `summary`/`confidence`/`discussed_state` defaults before validation, batch Storage URL→File API auto-retry on `INVALID_ARGUMENT`, focused re-analysis skips sparse segments (≤2 items + low density), 367 tests |
| **v9.7.0** | **Multi-segment batching** — groups consecutive video segments into single Gemini API calls when context window has headroom, greedy bin-packing by token budget (`planSegmentBatches`), `processSegmentBatch()` multi-video API calls, automatic fallback to single-segment on failure, `--no-batch` to disable, codebase audit fixes (unused imports, variable shadowing) |
| **v9.6.0** | **Interactive CLI UX** — arrow-key navigation for all selectors (folder, model, run mode, formats, confidence, doc exclusion), zero-dependency prompt engine (`interactive.js`), `selectOne()` with ↑↓+Enter, `selectMany()` with Space toggle + A all/none, non-TTY fallback to number input |
| **v9.5.0** | **Video processing flags** — `--no-compress`, `--speed`, `--segment-time` CLI flags, hardcoded 1200s for raw mode, deprecated `--skip-compression` |
| **v9.4.0** | **Context window safety** — pre-flight token checks, auto-truncation for oversized docs/VTTs, RESOURCE_EXHAUSTED recovery with automatic doc shedding, chunked compilation for large segment sets, P0/P1 hard cap (2× budget) prevents context overflow, improved deep-summary prompt quality |
| **v9.3.1** | **Audit & polish** — VIDEO_SPEED 1.5→1.6, `--exclude-docs` flag for non-interactive deep-summary exclusion, friendlier Gemini error messages, dead code removal, DRY RUN_PRESETS |
| **v9.3.0** | **Deep summary** — `--deep-summary` pre-summarizes context documents (60-80% token savings), interactive doc picker, `--exclude-docs` for CLI automation, batch processing |
| **v9.0.0** | **CLI UX upgrade** — colors & progress bar, HTML reports, PDF & DOCX output (via puppeteer and docx npm package), JSON Schema validation, confidence filter (`--min-confidence`), pipeline decomposition (`src/phases/` — 9 modules), test suite (285 tests via vitest), multi-format output (`--format`: md/html/json/pdf/docx/all), doc-parser service, shared renderer utilities |
| **v8.3.0** | **Universal content analysis** — prompt v4.0.0 supports video, audio, documents, and mixed content; input type auto-detection; timestamps conditional on content type; gemini.js bridge text generalized; all markdown docs updated |
| **v8.2.0** | **Architecture cleanup** — `src/modes/` for AI pipeline phases, `retry.js` self-contained defaults, dead code removal, export trimming, `process_and_upload.js` slim shim, `progress.js` → `checkpoint.js`, merged `prompt.js` into `cli.js` |
| **v8.1.0** | **Smart global config** — `taskex config` persistent setup (`~/.taskexrc`), first-run prompting, 5-level config resolution, production audit fixes, shared CLI flag injection, boolean flag parser fix |
| **v8.0.0** | **npm package** — `npm i -g task-summary-extractor`, `taskex` global CLI, `--gemini-key` / `--firebase-*` config flags, run from anywhere, CWD-first `.env` resolution |
| **v7.2.3** | Production hardening — cross-platform ffmpeg, shell injection fix, auto git init for progress tracking, `runs/` excluded from doc discovery |
| **v7.2.2** | Upload control flags (`--force-upload`, `--no-storage-url`), production-ready docs |
| **v7.2.1** | Storage URL optimization, 3-strategy file resolution, Gemini file cleanup, codebase audit fixes |
| **v7.2** | Interactive model selector, `--model` flag, 5-model registry |
| **v7.1** | `--dynamic` processes videos too — any content mix |
| **v7.0** | Dynamic mode, interactive folder selection |
| **v6.2** | `--deep-dive` → topic docs |
| **v6.1** | Git progress tracking, `--update-progress` |
| **v6** | Confidence scoring, learning loop, diff engine |
| **v5** | Quality gate, adaptive budgets |
| **v4** | 8-phase pipeline, cost tracking |
| **v3** | Logger, retry logic, checkpoints |

---

## Documentation

| Doc | What's In It | When to Read |
|-----|-------------|-------------|
| 📖 **[QUICK_START.md](QUICK_START.md)** | Full setup walkthrough, examples, troubleshooting | First time using the tool |
| 🏗️ **[ARCHITECTURE.md](ARCHITECTURE.md)** | Pipeline phases, algorithms, Mermaid diagrams | Understanding how it works |

---

## License

Proprietary — © 2026 Youssef Adel. All rights reserved.
