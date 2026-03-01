# PLAN.md — Feature Implementation Roadmap

> **taskex** v8.3.0 → v9.0.0  
> **Author:** Youssef Adel  
> **Last updated:** 2026-02-27  
> **Status:** Planning  

---

## Table of Contents

| #  | Feature                                   | Priority | Complexity | Est. Hours |
|----|-------------------------------------------|----------|------------|------------|
| 1  | [Progress Bar](#1-progress-bar)           | P0       | Low        | 4–6        |
| 2  | [HTML Report Viewer](#2-html-report-viewer) | P1     | Medium     | 10–14      |
| 3  | [JSON Schema Validation](#3-json-schema-validation) | P0 | Medium   | 8–10       |
| 4  | [Confidence Filter](#4-confidence-filter) | P1       | Low        | 3–5        |
| 5  | [Watch Mode](#5-watch-mode)               | P2       | Medium     | 8–12       |
| 6  | [Decompose pipeline.js](#6-decompose-pipelinejs) | P0 | High     | 12–16      |
| 7  | [Streaming / Live Analysis](#7-streaming--live-analysis) | P3 | Very High | 20–30 |
| 8  | [Test Suite](#8-test-suite)               | P0       | High       | 16–24      |
| 9  | [Audio-Only & Doc-Only Mode](#9-audio-only--doc-only-mode) | P0 | Medium | 6–8 |

**Total estimate:** 87–125 hours  
**Recommended implementation order:** 9 → 6 → 8 → 3 → 1 → 4 → 2 → 5 → 7

---

## 1. Progress Bar

**Goal:** Replace the opaque polling dots (`process.stdout.write('.')`) and silent waits with a real-time, informative progress display.

### Current State

- **`gemini.js`** `processWithGemini()` — polls Gemini File API status with `'.'` dots while waiting for file processing  
- **`pipeline.js`** `phaseProcessVideo()` — loops segments with `console.log` per segment, no aggregate progress  
- **`pipeline.js`** `run()` — calls 9 phases sequentially; each phase prints its own log, no unified bar  
- `parallelMap()` in `retry.js` runs concurrent segment analyses without any visual feedback  

### Design

```
  Processing: call 1
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 67% │ Phase 5/9: Compile
  Segment 4/6 ██████████████░░░░░░░░░░ 4/6 analyzed │ Cost: $0.12 │ ETA: 2m 14s
```

### Implementation

#### 1.1 Create `src/utils/progress-bar.js` (~150 lines)

```js
class ProgressBar {
  constructor(opts = {}) {
    this.total = opts.total || 0;
    this.current = 0;
    this.phase = '';
    this.phaseIndex = 0;
    this.totalPhases = 9;
    this.startTime = Date.now();
    this.width = opts.width || 40;
    this.stream = opts.stream || process.stderr;
    this.enabled = opts.enabled !== false && this.stream.isTTY;
    this.costTracker = opts.costTracker || null;
  }

  setPhase(name, index) { /* update phase label + index */ }
  tick(label) { /* increment current, redraw */ }
  setTotal(n) { /* set total for current phase */ }
  render() { /* write \r + bar + stats to stream */ }
  finish() { /* complete bar, newline */ }

  _eta() {
    const elapsed = Date.now() - this.startTime;
    const rate = this.current / elapsed;
    const remaining = (this.total - this.current) / rate;
    return fmtDuration(remaining / 1000);
  }
}
```

**Key decisions:**
- Write to `stderr` so bar doesn't pollute piped `stdout`
- Detect non-TTY (CI, piped) — fall back to simple line-per-event logging
- Use `\r` overwrite for single-line updates; `\n` only on phase transitions
- Integrate `CostTracker` for live cost display

#### 1.2 Wire into pipeline phases

| Phase | Progress Source | Total |
|-------|----------------|-------|
| `phaseInit` | 1 tick | 1 |
| `phaseDiscover` | 1 tick | 1 |
| `phaseServices` | doc prep ticks | `allDocFiles.length` |
| `phaseProcessVideo` | per-segment: compress, upload, analyze, quality-gate | `segments.length × 4` |
| `phaseCompile` | 1 tick (long AI call) | 1 |
| `phaseOutput` | JSON write, MD render, diff | 3 |
| `phaseSummary` | 1 tick | 1 |
| `phaseDeepDive` | per-topic | `topics.length` |

#### 1.3 Wire into Gemini polling

In `gemini.js`, the file-upload polling loop currently does:
```js
process.stdout.write('.');
```
Replace with a callback:
```js
async function waitForFileActive(file, { onPoll } = {}) {
  while (file.state === 'PROCESSING') {
    if (onPoll) onPoll();
    await sleep(5000);
    file = await ai.files.get({ name: file.name });
  }
}
```
Pipeline passes `onPoll: () => bar.tick('Uploading...')`.

#### 1.4 Non-TTY fallback

```js
if (!stream.isTTY) {
  // Print: "  [Phase 5/9] Compile — segment 4/6"
  // One line per meaningful event, no \r overwrites
}
```

### Files Changed

| File | Change |
|------|--------|
| `src/utils/progress-bar.js` | **New** — ProgressBar class |
| `src/pipeline.js` | Import + instantiate bar in `phaseInit`, pass to each phase, call `setPhase`/`tick` |
| `src/services/gemini.js` | Add `onPoll` callback to file-upload polling; add `onProgress` to `processWithGemini` |
| `src/utils/retry.js` | Add optional `onTick` callback to `parallelMap()` for concurrent progress |

### Risks

- **Windows terminal quirks** — `\r` works on cmd/PowerShell but some CI runners may not support it; non-TTY fallback covers this.
- **Parallel segment analysis** — multiple segments polling concurrently; bar must aggregate, not overwrite per-worker.

---

## 2. HTML Report Viewer

**Goal:** Generate a self-contained HTML file alongside the existing Markdown output, with interactive filtering, collapsible sections, confidence badges, and optional dark mode.

### Current State

- `src/renderers/markdown.js` (969 lines) — generates `results.md` with name clustering, confidence badges, diff sections, user-first layout  
- `pipelineOutput()` in `pipeline.js` writes `results.json` + `results.md` to the run directory  
- No web-based output exists  

### Design

#### Single self-contained HTML file

```
runs/2026-02-27T12-00-00/
  results.json
  results.md
  results.html     ← NEW
```

The HTML file embeds all CSS and JS inline (no external dependencies) so it opens in any browser with `file://`.

#### Features

| Feature | Details |
|---------|---------|
| Person tabs | One tab per person (like MD sections), user promoted to first |
| Confidence badges | Color-coded: 🟢 HIGH, 🟡 MEDIUM, 🔴 LOW |
| Filter controls | Dropdown: filter by confidence, person, item type |
| Collapsible sections | Tickets, CRs, Action Items, Blockers collapsible |
| Search | Live text search across all items |
| Diff view | If diff data available, toggle to show changes since last run |
| Dark mode | `prefers-color-scheme` + manual toggle |
| Print-friendly | `@media print` stylesheet strips interactive elements |
| Metadata header | Call name, date, model used, cost, segment count, quality scores |

#### Architecture

```
src/renderers/
  markdown.js     (existing — 969 lines)
  html.js         (NEW — ~400 lines)
  templates/
    report.html   (NEW — HTML template with {{placeholders}})
```

### Implementation

#### 2.1 Create `src/renderers/html.js` (~400 lines)

```js
/**
 * HTML renderer — generates a self-contained HTML report.
 * Reuses name clustering and dedup logic from markdown.js.
 */
function renderHtml(compiled, opts = {}) {
  const { userName, callName, runMeta, diffReport } = opts;
  // 1. Cluster names (share logic with markdown.js — extract to shared util)
  // 2. Build data structure for template
  // 3. Inject into HTML template
  // 4. Return complete HTML string
}
```

#### 2.2 Extract shared logic from `markdown.js`

The following functions should move to `src/renderers/shared.js`:
- `clusterNames()` (line 47)
- `resolve()` (line 100)
- `stripParens()` / `normalizeKey()` (lines 28–40)
- `dedup()` logic (items by ID)
- Confidence stats calculation

This avoids duplicating ~200 lines of name clustering/dedup between MD and HTML renderers.

#### 2.3 Create HTML template

The template uses simple `{{variable}}` placeholders (no template engine dependency).

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{{callName}} — Analysis Report</title>
  <style>/* ~200 lines of embedded CSS */</style>
</head>
<body>
  <header>...</header>
  <nav id="person-tabs">{{personTabs}}</nav>
  <main>{{content}}</main>
  <script>/* ~100 lines: tab switching, filtering, search, dark mode */</script>
</body>
</html>
```

#### 2.4 Wire into pipeline

In `phaseOutput()` of `pipeline.js`:
```js
// After MD render
if (!opts.skipHtml) {
  const htmlContent = renderHtml(finalCompiled, { userName, callName, runMeta, diffReport });
  fs.writeFileSync(path.join(runDir, 'results.html'), htmlContent, 'utf8');
  console.log(`  ✓ HTML report → ${runDir}/results.html`);
}
```

#### 2.5 CLI flag

Add `--format` flag to `cli.js`:
```
--format <formats>    Output formats: md,html,json (default: md,json)
                      Use "all" for all formats
--no-html             Disable HTML output (if enabled by default)
```

### Files Changed

| File | Change |
|------|--------|
| `src/renderers/html.js` | **New** — HTML renderer |
| `src/renderers/shared.js` | **New** — Extracted name clustering, dedup, confidence stats |
| `src/renderers/templates/report.html` | **New** — HTML template |
| `src/renderers/markdown.js` | Import shared utils instead of internal defs |
| `src/pipeline.js` | Call `renderHtml()` in `phaseOutput()` |
| `src/utils/cli.js` | Add `--format` / `--no-html` flags to `BOOLEAN_FLAGS` and `parseArgs` |

### Risks

- **Template size** — embedded CSS + JS could reach 15–20 KB; still far smaller than adding a framework.
- **Browser compatibility** — stick to vanilla JS and CSS Grid/Flexbox; no Web Components. Target: Chrome, Firefox, Edge, Safari (modern versions only).

---

## 3. JSON Schema Validation

**Goal:** Validate every Gemini AI response against a formal JSON Schema derived from `prompt.json`'s `output_structure`, catching malformed or incomplete responses before they propagate.

### Current State

- `prompt.json` defines `output_structure` (lines 249–326) with field descriptions, types, and examples — but this is prose, not a formal schema
- `json-parser.js` (246 lines) — 5-strategy extraction (strip fences → brace-match → regex → doubled-closer repair → truncation repair); validates parseability but not structure
- `quality-gate.js` (424 lines) — scores structural completeness via `scoreStructure()` checking for 4 required fields (`tickets`, `action_items`, `change_requests`, `summary`) and 4 optional fields; scores density, integrity, cross-references  
- No formal JSON Schema used anywhere; structural checks are hand-coded

### Design

#### Generate JSON Schema from prompt.json

Rather than maintain a separate schema file, **derive** the schema from `prompt.json` at build time or startup:

```
prompt.json (output_structure)
    ↓ build-schema.js (one-time generation)
src/schemas/
    analysis-segment.schema.json    ← per-segment output
    analysis-compiled.schema.json   ← compiled output
```

#### Validation flow

```
Gemini raw output
    → json-parser.js (extract JSON)
    → schema-validator.js (validate against schema)
        → PASS: continue to quality gate
        → FAIL: map errors to quality-gate diagnostics
            → retry with schema-aware hints
    → quality-gate.js (score quality)
```

### Implementation

#### 3.1 Create `src/schemas/analysis-segment.schema.json`

Derived from `prompt.json` `output_structure`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Segment Analysis",
  "type": "object",
  "required": ["tickets", "action_items", "change_requests", "summary"],
  "properties": {
    "tickets": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["ticket_id", "discussed_state", "confidence", "confidence_reason"],
        "properties": {
          "ticket_id": { "type": "string" },
          "discussed_state": { "type": "string" },
          "comments": { "type": "array", "items": { "type": "object" } },
          "code_changes": { "type": "array", "items": { "type": "object" } },
          "confidence": { "enum": ["HIGH", "MEDIUM", "LOW"] },
          "confidence_reason": { "type": "string" }
        }
      }
    },
    "action_items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "description", "assigned_to", "confidence"],
        "properties": {
          "id": { "type": "string" },
          "description": { "type": "string" },
          "assigned_to": { "type": "string" },
          "priority": { "enum": ["high", "medium", "low"] },
          "confidence": { "enum": ["HIGH", "MEDIUM", "LOW"] },
          "confidence_reason": { "type": "string" }
        }
      }
    },
    "change_requests": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "what", "where", "confidence"],
        "properties": {
          "id": { "type": "string" },
          "what": { "type": "string" },
          "where": { "type": "string" },
          "requested_by": { "type": "string" },
          "ticket_id": { "type": "string" },
          "confidence": { "enum": ["HIGH", "MEDIUM", "LOW"] },
          "confidence_reason": { "type": "string" }
        }
      }
    },
    "blockers": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["description", "confidence"],
        "properties": {
          "description": { "type": "string" },
          "impact": { "type": "string" },
          "suggested_resolution": { "type": "string" },
          "confidence": { "enum": ["HIGH", "MEDIUM", "LOW"] }
        }
      }
    },
    "scope_changes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["description", "confidence"],
        "properties": {
          "description": { "type": "string" },
          "from_scope": { "type": "string" },
          "to_scope": { "type": "string" },
          "confidence": { "enum": ["HIGH", "MEDIUM", "LOW"] }
        }
      }
    },
    "file_references": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file_path": { "type": "string" },
          "context": { "type": "string" },
          "language": { "type": "string" }
        }
      }
    },
    "your_tasks": {
      "type": "object",
      "properties": {
        "tasks_todo": { "type": "array", "items": { "type": "object" } },
        "tasks_waiting_on_others": { "type": "array", "items": { "type": "object" } },
        "decisions_needed": { "type": "array", "items": { "type": "object" } },
        "completed_in_call": { "type": "array", "items": { "type": "object" } }
      }
    },
    "summary": { "type": "string", "minLength": 1 }
  }
}
```

#### 3.2 Create `src/utils/schema-validator.js` (~120 lines)

Use **Ajv** (Another JSON Schema Validator) — the standard Node.js JSON Schema library:

```js
const Ajv = require('ajv');
const segmentSchema = require('../schemas/analysis-segment.schema.json');
const compiledSchema = require('../schemas/analysis-compiled.schema.json');

const ajv = new Ajv({ allErrors: true, verbose: true });
const validateSegment = ajv.compile(segmentSchema);
const validateCompiled = ajv.compile(compiledSchema);

function validateAnalysis(data, type = 'segment') {
  const validate = type === 'segment' ? validateSegment : validateCompiled;
  const valid = validate(data);
  if (valid) return { valid: true, errors: [] };

  return {
    valid: false,
    errors: validate.errors.map(err => ({
      path: err.instancePath,
      message: err.message,
      keyword: err.keyword,
      params: err.params,
    })),
    retryHints: buildSchemaRetryHints(validate.errors),
  };
}
```

#### 3.3 Integrate into pipeline

In `phaseProcessVideo()`, after `json-parser.js` extracts JSON and before `quality-gate.js`:

```js
// After: const parsed = extractJson(rawOutput);
const schemaResult = validateAnalysis(parsed, 'segment');
if (!schemaResult.valid) {
  log.warn(`Schema validation failed for segment ${idx}:`, schemaResult.errors);
  // Merge schema errors into quality gate context
  parseContext.schemaErrors = schemaResult.errors;
  parseContext.schemaRetryHints = schemaResult.retryHints;
}
```

#### 3.4 Schema-aware retry hints

Map schema validation errors to actionable retry instructions:

```js
function buildSchemaRetryHints(errors) {
  const hints = [];
  for (const err of errors) {
    if (err.keyword === 'required') {
      hints.push(`MISSING FIELD: "${err.params.missingProperty}" is required in ${err.instancePath || 'root'}`);
    }
    if (err.keyword === 'enum') {
      hints.push(`INVALID VALUE at ${err.instancePath}: must be one of ${err.params.allowedValues.join(', ')}`);
    }
    if (err.keyword === 'type') {
      hints.push(`WRONG TYPE at ${err.instancePath}: expected ${err.params.type}`);
    }
  }
  return hints;
}
```

### Files Changed

| File | Change |
|------|--------|
| `src/schemas/analysis-segment.schema.json` | **New** — Segment analysis JSON Schema |
| `src/schemas/analysis-compiled.schema.json` | **New** — Compiled analysis JSON Schema |
| `src/utils/schema-validator.js` | **New** — Ajv-based validator + retry hint builder |
| `src/pipeline.js` | Import validator; call after `extractJson()`, before `assessQuality()` |
| `src/utils/quality-gate.js` | Accept `schemaErrors` in context; factor into score |
| `package.json` | Add `"ajv": "^8.17.0"` to dependencies |

### Risks

- **Schema drift** — `prompt.json` evolves but schema falls behind. Mitigate: add a build-time script that re-generates schemas from `prompt.json` and warns on differences.
- **Overly strict** — Gemini sometimes includes extra fields. Set `additionalProperties: true` in schema to allow extras without failing validation.

---

## 4. Confidence Filter

**Goal:** Add a `--min-confidence` CLI flag that filters out items below a confidence threshold from the final output.

### Current State

- Every extracted item already has `"confidence": "HIGH|MEDIUM|LOW"` and `"confidence_reason"` fields  
- `quality-gate.js` `scoreDensity()` already counts and scores confidence coverage  
- `markdown.js` already renders confidence badges: `🟢 HIGH`, `🟡 MEDIUM`, `🔴 LOW`  
- No filtering mechanism exists — all items appear regardless of confidence  

### Design

```
taskex "call 1" --min-confidence medium
```

Confidence hierarchy: `HIGH > MEDIUM > LOW`

| Flag Value | Keeps |
|------------|-------|
| `high` | Only HIGH items |
| `medium` | HIGH + MEDIUM items |
| `low` (default) | All items (current behavior) |

### Implementation

#### 4.1 Add CLI flag

In `cli.js` `parseArgs()`:
- Add `'min-confidence'` as a value-consuming flag (not boolean)
- Validate: must be `high`, `medium`, or `low`

#### 4.2 Create `src/utils/confidence-filter.js` (~60 lines)

```js
const LEVELS = { HIGH: 3, MEDIUM: 2, LOW: 1 };

function filterByConfidence(compiled, minLevel = 'LOW') {
  const threshold = LEVELS[minLevel.toUpperCase()] || 1;
  const filter = (items) =>
    (items || []).filter(item =>
      (LEVELS[item.confidence] || 1) >= threshold
    );

  return {
    ...compiled,
    tickets:         filter(compiled.tickets),
    action_items:    filter(compiled.action_items),
    change_requests: filter(compiled.change_requests),
    blockers:        filter(compiled.blockers),
    scope_changes:   filter(compiled.scope_changes),
    // your_tasks sub-arrays
    your_tasks: compiled.your_tasks ? {
      tasks_todo:              filter(compiled.your_tasks.tasks_todo),
      tasks_waiting_on_others: filter(compiled.your_tasks.tasks_waiting_on_others),
      decisions_needed:        filter(compiled.your_tasks.decisions_needed),
      completed_in_call:       filter(compiled.your_tasks.completed_in_call),
    } : compiled.your_tasks,
    // Keep summary, file_references untouched (no confidence on those)
    _filterMeta: {
      minConfidence: minLevel.toUpperCase(),
      originalCounts: { /* counts before filtering */ },
      filteredCounts: { /* counts after filtering */ },
    },
  };
}
```

#### 4.3 Wire into pipeline

In `phaseOutput()`, between compilation result and rendering:

```js
let outputData = finalCompiled;
if (opts.minConfidence && opts.minConfidence !== 'low') {
  outputData = filterByConfidence(finalCompiled, opts.minConfidence);
  const meta = outputData._filterMeta;
  console.log(`  Confidence filter: ${meta.minConfidence} → kept ${meta.filteredCounts.total}/${meta.originalCounts.total} items`);
}

// results.json always contains FULL unfiltered data (for programmatic use)
fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(finalCompiled, null, 2));

// results.md and results.html use filtered data
const mdContent = renderMarkdown(outputData, { userName, ... });
```

#### 4.4 Update markdown renderer

Add a notice at the top of the MD when filtering is active:

```markdown
> ⚠️ **Confidence filter active:** showing only MEDIUM and HIGH confidence items.
> Full unfiltered data available in `results.json`.
```

### Files Changed

| File | Change |
|------|--------|
| `src/utils/confidence-filter.js` | **New** — Filter logic |
| `src/utils/cli.js` | Add `min-confidence` to known flags, validate value |
| `src/pipeline.js` | Import + apply filter in `phaseOutput()` before rendering |
| `src/renderers/markdown.js` | Add filter notice banner |
| `src/renderers/html.js` | (When built) Add interactive confidence filter toggle |

---

## 5. Watch Mode

**Goal:** Monitor a folder for new video/audio/document files and automatically trigger analysis when files appear.

### Design

```
taskex watch [folder] [--poll-interval 5000]
```

#### Workflow

```
1. User drops a .mp4 / .mp3 / .vtt into the watched folder
2. Watch mode detects the new file
3. Waits for file to stop growing (copy-in-progress detection)
4. Triggers a full pipeline run for that file
5. Returns to watching
```

### Implementation

#### 5.1 Create `src/modes/watch-mode.js` (~200 lines)

```js
const fs = require('fs');
const path = require('path');

const WATCH_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.webm',  // video
  '.mp3', '.wav', '.m4a', '.ogg', '.flac',  // audio
  '.vtt', '.srt', '.txt', '.pdf', '.docx',  // docs
]);

class WatchMode {
  constructor(targetDir, opts = {}) {
    this.targetDir = targetDir;
    this.pollInterval = opts.pollInterval || 5000;
    this.debounceMs = opts.debounceMs || 3000;
    this.processedFiles = new Set();
    this.pendingFiles = new Map(); // path → { size, stableCount }
    this.running = false;
  }

  async start() {
    console.log(`\n  👁  Watch mode active — monitoring: ${this.targetDir}`);
    console.log(`  Drop video/audio/document files to trigger analysis.`);
    console.log(`  Press Ctrl+C to stop.\n`);

    this.running = true;
    // Load already-processed files from existing runs/
    this._loadProcessedHistory();

    // Use fs.watch with polling fallback for network drives
    this._startWatcher();

    // Also poll for stability (file size stopped changing)
    this._pollLoop();
  }

  _startWatcher() {
    // fs.watch for instant detection
    try {
      fs.watch(this.targetDir, { recursive: false }, (event, filename) => {
        if (filename && this._isWatchable(filename)) {
          this._enqueue(path.join(this.targetDir, filename));
        }
      });
    } catch {
      // Fallback to pure polling on unsupported systems
    }
  }

  async _pollLoop() {
    while (this.running) {
      // Check pending files for stability
      for (const [filePath, meta] of this.pendingFiles) {
        const currentSize = this._getFileSize(filePath);
        if (currentSize === meta.size) {
          meta.stableCount++;
          if (meta.stableCount >= 2) {
            // File stable — trigger processing
            this.pendingFiles.delete(filePath);
            await this._processFile(filePath);
          }
        } else {
          meta.size = currentSize;
          meta.stableCount = 0;
        }
      }
      await new Promise(r => setTimeout(r, this.pollInterval));
    }
  }

  async _processFile(filePath) {
    if (this.processedFiles.has(filePath)) return;
    this.processedFiles.add(filePath);

    console.log(`\n  📥 New file detected: ${path.basename(filePath)}`);
    console.log(`  Starting analysis...\n`);

    // Import and run pipeline
    const { run } = require('../pipeline');
    try {
      await run({
        folderPath: this.targetDir,
        specificFile: filePath,
        // inherit current opts
      });
    } catch (err) {
      console.error(`  ✗ Analysis failed: ${err.message}`);
    }

    console.log(`\n  👁  Watching for new files...\n`);
  }
}
```

#### 5.2 CLI integration

In `cli.js`, add `'watch'` as a recognized subcommand:
```
taskex watch                        Watch current directory
taskex watch "call 1"               Watch specific folder
taskex watch --poll-interval 10000  Custom poll interval
```

#### 5.3 Wire into entry point

In `process_and_upload.js` / `bin/taskex.js`:
```js
if (flags.watch || positional[0] === 'watch') {
  const watchMode = new WatchMode(targetDir, { pollInterval: flags['poll-interval'] });
  await watchMode.start();
  return;
}
```

### Files Changed

| File | Change |
|------|--------|
| `src/modes/watch-mode.js` | **New** — File watcher with stability detection |
| `src/utils/cli.js` | Add `watch` subcommand, `--poll-interval` flag |
| `process_and_upload.js` | Route `watch` subcommand to WatchMode |
| `bin/taskex.js` | Same routing |

### Risks

- **`fs.watch` reliability** — notoriously unreliable on some platforms (especially network drives). The polling fallback mitigates this. Consider adding `chokidar` as an optional dependency if native watchers are insufficient.
- **Concurrent runs** — If two files arrive simultaneously, queue them sequentially. The pipeline is not designed for concurrent execution within a single process.

---

## 6. Decompose pipeline.js

**Goal:** Break the 2,008-line `pipeline.js` monolith into focused phase modules, improving testability, readability, and maintainability.

### Current State

`pipeline.js` contains:
- 50 lines of imports + constants
- `phaseInit()` (~150 lines) — CLI parsing, config validation, learning loop, model selection
- `phaseDiscover()` (~130 lines) — find videos/docs, resolve user name, banner
- `phaseServices()` (~100 lines) — Firebase/Gemini init, doc prep, doc upload
- `phaseProcessVideo()` (~450 lines) — compress, upload, analyze, quality gate, retry, focused pass
- `phaseCompile()` (~100 lines) — AI compilation
- `phaseOutput()` (~200 lines) — JSON + MD + diff
- `phaseSummary()` + `phaseDeepDive()` (~100 lines combined)
- `run()` (~120 lines) — main orchestrator
- `runDynamic()` (~200 lines) — doc-only mode
- `runProgressUpdate()` (~200 lines) — git-based progress tracking
- Helper functions: `findDocsRecursive`, `promptUser`, signal handlers, etc.

### Target Structure

```
src/
  pipeline.js              (~150 lines — orchestrator only: run, runDynamic, runProgressUpdate)
  phases/
    init.js                (~160 lines)
    discover.js            (~140 lines)
    services.js            (~110 lines)
    process-video.js       (~460 lines)
    compile.js             (~110 lines)
    output.js              (~210 lines)
    summary.js             (~50 lines)
    deep-dive.js           (move from src/modes/deep-dive.js integration)
  pipeline-context.js      (~40 lines — shared ctx type definition + factory)
```

### Implementation

#### 6.1 Create `src/pipeline-context.js`

Define the shared context shape that flows between phases:

```js
/**
 * Pipeline context — shared state passed between phases.
 * Each phase receives ctx and returns an augmented copy.
 *
 * @typedef {object} PipelineContext
 * @property {object} opts           - Parsed CLI options
 * @property {string} targetDir      - Absolute path to call folder
 * @property {Progress} progress     - Checkpoint tracker
 * @property {CostTracker} costTracker
 * @property {string[]} videoFiles   - (after discover)
 * @property {object[]} allDocFiles  - (after discover)
 * @property {string} userName       - (after discover)
 * @property {object} storage        - Firebase storage ref (after services)
 * @property {boolean} firebaseReady - (after services)
 * @property {object} ai             - Gemini client (after services)
 * @property {object[]} contextDocs  - Prepared docs (after services)
 * @property {string} callName       - (after services)
 */
function createContext(initial = {}) {
  return { ...initial };
}
module.exports = { createContext };
```

#### 6.2 Extract each phase

Each phase file exports a single async function:

```js
// src/phases/discover.js
'use strict';
const fs = require('fs');
const path = require('path');
const { VIDEO_EXTS, DOC_EXTS, SPEED, SEG_TIME } = require('../config');
const { findDocsRecursive } = require('../utils/fs');
const { promptUserText } = require('../utils/cli');
const log = require('../logger');

async function phaseDiscover(ctx) {
  // ... exact same logic, just moved here ...
  return { ...ctx, videoFiles, allDocFiles, userName };
}

module.exports = phaseDiscover;
```

#### 6.3 Slim down `pipeline.js`

The orchestrator becomes:

```js
'use strict';
const phaseInit      = require('./phases/init');
const phaseDiscover  = require('./phases/discover');
const phaseServices  = require('./phases/services');
const phaseProcess   = require('./phases/process-video');
const phaseCompile   = require('./phases/compile');
const phaseOutput    = require('./phases/output');
const phaseSummary   = require('./phases/summary');
// ... etc

async function run(overrides = {}) {
  let ctx = await phaseInit(overrides);
  ctx = await phaseDiscover(ctx);
  ctx = await phaseServices(ctx);

  const allResults = [];
  for (let i = 0; i < ctx.videoFiles.length; i++) {
    const result = await phaseProcess(ctx, ctx.videoFiles[i], i);
    allResults.push(result);
  }
  ctx.allResults = allResults;

  ctx = await phaseCompile(ctx);
  ctx = await phaseOutput(ctx);
  await phaseSummary(ctx);
  return ctx;
}

module.exports = { run, runDynamic, runProgressUpdate };
```

#### 6.4 Migration strategy

1. **Extract one phase at a time** — start with the simplest (`phaseSummary`) to validate the pattern
2. **Keep imports working** — `pipeline.js` already `module.exports = { run, runDynamic, runProgressUpdate }`, so external callers don't change
3. **Move helper functions** — `findDocsRecursive` is already in `utils/fs.js`; signal handlers stay in pipeline.js
4. **Order of extraction:**
   - `phaseSummary` → simplest, ~30 lines
   - `phaseCompile` → self-contained, ~100 lines
   - `phaseOutput` → depends on renderers but clean boundary
   - `phaseDiscover` → mostly I/O
   - `phaseServices` → Firebase + Gemini init
   - `phaseInit` → CLI parsing, config
   - `phaseProcessVideo` → last and largest (~450 lines)

### Files Changed

| File | Change |
|------|--------|
| `src/phases/init.js` | **New** — extracted from pipeline.js |
| `src/phases/discover.js` | **New** — extracted |
| `src/phases/services.js` | **New** — extracted |
| `src/phases/process-video.js` | **New** — extracted (largest) |
| `src/phases/compile.js` | **New** — extracted |
| `src/phases/output.js` | **New** — extracted |
| `src/phases/summary.js` | **New** — extracted |
| `src/pipeline-context.js` | **New** — ctx type definition |
| `src/pipeline.js` | **Modified** — slim orchestrator (~150 lines) |

### Risks

- **Shared mutable state** — phases currently share `ctx` by reference; extracted modules must still follow the `return { ...ctx, newField }` immutable pattern used today.
- **Circular dependencies** — `phaseProcessVideo` imports Gemini functions; Gemini functions are also used in `phaseServices`. No circular deps as long as phase modules only import from `services/`, `utils/`, and `config.js`.
- **`process.exit()` and signal handlers** — the `SIGINT`/`SIGTERM` handlers and `shuttingDown` flag remain in `pipeline.js` since they govern the whole process.

---

## 7. Streaming / Live Analysis (Gemini Live API)

**Goal:** Enable real-time analysis of ongoing meetings by streaming audio/video to Gemini's Live API, providing incremental results as the meeting progresses.

### Current State

- Pipeline is entirely batch-oriented: record → compress → upload → analyze → compile
- `gemini.js` uses `@google/genai` SDK's `generateContent()` method — single request/response
- No streaming or WebSocket support exists
- Gemini Live API uses WebSocket-based bidirectional streaming with audio/video input  

### Design

#### Two sub-modes

1. **Live capture** — pipe microphone/screen audio directly to Gemini Live API via WebSocket
2. **Stream file** — incrementally analyze a growing file (e.g., recording in progress)

#### Architecture

```
                ┌──────────────────────────┐
                │  Audio Source             │
                │  (mic / system audio)     │
                └─────────┬────────────────┘
                          │ PCM/WAV chunks
                          ▼
                ┌──────────────────────────┐
                │  LiveStreamManager       │
                │  - WebSocket connection   │
                │  - Audio chunking         │
                │  - Incremental results    │
                └─────────┬────────────────┘
                          │ partial analysis JSON
                          ▼
                ┌──────────────────────────┐
                │  LiveAccumulator         │
                │  - Merge incremental      │
                │  - Dedup items            │
                │  - Emit events            │
                └─────────┬────────────────┘
                          │ merged results
                          ▼
                ┌──────────────────────────┐
                │  Live UI (terminal)      │
                │  - Running item list      │
                │  - Final compilation      │
                └──────────────────────────┘
```

### Implementation

#### 7.1 Create `src/services/live-stream.js` (~300 lines)

```js
const { GoogleGenAI } = require('@google/genai');

class LiveStreamManager {
  constructor(apiKey, opts = {}) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = opts.model || 'gemini-2.5-flash';
    this.session = null;
    this.onPartialResult = opts.onPartialResult || (() => {});
    this.onError = opts.onError || console.error;
  }

  async connect() {
    // Open a Live API session
    this.session = await this.client.live.connect({
      model: this.model,
      config: {
        responseModalities: ['TEXT'],
        systemInstruction: this._buildSystemPrompt(),
      },
    });

    this.session.on('message', (msg) => {
      // Parse incremental analysis from text responses
      const text = msg.text();
      if (text) this._handleResponse(text);
    });

    this.session.on('error', this.onError);
  }

  sendAudioChunk(chunk) {
    // Send PCM16 audio data
    this.session.sendRealtimeInput({
      audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });
  }

  async disconnect() {
    if (this.session) {
      await this.session.close();
    }
  }

  _buildSystemPrompt() {
    // Adapted from prompt.json for streaming context
    return `You are analyzing a meeting in real-time. As you hear discussion:
      1. Extract tickets, action items, change requests as they're mentioned
      2. Output incremental JSON updates
      3. Use confidence: HIGH for explicitly stated items, MEDIUM for implied
      ...`;
  }
}
```

#### 7.2 Create `src/modes/live-mode.js` (~250 lines)

Orchestrator for live analysis:

```js
class LiveMode {
  constructor(opts) {
    this.streamManager = new LiveStreamManager(opts.apiKey, opts);
    this.accumulator = new LiveAccumulator();
    this.audioSource = opts.audioSource; // 'mic' | 'file'
  }

  async start() {
    await this.streamManager.connect();

    if (this.audioSource === 'mic') {
      await this._captureMicrophone();
    } else {
      await this._streamFile(this.audioSource);
    }
  }

  async _captureMicrophone() {
    // Use node-record-lpcm16 or similar
    // Requires optional dependency
  }

  async _streamFile(filePath) {
    // Read file in chunks, simulating real-time
    // Or watch file for growth (recording in progress)
  }
}
```

#### 7.3 CLI integration

```
taskex live                    Start live analysis (microphone)
taskex live --source file.mp4  Stream a file incrementally
taskex live --output live/     Output directory for incremental results
```

### Files Changed

| File | Change |
|------|--------|
| `src/services/live-stream.js` | **New** — Gemini Live API WebSocket client |
| `src/modes/live-mode.js` | **New** — Live mode orchestrator |
| `src/utils/live-accumulator.js` | **New** — Incremental result merger/deduplicator |
| `src/utils/cli.js` | Add `live` subcommand + `--source` flag |
| `process_and_upload.js` | Route `live` subcommand |
| `package.json` | Optional: `node-record-lpcm16` for mic capture |

### Risks

- **Gemini Live API availability** — currently in preview; API surface may change. Build with an abstraction layer.
- **Audio capture** — requires platform-specific audio drivers. Make mic capture optional; file streaming is the safer first implementation.
- **Cost** — Live API pricing may differ from batch. Integrate cost tracking from the start.
- **Incremental JSON merging** — partial results from streaming are inherently noisy. The accumulator must handle duplicates, corrections, and out-of-order items.
- **Complexity** — This is the largest feature by far. Consider shipping file-streaming first, mic capture second.

### Recommended phasing

1. **Phase A:** File streaming with incremental analysis (most value, no hardware deps)
2. **Phase B:** Mic capture for true live analysis
3. **Phase C:** Live UI with real-time terminal display

---

## 8. Test Suite

**Goal:** Comprehensive test coverage for all utility modules, services, and pipeline phases. Target: 80%+ line coverage on utility and service modules.

### Current State

- **Zero tests** — no test framework, no test files, no CI
- 32 source files, ~9,300 lines of code
- Highly testable pure functions in: `quality-gate.js`, `json-parser.js`, `adaptive-budget.js`, `context-manager.js`, `diff-engine.js`, `confidence-filter.js` (once created)
- Service modules (`gemini.js`, `firebase.js`) need mocking

### Framework Choice: **Vitest**

Vitest over Jest because:
- Native ESM support (future-proofing)
- Compatible with `'use strict'` CommonJS used throughout
- Faster startup, built-in coverage via `v8`
- Jest-compatible API (easy migration if needed)

### Implementation

#### 8.1 Setup

```bash
npm install --save-dev vitest @vitest/coverage-v8
```

`vitest.config.js`:
```js
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/services/firebase.js'], // needs integration tests
      thresholds: { lines: 80, functions: 80, branches: 70 },
    },
  },
});
```

`package.json` additions:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

#### 8.2 Test priority matrix

| Priority | Module | Lines | Testability | Test Count (est.) |
|----------|--------|-------|-------------|-------------------|
| **P0** | `quality-gate.js` | 424 | Pure functions | 25–30 |
| **P0** | `json-parser.js` | 246 | Pure functions | 20–25 |
| **P0** | `adaptive-budget.js` | 230 | Pure functions | 12–15 |
| **P0** | `confidence-filter.js` | ~60 | Pure functions | 8–10 |
| **P1** | `context-manager.js` | 420 | Pure (VTT slicing) | 15–20 |
| **P1** | `diff-engine.js` | 277 | Pure functions | 12–15 |
| **P1** | `learning-loop.js` | 269 | Pure + FS mocking | 10–12 |
| **P1** | `retry.js` | 136 | Async, mockable | 8–10 |
| **P1** | `format.js` | ~60 | Pure functions | 6–8 |
| **P2** | `cli.js` | 449 | Pure for parseArgs | 15–20 |
| **P2** | `schema-validator.js` | ~120 | Pure + Ajv | 10–12 |
| **P2** | `renderers/markdown.js` | 969 | Pure (string output) | 20–25 |
| **P3** | `services/gemini.js` | 780 | Needs mocking | 10–15 |
| **P3** | `services/video.js` | 306 | Needs ffmpeg mock | 5–8 |
| **P3** | `pipeline.js` phases | 2008 | Integration tests | 10–15 |

**Total: ~190–250 tests**

#### 8.3 Test file structure

```
tests/
  utils/
    quality-gate.test.js
    json-parser.test.js
    adaptive-budget.test.js
    confidence-filter.test.js
    context-manager.test.js
    diff-engine.test.js
    learning-loop.test.js
    retry.test.js
    format.test.js
    cli.test.js
    schema-validator.test.js
  renderers/
    markdown.test.js
    html.test.js
  services/
    gemini.test.js
    video.test.js
  phases/
    init.test.js
    discover.test.js
    process-video.test.js
  fixtures/
    sample-analysis.json        (valid segment analysis)
    malformed-json.txt          (various broken JSON samples)
    truncated-output.txt        (cut-off Gemini output)
    sample-vtt.vtt              (VTT file for context-manager tests)
    sample-compilation.json     (compiled multi-segment result)
```

#### 8.4 Example test: `quality-gate.test.js`

```js
import { describe, it, expect } from 'vitest';
import { assessQuality, THRESHOLDS } from '../../src/utils/quality-gate';

describe('assessQuality', () => {
  it('returns PASS for complete, rich analysis', () => {
    const analysis = {
      tickets: [{ ticket_id: 'T-1', discussed_state: 'in progress', confidence: 'HIGH', confidence_reason: 'explicitly mentioned', comments: [{ text: 'test' }] }],
      action_items: [{ id: 'A-1', description: 'Do thing', assigned_to: 'John', confidence: 'MEDIUM', confidence_reason: 'implied' }],
      change_requests: [{ id: 'CR-1', what: 'change X', where: 'file.js', confidence: 'HIGH', confidence_reason: 'stated' }],
      summary: 'Team discussed migration plan with detailed timeline and ownership assignments.',
      blockers: [],
      scope_changes: [],
      your_tasks: { tasks_todo: [{ description: 'Review PR' }], tasks_waiting_on_others: [], decisions_needed: [], completed_in_call: [] },
    };
    const report = assessQuality(analysis, { parseSuccess: true, rawLength: 5000 });
    expect(report.grade).toBe('PASS');
    expect(report.score).toBeGreaterThanOrEqual(THRESHOLDS.WARN);
    expect(report.shouldRetry).toBe(false);
  });

  it('returns FAIL for empty analysis', () => {
    const report = assessQuality({}, { parseSuccess: true, rawLength: 100 });
    expect(report.grade).toBe('FAIL');
    expect(report.shouldRetry).toBe(true);
    expect(report.retryHints.length).toBeGreaterThan(0);
  });

  it('returns FAIL when parse failed', () => {
    const report = assessQuality(null, { parseSuccess: false, rawLength: 0 });
    expect(report.grade).toBe('FAIL');
    expect(report.issues).toContain(expect.stringContaining('JSON parse failed'));
  });
});
```

#### 8.5 Example test: `json-parser.test.js`

```js
import { describe, it, expect } from 'vitest';
import { extractJson } from '../../src/utils/json-parser';

describe('extractJson', () => {
  it('parses clean JSON', () => {
    const result = extractJson('{"tickets": [], "summary": "test"}');
    expect(result).toEqual({ tickets: [], summary: 'test' });
  });

  it('strips markdown fences', () => {
    const result = extractJson('```json\n{"tickets": []}\n```');
    expect(result).toEqual({ tickets: [] });
  });

  it('repairs truncated JSON', () => {
    const result = extractJson('{"tickets": [{"id": "T-1", "state": "open"');
    expect(result).not.toBeNull();
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].id).toBe('T-1');
  });

  it('handles doubled closers', () => {
    const result = extractJson('{"tickets": []}}');
    expect(result).toEqual({ tickets: [] });
  });

  it('returns null for non-JSON', () => {
    const result = extractJson('This is not JSON at all');
    expect(result).toBeNull();
  });
});
```

### Files Changed

| File | Change |
|------|--------|
| `vitest.config.js` | **New** — Test framework configuration |
| `tests/**/*.test.js` | **New** — All test files (~15–20 files) |
| `tests/fixtures/*` | **New** — Test data fixtures |
| `package.json` | Add `vitest` + coverage deps, test scripts |
| `.gitignore` | Add `coverage/` |

### Risks

- **Module format** — All source uses CommonJS (`require`); Vitest handles this natively but coverage instrumentation needs `v8` provider (not `istanbul`).
- **Service mocking** — `gemini.js` and `firebase.js` make external API calls; use `vi.mock()` to mock the `@google/genai` and `firebase` packages.
- **ffmpeg tests** — `video.js` calls `spawnSync(ffmpeg, ...)`. Mock `child_process` or skip these in CI without ffmpeg.

---

## 9. Audio-Only & Doc-Only Mode (Pipeline Bug Fix)

**Goal:** Fix the pipeline to accept audio-only and document-only inputs in default mode, matching `prompt.json` v4.0.0's universal content support.

### Bug Analysis

**Root cause:** `phaseDiscover()` in `pipeline.js` (around line 295) unconditionally throws when no video files are found:

```js
// pipeline.js phaseDiscover() — THE BUG
let videoFiles = fs.readdirSync(targetDir)
  .filter(f => {
    const stat = fs.statSync(path.join(targetDir, f));
    return stat.isFile() && VIDEO_EXTS.includes(path.extname(f).toLowerCase());
  })
  .map(f => path.join(targetDir, f));

if (videoFiles.length === 0) {
  throw new Error('No video files found (mp4/mkv/avi/mov/webm). Check that the folder contains video files.');
}
```

**Impact:**
- Audio files (`.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac`) are not recognized as primary inputs
- Users with only documents must use `--dynamic` mode, but default mode would actually work if it didn't throw here
- `prompt.json` v4.0.0 explicitly supports `input_types: ["video", "audio", "document", "subtitle", "mixed"]`

**Additionally**, `VIDEO_EXTS` in `config.js` only contains video extensions — no audio extensions defined:
```js
const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
```

And `video.js` `compressAndSegment()` always maps video+audio streams (`-map 0:v:0 -map 0:a:0`), which fails for audio-only files.

### Implementation

#### 9.1 Add audio extensions to `config.js`

```js
const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma'];
const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS];
```

Export `AUDIO_EXTS` and `MEDIA_EXTS` alongside `VIDEO_EXTS`.

#### 9.2 Create audio compression in `video.js`

Add a parallel function for audio-only files:

```js
/**
 * Compress and segment an audio file using ffmpeg.
 * Audio-only: no video stream, just audio compression + segmentation.
 */
function compressAndSegmentAudio(inputFile, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const duration = probeFormat(inputFile, 'duration');
  const durationSec = duration ? parseFloat(duration) : null;
  const effectiveDuration = durationSec ? durationSec / SPEED : null;

  console.log(`  Duration : ${duration ? fmtDuration(parseFloat(duration)) : 'unknown'}`);
  console.log(`  Audio-only mode | ${SPEED}x speed`);

  // Convert to MP4 container with AAC audio (for Gemini compatibility)
  const needsSegmentation = effectiveDuration === null || effectiveDuration > SEG_TIME;

  const encodingArgs = [
    '-af', `atempo=${SPEED}`,
    '-c:a', 'aac', '-b:a', '128k',
    '-vn',  // no video
  ];

  if (needsSegmentation) {
    const args = [
      '-y', '-i', inputFile,
      ...encodingArgs,
      '-f', 'segment', '-segment_time', String(SEG_TIME), '-reset_timestamps', '1',
      path.join(outputDir, 'segment_%02d.m4a'),
    ];
    spawnSync(getFFmpeg(), args, { stdio: 'inherit' });
  } else {
    const outPath = path.join(outputDir, 'segment_00.m4a');
    const args = ['-y', '-i', inputFile, ...encodingArgs, outPath];
    spawnSync(getFFmpeg(), args, { stdio: 'inherit' });
  }

  return fs.readdirSync(outputDir)
    .filter(f => f.startsWith('segment_') && (f.endsWith('.m4a') || f.endsWith('.mp4')))
    .sort()
    .map(f => path.join(outputDir, f));
}
```

#### 9.3 Fix `phaseDiscover()` in `pipeline.js`

Replace the hard error with a tri-state detection:

```js
// Find video files
let videoFiles = fs.readdirSync(targetDir)
  .filter(f => {
    const stat = fs.statSync(path.join(targetDir, f));
    return stat.isFile() && VIDEO_EXTS.includes(path.extname(f).toLowerCase());
  })
  .map(f => path.join(targetDir, f));

// Find audio files (if no video)
let audioFiles = [];
if (videoFiles.length === 0) {
  audioFiles = fs.readdirSync(targetDir)
    .filter(f => {
      const stat = fs.statSync(path.join(targetDir, f));
      return stat.isFile() && AUDIO_EXTS.includes(path.extname(f).toLowerCase());
    })
    .map(f => path.join(targetDir, f));
}

// Find documents
const allDocFiles = findDocsRecursive(targetDir, DOC_EXTS);

// Determine input mode
let inputMode;
if (videoFiles.length > 0) {
  inputMode = 'video';
} else if (audioFiles.length > 0) {
  inputMode = 'audio';
} else if (allDocFiles.length > 0) {
  inputMode = 'document';
  console.log('  ℹ No video or audio files found — running in document-only mode.');
  console.log('  Tip: Use --dynamic for custom document generation.\n');
} else {
  throw new Error(
    'No processable files found (video, audio, or documents).\n' +
    '  Supported: .mp4 .mkv .avi .mov .webm (video) | .mp3 .wav .m4a .ogg .flac (audio) | .vtt .txt .pdf .docx .md (docs)'
  );
}

// ... rest of discover ...

return { ...ctx, videoFiles, audioFiles, allDocFiles, userName, inputMode };
```

#### 9.4 Update `phaseProcessVideo()` to handle audio

Rename to `phaseProcessMedia()` (or keep name, add branching):

```js
async function phaseProcessVideo(ctx, mediaPath, mediaIndex) {
  const isAudio = AUDIO_EXTS.includes(path.extname(mediaPath).toLowerCase());

  // Compress & segment
  let segments;
  if (isAudio) {
    segments = compressAndSegmentAudio(mediaPath, segmentDir);
  } else {
    segments = compressAndSegment(mediaPath, segmentDir);
  }

  // Upload segments — same flow
  // Analyze with Gemini — same flow (Gemini handles audio natively)
  // ...
}
```

#### 9.5 Handle document-only in default mode

When `inputMode === 'document'`:
- Skip `phaseProcessVideo()` entirely
- Go straight to `phaseCompile()` with document context only
- Or delegate to `runDynamic()` internally with a default request

```js
// In run():
if (ctx.inputMode === 'document') {
  console.log('  Document-only mode — analyzing documents without media.');
  // Use document context for compilation directly
  ctx = await phaseCompileDocOnly(ctx);
} else {
  // Normal video/audio processing loop
  for (let i = 0; i < ctx.mediaFiles.length; i++) {
    const result = await phaseProcessVideo(ctx, ctx.mediaFiles[i], i);
    allResults.push(result);
  }
}
```

#### 9.6 Update banner and messaging

```js
console.log('==============================================');
console.log(inputMode === 'video'    ? ' Video Compress → Upload → AI Process'    :
            inputMode === 'audio'    ? ' Audio Compress → Upload → AI Process'    :
                                       ' Document Analysis → AI Process');
console.log('==============================================');

console.log(`  Input   : ${inputMode}`);
console.log(`  Videos  : ${videoFiles.length}`);
console.log(`  Audio   : ${audioFiles.length}`);
console.log(`  Docs    : ${allDocFiles.length}`);
```

### Files Changed

| File | Change |
|------|--------|
| `src/config.js` | Add `AUDIO_EXTS`, `MEDIA_EXTS` exports |
| `src/services/video.js` | Add `compressAndSegmentAudio()`, export it |
| `src/pipeline.js` | Fix `phaseDiscover()` tri-state detection; update `phaseProcessVideo()` for audio; add doc-only flow in `run()` |
| `src/utils/cli.js` | Update `discoverFolders()` to detect audio files (already detects docs) |

### Testing Scenarios

| Scenario | Expected |
|----------|----------|
| Folder with `.mp4` only | Current behavior (video mode) |
| Folder with `.mp3` only | Audio mode — compress audio, analyze, compile |
| Folder with `.vtt` + `.pdf` only | Document-only mode — analyze docs, compile |
| Folder with `.mp4` + `.mp3` | Video mode (video takes priority, audio files treated as docs) |
| Empty folder | Error: "No processable files found" with helpful message |

---

## Implementation Order & Dependencies

```
Phase 1 — Foundations (v8.4.0)
├── #9  Audio-Only & Doc-Only Mode  ← Bug fix, unlocks use cases
├── #6  Decompose pipeline.js       ← Enables all other features
└── #8  Test Suite (P0 modules)     ← Safety net for all changes

Phase 2 — Quality & UX (v8.5.0)
├── #3  JSON Schema Validation      ← Catches Gemini output issues
├── #1  Progress Bar                ← User experience improvement
└── #4  Confidence Filter           ← Quick win, builds on existing data

Phase 3 — Output & Monitoring (v9.0.0)
├── #2  HTML Report Viewer          ← Major output upgrade
├── #5  Watch Mode                  ← Automation capability
└── #8  Test Suite (remaining)      ← Complete coverage

Phase 4 — Advanced (v9.x)
└── #7  Streaming / Live Analysis   ← Experimental, Gemini Live API dependent
```

### Dependency Graph

```
#9 Audio-Only ──────┐
                    ├──→ #6 Decompose ──→ #8 Tests (P0)
                    │                        │
                    │         ┌───────────────┤
                    │         ▼               ▼
                    │    #3 Schema Val   #1 Progress Bar
                    │         │               │
                    │         ▼               ▼
                    │    #4 Confidence   #2 HTML Report
                    │         Filter
                    │
                    └──→ #5 Watch Mode
                    
#7 Streaming ── independent (can start anytime, but benefits from #6)
```

### Version Mapping

| Version | Features | Breaking Changes |
|---------|----------|------------------|
| v8.4.0 | #9, #6, #8 (P0 tests) | `pipeline.js` restructured → `src/phases/`; no API changes |
| v8.5.0 | #3, #1, #4 | `ajv` new dependency; `--min-confidence` new flag |
| v9.0.0 | #2, #5, #8 (complete) | `--format` flag; `watch` subcommand; potential default HTML output |
| v9.x | #7 | `live` subcommand; optional `node-record-lpcm16` dep |

---

## Open Questions

1. **HTML as default output?** — Should `results.html` be generated alongside `results.md` by default, or only with `--format html`?
2. **Watch mode — auto-name?** — Should Watch Mode auto-detect user name from git config or prompt once at startup?
3. **Schema strictness** — Should schema validation FAIL the quality gate or just WARN? Recommend: WARN + inject hints for retry.
4. **Audio priority** — When a folder has both video and audio files, should audio files be analyzed as separate media or treated as context documents?
5. **Live API billing** — Gemini Live API pricing is different from batch. Should cost tracking use separate rate cards?

---

> Proprietary — © 2026 Youssef Adel. All rights reserved.
