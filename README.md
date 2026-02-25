# Task Summary Extractor

> **v6.1.0** — AI-powered meeting & call analysis pipeline  
> Record any call or meeting, drop it in a folder, get structured task documents in minutes.

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-green" alt="Node.js" />
  <img src="https://img.shields.io/badge/gemini-2.5--flash-blue" alt="Gemini" />
  <img src="https://img.shields.io/badge/firebase-11.x-orange" alt="Firebase" />
  <img src="https://img.shields.io/badge/version-6.1.0-brightgreen" alt="Version" />
</p>

---

## What It Does

You record a call or meeting — any kind. You drop the recording in a folder with supporting docs. The tool:

1. **Compresses** the video (H.264, 1.5× speed, text-optimized)
2. **Segments** into ≤5 min chunks for API limits
3. **Analyzes** each segment with Google Gemini AI
4. **Extracts** tickets, change requests, action items, blockers, scope changes, decisions
5. **Scores** confidence on every item, retries weak segments automatically
6. **Outputs** a structured Markdown task document + JSON data

You get a `results.md` with your personalized task list, ready to act on.

### Use Cases

| Scenario | What You Get |
|----------|-------------|
| **Sprint Planning / Standup** | Tickets discussed, assignments, blockers, scope changes |
| **Code Review** | Change requests with file-level detail, reviewer feedback, action items |
| **Client Meeting** | Requirements, decisions, action items per person, agreed scope |
| **Technical Interview** | Assessment notes, topics covered, follow-up items |
| **Training / Onboarding** | Key topics, references shared, tasks assigned to trainee |
| **Incident Review / Post-mortem** | Root causes, action items, owners, deadlines |
| **Product Discussion** | Feature decisions, scope additions/removals, who owns what |
| **1-on-1 / Sync** | Personal action items, blockers raised, decisions made |

The AI adapts to the meeting content — it extracts whatever structure exists in the conversation.

---

## Quick Start

### 1. Setup

```bash
git clone https://github.com/youssefadel94/task-summary-extractor.git
cd task-summary-extractor
node setup.js
```

The setup script handles everything — checks Node.js, ffmpeg, git, installs dependencies, creates your `.env` with API key.

> **Need your Gemini API key?** → [Google AI Studio](https://aistudio.google.com/apikey) (free tier available)

### 2. Prepare a Call Folder

Create a folder with your recording and any relevant context:

```
my-call/
├── Meeting Recording.mp4       ← Your video (required)
├── Meeting Recording.vtt       ← Subtitles (recommended)
├── agenda.md                   ← Loose docs work too (optional)
│
├── .tasks/                     ← Context folder (optional, improves quality)
│   ├── code-map.md
│   └── current-sprint.md
├── specs/                      ← Any number of folders — all are scanned
│   └── requirements.md
└── notes/
    └── previous-meeting.md
```

The pipeline **recursively scans all subfolders** for documents — use any folder structure that fits your workflow. `.tasks/` gets priority weighting but every folder is included.

**Supported formats:** `.mp4`, `.mkv`, `.webm` (video) · `.vtt`, `.srt`, `.txt`, `.md`, `.csv`, `.pdf` (documents)

### 3. Run

```bash
node process_and_upload.js --name "Your Name" "my-call"
```

### 4. View Results

```
my-call/runs/{timestamp}/
├── results.md            ← Your task document
├── results.json          ← Full pipeline data
└── compilation.json      ← All extracted items
```

> See [QUICK_START.md](QUICK_START.md) for the full step-by-step walkthrough.

---

## How to Use This Repo

This repo is a **tool** — you pull `main` and create a local branch for your usage:

```bash
# First time
git clone https://github.com/youssefadel94/task-summary-extractor.git
cd task-summary-extractor
node setup.js

# Create your local working branch
git checkout -b local/my-workspace

# Add your call folders, .env, etc. — these stay local
# .gitignore already excludes call folders, .env, logs, videos
```

### Updating

```bash
# Get latest tool updates
git checkout main
git pull

# Merge into your working branch
git checkout local/my-workspace
git merge main
```

### What Stays Local (Not Committed)

| Item | Why |
|------|-----|
| `call */` folders | Your recordings + results |
| `.env` | API keys |
| `logs/` | Run logs |
| `gemini_runs/` | Raw AI response records |
| `*.mp4`, `*.mkv`, etc. | Video files |
| `node_modules/` | Dependencies |

---

## Usage

### Basic

```bash
# Analyze a call
node process_and_upload.js --name "Jane" "client-kickoff"

# Skip Firebase uploads (local only)
node process_and_upload.js --skip-upload "weekly-standup"

# Resume an interrupted run
node process_and_upload.js --resume "client-kickoff"

# Force re-analysis
node process_and_upload.js --reanalyze "client-kickoff"
```

### Progress Tracking

After doing the work from a call, check what's been completed:

```bash
node process_and_upload.js --update-progress --repo "C:\my-project" "call 1"
```

Outputs `progress.md` with: ✅ done, 🔄 in progress, ⏳ not started — with git evidence.

> Works best when extracted items reference files or ticket IDs that appear in your git history.

### Advanced

```bash
# Dry run — preview without executing
node process_and_upload.js --dry-run "client-kickoff"

# Custom thinking budget
node process_and_upload.js --thinking-budget 32768 "client-kickoff"

# Debug logging
node process_and_upload.js --log-level debug "client-kickoff"

# Disable smart features (faster, less thorough)
node process_and_upload.js --no-focused-pass --no-learning --no-diff "client-kickoff"
```

---

## What Gets Extracted

The AI extracts **6 categories** from each call:

| Category | What's In It |
|----------|-------------|
| **Tickets / Items** | ID, title, status, assignee, reviewer, timestamps, details |
| **Change Requests** | WHERE (target), WHAT (change), HOW (approach), WHY (justification) |
| **References** | Files, documents, links, tools, and resources mentioned |
| **Action Items** | Description, assigned to, deadline, dependencies |
| **Blockers** | Description, severity, owner, proposed resolution |
| **Scope Changes** | Type (added/removed/deferred), original vs new scope, impact |

Every item includes a **confidence score** (HIGH / MEDIUM / LOW) with a reason.

You also get a **`your_tasks`** section scoped to the `--name` you provide — owned items, TODOs, things you're waiting on.

> The categories adapt to the meeting content. In a dev call you get tickets and code-level changes; in a client meeting you get requirements and deliverable changes; in an interview you get assessment items.

---

## Features

| Feature | Description |
|---------|-------------|
| **Video Compression** | H.264 CRF 24, text-optimized sharpening, configurable speed |
| **Smart Segmentation** | ≤5 min chunks with boundary-aware splitting |
| **Cross-Segment Continuity** | Ticket IDs, names, and context carry forward across segments |
| **Document Discovery** | Auto-finds `.vtt`, `.pdf`, `.md`, `.txt`, `.csv`, `.srt` in your call folder |
| **Quality Gate** | 4-dimension scoring with auto-retry on low quality |
| **Focused Re-Analysis** | Targeted second pass on weak areas only |
| **Learning Loop** | Auto-tunes thinking budgets based on past run quality |
| **Diff Engine** | Shows what changed between analysis runs |
| **Confidence Scoring** | Every item rated HIGH / MEDIUM / LOW with evidence |
| **Git Progress Tracking** | Correlates git commits with extracted items |
| **Resume / Checkpoint** | `--resume` picks up where you left off |
| **Firebase Upload** | Team access via cloud storage (optional) |
| **Structured Logging** | JSONL logs with timing and phase spans |

---

## Document Patterns

The pipeline discovers documents in your call folder to give the AI context. Better docs = better extraction.

### Recommended Call Folder Structure

```
my-call/
├── Recording.mp4                      Video (required)
├── Recording.vtt                      Subtitles (highly recommended)
├── meeting-notes.md                   Loose docs at root — scanned automatically
├── agenda.md                          Meeting agenda / context
│
├── .tasks/                            High-priority context folder (optional)
│   ├── code-map.md                    What each module/component does
│   ├── current-sprint.md              Sprint goals & assigned tickets
│   └── team.csv                       Name, role, email for attribution
│
├── specs/                             Any subfolder name works
│   ├── requirements.md                Requirements or acceptance criteria
│   └── api-contract.md                API specs, schemas, etc.
│
├── research/                          Add as many context folders as needed
│   └── competitor-analysis.md
│
├── compressed/                        ← Generated
├── runs/                              ← Generated
└── gemini_runs/                       ← Generated
```

> The pipeline recursively discovers **all** documents in **every** subfolder. Use whatever folder structure fits your project — `.tasks/` receives priority weighting in the AI prompt, but all folders are included.

### What Helps Most

| Document | Impact |
|----------|--------|
| **Subtitles (`.vtt`/`.srt`)** | Dramatically improves name, ID, and terminology extraction |
| **Context folders** | Any subfolders (`.tasks/`, `specs/`, `docs/`, etc.) are recursively scanned and sent to AI |
| **Agenda / notes** | Guides AI focus and helps resolve ambiguous references |
| **Team roster (`.csv`)** | Accurate attribution of action items to people |
| **Code map / architecture docs** | AI matches change requests to actual files and modules |
| **Sprint/board exports** | Helps determine current status of discussed items |

### Adapting Context Folders to Your Use Case

Use any folder names and nesting — the pipeline scans everything. `.tasks/` gets the highest priority weighting but all folders are included.

| Use Case | Recommended Structure |
|----------|----------------------|
| **Dev calls** | `.tasks/code-map.md`, `.tasks/current-sprint.md`, `docs/tech-debt.md` |
| **Client meetings** | `requirements/scope.md`, `contracts/sow.md`, `.tasks/stakeholders.csv` |
| **Interviews** | `role/job-description.md`, `role/evaluation-rubric.md`, `candidates/notes.md` |
| **Incident reviews** | `systems/architecture.md`, `runbooks/service-x.md`, `timeline/incident.md` |
| **Training** | `curriculum/outline.md`, `materials/prerequisites.md`, `resources/links.md` |

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | ≥ 18 | v24 tested |
| **ffmpeg** | any | Must be in PATH — [download](https://www.gyan.dev/ffmpeg/builds/) |
| **Git** | any | Optional — only for `--update-progress` |
| **Gemini API Key** | — | [Google AI Studio](https://aistudio.google.com/apikey) |

---

## Configuration

### Environment Variables (`.env`)

| Variable | Default | Required? |
|----------|---------|-----------|
| `GEMINI_API_KEY` | — | **Yes** |
| `GEMINI_MODEL` | `gemini-2.5-flash` | No |
| `FIREBASE_*` (7 fields) | — | No — skip with `--skip-upload` |
| `VIDEO_SPEED` | `1.5` | No |
| `VIDEO_SEGMENT_TIME` | `280` (seconds) | No |
| `THINKING_BUDGET` | `24576` | No |
| `LOG_LEVEL` | `info` | No |

> Full variable list + encoding parameters → [ARCHITECTURE.md](ARCHITECTURE.md)

### CLI Reference

```
Usage: node process_and_upload.js [options] <folder>

Core:
  --name <name>            Your name (skips prompt)
  --skip-upload            Skip Firebase uploads
  --resume                 Resume from checkpoint
  --reanalyze              Force re-analysis
  --dry-run                Show plan without executing

Progress:
  --update-progress        Track item completion via git
  --repo <path>            Project git repo path

Tuning:
  --thinking-budget <n>    Thinking tokens per segment (default: 24576)
  --parallel-analysis <n>  Concurrent segment analysis (default: 2)
  --log-level <level>      debug / info / warn / error
  --no-focused-pass        Disable focused re-analysis
  --no-learning            Disable learning loop
  --no-diff                Disable diff comparison

Info:
  --help, -h               Show help
  --version, -v            Show version
```

---

## Output Structure

### After Analysis

```
my-call/
├── compressed/
│   └── Meeting Recording/
│       ├── segment_00.mp4
│       └── ...
└── runs/
    └── 2026-02-24T16-22-28/
        ├── results.md            Human-readable task document
        ├── results.json          Pipeline metadata + per-segment data
        └── compilation.json      All extracted items (JSON)
```

### After Progress Update

```
my-call/
└── runs/
    └── 2026-02-25T14-30-00/
        ├── progress.md           Status report with git evidence
        └── progress.json         Full progress data
```

---

## Project Structure

```
task-summary-extractor/
├── process_and_upload.js       Entry point
├── setup.js                    Automated setup & validation
├── package.json                Dependencies & scripts
├── prompt.json                 Gemini extraction schema
├── .gitignore                  Excludes local data & videos
│
├── src/
│   ├── config.js               Configuration
│   ├── logger.js               Structured logger
│   ├── pipeline.js             8-phase orchestrator
│   ├── services/
│   │   ├── firebase.js         Firebase Storage
│   │   ├── gemini.js           Gemini AI analysis
│   │   ├── git.js              Git CLI wrapper
│   │   └── video.js            ffmpeg compression
│   ├── renderers/
│   │   └── markdown.js         Report renderer
│   └── utils/                  17 utility modules
│
├── QUICK_START.md              Getting started guide
├── ARCHITECTURE.md             Technical deep dive & diagrams
└── EXPLORATION.md              Feature roadmap
```

---

## npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm run setup` | `node setup.js` | First-time setup |
| `npm run check` | `node setup.js --check` | Validate environment |
| `npm start` | `node process_and_upload.js` | Run the pipeline |
| `npm run help` | `node process_and_upload.js --help` | Show CLI help |

---

## Version History

| Version | Theme | Highlights |
|---------|-------|-----------|
| **v6.1** | Change Detection | Git progress tracking, AI correlation, `--update-progress` |
| **v6** | Self-Improving | Confidence scoring, focused re-analysis, learning loop, diff engine |
| **v5** | Smart & Accurate | Quality gate, adaptive budgets, health dashboard |
| **v4** | Architecture | 8-phase pipeline, cost tracking, configurable budgets |
| **v3** | Core | Logger, retry logic, CLI args, checkpoints, parallel uploads |

---

## Documentation

| Document | Description |
|----------|-------------|
| **[QUICK_START.md](QUICK_START.md)** | 5-minute setup to first analysis |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Technical deep dive — processing flows, algorithms, diagrams |
| **[EXPLORATION.md](EXPLORATION.md)** | Feature roadmap & architecture exploration |

---

## License

Private — © 2026
