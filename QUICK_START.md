# Quick Start Guide

> **5 minutes from zero to your first meeting analysis.**

---

## Step 1: Clone & Setup

```bash
git clone https://github.com/youssefadel94/task-summary-extractor.git
cd task-summary-extractor
node setup.js
```

The setup script will:
- Check that Node.js ≥ 18, ffmpeg, and git are installed
- Run `npm install`
- Create a `.env` file and prompt for your **Gemini API key**
- Validate that the pipeline loads correctly

> **Get your Gemini API key** → [Google AI Studio](https://aistudio.google.com/apikey) (free tier available)

---

## Step 2: Create Your Working Branch

Call folders, logs, and results are **local** — they don't go into the repo. Create a local branch to keep your workspace separate from tool updates:

```bash
git checkout -b local/my-workspace
```

This way you can always `git checkout main && git pull` to get updates, then merge back.

---

## Step 3: Prepare a Call Folder

Create a folder with your recording and any supporting context:

```
my-meeting/
├── Meeting Recording.mp4       ← Your video file (required)
├── Meeting Recording.vtt       ← Subtitles (recommended — improves quality a lot)
├── agenda.md                   ← Loose docs at root work too
│
├── .tasks/                     ← Context folder (optional, gets priority)
│   ├── code-map.md             ← Module/component descriptions
│   └── team.csv                ← Participants with roles
├── specs/                      ← Any folder name works
│   └── requirements.md         ← Relevant requirements or spec
└── notes/                      ← Add as many folders as you need
    └── previous-decisions.md
```

> The pipeline **recursively scans all subfolders** for documents — not just `.tasks/`. Use whatever folder structure fits your workflow. See [README.md](README.md#adapting-context-folders-to-your-use-case) for examples by scenario.

**Supported video formats:** `.mp4`, `.mkv`, `.webm`
**Supported document formats:** `.vtt`, `.srt`, `.txt`, `.md`, `.csv`, `.pdf`

---

## Step 4: Run Analysis

```bash
node process_and_upload.js --name "Your Name" "my-meeting"
```

The pipeline will:
1. Compress the video (H.264, 1.5× speed)
2. Split into ≤5 min segments
3. Send each segment + docs to Gemini AI
4. Extract action items, decisions, change requests, blockers, scope changes
5. Score confidence and retry weak segments
6. Output structured results

This takes ~2-5 minutes per segment depending on video length.

---

## Step 5: View Results

```
my-meeting/runs/{timestamp}/
├── results.md            ← Open this — your task document
├── results.json          ← Full pipeline data
└── compilation.json      ← All extracted items (JSON)
```

`results.md` contains:
- Your personalized task list (owned items, TODOs, blockers)
- All topics discussed with assignees and status
- Change requests / requirements with detail
- Action items with owners and deadlines
- Decisions made during the meeting
- Confidence scores on every item

> The output adapts to what was actually discussed — dev calls get ticket-level detail, client meetings get requirements and deliverables, etc.

---

## Common Options

| What You Want | Command |
|---------------|---------|
| Skip cloud upload | `node process_and_upload.js --skip-upload "my-meeting"` |
| Resume interrupted run | `node process_and_upload.js --resume "my-meeting"` |
| Force re-analysis | `node process_and_upload.js --reanalyze "my-meeting"` |
| Preview without running | `node process_and_upload.js --dry-run "my-meeting"` |
| Track progress via git | `node process_and_upload.js --update-progress --repo "C:\project" "my-meeting"` |
| Debug mode | `node process_and_upload.js --log-level debug "my-meeting"` |

---

## Updating the Tool

```bash
git checkout main
git pull
git checkout local/my-workspace
git merge main
```

Your call folders and `.env` are gitignored — they won't be affected.

---

## Validation

```bash
# Check your setup
node setup.js --check

# Show version / help
node process_and_upload.js --version
node process_and_upload.js --help
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `ffmpeg not found` | Add to PATH or place in `C:\ffmpeg\bin\` — [download](https://www.gyan.dev/ffmpeg/builds/) |
| `GEMINI_API_KEY not set` | Edit `.env` → add key from [AI Studio](https://aistudio.google.com/apikey) |
| `ECONNREFUSED` | Check internet — Gemini API needs network access |
| Large videos take long | Normal — ~30-60s per 5-min segment |
| JSON parse warnings | Expected — the parser has 5 fallback strategies |

---

## Next Steps

- **[README.md](README.md)** — Full feature list, usage patterns, configuration
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Technical deep dive with flow diagrams
