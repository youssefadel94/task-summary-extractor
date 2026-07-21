# Test Coverage & E2E Plan

Goal: make sure the whole tool works correctly and is tested, with special
attention to the two flows the maintainer actually uses:

1. **⚙️ Custom** — choose each setting interactively (format → confidence → feature flags → model), then run the normal pipeline.
2. **📄 Dynamic** — generate custom documents from files given a request prompt (topics or unified output).

Baseline (before this effort): **33.2%** statements. The critical paths for the
two used flows were ~0% covered.

## Flow map

### ⚙️ Custom flow
- Entry: `src/phases/init.js` `phaseInit()` → `selectRunMode()` returns `custom`.
- Interactive pickers: `selectFormats()`, `selectConfidence()`, `selectFeatureFlags()`, `selectModel()` (all `src/utils/cli.js` + `src/utils/interactive.js`).
- Feature-flag inversion mapping (`FEATURE_FLAGS`, `inverted` semantics) → `opts`.
- Then normal pipeline: `src/pipeline.js` `run()` → video/audio path, or `runDocOnly()` for doc/image folders.
- Output renderers: `src/renderers/{markdown,html,pdf,docx}.js` gated by `opts.formats`.

### 📄 Dynamic flow
- Entry: `phaseInit()` → `selectRunMode()` returns `dynamic` → sets `opts.dynamic`, applies `RUN_PRESETS.dynamic`.
- `run()` collects request text + output-structure (topics/unified) + name.
- Discover (`phaseDiscover`) → doc-only vs media.
- Compilation (or `mergeSegmentAnalysesForDynamic` fallback) → `runDynamicTopics()`.
- `src/modes/dynamic-mode.js`: `planTopics` → `generateAllDynamicDocuments`/`generateUnifiedDocument` → `writeDynamicOutput` (INDEX.md + per-topic md + dynamic-run.json).
- Optional Firebase upload; on-the-fly image batch analysis when images present.

## Test strategy
- **Mocked AI harness** (`tests/helpers/mock-ai.js`): a fake `ai.models.generateContent` returning canned JSON/markdown + `usageMetadata`, so the full Custom + Dynamic logic is exercised deterministically, free, and CI-safe.
- **Opt-in live smoke test** (`tests/live/*.live.test.js`): gated on `RUN_LIVE_TESTS=1` + real `GEMINI_API_KEY`; a small real end-to-end Dynamic run.

## Coverage gaps → planned tests

| Area | File | Baseline | Plan |
|---|---|---|---|
| Dynamic core | `src/modes/dynamic-mode.js` | 0% | Unit + mocked E2E: planTopics parse, doc gen fence-strip, batch settle, writeDynamicOutput (slugs/index/stats), compiledToContext/VideoSummaries |
| Pipeline orchestration | `src/pipeline.js` | 0% | Mocked E2E: `runDynamicTopics` topics+unified+empty+fallback+images; `mergeSegmentAnalysesForDynamic` dedup |
| Custom wiring | `src/phases/init.js` | 0% | Non-TTY `phaseInit` with flags → opts; format/confidence/dynamic-output validation; preset application |
| Interactive selectors | `src/utils/cli.js` | 39% | Non-TTY fallbacks for selectFormats/Confidence/RunMode/FeatureFlags; feature-flag inversion mapping |
| Interactive engine | `src/utils/interactive.js` | 7% | computeWindow, fitToWidth, decodeKey, non-TTY fallbacks (already partial) |
| Doc parsing | `src/services/doc-parser.js` | 0% | Extension/mime routing, text vs binary, unreadable-file handling |
| Discover | `src/phases/discover.js` | 0% | Folder classification (video/audio/doc/image), inputMode selection |
| Output phase | `src/phases/output.js` | 0% | Format gating, file writes per selected format |
| Renderers pdf/docx | `src/renderers/{pdf,docx}.js` | low | Render from fixture compiled analysis without crash; empty/partial fields |
| Gemini service | `src/services/gemini.js` | 0% | Pure helpers (token usage extraction, payload build) with mocked client |

## Bug log
Findings from the audit pass are tracked here as they're confirmed and fixed.

- [FIXED] `pipeline.js` `runDynamicTopics`: `thinkingBudget` used before its `const` declaration (temporal dead zone) → `ReferenceError` in Dynamic mode when a folder has images but no pre-analyzed descriptions. Declaration moved above first use.
- [FIXED] `confidence-filter.js`: `--min-confidence medium/high` erased all `your_tasks` items (To Do / Waiting / Decisions) because they carry no `confidence` field and were assumed LOW. Now preserved unless they carry an explicit confidence.
- [FIXED] `cli.js` `parseArgs`: boolean flags in `--flag=value` form coerced `false`/`0`/`no`/`off` to `true`. Now parsed correctly.
- [FIXED] `init.js`: wizard-configured flags (`--min-confidence`, `--deep-summary`, `--deep-dive`, `--no-html/-batch/-progress`) now skip interactive prompts, matching documented behavior.
- [FIXED] `markdown.js`: table cells with newlines (multi-line descriptions) split rows and corrupted tables. Newlines now collapsed to spaces.
- [FIXED] `dynamic-mode.js` `writeDynamicOutput`: a topic missing `id`/`title` threw and discarded ALL generated docs. Now fills deterministic fallbacks, disambiguates filename collisions, and shows a real reason for empty-output failures.
- [FIXED] `pipeline.js` `runDynamicTopics`: image-analysis context was embedded twice in `docSnippets` (once as the synthesized `_image_analysis_combined.md`, once via `imageDescriptions`). Now de-duplicated.

- [FIXED] `services/git.js` `getCommitsSince`: field separator was a null byte, which Node ≥20 rejects as a spawn argument (`ERR_INVALID_ARG_VALUE`) — the function silently returned `[]` on every call, disabling commit-based progress tracking and `getDiffSummary`. Switched to git's `%x1f` unit separator.
- [FIXED] `services/git.js` `getChangedFilesSince`: renamed/copied files (`R100`/`C075` status, two tab-separated paths) were dropped by the single-letter regex. Now parsed by status letter with the destination path taken for renames/copies.
- [FIXED] `services/git.js` `getDiffSummary`: root-commit changes under-reported when the oldest commit has no parent. Now diffs against git's empty-tree sentinel.
- [FIXED] `services/gemini.js`: `String.replace` with `$`-containing replacement corrupted the trimmed/reduced compilation prompt (split/join + replacer fn now); `nonDocParts` slice offset was wrong when image docs are present on RESOURCE_EXHAUSTED retry (counts actual parts now); all `response.text` accesses guarded.
- [FIXED] `renderers/pdf.js`: reported `pages` count was always 0 under Puppeteer v24 (Uint8Array vs Buffer). Normalised to a Buffer before scanning.
- [FIXED] `renderers/html.js`: `related_tickets` injected unescaped in the person To-Do list. Now HTML-escaped.
- [FIXED] `utils/format.js` `fmtBytes`: added numeric guard (NaN/undefined/null/negative → "0 B").

- [FIXED] `config.js`: default model was `gemini-2.5-flash`, and the economy tier resolved to `gemini-2.5-flash-lite` — the entire `gemini-2.5-*` line now returns 404 "no longer available to new users" (confirmed via live API). Removed the three retired 2.5 models, set the default to `gemini-3-flash-preview`, and fixed the pricing fallback. All tiers now resolve to available `gemini-3.x` models. Docs/help/.env.example updated.

### Remaining audit findings (tracked, lower priority)
- `config.js`: package-root `.env` outranks `~/.taskexrc`, inverting documented precedence (dev-checkout only).
- `progress-updater.js`: id-field mismatch can drop a `_progress` annotation when a ticket lacks `ticket_id` (uses synthetic id).
