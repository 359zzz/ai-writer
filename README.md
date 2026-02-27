# ai-writer

Local, single-user, multi-agent collaborative novel writing platform (FastAPI + Next.js).

[English](README.md) | [简体中文](README.zh-CN.md)

## What You Get

- Notion-like writing workspace: Projects/Outline/Chapters + Markdown editor/preview + tool panels
- Multi-agent pipeline with SSE streaming trace, plus visualization (timeline + graph)
- Local Knowledge Base (SQLite + FTS5) with **Weak/Strong** dependency modes
- Optional web search tool (transient; never auto-imported into KB)
- Continue mode: upload/paste manuscript → extract StoryState → continue writing
- Export: DOCX / EPUB / PDF (pandoc-first; graceful fallbacks)

## Requirements

- Windows 10/11
- Python 3.11
- Node.js (LTS recommended)
- Optional (recommended):
  - `pandoc` for best DOCX/EPUB/PDF exports
  - a LaTeX engine (e.g. MiKTeX) for high-quality PDF output

## Quick Start (Windows)

1) Configure API keys (recommended via UI):
   - Open the app → Settings → Model → `API Keys` (masked inputs, stored locally on the backend).
   - Alternatively you can still use environment variables.
   - `api.txt` is kept as a legacy fallback (gitignored).

2) Run:

```powershell
.\scripts\dev.ps1
```

This starts:
- API: http://localhost:8000
- Web: http://localhost:3000

Open the UI at: http://localhost:3000

## Using the App (UI Guide)

### 1) Create/select a project

- Writing tab → left panel → Projects → Create
- Select the project in the list

All story fields are optional; missing fields can be autofilled by LLM in **Weak** KB mode.

### 2) Configure model + tools

- Settings tab:
  - API Keys: set keys in **Settings → Model → API Keys** (masked; never shown in full)
  - Provider: GPT (OpenAI-compatible) or Gemini
  - Model / Base URL / temperature / max_tokens
  - KB mode:
    - Weak: KB preferred; model can creatively fill gaps
    - Strong: canon-locked; new facts must be grounded in local KB/settings/manuscript
  - Web search tool: enable + choose provider

Security note: the UI only shows key presence (present/missing). It never displays full keys.

### 3) Add Local KB (optional but recommended)

- Writing tab → right panel → Local KB
- Add chunks with title/tags/content
- Use search to retrieve canon/style notes quickly

### 4) Write

- Create mode:
  - Generate outline
  - Write chapters with LLM + editor pass
- Continue mode:
  - Use the single “Continue source” box (drag-drop / click upload / paste text or a file)
  - Choose excerpt position (tail/head) and excerpt length (chars)
  - Click “Extract + Continue”

For large books, uploading is recommended: the backend stores the full text locally under `apps/api/data/continue_sources/`
(gitignored) and only returns a short preview to the browser.

### 5) Export

- Writing tab → right panel → Export
- Choose DOCX / EPUB / PDF

## Smoke Test (LLM)

This project loads API keys from:
- environment variables
- backend local secrets store (`apps/api/data/secrets.local.json`, gitignored)
- legacy `api.txt` fallback (gitignored)

Run a short, safe smoke test (<=500 chars output):

```powershell
.\apps\api\.venv\Scripts\python.exe .\apps\api\scripts\smoke_llm.py --provider openai
```

## Project Structure

- `apps/api` FastAPI backend
- `apps/web` Next.js frontend
- `scripts` one-click local dev scripts (PowerShell)
- `AGENTS.md` architecture + versioned iteration notes (project brain)

## Troubleshooting

- If a run fails but the health check is OK: open the Agents tab and inspect the trace events.
- Web search errors can be network-dependent. Try switching provider in Settings (auto/bing/duckduckgo).
- Export quality depends on environment. For best results, install `pandoc` and (for PDF) a LaTeX engine.

## Security

- Never commit `api.txt` or `.env*` files.
- The app will never display full API keys in the UI.
