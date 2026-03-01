# Task Summary Extractor — Where We Are & Where We Can Go

> **Version 9.0.0** — March 2026  
> Module map, codebase stats, and future roadmap.  
> For setup and CLI reference, see [README.md](README.md) · [Quick Start](QUICK_START.md)  
> For architecture diagrams and algorithms, see [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Part 1: Where We Are Now

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│          taskex (bin/taskex.js) or process_and_upload.js            │
│                          (Entry Points)                             │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────────┐
│                       pipeline.js (~920 lines)                      │
│              9-Phase Orchestrator + src/phases/                      │
│                                                                     │
│  Init ──────► Discover ──► Services ──► ProcessVideo ──► Compile    │
│  │ learning                               │    │           │        │
│  │ insights                         ┌─────▼────▼──┐    Diff        │
│  │ loaded                           │ For each    │   Engine       │
│  │                                  │ segment:    │      │         │
│  │                                  │ ┌─────────┐ │   Output      │
│  │                                  │ │Compress │ │   (MD+HTML)    │
│  │                                  │ │Upload   │ │      │         │
│  │                                  │ │Analyze ◄──┼── Quality Gate │
│  │                                  │ │ ↻Retry  │ │   + Confidence│
│  │                                  │ │ 🔍Focus │ │   Scoring     │
│  │                                  │ └─────────┘ │               │
│  │                                  └─────────────┘   Summary     │
│  │                                                       │         │
│  └──────────────────── learning history saved ◄──────────┘         │
└────┬──────────┬──────────┬──────────┬──────┬─────────┬─────────────┘
     │          │          │          │      │         │
┌────▼───┐ ┌───▼──────┐ ┌▼────────┐ ┌▼─────┐ ┌▼─────┐┌▼─────────┐
│Services│ │  Utils   │ │Renderers│ │Logger│ │Schema││  Config  │
│        │ │          │ │         │ │      │ │      ││          │
│gemini  │ │quality   │ │markdown │ │JSONL │ │seg   ││dotenv    │
│firebase│ │-gate     │ │(801 ln) │ │struct│ │comp  ││validation│
│video   │ │colors    │ │html.js  │ │spans │ │      ││env helper│
│git     │ │progress  │ │(673 ln) │ │phases│ │      ││model reg │
│doc-    │ │-bar      │ │shared   │ │metric│ │      ││          │
│parser  │ │confidence│ │(212 ln) │ │      │ │      ││          │
│        │ │-filter   │ │         │ │      │ │      ││          │
│        │ │schema-   │ │         │ │      │ │      ││          │
│        │ │validator │ │         │ │      │ │      ││          │
│        │ │+15 more  │ │         │ │      │ │      ││          │
└────────┘ └──────────┘ └─────────┘ └──────┘ └──────┘└──────────┘
```

### Codebase Stats

| Category | Files | Lines |
|----------|-------|-------|
| Pipeline orchestrator | 1 | ~920 |
| Pipeline phases (`src/phases/`) | 9 | ~1,800 |
| Services (Gemini, Firebase, Video, Git, Doc-Parser) | 5 | ~1,650 |
| Modes (AI pipeline phases) | 5 | 2,054 |
| Utilities (19 modules) | 19 | ~4,100 |
| Renderers (markdown, html, shared) | 3 | ~1,686 |
| Config + Logger | 2 | 597 |
| Schemas (JSON) | 2 | ~400 |
| Entry points (taskex + legacy) | 2 | 79 |
| Setup script | 1 | 418 |
| Prompt (JSON) | 1 | 333 |
| Tests (vitest) | 13 | ~3,200 |
| **Total** | **~63 files** | **~13,000+ lines** |

### Version History

| Version | Theme | Key Additions |
|---------|-------|---------------|
| **v3** | Core Improvements | dotenv, logger, retry logic, CLI args, graceful shutdown, config validation, progress persistence, error handling, video fixes, parallel uploads |
| **v4** | Architecture & Orchestration | Phase decomposition (7 phases), CostTracker, configurable thinking budget, poll timeouts, dead code cleanup, no `process.exit()`, CLI enhancements |
| **v5** | Smart & Accurate | Quality Gate (4-dimension scoring), auto-retry with corrective hints, adaptive thinking budget, smart boundary detection, health dashboard, enhanced prompt engineering, compilation quality assessment |
| **v6** | Self-Improving Intelligence | Confidence scoring per item, focused re-analysis for weak areas, learning loop (historical auto-tuning), diff-aware compilation (cross-run deltas), structured JSONL logging with phase spans, confidence badges in Markdown |
| **v6.1** | Smart Change Detection | Git-based progress tracking, AI-powered change correlation, automatic item status assessment (DONE/IN_PROGRESS/NOT_STARTED), progress markdown reports, `--update-progress` mode |
| **v6.2** | Deep Dive | `--deep-dive` generates explanatory docs per topic, 8 content categories |
| **v7.0** | Dynamic Mode | `--dynamic` doc-only mode, interactive folder selection, fully flexible pipeline |
| **v7.1** | Dynamic + Video | `--dynamic` now processes videos: compress, segment, analyze — works with any content |
| **v7.2** | Model Selection | Interactive model selector, `--model` flag, 5-model registry with pricing, runtime model switching |
| **v7.2.1** | Storage URL + Audit | Firebase Storage URLs as Gemini External URLs (skip File API upload), 3-strategy file resolution, URI reuse for retry/focused pass, Gemini file cleanup, confidence % fix, logger/firebase/git/version fixes |
| **v7.2.2** | Upload Control | `--force-upload` to re-upload existing files, `--no-storage-url` to force Gemini File API, production-ready docs |
| **v7.2.3** | Production Hardening | Cross-platform ffmpeg detection, shell injection fix (spawnSync), auto git init for `--update-progress`, `runs/` excluded from doc discovery, entry point docs updated |
| **v8.0.0** | npm Package | Global CLI (`taskex`), `--gemini-key`/`--firebase-*` config flags, CWD-based path resolution, CWD-first `.env`, `bin/taskex.js` entry point, npm publish-ready `package.json` |
| **v8.1.0** | Smart Global Config | Persistent `~/.taskexrc` config, `taskex config` subcommand, first-run API key prompting, 5-level config resolution, production audit (14 fixes), shared CLI flag injection, boolean flag parser fix |
| **v8.2.0** | Architecture Cleanup | `src/modes/` for AI pipeline phases, `retry.js` self-contained defaults, dead code removal, export trimming, `process_and_upload.js` slim shim, `progress.js` → `checkpoint.js`, merged `prompt.js` into `cli.js` |
| **v8.3.0** | Universal Content Analysis | prompt.json v4.0.0 — input type auto-detection (video/audio/document/mixed), timestamps conditional, domain-adaptive extraction for any content source, gemini.js bridge text generalized |
| **v9.0.0** | CLI UX + Pipeline Decomposition | Colors & progress bar, HTML reports (`results.html`), JSON Schema validation (`src/schemas/`), confidence filter (`--min-confidence`), pipeline decomposed into `src/phases/` (9 modules), test suite (285 tests via vitest), multi-format output (`--format`), doc-parser service, shared renderer utilities |

### What v6 Delivers

#### 1. Confidence Scoring Per Extracted Item
Every ticket, action item, CR, blocker, and scope change now carries a `confidence` field (HIGH / MEDIUM / LOW) and a `confidence_reason` explaining the evidence basis.

| Confidence | Meaning | Example |
|------------|---------|---------|
| **HIGH** | Explicitly stated + corroborated by docs/context | "Mentioned by name with ticket ID in VTT and Azure DevOps" |
| **MEDIUM** | Partially stated or single-source | "Discussed verbally but no written reference" |
| **LOW** | Inferred from context, not directly stated | "Implied from related discussion, not explicitly assigned" |

**Where it shows up:**
- **Quality Gate** (`quality-gate.js` — 366 lines): New 15-point confidence coverage dimension in density scoring. Flags missing confidence fields and suspicious uniformity (all HIGH = likely not calibrated). Generates retry hints for poor confidence.
- **Markdown Renderer** (`markdown.js` — 879 lines): Confidence badges (🟢 🟡 🔴) on every ticket header, action item row, CR row, blocker, scope change, and todo item. "📊 Confidence Distribution" summary table near report header.
- **Prompt** (`prompt.json` — 333 lines): Explicit confidence scoring instructions injected into extraction prompt. Self-verification checklist updated.

#### 2. Focused Re-Analysis (`focused-reanalysis.js` — 268 lines)
When the quality gate identifies specific weak dimensions (score <60, ≥2 weak areas), a **targeted second pass** runs instead of a full re-analysis.

| Component | What It Does |
|-----------|--------------|
| `identifyWeaknesses()` | Analyzes quality dimensions + confidence coverage to find gaps (missing tickets, sparse assignees, low confidence items, broken cross-refs) |
| `runFocusedPass()` | Sends a focused Gemini prompt targeting ONLY the weak areas, with reduced thinking budget (12K tokens) |
| `mergeFocusedResults()` | Intelligent merge: updates existing items by ID, appends new items, marks `_enhanced_by_focused_pass` / `_from_focused_pass` |

**Pipeline integration**: Runs after the quality gate + retry cycle for each segment. Controlled by `--no-focused-pass` flag. Costs tracked separately in cost tracker.

#### 3. Learning & Improvement Loop (`learning-loop.js` — 269 lines)
The pipeline remembers its past performance and auto-tunes for the future.

**How it works:**
1. **Before processing**: `loadHistory()` reads `history.json` (up to 50 past runs), `analyzeHistory()` computes trends and budget adjustments
2. **Budget auto-tuning**: If avg quality <45 across recent runs → boost thinking budget +4096 tokens. If >80 → reduce by 2048 to save cost.
3. **Retry effectiveness**: Tracks whether retries actually improve quality. If retry success rate <30%, recommends increasing base budget instead.
4. **After processing**: `saveHistory()` persists compact metrics (quality scores, extraction counts, costs, budgets, retry stats) for the next run.

```
  📈 Learning Insights:
    Historical runs : 12
    Quality trend   : improving (avg: 74/100)
    Budget adjust   : -2048 tokens (analysis)
    Recommendations :
      • High average quality (74/100) — reducing thinking budget by 2048 tokens to save cost
      • Focused re-analysis was used in 3/10 runs — system is self-correcting effectively
```

#### 4. Diff-Aware Compilation (`diff-engine.js` — 277 lines)
Compares the current run's compiled analysis against the previous run to produce a delta report.

| Diff Category | What's Detected |
|---------------|-----------------|
| **New items** | Tickets, CRs, action items, blockers, scope changes that didn't exist before |
| **Removed items** | Items from the previous run that no longer appear |
| **Changed items** | Status, priority, assignee, or confidence changes on existing items |
| **Unchanged** | Items that remain identical |

**Output**: Appended to `results.md` as a "🔄 Changes Since Previous Run" section with summary table + detailed new/removed/changed listings. Also saved as `diff.json` in the run folder.

#### 5. Structured Logging & Observability (`logger.js` — 306 lines)
The logger now writes **three parallel outputs**:

| Output | Format | Purpose |
|--------|--------|---------|
| `*_detailed.log` | Human-readable | Full debug/info/warn/error messages |
| `*_minimal.log` | Compact steps | Steps + timestamps only |
| `*_structured.jsonl` | Machine-readable JSONL | Every event as a JSON object with level, timestamp, context, phase |

**New capabilities:**
- **Phase spans**: `phaseStart(name)` / `phaseEnd(meta)` track timing per pipeline phase with structured records
- **Operation context**: `setContext()` / `clearContext()` stack for enriching log entries with segment/operation metadata
- **Structured metrics**: `metric(name, value)` for recording quantitative data (confidence coverage, token counts, etc.)
- All phase timers auto-emit structured span events

#### 6. Enhanced Quality Gate (`quality-gate.js` — 366 lines)
**New in v6:** Confidence coverage is now a scoring dimension within density (15 points):
- Checks percentage of items with valid confidence fields
- Detects suspicious uniformity (all same confidence = likely not calibrated)
- New `getConfidenceStats(analysis)` export returns `{total, high, medium, low, missing, coverage}`
- Two new retry hint generators for missing/uniform confidence

### All v5 Features Retained

| Feature | Module | Description |
|---------|--------|-------------|
| Quality Gate | `quality-gate.js` | 4-dimension scoring (structure, density, integrity, cross-refs), auto-retry on FAIL |
| Adaptive Thinking Budget | `adaptive-budget.js` | Segment position, complexity, context docs → dynamic 8K–32K range |
| Smart Boundary Detection | `context-manager.js` | Mid-conversation detection, open ticket carry-forward, continuity hints |
| Health Dashboard | `health-dashboard.js` | Quality scores, extraction density bars, retry stats, efficiency metrics |
| Enhanced Prompt | `prompt.json` | Universal content analysis (v4.0.0): input type detection, timestamps conditional on content type, domain-adaptive extraction, self-verification checklist |

### Current Capabilities

| Capability | Status | Description |
|------------|--------|-------------|
| Video compression | ✅ Mature | ffmpeg-based, CRF, configurable speed/preset |
| Video segmentation | ✅ Mature | Time-based splitting, segment pre-validation |
| Firebase upload | ✅ Mature | Parallel, retry, skip-existing, anonymous auth, async I/O, `--force-upload` re-upload |
| Storage URL optimization | ✅ v7.2.1 New | Firebase download URLs used as Gemini External URLs — skips File API upload, `--no-storage-url` to disable |
| Gemini segment analysis | ✅ Premium | 1M context, VTT slicing, progressive context, adaptive budget, 3-strategy file resolution |
| Gemini file cleanup | ✅ v7.2.1 New | Auto-delete File API uploads after all passes complete |
| Quality gate + retry | ✅ Enhanced | 4-dimension scoring + confidence coverage dimension, auto-retry with hints |
| Confidence scoring | ✅ v6 New | HIGH/MEDIUM/LOW per item with evidence reasoning |
| Focused re-analysis | ✅ v6 New | Targeted second pass for weak quality dimensions |
| Learning loop | ✅ v6 New | Historical auto-tuning of budgets/thresholds across runs |
| Diff engine | ✅ v6 New | Cross-run delta reports (new/removed/changed items) |
| Structured logging | ✅ v6 New | JSONL structured log, phase spans, operation contexts, metrics |
| Cross-segment continuity | ✅ Premium | Progressive context compression, boundary detection, focus instructions |
| AI compilation | ✅ Premium | Dedup, name normalization, adaptive compilation budget |
| Markdown rendering | ✅ Enhanced | Name clustering, ID dedup, confidence badges, diff section |
| Cost tracking | ✅ Mature | Per-segment + compilation + focused passes, long-context tier pricing |
| Progress persistence | ✅ Mature | Checkpoint/resume after crashes |
| CLI | ✅ Complete | 18 flags, help, version, output dir |
| Logging | ✅ v6 Rewritten | Triple output: detailed + minimal + structured JSONL |
| Health dashboard | ✅ Mature | Quality, density, retries, efficiency |

### CLI Reference

```
Usage: taskex [options] [folder]

Install: npm i -g task-summary-extractor

If no folder is specified, shows an interactive folder selector.

Configuration (override .env):
  --gemini-key <key>                Gemini API key
  --firebase-key <key>              Firebase API key
  --firebase-project <id>           Firebase project ID
  --firebase-bucket <bucket>        Firebase storage bucket
  --firebase-domain <domain>        Firebase auth domain

Modes:
  (default)                         Video analysis — compress, analyze, extract, compile
  --dynamic                         Document-only mode — no video required
  --update-progress                 Track item completion via git
  --deep-dive                       Generate explanatory docs per topic discussed

Core Options:
  --name <name>                     Your name (skips interactive prompt)
  --model <id>                      Gemini model to use (skips interactive selector)
  --skip-upload                     Skip all Firebase Storage uploads
  --force-upload                    Re-upload files even if they already exist in Storage
  --no-storage-url                  Disable Storage URL optimization (force Gemini File API)
  --skip-compression                Skip video compression (use existing segments)
  --skip-gemini                     Skip Gemini AI analysis
  --resume                          Resume from last checkpoint
  --reanalyze                       Force re-analysis of all segments
  --dry-run                         Show what would be done without executing

Dynamic Mode:
  --dynamic                         Enable document-only mode
  --request <text>                  What to generate (prompted if omitted)

Progress Tracking:
  --repo <path>                     Path to the project git repo

Tuning:
  --parallel <n>                    Max parallel uploads (default: 3)
  --parallel-analysis <n>           Concurrent segment analysis batches (default: 2)
  --thinking-budget <n>             Thinking tokens per segment (default: 24576)
  --compilation-thinking-budget <n> Thinking tokens for compilation (default: 10240)
  --log-level <level>               debug | info | warn | error (default: info)
  --output <dir>                    Custom output directory for results
  --no-focused-pass                 Disable focused re-analysis
  --no-learning                     Disable learning loop
  --no-diff                         Disable diff comparison

Output:
  --format <type>                   Output format: md, html, json, all (default: md)
  --min-confidence <level>          Filter by confidence: high, medium, low
  --no-html                         Suppress HTML report generation

Info:
  --help, -h                        Show help
  --version, -v                     Show version
```

### Full Module Map

```
bin/
└── taskex.js                 65 ln  ★ v8.0.0 — Global CLI entry point, config flag injection

src/
├── config.js                291 ln  Central config, env vars, model registry, validation
├── logger.js                306 ln  ★ v6 — Triple output: detailed + minimal + structured JSONL, phase spans, metrics
├── pipeline.js            ~920 ln  Multi-mode orchestrator with lazy phase imports, Storage URL optimization, upload control flags, learning loop, diff engine
├── phases/                         ★ v9.0.0 — Decomposed pipeline phase modules
│   ├── _shared.js                  Shared phase utilities (logging, error helpers)
│   ├── init.js                     Phase 1: CLI parsing, config validation, logger setup
│   ├── discover.js                 Phase 2: Find videos/audio, discover docs, resolve name
│   ├── services.js                 Phase 3: Firebase auth, Gemini init, doc prep
│   ├── process-media.js            Phase 4: Compress, upload, analyze, quality gate
│   ├── compile.js                  Phase 5: Cross-segment compilation, diff engine
│   ├── output.js                   Phase 6: Write JSON, render MD + HTML
│   ├── summary.js                  Phase 8: Save learning history, print summary
│   └── deep-dive.js                Phase 9: Optional deep-dive generation
├── modes/                          ★ v8.2.0 — AI-heavy pipeline phase modules
│   ├── change-detector.js   417 ln  Git-based change correlation engine
│   ├── deep-dive.js         473 ln  ★ v6.2 — Topic discovery, parallel doc generation, index builder
│   ├── dynamic-mode.js      494 ln  ★ v7.0 — Context-only doc generation, topic planning, parallel writing
│   ├── focused-reanalysis.js 268 ln ★ v6 — Weakness detection, targeted second pass, intelligent merge
│   └── progress-updater.js  402 ln  ★ v6.1 — AI-powered progress assessment, status report generation
├── renderers/
│   ├── markdown.js          801 ln  ★ v6 — Confidence badges (🟢🟡🔴), confidence distribution table, diff section
│   ├── html.js              673 ln  ★ v9.0.0 — Self-contained HTML report: collapsible sections, confidence badges, filtering, dark mode
│   └── shared.js            212 ln  ★ v9.0.0 — Shared renderer utilities (name clustering, dedup, formatting)
├── services/
│   ├── firebase.js           92 ln  Init, upload, exists check (with retry, async I/O)
│   ├── gemini.js            677 ln  ★ v7.2.1 — 3-strategy file resolution, External URL support, cleanup, doc prep, analysis, compilation
│   ├── git.js               264 ln  ★ v7.2.3 — Git CLI wrapper: log, diff, status, changed files, auto-init
│   ├── video.js             273 ln  ★ v7.2.3 — ffmpeg compress, segment, probe (cross-platform, spawnSync)
│   └── doc-parser.js        346 ln  ★ v9.0.0 — Document text extraction (DOCX, XLSX, PPTX, HTML, ODT, RTF, EPUB)
└── utils/                          Pure utilities — parsing, retry, budget, config
    ├── adaptive-budget.js   230 ln  ★ v5 — Transcript complexity → dynamic budget
    ├── checkpoint.js        145 ln  Checkpoint/resume persistence (renamed from progress.js in v8.2.0)
    ├── cli.js               391 ln  ★ v8.0.0 — Interactive prompts, model selector, folder picker, config flags, taskex help
    ├── context-manager.js   420 ln  4-tier priority, VTT slicing, progressive context, boundary detection
    ├── cost-tracker.js      140 ln  Token counting, USD cost estimation (+ focused pass tracking)
    ├── diff-engine.js       277 ln  ★ v6 — Cross-run delta: new/removed/changed items, Markdown rendering
    ├── format.js             27 ln  Duration, bytes formatting
    ├── fs.js                 34 ln  Recursive doc finder (skips runs/)
    ├── global-config.js     274 ln  ★ v8.1.0 — ~/.taskexrc persistent config, interactive setup
    ├── health-dashboard.js  191 ln  ★ v5 — Quality report, density bars, efficiency metrics
    ├── inject-cli-flags.js   49 ln  ★ v8.1.0 — CLI flag → env var injection
    ├── json-parser.js       216 ln  5-strategy JSON extraction + repair
    ├── learning-loop.js     269 ln  ★ v6 — History I/O, trend analysis, budget auto-tuning, recommendations
    ├── quality-gate.js      366 ln  ★ v6 — 4+1 dimension scoring (+ confidence coverage), retry hints
    ├── retry.js             118 ln  Exponential backoff, parallel map (self-contained defaults)
    ├── colors.js             84 ln  ★ v9.0.0 — Zero-dep ANSI color utility (bold, red, green, yellow, cyan, dim, reset)
    ├── progress-bar.js      287 ln  ★ v9.0.0 — Visual progress bar with phase tracking, ETA, cost display, TTY-aware
    ├── confidence-filter.js 130 ln  ★ v9.0.0 — Filter extracted items by confidence level (--min-confidence flag)
    └── schema-validator.js  260 ln  ★ v9.0.0 — JSON Schema validation using ajv (segment + compiled schemas)

schemas/
├── analysis-segment.schema.json    ★ v9.0.0 — JSON Schema for segment analysis output
└── analysis-compiled.schema.json   ★ v9.0.0 — JSON Schema for compiled analysis output

prompt.json                  333 ln  ★ v4.0.0 — Universal content analysis: video, audio, documents, mixed input; auto-detects input type + domain
process_and_upload.js         14 ln  Backward-compatible shim — delegates to bin/taskex.js
setup.js                     418 ln  Automated first-time setup & environment validation (v8.0.0)
```

---

## Part 2: Where We Can Go

### Already Implemented (v6)

The following features from the original exploration have been **fully implemented**:

| Feature | Status | Implemented In |
|---------|--------|----------------|
| 📊 Confidence Scoring Per Extracted Item | ✅ Done | `prompt.json`, `quality-gate.js`, `markdown.js` |
| 🔄 Multi-Pass Analysis (Focused Re-extraction) | ✅ Done | `modes/focused-reanalysis.js` (268 ln), pipeline integration |
| 🧠 Learning & Improvement Loop | ✅ Done | `learning-loop.js` (270 ln), pipeline init + save |
| 📝 Diff-Aware Compilation | ✅ Done | `diff-engine.js` (280 ln), pipeline output + MD |
| 🔍 Structured Logging & Observability | ✅ Done | `logger.js` rewritten (303 ln), JSONL + spans + metrics |
| Parallel segment analysis (via CLI) | ✅ Done | `--parallel-analysis` flag, pipeline batching |
| 🔎 Smart Change Detection & Progress Tracking | ✅ Done | `git.js` (310 ln), `modes/change-detector.js` (417 ln), `modes/progress-updater.js` (402 ln), pipeline `--update-progress` mode |
| 🗓️ Deep Dive Document Generation | ✅ Done | `modes/deep-dive.js` (473 ln), pipeline phase 9 |
| 📝 Dynamic Mode (doc-only generation) | ✅ Done | `modes/dynamic-mode.js` (494 ln), pipeline `--dynamic` route |
| 🤖 Runtime Model Selection | ✅ Done | `config.js` model registry, `cli.js` selector, `--model` flag |
| 📊 Progress Bar | ✅ Done | `progress-bar.js` (287 ln), pipeline integration, TTY-aware |
| 🌐 HTML Report Viewer | ✅ Done | `renderers/html.js` (673 ln), self-contained HTML with filtering, dark mode |
| 🔧 JSON Schema Validation | ✅ Done | `schema-validator.js` (260 ln), `schemas/` (2 files), ajv-based |
| 🎯 Confidence Filter | ✅ Done | `confidence-filter.js` (130 ln), `--min-confidence` flag |
| 🏗️ Pipeline Decomposition | ✅ Done | `src/phases/` (9 modules), `pipeline.js` reduced to ~920 lines |
| 🧪 Test Suite | ✅ Done | 285 tests across 13 files using vitest |
| 🎨 ANSI Colors | ✅ Done | `colors.js` (84 ln), zero-dep ANSI color utility wired throughout CLI |
| 📄 Doc Parser Service | ✅ Done | `doc-parser.js` (346 ln), DOCX/XLSX/PPTX/HTML/ODT/RTF/EPUB extraction |

---

### Tier 1: High-Impact, Medium Effort

#### 🔊 Speaker Diarization & Attribution
**What**: Automatically identify who is speaking at each moment in the video.  
**How**: Use Gemini's audio understanding or integrate a dedicated diarization API (e.g., AssemblyAI, Deepgram) as a preprocessing step. Map speaker segments to VTT timestamps.  
**Impact**: Dramatically improves action item attribution ("Mohamed said X" vs. "someone said X"). Currently relies on Gemini inferring speakers from VTT voice tags or contextual clues.  
**Modules affected**: New `services/diarization.js`, updates to `gemini.js` content building, `context-manager.js` for speaker-aware slicing.

#### 🌐 ~~Web Dashboard / Viewer~~ ✅ Done (v9.0.0)
**Status**: Implemented as `src/renderers/html.js` — self-contained HTML report with collapsible sections, confidence badges, filtering, dark mode, and print-friendly styling. Generated as `results.html` alongside `results.md`.
**Next step**: Build a hosted React/Next.js viewer that reads from Firebase for team-wide access.

---

### Tier 2: Differentiation Features

#### 🎯 Task Board Integration (Azure DevOps / Jira / Linear)
**What**: Push extracted action items and tickets directly to your project management tool.  
**How**: After compilation, map extracted items to work item templates. Use Azure DevOps REST API / Jira API / Linear API to create/update items. Cross-reference extracted CR numbers with existing work items.  
**Impact**: Closes the loop — call discussions automatically become tracked work items. No manual "meeting notes → task creation" step.  
**Modules affected**: New `services/task-board.js`, integration config in `config.js`, new CLI flags (`--push-to-jira`, `--sync-devops`).

#### 🎙️ Real-Time / Live Analysis Mode
**What**: Analyze calls as they happen, producing running analysis instead of post-call batch processing.  
**How**: Stream audio/video chunks to Gemini in real-time using Live API. Maintain a rolling context window. Produce incremental analysis updates.  
**Impact**: During the call, participants see extracted items appearing in real-time. Post-call report is instant.  
**Modules affected**: New `services/live-stream.js`, new `pipeline-live.js`, WebSocket output to a dashboard.

---

### Tier 3: Platform Evolution

#### 🏗️ Plugin Architecture
**What**: Allow custom plugins for different output formats, analysis types, and integrations.  
**How**: Define hook points: `onSegmentAnalyzed`, `onCompiled`, `onOutput`. Plugins register handlers. Ship with built-in plugins (markdown, json, firebase). Community can add: Slack notifications, email summaries, PDF reports, custom prompts per team.  
**Impact**: Transforms from a single-purpose tool to a platform. Different teams customize for their workflow.

#### 🤖 Multi-Model Support
**What**: Support different AI models beyond Gemini — OpenAI GPT-4o, Claude, Llama local models.  
**Status**: *Partially implemented in v7.2* — runtime model selection across 5 Gemini models with `--model` flag and interactive selector. Full multi-provider abstraction (OpenAI, Claude, local) remains a future enhancement.  
**Next step**: Abstract the AI service behind a provider interface. Each provider implements: `upload()`, `analyze()`, `compile()`. Config selects the active provider.  
**Impact**: Users choose the best model for their budget/accuracy needs. Can run local models for sensitive content. Enables A/B testing between models.

#### 📱 Mobile App / Bot
**What**: Telegram/Teams/Slack bot that accepts video links and returns analysis.  
**How**: Bot receives a shared video/meeting link → triggers pipeline → sends back the compiled Markdown or a link to the web dashboard.  
**Impact**: Zero-friction usage — share a link, get a task summary. No CLI needed.

#### 🔐 Multi-Tenant SaaS
**What**: Hosted version where teams sign up, configure their projects, and get analysis as a service.  
**How**: Next.js frontend, Node.js API (reusing current pipeline), per-team Firebase/S3 storage, Stripe billing, queue-based processing.  
**Impact**: Commercial product. Teams pay per call analyzed. Revenue model.

---

### Tier 4: Polish & Reliability

#### 🧪 ~~Test Suite~~ ✅ Done (v9.0.0)
**Status**: 285 tests across 13 files using vitest. Covers: quality-gate, adaptive-budget, json-parser, confidence-filter, context-manager, diff-engine, format, progress-bar, retry, schema-validator, cli, and renderers (html, markdown).
**Commands**: `npm test`, `npm run test:watch`, `npm run test:coverage`.

#### 📦 ~~Packaging & Distribution~~ ✅ Done (v8.0.0)
**Status**: Published as `task-summary-extractor` on npm. Global CLI: `taskex`. Install: `npm i -g task-summary-extractor`.  
**What was done**: `bin/taskex.js` entry point, `--gemini-key`/`--firebase-*` CLI config flags, CWD-based `.env` resolution, `PKG_ROOT`/`PROJECT_ROOT` path split for global compatibility.

#### 🔍 Advanced Observability (OpenTelemetry)
**What**: Extend the existing structured JSONL logging with OpenTelemetry trace export for external monitoring.  
**How**: Wrap existing `phaseStart`/`phaseEnd` spans with OTel SDK. Export traces to Jaeger/Grafana. Add alert rules on quality metric degradation.  
**Impact**: Production monitoring. Performance profiling across runs. Alert on quality regression trends.  
**Note**: Basic structured logging is already done in v6. This extends it to distributed tracing systems.

#### 🌍 i18n Prompt Library
**What**: Support different language pairs beyond Arabic+English. Ship prompt templates per domain.  
**How**: Move prompt.json to a `prompts/` directory with variants: `arabic-english-dotnet.json`, `spanish-english-react.json`, `french-english-java.json`. CLI flag: `--prompt-template react-english`.  
**Impact**: Anyone can use this tool regardless of their team's language or tech stack.

---

### Quick Wins (< 1 day each)

| Feature | Effort | Impact |
|---------|--------|--------|
| **Email summary** — send compiled MD via SMTP after processing | ~2 hrs | Users get results in inbox |
| **Slack webhook** — post summary to a channel | ~1 hr | Team-wide visibility |
| **Segment preview** — show first 3 VTT lines per segment before analyzing | ~30 min | Better UX during processing |
| **Custom output templates** — Handlebars/Mustache for MD output | ~4 hrs | Teams customize report format |
| **~~Audio-only mode~~** | ~~Done~~ | prompt.json v4.0.0 supports audio/doc/mixed — pipeline video requirement is next |
| **Watch mode** — monitor a folder and auto-process new recordings | ~3 hrs | Hands-free automation |
| **Git integration** — auto-commit results to repo | ~1 hr | Version-controlled meeting history |
| **Confidence threshold filter** | ~~Done~~ | ★ v9.0.0 `--min-confidence` flag implemented in `confidence-filter.js` |
| **History viewer** — CLI command to print learning loop trends without running pipeline | ~2 hrs | Introspect past performance |

---

### Recommended Next Sprint

Based on impact vs. effort, here's a suggested 5-item sprint building on v7.2:

1. **~~Test suite foundation~~** — ✅ Done (v9.0.0) — 285 tests across 13 files using vitest
2. **~~Web dashboard / viewer~~** — ✅ Done (v9.0.0) — Self-contained HTML report with filtering and collapsible sections
3. **Speaker diarization** — Gemini audio understanding for speaker attribution (1.5 days)
4. **Task board integration** — Push tickets/CRs to Azure DevOps or Jira (1.5 days)
5. **Slack/email notification** — Post compiled results automatically (half day)

These five deliver: reliability (tests), accessibility (dashboard), accuracy (speakers), workflow integration (task board), and team visibility (notifications).

---

*Generated from the v9.0.0 codebase — ~63 files, ~13,000+ lines of self-improving pipeline intelligence. npm: `task-summary-extractor` · CLI: `taskex`*

---

## See Also

| Doc | What's In It |
|-----|-------------|
| 📖 [README.md](README.md) | Setup, CLI flags, configuration, features |
| 📖 [QUICK_START.md](QUICK_START.md) | Step-by-step first-time walkthrough |
| 🏗️ [ARCHITECTURE.md](ARCHITECTURE.md) | Pipeline phases, processing flows, Mermaid diagrams |
