# Architecture & Technical Deep Dive

> Internal reference for the pipeline's architecture, processing flows, and design decisions.  
> This tool analyzes any recorded meeting or call — see [README.md](README.md) for use cases.  
> For usage instructions, see [README.md](README.md) · [Quick Start](QUICK_START.md)

---

## Table of Contents

- [System Architecture](#system-architecture)
- [Pipeline Phases](#pipeline-phases)
- [Per-Segment Processing](#per-segment-processing)
- [Smart Change Detection](#smart-change-detection)
- [Extraction Schema](#extraction-schema)
- [JSON Parser](#json-parser--5-strategy-extraction)
- [Quality Gate](#quality-gate--4-dimension-scoring)
- [Learning Loop](#learning-loop--self-improving-budgets)
- [Cross-Segment Continuity](#cross-segment-continuity)
- [Diff Engine](#diff-engine--cross-run-intelligence)
- [Document Processing](#document-context-processing)
- [Skip Logic / Caching](#skip-logic--caching)
- [Logging](#logging)
- [Tech Stack](#tech-stack)

---

## System Architecture

```mermaid
flowchart TB
    subgraph Entry["Entry Point"]
        EP["process_and_upload.js"]
    end

    subgraph Pipeline["pipeline.js — 8-Phase Orchestrator"]
        direction TB
        P1["Phase 1: Init"]
        P2["Phase 2: Discover"]
        P3["Phase 3: Services"]
        P4["Phase 4: Process Videos"]
        P5["Phase 5: Compile"]
        P6["Phase 6: Output"]
        P7["Phase 7: Health Dashboard"]
        P8["Phase 8: Summary"]

        P1 --> P2 --> P3 --> P4 --> P5 --> P6 --> P7 --> P8
    end

    subgraph Alt["Alternative Mode"]
        UP["--update-progress"]
    end

    subgraph Services["Services"]
        GEM["gemini.js"]
        FB["firebase.js"]
        VID["video.js"]
        GIT["git.js"]
    end

    subgraph Utils["Utilities — 17 modules"]
        QG["quality-gate"]
        FR["focused-reanalysis"]
        LL["learning-loop"]
        DE["diff-engine"]
        CD["change-detector"]
        PU["progress-updater"]
        CM["context-manager"]
        JP["json-parser"]
        AB["adaptive-budget"]
        HD["health-dashboard"]
        OT["+ 7 more"]
    end

    subgraph Renderers["Renderers"]
        MD["markdown.js"]
    end

    EP --> Pipeline
    P1 -.->|"--update-progress"| Alt
    Pipeline --> Services
    Pipeline --> Utils
    Pipeline --> Renderers
    Alt --> GIT
    Alt --> CD
    Alt --> PU
    Alt --> GEM
```

### Phase Descriptions

| Phase | Name | What Happens |
|-------|------|-------------|
| 1 | **Init** | CLI parsing, config validation, logger setup, load learning insights |
| 2 | **Discover** | Find videos, discover documents, resolve user name, check resume state |
| 3 | **Services** | Firebase auth, Gemini init, prepare document parts |
| 4 | **Process** | Compress → Upload → Analyze → Quality Gate → Retry → Focused Pass |
| 5 | **Compile** | Cross-segment compilation, diff engine comparison |
| 6 | **Output** | Write JSON, render Markdown, upload to Firebase |
| 7 | **Health** | Quality metrics dashboard, cost breakdown |
| 8 | **Summary** | Save learning history, print run summary |

---

## Pipeline Phases

```mermaid
flowchart LR
    subgraph P1["Phase 1: Init"]
        CLI["Parse CLI args"]
        CFG["Validate config"]
        LOG["Init logger"]
        LRN["Load learning history"]
    end

    subgraph P2["Phase 2: Discover"]
        VID["Find videos"]
        DOC["Find documents"]
        USR["Resolve user name"]
    end

    subgraph P3["Phase 3: Services"]
        FB["Firebase auth"]
        AI["Gemini init"]
        DPR["Prepare docs"]
    end

    subgraph P4["Phase 4: Process"]
        CMP["Compress"]
        UPL["Upload"]
        ANZ["Analyze"]
        QG["Quality Gate"]
        RTY["Retry"]
        FOC["Focused Pass"]
    end

    subgraph P5["Phase 5: Compile"]
        CFL["Final Compilation"]
        DIF["Diff Engine"]
    end

    subgraph P6["Phase 6: Output"]
        JSON["results.json"]
        MDR["results.md"]
        FBU["Firebase upload"]
    end

    subgraph P7["Phase 7: Health"]
        HD["Health Dashboard"]
    end

    subgraph P8["Phase 8: Summary"]
        SAV["Save learning history"]
        SUM["Print summary"]
    end

    P1 --> P2 --> P3 --> P4 --> P5 --> P6 --> P7 --> P8
```

---

## Per-Segment Processing

Each video segment goes through this flow (Phase 4 detail):

```mermaid
flowchart TB
    START(["Segment N"]) --> COMPRESS["ffmpeg compress\nH.264 CRF 24, 1.5x speed"]
    COMPRESS --> VERIFY["Verify segment integrity"]
    VERIFY --> UPLOAD_FB["Upload to Firebase Storage"]
    VERIFY --> UPLOAD_GEM["Upload to Gemini File API"]
    UPLOAD_GEM --> WAIT["Poll until ACTIVE"]
    WAIT --> ANALYZE["Gemini AI Analysis\nVideo + Docs + Prompt + Context"]
    ANALYZE --> PARSE["JSON Parser\n5-strategy extraction"]
    PARSE --> QUALITY{"Quality Gate\nScore 0-100"}

    QUALITY -->|"Score < 45"| RETRY["Auto-Retry\nwith corrective hints"]
    RETRY --> ANALYZE
    QUALITY -->|"Score 45-59\nweak areas"| FOCUS["Focused Re-Analysis\ntargeted second pass"]
    FOCUS --> MERGE["Merge focused results"]
    QUALITY -->|"Score >= 60"| NEXT(["Next Segment"])
    MERGE --> NEXT

    NEXT --> CTX["Inject into cross-segment context"]
```

### Quality Gate Decision Table

| Score | Action |
|-------|--------|
| < 45 | Auto-retry with corrective hints |
| 45–59 with ≥2 weak dimensions | Focused re-analysis on weak areas |
| ≥ 60 | Pass |

---

## Smart Change Detection

The `--update-progress` mode tracks which extracted items have been addressed:

```mermaid
flowchart TB
    START(["--update-progress"]) --> LOAD["Load latest\ncompilation.json"]
    LOAD --> GIT["Git: commits, changed files,\nworking tree, diff summary"]
    LOAD --> DOCS["Doc changes:\nfile mtime comparison"]

    GIT --> ITEMS["Extract trackable items\nfrom analysis"]
    DOCS --> ITEMS

    ITEMS --> CORR["Correlation Engine"]

    CORR --> S1["File Path Match\nscore: +0.4"]
    CORR --> S2["Ticket ID in Commit\nscore: +0.5"]
    CORR --> S3["Keyword Overlap\nscore: +0.3"]
    CORR --> S4["Commit-File Overlap\nscore: +0.15"]

    S1 & S2 & S3 & S4 --> LOCAL["Local Assessment"]

    LOCAL --> AI{"Gemini AI\navailable?"}
    AI -->|Yes| SMART["AI Smart Layer\nReviews all evidence\nAssigns final status"]
    AI -->|No| OUTPUT

    SMART --> OUTPUT(["Output"])
    OUTPUT --> PJ["progress.json"]
    OUTPUT --> PM["progress.md"]
    OUTPUT --> FBU["Firebase upload"]
```

### Correlation Strategies

| Strategy | Score Contribution | How It Works |
|----------|--------------------|-------------|
| **File Path Match** | +0.4 | Git changed files match file paths mentioned in analysis items |
| **Ticket ID in Commit** | +0.5 | Commit messages contain ticket IDs from extracted items |
| **Keyword Overlap** | +0.3 | Keywords from item descriptions appear in commit messages or file names |
| **Commit-File Overlap** | +0.15 | Files touched in commits overlap with files referenced across items |

### Assessment Thresholds

| Correlation Score | Status Assigned |
|-------------------|----------------|
| ≥ 0.6 | **DONE** ✅ |
| ≥ 0.25 | **IN_PROGRESS** 🔄 |
| < 0.25 | **NOT_STARTED** ⏳ |
| *(AI override)* | **SUPERSEDED** 🔀 |

---

## Extraction Schema

The AI extracts 6 structured categories from each meeting. The categories are content-adaptive — the AI populates whichever fields are relevant to the actual discussion.

### Categories

| Category | Key Fields | Adapts To |
|----------|-----------|----------|
| **Tickets / Items** | `ticket_id`, `title`, `status`, `assignee`, `reviewer`, `video_segments` with timestamps, `speaker_comments`, `details` with priority, confidence | Sprint items, requirements, interview topics, incident items |
| **Change Requests** | `WHERE` (target: file, system, process, scope), `WHAT` (specific change), `HOW` (approach), `WHY` (justification), `dependencies`, `blocked_by`, confidence | Code changes, requirement changes, process changes, scope adjustments |
| **References** | `name`, `type`, `role`, cross-refs to tickets & CRs, `context_doc_match` | Files, documents, URLs, tools, systems, resources mentioned |
| **Action Items** | `description`, `assigned_to`, `status`, `deadline`, `dependencies`, related tickets & CRs, confidence | Any follow-up work discussed |
| **Blockers** | `description`, `severity`, `owner`, `status`, `proposed_resolution`, confidence | Technical blockers, approval gates, resource constraints |
| **Scope Changes** | `type` (added/removed/deferred), `original` vs `new` scope, `decided_by`, `impact`, confidence | Feature scope, project scope, contract scope, training scope |

### Personalized Task Section

Every analysis includes a `your_tasks` section scoped to the `--name` user:

| Field | Description |
|-------|-------------|
| `owned_tickets` | Items assigned to you |
| `tasks_todo` | Action items with priority |
| `waiting_on_others` | Items blocked on other people |
| `decisions_needed` | Things you need to decide |
| `completed_in_call` | Items resolved during the meeting |

### Confidence Scoring

Every extracted item carries a confidence rating:

| Level | Criteria | Example |
|-------|----------|---------|
| **HIGH** | Explicitly stated + corroborated | "Mentioned with ticket ID in VTT and task docs" |
| **MEDIUM** | Partially stated or single-source | "Discussed verbally, no written reference" |
| **LOW** | Inferred from context | "Implied from related discussion" |

---

## JSON Parser — 5-Strategy Extraction

Gemini output is unpredictable. The parser handles it with cascading strategies:

```mermaid
flowchart TB
    RAW(["Raw AI Response"]) --> S1["Strategy 1\nStrip markdown fences"]
    S1 -->|fail| S2["Strategy 2\nBrace-depth matching"]
    S2 -->|fail| S3["Strategy 3\nRegex fence extraction"]
    S3 -->|fail| S4["Strategy 4\nTruncation repair"]
    S4 -->|fail| S5["Strategy 5\nDoubled-closer fix"]

    S1 -->|success| OK
    S2 -->|success| OK
    S3 -->|success| OK
    S4 -->|success| OK
    S5 -->|success| OK

    S1 & S2 & S3 & S4 & S5 -->|"each retries with"| SAN["Escape Sanitizer\nFixes invalid backslash-d backslash-s backslash-w"]
    SAN -->|success| OK(["Parsed JSON"])
    SAN -->|"still fails"| MAL["Malformation Fixer\nDoubled braces, trailing commas"]
    MAL -->|success| OK
    MAL -->|fail| NULL(["null — parse failed"])
```

Each strategy is tried in order. If a strategy fails, it falls through to the next. After each strategy, a sanitizer pass is attempted. This achieves >99% parse success on real Gemini output.

---

## Quality Gate — 4-Dimension Scoring

| Dimension | Weight | What It Measures |
|-----------|--------|------------------|
| **Density** | 30% | Items extracted per minute of video |
| **Structure** | 25% | Required fields present (IDs, assignees, statuses) |
| **Confidence** | 25% | Confidence field coverage + calibration (not all HIGH) |
| **Cross-References** | 20% | Tickets linked to CRs, files referenced, action items connected |

The weighted sum yields a score 0–100. Low scores trigger automatic retry or focused re-analysis.

---

## Learning Loop — Self-Improving Budgets

```mermaid
flowchart LR
    HIST["history.json\nup to 50 runs"] --> ANALYZE["analyzeHistory()"]
    ANALYZE --> TREND["Quality trend:\nimproving / declining / stable"]
    ANALYZE --> ADJ["Budget adjustment"]
    ANALYZE --> REC["Recommendations"]

    ADJ --> PIPE["Applied to next pipeline run"]
    PIPE --> SAVE["After run: save metrics"]
    SAVE --> HIST
```

| Condition | Adjustment |
|-----------|-----------|
| Avg quality < 45 | +4096 thinking tokens |
| Avg quality > 80 | -2048 thinking tokens (save cost) |
| Quality stable | No change |

---

## Cross-Segment Continuity

```mermaid
flowchart LR
    S0(["Segment 0"]) --> CTX1["Context:\ntickets, CRs, names,\nfile refs, your_tasks"]
    CTX1 --> S1(["Segment 1"])
    S1 --> CTX2["Accumulated context\nfrom segments 0+1"]
    CTX2 --> S2(["Segment 2"])
    S2 --> CTX3["...continues"]
```

Each segment receives the full accumulated context from all prior segments. This ensures:
- Topic IDs mentioned in segment 0 are recognized in segment 3
- CR numbering is consistent across the entire recording
- Speaker names are resolved once and carried forward

---

## Diff Engine — Cross-Run Intelligence

When a previous run exists, the diff engine compares:

| Category | Detection |
|----------|-----------|
| **New items** | Present in current, absent in previous |
| **Resolved items** | Present in previous, absent in current |
| **Changed items** | Same ID but different status, assignee, or description |
| **Stable items** | Unchanged across runs |

This is useful when re-running analysis after updating documents — the diff shows exactly what the AI extracted differently.

---

## Document Context Processing

| Extension | Method | Description |
|-----------|--------|-------------|
| `.vtt` `.srt` `.txt` `.md` `.csv` | Inline text | Read and passed directly as text parts |
| `.pdf` | Gemini File API | Uploaded as binary, Gemini processes natively |
| `.docx` `.doc` | Firebase only | Uploaded for archival, not processable by Gemini |

Directories skipped during recursive discovery: `node_modules`, `.git`, `compressed`, `logs`, `gemini_runs`

---

## Skip Logic / Caching

| Stage | Skip Condition |
|-------|----------------|
| **Compression** | `compressed/{video}/segment_*.mp4` exist on disk |
| **Firebase upload** | File already exists at `calls/{name}/segments/{video}/` |
| **Gemini analysis** | Run file exists in `gemini_runs/` AND user chooses not to re-analyze |

---

## Logging

Every run creates two log files in `logs/`:

| File | Contents |
|------|----------|
| **Detailed** (`_detailed.log`) | All console output, debug info, response previews, timestamps |
| **Minimal** (`_minimal.log`) | Key milestones: start, compression, uploads, AI results, errors |

Log levels: `STEP` (milestones) · `INFO` (verbose) · `WARN` (non-fatal) · `ERR` (failures) · `DBG` (debug data)

JSONL structured format includes phase spans with timing metrics for observability.

---

## Tech Stack

| Component | Package | Purpose |
|-----------|---------|---------|
| **Node.js** | ≥ 18.0.0 | Runtime (v24 tested) |
| **Gemini AI** | `@google/genai@^1.42.0` | Video analysis, File API, 1M context window |
| **Firebase** | `firebase@^11.0.0` | Anonymous auth + Cloud Storage uploads |
| **dotenv** | `dotenv@^17.3.1` | Environment variable loading |
| **ffmpeg** | System binary | H.264 video compression + segmentation |
| **Git** | System binary | Change detection for progress tracking |

**Codebase: 29 files · 10,626 lines**

---

## Video Encoding Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| Codec | H.264 (libx264) | Universal compatibility |
| CRF | 24 (screenshare) / 20 (4K) | Quality-size balance |
| Tune | `stillimage` | Optimized for screen content |
| Sharpening | `unsharp=3:3:0.3` | Preserve text clarity |
| x264 params | `aq-mode=3:deblock=-1,-1:psy-rd=1.0,0.0` | Text readability |
| Audio | AAC, 64–128k, original sample rate | Clear speech |

---

## Gemini Run Record Format

Each segment analysis is saved as a timestamped JSON file:

```json
{
  "run": {
    "model": "gemini-2.5-flash",
    "displayName": "my-meeting_Recording_seg00",
    "userName": "Jane Smith",
    "timestamp": "2026-02-23T17:39:50.123Z",
    "durationMs": 45230
  },
  "input": {
    "videoFile": { "mimeType": "video/mp4", "fileUri": "..." },
    "contextDocuments": [{ "fileName": ".tasks/requirements.md" }],
    "previousSegmentCount": 0
  },
  "output": {
    "raw": "{ ... full AI response ... }",
    "parsed": { "tickets": [], "change_requests": [] },
    "parseSuccess": true
  }
}
```
