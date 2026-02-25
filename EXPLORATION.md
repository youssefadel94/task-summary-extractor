# Task Summary Extractor — Where We Are & Where We Can Go

> **Version 6.1.0** — February 2026  
> A self-improving pipeline that compresses developer call recordings, analyzes them with Gemini AI, and produces structured task documents with confidence-scored tickets, change requests, action items, and personalized task lists — now with focused re-analysis, cross-run diff intelligence, a learning loop that tunes itself over time, and smart git-based progress tracking.

---

## Part 1: Where We Are Now

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        process_and_upload.js                        │
│                          (Entry Point)                              │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────────┐
│                       pipeline.js (1,323 lines)                     │
│                    8-Phase Orchestrator                              │
│                                                                     │
│  Init ──────► Discover ──► Services ──► ProcessVideo ──► Compile    │
│  │ learning                               │    │           │        │
│  │ insights                         ┌─────▼────▼──┐    Diff        │
│  │ loaded                           │ For each    │   Engine       │
│  │                                  │ segment:    │      │         │
│  │                                  │ ┌─────────┐ │   Output      │
│  │                                  │ │Compress │ │      │         │
│  │                                  │ │Upload   │ │   Health      │
│  │                                  │ │Analyze ◄──┼── Quality Gate │
│  │                                  │ │ ↻Retry  │ │   + Confidence│
│  │                                  │ │ 🔍Focus │ │   Scoring     │
│  │                                  │ └─────────┘ │               │
│  │                                  └─────────────┘   Summary     │
│  │                                                       │         │
│  └──────────────────── learning history saved ◄──────────┘         │
└────┬──────────┬──────────┬──────────┬──────────┬───────────────────┘
     │          │          │          │          │
┌────▼───┐ ┌───▼──────┐ ┌▼────────┐ ┌▼─────┐ ┌▼──────────┐
│Services│ │  Utils   │ │Renderers│ │Logger│ │  Config   │
│        │ │          │ │         │ │      │ │           │
│gemini  │ │quality   │ │markdown │ │JSONL │ │dotenv     │
│firebase│ │-gate     │ │(969 ln) │ │struct│ │validation │
│video   │ │focused   │ │+ conf   │ │spans │ │env helpers│
│        │ │-reanalysis│ │  badges│ │phases│ │           │
│        │ │learning  │ │+ diff   │ │metrics│ │           │
│        │ │-loop     │ │ section │ │      │ │           │
│        │ │diff      │ │         │ │      │ │           │
│        │ │-engine   │ │         │ │      │ │           │
│        │ │adapt-budg│ │         │ │      │ │           │
│        │ │context   │ │         │ │      │ │           │
│        │ │+9 more   │ │         │ │      │ │           │
└────────┘ └──────────┘ └─────────┘ └──────┘ └───────────┘
```

### Codebase Stats

| Category | Files | Lines |
|----------|-------|-------|
| Pipeline orchestrator | 1 | 1,323 |
| Services (Gemini, Firebase, Video) | 3 | 986 |
| Utilities (15 modules) | 15 | 3,263 |
| Renderers | 1 | 969 |
| Config + Logger | 2 | 527 |
| Entry point | 1 | 67 |
| Prompt (JSON) | 1 | 265 |
| **Total** | **24 files** | **7,400 lines** |

### Version History

| Version | Theme | Key Additions |
|---------|-------|---------------|
| **v3** | Core Improvements | dotenv, logger, retry logic, CLI args, graceful shutdown, config validation, progress persistence, error handling, video fixes, parallel uploads |
| **v4** | Architecture & Orchestration | Phase decomposition (7 phases), CostTracker, configurable thinking budget, poll timeouts, dead code cleanup, no `process.exit()`, CLI enhancements |
| **v5** | Smart & Accurate | Quality Gate (4-dimension scoring), auto-retry with corrective hints, adaptive thinking budget, smart boundary detection, health dashboard, enhanced prompt engineering, compilation quality assessment |
| **v6** | Self-Improving Intelligence | Confidence scoring per item, focused re-analysis for weak areas, learning loop (historical auto-tuning), diff-aware compilation (cross-run deltas), structured JSONL logging with phase spans, confidence badges in Markdown |
| **v6.1** | Smart Change Detection | Git-based progress tracking, AI-powered change correlation, automatic item status assessment (DONE/IN_PROGRESS/NOT_STARTED), progress markdown reports, `--update-progress` mode |

### What v6 Delivers

#### 1. Confidence Scoring Per Extracted Item
Every ticket, action item, CR, blocker, and scope change now carries a `confidence` field (HIGH / MEDIUM / LOW) and a `confidence_reason` explaining the evidence basis.

| Confidence | Meaning | Example |
|------------|---------|---------|
| **HIGH** | Explicitly stated + corroborated by docs/context | "Mentioned by name with ticket ID in VTT and Azure DevOps" |
| **MEDIUM** | Partially stated or single-source | "Discussed verbally but no written reference" |
| **LOW** | Inferred from context, not directly stated | "Implied from related discussion, not explicitly assigned" |

**Where it shows up:**
- **Quality Gate** (`quality-gate.js` — 430 lines): New 15-point confidence coverage dimension in density scoring. Flags missing confidence fields and suspicious uniformity (all HIGH = likely not calibrated). Generates retry hints for poor confidence.
- **Markdown Renderer** (`markdown.js` — 969 lines): Confidence badges (🟢 🟡 🔴) on every ticket header, action item row, CR row, blocker, scope change, and todo item. "📊 Confidence Distribution" summary table near report header.
- **Prompt** (`prompt.json` — 265 lines): Explicit confidence scoring instructions injected into extraction prompt. Self-verification checklist updated.

#### 2. Focused Re-Analysis (`focused-reanalysis.js` — 318 lines)
When the quality gate identifies specific weak dimensions (score <60, ≥2 weak areas), a **targeted second pass** runs instead of a full re-analysis.

| Component | What It Does |
|-----------|--------------|
| `identifyWeaknesses()` | Analyzes quality dimensions + confidence coverage to find gaps (missing tickets, sparse assignees, low confidence items, broken cross-refs) |
| `runFocusedPass()` | Sends a focused Gemini prompt targeting ONLY the weak areas, with reduced thinking budget (12K tokens) |
| `mergeFocusedResults()` | Intelligent merge: updates existing items by ID, appends new items, marks `_enhanced_by_focused_pass` / `_from_focused_pass` |

**Pipeline integration**: Runs after the quality gate + retry cycle for each segment. Controlled by `--no-focused-pass` flag. Costs tracked separately in cost tracker.

#### 3. Learning & Improvement Loop (`learning-loop.js` — 302 lines)
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

#### 4. Diff-Aware Compilation (`diff-engine.js` — 316 lines)
Compares the current run's compiled analysis against the previous run to produce a delta report.

| Diff Category | What's Detected |
|---------------|-----------------|
| **New items** | Tickets, CRs, action items, blockers, scope changes that didn't exist before |
| **Removed items** | Items from the previous run that no longer appear |
| **Changed items** | Status, priority, assignee, or confidence changes on existing items |
| **Unchanged** | Items that remain identical |

**Output**: Appended to `results.md` as a "🔄 Changes Since Previous Run" section with summary table + detailed new/removed/changed listings. Also saved as `diff.json` in the run folder.

#### 5. Structured Logging & Observability (`logger.js` — 352 lines)
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

#### 6. Enhanced Quality Gate (`quality-gate.js` — 430 lines)
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
| Enhanced Prompt | `prompt.json` | Timestamp accuracy, dedup rules, self-verification checklist, retry hints |

### Current Capabilities

| Capability | Status | Description |
|------------|--------|-------------|
| Video compression | ✅ Mature | ffmpeg-based, CRF, configurable speed/preset |
| Video segmentation | ✅ Mature | Time-based splitting, segment pre-validation |
| Firebase upload | ✅ Mature | Parallel, retry, skip-existing, anonymous auth |
| Gemini segment analysis | ✅ Premium | 1M context window, VTT slicing, progressive context, adaptive budget |
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
| CLI | ✅ Complete | 16 flags, help, version, output dir |
| Logging | ✅ v6 Rewritten | Triple output: detailed + minimal + structured JSONL |
| Health dashboard | ✅ Mature | Quality, density, retries, efficiency |

### CLI Reference

```
Usage: node process_and_upload.js [options] <folder>

Options:
  --name <name>                     Your name (skips interactive prompt)
  --skip-upload                     Skip Firebase Storage uploads
  --skip-compression                Skip video compression (use existing segments)
  --skip-gemini                     Skip Gemini AI analysis
  --resume                          Resume from last checkpoint
  --reanalyze                       Force re-analysis of all segments
  --parallel <n>                    Max parallel uploads (default: 3)
  --parallel-analysis <n>           Concurrent segment analysis batches (default: 2)
  --log-level <level>               debug | info | warn | error (default: info)
  --output <dir>                    Custom output directory for results
  --thinking-budget <n>             Thinking tokens per segment (default: 24576)
  --compilation-thinking-budget <n> Thinking tokens for compilation (default: 10240)
  --no-focused-pass                 Disable focused re-analysis
  --no-learning                     Disable learning loop
  --no-diff                         Disable diff comparison
  --dry-run                         Show what would be done without executing
  --help, -h                        Show help
  --version, -v                     Show version
```

### Full Module Map

```
src/
├── config.js                175 ln  Central config, env vars, validation
├── logger.js                352 ln  ★ v6 — Triple output: detailed + minimal + structured JSONL, phase spans, metrics
├── pipeline.js            1,323 ln  8-phase orchestrator with learning loop + focused re-analysis + diff engine
├── renderers/
│   └── markdown.js          969 ln  ★ v6 — Confidence badges (🟢🟡🔴), confidence distribution table, diff section
├── services/
│   ├── firebase.js          104 ln  Init, upload, exists check (with retry)
│   ├── gemini.js            597 ln  Init, doc prep, segment analysis, compilation
│   └── video.js             285 ln  ffmpeg compress, segment, probe, verify
└── utils/
    ├── adaptive-budget.js   269 ln  ★ v5 — Transcript complexity → dynamic budget
    ├── cli.js               102 ln  ★ v6 — 16 flags including --no-focused-pass, --no-learning, --no-diff
    ├── context-manager.js   502 ln  4-tier priority, VTT slicing, progressive context, boundary detection
    ├── cost-tracker.js      158 ln  Token counting, USD cost estimation (+ focused pass tracking)
    ├── diff-engine.js       316 ln  ★ v6 — Cross-run delta: new/removed/changed items, Markdown rendering
    ├── focused-reanalysis.js 318 ln ★ v6 — Weakness detection, targeted second pass, intelligent merge
    ├── format.js             33 ln  Duration, bytes formatting
    ├── fs.js                 40 ln  Recursive doc finder
    ├── health-dashboard.js  217 ln  ★ v5 — Quality report, density bars, efficiency metrics
    ├── json-parser.js       246 ln  5-strategy JSON extraction + repair
    ├── learning-loop.js     302 ln  ★ v6 — History I/O, trend analysis, budget auto-tuning, recommendations
    ├── progress.js          167 ln  Checkpoint/resume persistence
    ├── prompt.js             33 ln  Interactive user prompts
    ├── quality-gate.js      430 ln  ★ v6 — 4+1 dimension scoring (+ confidence coverage), retry hints
    └── retry.js             130 ln  Exponential backoff, parallel map

prompt.json                  265 ln  ★ v6 — Confidence scoring instructions, evidence-based schema
process_and_upload.js         67 ln  Entry point, HELP_SHOWN handler
```

---

## Part 2: Where We Can Go

### Already Implemented (v6)

The following features from the original exploration have been **fully implemented**:

| Feature | Status | Implemented In |
|---------|--------|----------------|
| 📊 Confidence Scoring Per Extracted Item | ✅ Done | `prompt.json`, `quality-gate.js`, `markdown.js` |
| 🔄 Multi-Pass Analysis (Focused Re-extraction) | ✅ Done | `focused-reanalysis.js` (318 ln), pipeline integration |
| 🧠 Learning & Improvement Loop | ✅ Done | `learning-loop.js` (302 ln), pipeline init + save |
| 📝 Diff-Aware Compilation | ✅ Done | `diff-engine.js` (316 ln), pipeline output + MD |
| 🔍 Structured Logging & Observability | ✅ Done | `logger.js` rewritten (352 ln), JSONL + spans + metrics |
| Parallel segment analysis (via CLI) | ✅ Done | `--parallel-analysis` flag, pipeline batching |
| 🔎 Smart Change Detection & Progress Tracking | ✅ Done | `git.js` (280 ln), `change-detector.js` (310 ln), `progress-updater.js` (320 ln), pipeline `--update-progress` mode |

---

### Tier 1: High-Impact, Medium Effort

#### 🔊 Speaker Diarization & Attribution
**What**: Automatically identify who is speaking at each moment in the video.  
**How**: Use Gemini's audio understanding or integrate a dedicated diarization API (e.g., AssemblyAI, Deepgram) as a preprocessing step. Map speaker segments to VTT timestamps.  
**Impact**: Dramatically improves action item attribution ("Mohamed said X" vs. "someone said X"). Currently relies on Gemini inferring speakers from VTT voice tags or contextual clues.  
**Modules affected**: New `services/diarization.js`, updates to `gemini.js` content building, `context-manager.js` for speaker-aware slicing.

#### 🌐 Web Dashboard / Viewer
**What**: A browser-based UI to view analysis results interactively — filter by ticket, search, click timestamps to jump in video.  
**How**: Generate a self-contained HTML file alongside the MD output (embed results.json). Or build a lightweight React/Next.js viewer that reads from Firebase.  
**Impact**: Transforms the tool from CLI-output to a proper product. Stakeholders who don't use VS Code can access results.  
**Modules affected**: New `renderers/html.js` or separate `viewer/` project. Firebase integration for hosted version.

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
**How**: Abstract the AI service behind a provider interface. Each provider implements: `upload()`, `analyze()`, `compile()`. Config selects the active provider.  
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

#### 🧪 Test Suite
**What**: Unit tests for all utility modules, integration tests for the pipeline.  
**How**: Jest or Vitest. Mock Gemini API responses. Test quality gate scoring with fixtures. Test JSON parser with known-bad inputs. Test adaptive budget calculations. Test focused-reanalysis merge logic. Test diff-engine comparisons. Test learning-loop trend analysis.  
**Impact**: Confidence in changes. CI/CD pipeline with automated testing. Prevents regressions.  
**Priority modules to test**: `quality-gate.js`, `adaptive-budget.js`, `json-parser.js`, `context-manager.js`, `cost-tracker.js`, `focused-reanalysis.js`, `diff-engine.js`, `learning-loop.js`.

#### 📦 Packaging & Distribution
**What**: Publish as an npm package (`npx task-summary-extractor 'call 1'`), or as a standalone binary.  
**How**: Add bin field to package.json. Use `pkg` or `nexe` for standalone. Publish to npm registry.  
**Impact**: Installation becomes `npx task-summary-extractor` instead of cloning a repo.

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
| **Audio-only mode** — support .mp3/.wav without video | ~2 hrs | Works for phone calls, podcasts |
| **Watch mode** — monitor a folder and auto-process new recordings | ~3 hrs | Hands-free automation |
| **Git integration** — auto-commit results to repo | ~1 hr | Version-controlled meeting history |
| **Confidence threshold filter** — CLI flag to exclude LOW confidence items from output | ~1 hr | Cleaner reports on demand |
| **History viewer** — CLI command to print learning loop trends without running pipeline | ~2 hrs | Introspect past performance |

---

### Recommended Next Sprint

Based on impact vs. effort, here's a suggested 5-item sprint building on v6:

1. **Test suite foundation** — Jest setup + tests for quality-gate, adaptive-budget, json-parser, focused-reanalysis, diff-engine, learning-loop (1.5 days)
2. **Web dashboard / viewer** — Self-contained HTML report with filtering and video timestamp links (2 days)
3. **Speaker diarization** — Gemini audio understanding for speaker attribution (1.5 days)
4. **Task board integration** — Push tickets/CRs to Azure DevOps or Jira (1.5 days)
5. **Slack/email notification** — Post compiled results automatically (half day)

These five deliver: reliability (tests), accessibility (dashboard), accuracy (speakers), workflow integration (task board), and team visibility (notifications).

---

*Generated from the v6.0.0 codebase — 24 files, 7,400 lines of self-improving pipeline intelligence.*
