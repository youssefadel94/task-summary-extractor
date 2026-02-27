# Task Summary Extractor

> **v7.2.0** — AI-powered meeting analysis & document generation from the CLI.

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-green" alt="Node.js" />
  <img src="https://img.shields.io/badge/gemini-2.5--flash-blue" alt="Gemini" />
  <img src="https://img.shields.io/badge/firebase-11.x-orange" alt="Firebase" />
  <img src="https://img.shields.io/badge/version-7.2.0-brightgreen" alt="Version" />
</p>

**Record a meeting → get a structured task document.** Or point it at any folder and generate docs from context.

📖 **New here?** Jump to [Setup (3 steps)](#setup-3-steps) — you'll be running in under 5 minutes.

---

## What It Does

### 🎥 Video Analysis (default mode)

Drop a recording in a folder → run the tool → get a Markdown task document with:

- **Tickets** — ID, title, status, assignee, confidence score
- **Change Requests** — what changed, where, how, why
- **Action Items** — who does what, by when
- **Blockers** — severity, owner, proposed resolution
- **Scope Changes** — added, removed, deferred items
- **Your Tasks** — personalized list scoped to your name

```bash
node process_and_upload.js --name "Jane" "my-meeting"
```

### 📝 Dynamic Mode (`--dynamic`)

No video needed. Point at a folder with docs, tell it what you want:

```bash
node process_and_upload.js --dynamic --request "Plan migration from MySQL to Postgres" "db-specs"
```

Generates 3–15 Markdown documents: overviews, guides, checklists, decision records, etc.

### 🔍 Deep Dive (`--deep-dive`)

After video analysis, generate standalone docs for every topic discussed:

```bash
node process_and_upload.js --deep-dive --name "Jane" "my-meeting"
```

### 📊 Progress Tracking (`--update-progress`)

Check which items from a previous analysis have been completed, using git evidence:

```bash
node process_and_upload.js --update-progress --repo "C:\my-project" "my-meeting"
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

### Step 1: Clone & install

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
node process_and_upload.js --name "Your Name" "my-meeting"
```

Or just run `node process_and_upload.js` — it'll walk you through everything interactively.

**Done.** Your results are in `my-meeting/runs/{timestamp}/results.md`.

> 🎓 **Full walkthrough** with examples, folder structures, and troubleshooting → [QUICK_START.md](QUICK_START.md)

---

## CLI Flags

Every flag is optional. Run with no flags for fully interactive mode.

### Everyday Flags

These are the ones you'll actually use:

| Flag | What It Does | Example |
|------|-------------|---------|
| `--name <name>` | Set your name (skips prompt) | `--name "Jane"` |
| `--model <id>` | Pick a Gemini model (skips selector) | `--model gemini-2.5-pro` |
| `--skip-upload` | Don't upload to Firebase (local only) | `--skip-upload` |
| `--resume` | Continue an interrupted run | `--resume` |
| `--reanalyze` | Force fresh analysis (ignore cache) | `--reanalyze` |
| `--dry-run` | Preview what would run, without running | `--dry-run` |

**Typical usage:**

```bash
# Interactive — picks folder, model, prompts for name
node process_and_upload.js

# Specify everything upfront
node process_and_upload.js --name "Jane" --model gemini-2.5-pro --skip-upload "my-meeting"

# Resume a run that crashed halfway
node process_and_upload.js --resume "my-meeting"
```

### Mode Flags

Choose what the tool does. Only use one at a time:

| Flag | Mode | What You Get |
|------|------|-------------|
| *(none)* | **Video analysis** | `results.md` — structured task document |
| `--dynamic` | **Doc generation** | `INDEX.md` + 3–15 topic documents |
| `--deep-dive` | **Topic explainers** | `INDEX.md` + per-topic deep-dive docs |
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
| `--skip-compression` | Video compression | You already compressed/segmented the video |
| `--skip-gemini` | AI analysis entirely | You just want to compress & upload |

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
node process_and_upload.js [flags] [folder]

MODES      --dynamic  --deep-dive  --update-progress
CORE       --name  --model  --skip-upload  --resume  --reanalyze  --dry-run
SKIP       --skip-compression  --skip-gemini
DYNAMIC    --request <text>
PROGRESS   --repo <path>
TUNING     --thinking-budget  --compilation-thinking-budget  --parallel
           --parallel-analysis  --log-level  --output
           --no-focused-pass  --no-learning  --no-diff
INFO       --help (-h)  --version (-v)
```

---

## Output

### Video Analysis

```
my-meeting/runs/{timestamp}/
├── results.md            ← Open this — your task document
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

Drop docs alongside your video to give the AI context. **More context = better extraction.**

```
my-meeting/
├── Recording.mp4                  ← Video (required for video mode)
├── Recording.vtt                  ← Subtitles (highly recommended)
├── agenda.md                      ← Loose docs at root are fine
│
├── .tasks/                        ← Gets priority weighting (optional)
│   ├── code-map.md                ← What each module/component does
│   └── current-sprint.md          ← Current sprint goals and tickets
│
└── specs/                         ← Any subfolder name works
    └── requirements.md
```

**Supported formats:** `.mp4` `.mkv` `.webm` `.avi` `.mov` (video) · `.vtt` `.srt` `.txt` `.md` `.csv` `.pdf` (docs)

The tool **recursively scans all subfolders**. `.tasks/` gets highest priority weighting but everything is included.

| What Helps Most | Why |
|-----------------|-----|
| **Subtitles** (`.vtt`/`.srt`) | Dramatically improves name/ID extraction |
| **Team roster** (`.csv`) | Accurate attribution of action items |
| **Code map / architecture docs** | AI matches changes to actual files |
| **Sprint / board exports** | Status context for discussed items |

---

## Configuration

### `.env`

Created by `node setup.js`. Only `GEMINI_API_KEY` is required — everything else has defaults:

```env
# Required
GEMINI_API_KEY=your-key-here

# Optional — uncomment to customize
# GEMINI_MODEL=gemini-2.5-flash
# VIDEO_SPEED=1.5
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
| **Video Compression** | H.264 CRF 24, text-optimized sharpening, configurable speed |
| **Smart Segmentation** | ≤5 min chunks with boundary-aware splitting |
| **Cross-Segment Continuity** | Ticket IDs, names, and context carry forward |
| **Document Discovery** | Auto-finds docs in all subfolders |
| **Quality Gate** | 4-dimension scoring with auto-retry |
| **Focused Re-Analysis** | Targeted second pass on weak areas |
| **Learning Loop** | Auto-tunes budgets from past run quality |
| **Diff Engine** | Shows what changed between runs |
| **Confidence Scoring** | Every item rated HIGH/MEDIUM/LOW with evidence |
| **Model Selection** | 5 Gemini models — interactive picker or `--model` |
| **Git Progress Tracking** | Correlates commits with extracted items |
| **Deep Dive** | Explanatory docs per topic discussed |
| **Dynamic Mode** | Generate docs from any content mix |
| **Interactive CLI** | Run with no args → guided experience |
| **Resume / Checkpoint** | `--resume` continues interrupted runs |
| **Firebase Upload** | Team access via cloud (optional) |

> Technical details on each feature → [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Updating

```bash
git checkout main && git pull
```

Your call folders, `.env`, logs, and videos are all `.gitignore`d — nothing gets lost.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ffmpeg not found` | [Download](https://www.gyan.dev/ffmpeg/builds/) → add to PATH |
| `GEMINI_API_KEY not set` | Edit `.env` → paste key from [AI Studio](https://aistudio.google.com/apikey) |
| `ECONNREFUSED` | Check your internet — Gemini API needs network |
| Videos are slow | Normal — ~30-60s per 5-min segment |
| JSON parse warnings | Expected — the parser has 5 fallback strategies |
| Something else broken | `node setup.js --check` validates everything |

---

## Project Structure

```
task-summary-extractor/
├── process_and_upload.js       Entry point
├── setup.js                    First-time setup & validation
├── package.json                Dependencies & scripts
├── prompt.json                 Gemini extraction prompt
│
├── src/
│   ├── config.js               Config, model registry, env vars
│   ├── logger.js               Structured JSONL logger
│   ├── pipeline.js             Multi-mode orchestrator (1,710 lines)
│   ├── services/
│   │   ├── gemini.js           Gemini AI analysis
│   │   ├── firebase.js         Firebase Storage
│   │   ├── video.js            ffmpeg compression
│   │   └── git.js              Git CLI wrapper
│   ├── renderers/
│   │   └── markdown.js         Report renderer
│   └── utils/                  19 modules — see ARCHITECTURE.md
│
├── QUICK_START.md              Step-by-step setup guide
├── ARCHITECTURE.md             Technical deep dive
└── EXPLORATION.md              Roadmap & future features
```

> Full module map with line counts → [EXPLORATION.md](EXPLORATION.md#full-module-map)

---

## npm Scripts

| Script | What |
|--------|------|
| `npm run setup` | First-time setup |
| `npm run check` | Validate environment |
| `npm start` | Run the pipeline |
| `npm run help` | Show CLI help |

---

## Version History

| Version | Highlights |
|---------|-----------|
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
| 🔭 **[EXPLORATION.md](EXPLORATION.md)** | Module map, line counts, future roadmap | Contributing or extending |

---

## License

Private — © 2026
