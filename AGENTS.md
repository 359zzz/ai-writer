# ai-writer (Personal, Public)

This file is the stable "project brain" for Codex/agents.

It is intentionally split into:
1) **North Star** (overall architecture + non-negotiable constraints; do not change lightly)
2) **Versioned Iteration Notes** (update per version as we iterate)

---

## 1) North Star (Do Not Change Lightly)

### 1.1 Product Goal
Build a local, single-user, web-based **multi-agent collaborative novel writing platform** with:
- A modern, easy-to-use web UI with **tab switching**: `Writing` / `Agent Collaboration` / `Settings`.
- User-defined story settings (characters, outline, lore, style, length, chapters, etc.) where **all fields are optional**.
  - Missing fields are **autofilled by LLM** (random/creative), without overwriting fields the user already set.
- A **local-only knowledge base** (KB) for project lore/style/reference and already-written chapters.
- Optional **web search** as an external research tool (not automatically persisted into KB unless user chooses).
- Strong/Weak KB dependency modes:
  - **Weak**: KB preferred; model can creatively fill gaps.
  - **Strong (canon-locked)**: world/canon facts must come from local KB + user config + existing manuscript.
    If missing, ask questions or create "to-confirm" items instead of inventing canon.
- "Continue writing" mode: ingest existing text, extract StoryState (characters/world/timeline/outline/style),
  then continue from that state.
- Export: Markdown writing inside app, with export options: **DOCX / EPUB / PDF**.

### 1.2 Constraints / Safety
- Never commit secrets. `api.txt`, `.env*` are ignored by git.
- During any automated tests that call real LLM APIs: **do not generate more than 500 Chinese characters / ~500 words**
  (keep prompts short and ask for short outputs).
- Do not log API keys. Settings UI must never reveal full keys.

### 1.3 Architecture (Monorepo)
- `apps/api`: FastAPI backend (SSE streaming, orchestration, storage)
- `apps/web`: Next.js frontend (Writing/Agents/Settings)
- `scripts`: one-click local dev scripts (Windows PowerShell)
- Storage:
  - SQLite for persistent app data (projects, chapters, settings, traces, KB chunks)
  - Local filesystem for exports

### 1.4 Multi-Agent Orchestration (MVP principle)
- Use a **Supervisor/Orchestrator** pattern:
  - Director orchestrates worker agents.
  - Workers: ConfigAutofill, Outliner, Writer, LoreKeeper(Verifier), Editor, Extractor.
- Every run produces a **trace** (events with timestamps) persisted to DB and displayed in the UI:
  - agent start/end
  - tool calls (KB search / web search)
  - partial outputs (when streaming)
  - final artifacts (outline/chapter/story state)

### 1.5 KB + Web Search (Operational Definition)
- Local KB is the canonical source for story facts/style when `Strong` mode is enabled.
- Web search is an **external research tool**:
  - Allowed in both modes when enabled
  - Never auto-writes into KB; user can explicitly import curated results.

### 1.6 One-Click Local Run
- Primary entrypoint: `scripts/dev.ps1`
  - Creates/uses Python 3.11 venv for backend
  - Installs backend deps (pip)
  - Installs frontend deps (npm)
  - Runs API + Web concurrently

---

## 2) Versioned Iteration Notes (Update Per Release)

Versioning policy (from v1.0.x onward):
- Bigger iterations: bump `minor` and reset patch → `1.a.0` (e.g. 1.1.0, 1.2.0)
- Smaller iterations: bump `patch` → `1.a.b` (e.g. 1.1.1, 1.1.2)

### v0.0.0 (Scaffold)
- Repo scaffold created: monorepo folders, gitignore, basic docs.
- Dev scripts added.

### v0.1.0 (API + Web Hello World)
- Backend FastAPI with `/api/health`
- Frontend Next.js with tabs + health check display

### v0.2.0 (Projects + Settings)
- SQLite persistence for projects + settings
- Settings UI to select provider/model + KB mode + web search toggle

### v0.3.0 (Runs + Multi-Agent Trace)
- "Run" endpoint + SSE stream
- Trace persisted + Agents tab shows timeline

### v0.4.0 (Local KB)
- Local KB chunks stored in SQLite + FTS5 search
- UI to add KB notes/snippets + search

### v0.5.0 (Web Search Tool)
- DuckDuckGo-based web search tool (with URL + snippet)
- UI can import selected web results into local KB (manual, explicit)

### v0.6.0 (Writing Workflow)
- Outline generation + chapter writing + editor pass
- Continue mode: extract StoryState from existing text

### v0.7.0 (Export)
- Markdown export -> docx/epub/pdf pipeline (prefer pandoc; fallbacks as needed)

### v0.8.0 (Polish + Settings)
- Continue mode UI (paste text → extract + continue)
- Agents tab: run history selector + timeline + compressed graph view
- Settings: visual editing of provider, model, base_url, temperature, max tokens, chapter targets

### v1.0.0 (MVP Complete)
- Writing workspace usable end-to-end
- Multi-agent collaboration visualization (timeline + basic graph)
- Strong/Weak KB dependency implemented + verifier behavior
- Documentation + safe API test script

#### Known Limitations (v1.0.0)
- Some OpenAI-compatible gateways may return empty `message.content` for certain reasoning-heavy models (e.g. Gemini 2.5 Pro via some proxies).
  - Workaround: switch provider to GPT, or choose a non-reasoning Gemini model (e.g. Flash) in Settings.
- Export quality varies by environment:
  - DOCX/EPUB use pandoc when available; otherwise a basic fallback converter is used.
  - PDF fallback is plain-text oriented.

### v1.0.1 (UI Preferences: Language + Theme)
- UI language switch (中文/EN) + persisted UI preferences (localStorage).
- Theme accent token for primary UI (tabs/primary buttons) + theme manager (add/delete/reset presets).

### v1.0.2 (Docs + i18n Polish)
- Added Simplified Chinese README (`README.zh-CN.md`) and language links in `README.md`.
- Fixed remaining English placeholders in editors under Chinese mode.
- Agents tab: front-end-only Chinese mapping for common event types / agent names.

### v1.1.0 (Writing: Notion-like 3-Column Workspace)
- Writing tab upgraded to a 3-column layout:
  - Left: Projects + Outline + Chapters
  - Center: Markdown editor + live preview (edit/preview/split)
  - Right: Runs + Export + Local KB + Web search
- Markdown preview uses `react-markdown` + `remark-gfm` (tables/lists/code supported).
- Outline view renders as a readable chapter list (prefers latest run artifact, falls back to project settings).

### v1.2.0 (Strong Mode Evidence Chain + Export Templates + UI Polish)
- Strong KB mode upgraded to **evidence-chain validation**:
  - `ConfigAutofill` skips random autofill in `strong` mode (avoid hallucinated canon/settings).
  - `Writer` is instructed to cite canon facts with inline `[KB#ID]` (IDs must come from local KB excerpts),
    otherwise use `[[TBD]]` + add a **待确认 / To Confirm** list.
  - `LoreKeeper` runs an evidence audit (LLM JSON) and emits an `evidence_report` artifact; unsafe canon claims are
    sanitized into `[[TBD]]` via a minimal rewrite pass.
- Export upgraded toward **pandoc-first + nicer templates**:
  - DOCX/EPUB/PDF prefer `pandoc` with `--toc`, numbered sections, and explicit chapter page breaks (`\\newpage`).
  - EPUB uses a project stylesheet: `apps/api/templates/export/epub.css`.
  - DOCX uses an auto-generated `reference.docx` (fonts/headings) when possible.
  - PDF uses pandoc when a LaTeX engine is present (falls back gracefully otherwise).
- Settings upgraded with a left nav pane: UI / Model / Project / Export / Debug.
- UI prefs expanded: theme now uses **bg + surface + accent**, plus local logo + background image (opacity/blur).
- Agents collaboration page improved:
  - Timeline shows tool calls/results, warnings, and expandable details.
  - Graph view shows per-agent duration + tool/artifact counts.
