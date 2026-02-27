# Quick Start Guide

> From zero to your first analysis in **under 5 minutes**.
>
> For the full feature list, CLI reference, and configuration → [README.md](README.md)

---

## Step 1: Install prerequisites

You need three things on your machine:

### Node.js (≥ 18)

Check: `node --version`

If not installed → [nodejs.org](https://nodejs.org/) (LTS recommended)

### ffmpeg

Check: `ffmpeg -version`

If not installed:
- **Windows**: [Download from gyan.dev](https://www.gyan.dev/ffmpeg/builds/) → extract → add the `bin` folder to your PATH
- **Mac**: `brew install ffmpeg`
- **Linux**: `sudo apt install ffmpeg`

> **How to add to PATH on Windows:**
> 1. Extract ffmpeg to `C:\ffmpeg`
> 2. Search "Environment Variables" in Start
> 3. Edit `Path` → Add `C:\ffmpeg\bin`
> 4. Restart your terminal

### Gemini API Key (free)

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click "Create API key"
4. Copy the key — you'll paste it in Step 2

---

## Step 2: Clone & set up

```bash
git clone https://github.com/youssefadel94/task-summary-extractor.git
cd task-summary-extractor
node setup.js
```

The setup script will:

1. ✅ Check Node.js, ffmpeg, and git are installed
2. ✅ Run `npm install` (installs dependencies)
3. ✅ Create a `.env` file and ask for your Gemini API key
4. ✅ Set up `.gitignore` so your recordings and keys stay local
5. ✅ Create a sample folder to test with
6. ✅ Validate the pipeline loads correctly

**Just follow the prompts.** If anything fails, it tells you exactly what to fix.

> Already set up? Run `node setup.js --check` to validate your environment.

---

## Step 3: Prepare your recording

Create a folder and put your video in it:

```
my-meeting/
├── Meeting Recording.mp4       ← Your video file (required)
└── Meeting Recording.vtt       ← Subtitles (optional, but highly recommended)
```

**That's the minimum.** You can optionally add more context:

```
my-meeting/
├── Meeting Recording.mp4
├── Meeting Recording.vtt
├── agenda.md                   ← Meeting agenda
├── .tasks/                     ← Context folder (gets priority)
│   ├── code-map.md             ← What each module does
│   └── current-sprint.md       ← What the team is working on
└── specs/
    └── requirements.md         ← Relevant specs
```

The tool **automatically scans all subfolders** for documents. Use whatever structure fits your workflow.

**Supported files:**
- Video: `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`
- Docs: `.vtt`, `.srt`, `.txt`, `.md`, `.csv`, `.pdf`

---

## Step 4: Run it

### Option A: Interactive (easiest)

```bash
node process_and_upload.js
```

The tool will:
1. Show available folders — pick one
2. Ask for your name
3. Show available Gemini models — pick one (or press Enter for default)
4. Run the full analysis pipeline

### Option B: Specify everything upfront

```bash
node process_and_upload.js --name "Your Name" "my-meeting"
```

### Option C: Skip Firebase (local only)

If you don't have Firebase set up, add `--skip-upload`:

```bash
node process_and_upload.js --name "Your Name" --skip-upload "my-meeting"
```

### What happens

The pipeline will:
1. **Compress** the video (~30s)
2. **Segment** it into ≤5 min chunks
3. **Upload** segments to Firebase Storage (if configured)
4. **Analyze** each segment with Gemini AI — uses Firebase Storage URL directly when available (skips separate Gemini upload)
5. **Quality check** — retry weak segments automatically (reuses file reference — no re-upload)
6. **Compile** results across all segments
7. **Output** `results.md` + `results.json`

This takes **~2-5 minutes** depending on video length.

---

## Step 5: View your results

```
my-meeting/runs/{timestamp}/
├── results.md            ← Open this! Your task document
├── results.json          ← Full pipeline data (JSON)
└── compilation.json      ← All extracted items (JSON)
```

**Open `results.md`** — it contains:
- Your personal task list (items assigned to you, TODOs, blockers)
- All tickets discussed with status, assignees, and confidence scores
- Change requests with file-level detail
- Action items with owners and deadlines
- Blockers and scope changes
- Confidence badges (🟢 HIGH, 🟡 MEDIUM, 🔴 LOW) on every item

---

## Try Dynamic Mode (no video needed)

Generate documents from a folder of docs:

```bash
node process_and_upload.js --dynamic --request "Explain this codebase for new developers" "my-project"
```

Output:

```
my-project/runs/{timestamp}/
├── INDEX.md              ← Open this — document index
├── dm-01-overview.md
├── dm-02-guide.md
├── dm-03-analysis.md
└── dynamic-run.json
```

---

## Common Commands

| What You Want | Command |
|---------------|---------|
| **Interactive mode** | `node process_and_upload.js` |
| **Analyze a meeting** | `node process_and_upload.js --name "Jane" "my-meeting"` |
| **Pick a specific model** | `node process_and_upload.js --model gemini-2.5-pro "my-meeting"` |
| **Run without Firebase** | `node process_and_upload.js --skip-upload "my-meeting"` |
| **Resume interrupted run** | `node process_and_upload.js --resume "my-meeting"` |
| **Force re-analysis** | `node process_and_upload.js --reanalyze "my-meeting"` |
| **Preview without running** | `node process_and_upload.js --dry-run "my-meeting"` |
| **Deep dive docs** | `node process_and_upload.js --deep-dive "my-meeting"` |
| **Generate docs (no video)** | `node process_and_upload.js --dynamic "my-project"` |
| **Track progress via git** | `node process_and_upload.js --update-progress --repo "C:\project" "my-meeting"` |
| **Debug mode** | `node process_and_upload.js --log-level debug "my-meeting"` |

> Full CLI reference with all flags → [README.md — CLI Flags](README.md#cli-flags)

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ffmpeg not found` | [Download](https://www.gyan.dev/ffmpeg/builds/) → add `bin` folder to PATH → restart terminal |
| `GEMINI_API_KEY not set` | Edit `.env` → paste your key from [AI Studio](https://aistudio.google.com/apikey) |
| `Cannot find module` | Run `npm install` |
| `ECONNREFUSED` | Check internet — Gemini API needs network access |
| Videos are slow | Normal — about 30-60 seconds per 5-minute segment |
| JSON parse warnings | Expected — the parser has 5 fallback strategies, usually self-corrects |
| Something broke | Run `node setup.js --check` to validate your setup |

---

## Updating the Tool

```bash
git checkout main
git pull
```

Your recordings, `.env`, logs — everything local is `.gitignore`d and safe.

---

## Next Steps

| What | Where |
|------|-------|
| Full feature list, all CLI flags, configuration | [README.md](README.md) |
| How the pipeline works internally | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Module map, line counts, roadmap | [EXPLORATION.md](EXPLORATION.md) |
