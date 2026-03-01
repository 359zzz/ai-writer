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

### v1.2.1 (Theme Defaults: Classic Palette Restored)
- Restored built-in theme colors to the original v1.x palette (e.g. `破晓` accent back to orange `#F97316`).
- Default UI background/surface reverted to a more neutral "classic" look (`#FAFAFA` / `#FFFFFF`).
- Added a small migration: users still on the untouched v1.2.0 default themes auto-upgrade to the classic defaults.

### v1.2.2 (UI Contrast + Background Image Fix)
- Fixed UI background image not showing: background layer now renders behind content reliably (z-index/stacking fix).
- Prevented OS-level dark mode from causing low-contrast text (Tailwind `dark:` variants are now class-based; app stays visually consistent until we add an explicit dark-mode toggle).

### v1.2.3 (Theme: Text + Control Colors)
- Theme system expanded with more tokens: normal text color + muted text + control (input/button) background + control text.
- UI controls now use theme tokens so custom themes won't create "black boxes with unreadable text".

### v1.2.4 (Web Search Robustness + Writing Modes + Resizable Workspace)
- Fixed web search failures in some networks: backend now supports provider routing (`auto` prefers Bing HTML scrape, falls back to DDG).
- Settings: added web search provider selector (still optional; results never auto-import into KB).
- Writing: added a left sidebar switch for `创作 / 续写` to make workflows clearer; research query is now shared across both flows.
- Writing layout: removed the narrow centered max-width and added draggable resizable panels (left / editor / tools) with auto-save sizing.
- Local KB: KB chunk inputs no longer prefill duplicate "设定"; title/tags now have explicit labels + clearer guidance.

### v1.2.5 (Resizable Heights + Continue File Upload)
- Writing layout now fills a fixed viewport height and supports vertical (height) resizing in the right tool panel (runs/export/KB/web cards are split into draggable panels).
- Continue mode supports uploading `.txt/.docx/.pdf/.epub` files (backend extracts plain text locally; no LLM call), and populates the continue textarea for editing.
- Backend: added `/api/tools/extract_text` and a reusable `tools/text_extract.py` utility; added `pypdf` for PDF extraction; added minimal tests for the new tool.

### v1.2.6 (Continue Sources: Local Storage + Preview + Progress)
- Fixed `DetachedInstanceError` in SSE pipelines by using DB sessions with `expire_on_commit=False` (prevents project settings from expiring after commit).
- Continue mode upgraded for large manuscripts:
  - New backend endpoints store uploads/pasted text under `apps/api/data/continue_sources/` and return a `source_id` + short preview (no full-text round trip).
  - Runs now accept `source_id` + `source_slice_mode/head|tail` + `source_slice_chars`, and load excerpts from disk for the Extractor agent.
  - Writing UI merged “upload + paste” into a single dropzone textarea supporting drag-drop, click upload, and paste (file/text), plus excerpt preview/truncation controls.
- Continue text extraction improved with light pre-cleaning for PDF/EPUB (skip toc/nav docs, remove repeated PDF headers/footers, remove TOC dot-leader noise).
- Backend status card now shows active run + progress bar (front-end derived from SSE trace events).  

### v1.2.7 (LLM Retry + Progress Error Banner)
- LLM calls are now more robust to transient gateway issues:
  - OpenAI-compatible calls try both `/chat/completions` and `/v1/chat/completions` even when one path returns 5xx (fixes some proxy/base_url combinations).
  - Added small retry/backoff for transient errors (502/503/504/429/timeouts) and slightly increased timeout.
- Writing → Backend progress bar now shows the run error message on abnormal exit (and during failure), sourced from SSE `run_error` events.

### v1.2.8 (Base URL Robustness + Cleaner 502 Errors)
- OpenAI-compatible base_url handling is now safer:
  - Accepts base URLs with or without `/v1` without accidentally producing `/v1/v1/...`.
  - Keeps the most meaningful failure reason (e.g. 502) instead of being overwritten by a later 404.
- Sanitized HTML error pages in LLM errors to a short marker (`html_error_page`) to avoid flooding traces/UI.
- `apps/api/scripts/smoke_llm.py` can now be run from repo root reliably (adds `apps/api` to `sys.path`).

### v1.2.9 (API Key UI + OpenAI Responses + Gemini Proxy Fixes)
- Secrets/config are now configurable in-app (no longer reliant on `api.txt`):
  - Backend adds a local-only secrets store at `apps/api/data/secrets.local.json` (gitignored).
  - New endpoint `POST /api/secrets/set` stores keys without ever returning them; UI shows presence only.
  - Settings → Model adds masked inputs for GPT/Gemini API keys (inputs clear after saving).
- OpenAI-compatible calling is upgraded:
  - Added `wire_api` support: `chat/completions` or `responses` (PackyAPI/Codex often prefers `responses`).
  - Model settings now include an `OpenAI 接口类型（wire API）` selector persisted per-project.
  - Backend falls back between `chat/completions` and `responses` automatically when one fails.
- Gemini provider becomes proxy-friendly:
  - Non-Google base URLs now try Gemini `v1beta:generateContent` first, then fall back to OpenAI-compatible.
  - Improved parsing and retries for flaky/empty proxy outputs (reduces `empty_completion` failures).

### v1.2.10 (Continue: ConfigAutofill Soft-Fail + Version Align)
- Continue/Chapter runs: `ConfigAutofill` is now **best-effort** in `weak` mode.
  - Transient LLM gateway failures (e.g. `openai_http_502:html_error_page`) no longer abort “抽取 + 续写”.
  - The pipeline continues with existing settings so Extractor/Outliner/Writer can still run.
- Backend tests: added a regression test to ensure continue runs still complete and emit chapter artifacts when ConfigAutofill fails.
- Version alignment: frontend bumped to `1.2.10` to match the API version.

### v1.3.0 (Think Stripping + Gemini Fallback + Manage UI)
- Backend: strips `<think>...</think>` blocks before persisting chapter/agent outputs (prevents hidden reasoning from being saved/exported).
- Gemini (PackyAPI/proxy): detects “无可用渠道 / distributor” model-unavailable errors and falls back to `gemini-2.5-flash` / `gemini-2.0-flash` / `gemini-1.5-flash` automatically; default Gemini model switched to `gemini-2.5-flash`.
- Writing UI: added delete + drag-reorder for Projects (localStorage order) and Chapters (persisted `chapter_index` reorder + delete endpoint).
- API: added management endpoints:
  - `DELETE /api/projects/{project_id}` (cascade delete: runs/events/chapters/KB)
  - `DELETE /api/projects/{project_id}/chapters/{chapter_id}`
  - `POST /api/projects/{project_id}/chapters/reorder`
- Tests: added regressions for think-stripping + chapter/project delete/reorder APIs.

### v1.3.1 (PackyAPI Gemini: Better Defaults + Reliable Fallback)
- PackyAPI Gemini: improved fallback model set to include Gemini 3 (`gemini-3-pro-preview` / `gemini-3-flash-preview` / `gemini-3.1-pro-preview`) and also triggers fallback on `empty_completion` (some gateways return reasoning-only outputs with empty text).
- Settings: default Gemini model updated to `gemini-3-pro-preview` (matches PackyAPI third-party client guidance and works more reliably than some 2.5 models in certain groups).

### v1.3.2 (PackyAPI Gemini: Consistent Runs + Save-Then-Run)
- Web: run buttons now wait for any in-flight Settings/Secrets save to complete before starting a run (prevents “I set gemini-3-* but tool_call still shows old gemini-2.5-*” races).
- API: run pipeline snapshots the LLM config at run start and includes it in `run_started` trace payload; prevents mid-run settings edits from mixing models across agents.
- Gemini (PackyAPI): prefer OpenAI-compatible `chat/completions` first (per PackyAPI third-party guidance), then fall back to Gemini v1beta + model fallback set.

### v1.3.3 (PackyAPI Gemini: Writer 503 Resilience)
- Gemini (PackyAPI/proxy): strengthened retry + fallback behavior for flaky gateways so “Writer: gemini_http_503 无可用渠道（distributor）” is much less likely to abort runs:
  - OpenAI-compatible calls treat `empty_completion` as retryable (some distributors return reasoning-only outputs with empty text).
  - Gemini v1beta calls now retry/backoff on transient 5xx/429 **including** distributor-like 503s (previously raised immediately).
  - Fallback model set includes `gemini-2.5-pro`, and fallbacks also trigger on transient `http_5xx` errors (not only on “model unavailable”/empty outputs).

### v1.3.4 (Reliability: Outliner Soft-Fail + Editor Guardrails + Packy Throttle)
- Web: clears previous outline/markdown at run start so a failed run won’t look “success” due to stale content.
- Runs pipeline:
  - Outliner: retries once when JSON parsing fails (with a stricter prompt and `gemini-3-flash-preview` fallback), and **soft-fails** on `chapter/continue` so writing can proceed even if outline generation is flaky.
  - Writer: per-run `max_tokens` is scaled by `chapter_words`; retries once on suspiciously short output (prefers `gemini-3-flash-preview` on Packy) and fails loudly if still too short (prevents “run completed but chapter is incomplete”).
  - Editor: prompt updated to preserve structure/length (no summarization); adds a guardrail to fall back to Writer output if the edited result looks truncated/incorrect.
- LLM (PackyAPI): reduces bursty traffic risk:
  - Adds gentle throttling + in-flight limiting for PackyAPI requests.
  - Uses only documented `/v1/...` endpoints for Packy base URLs; Gemini-on-Packy uses chat-only (avoids `/responses`) to reduce “probing noise”.

### v1.3.5 (Dev Script: Stable Backend Python)
- `scripts/dev.ps1`: always launches backend with the project venv’s `python.exe` (instead of relying on PATH activation) to prevent “restarted but still running old API version” confusion under Uvicorn `--reload`.
- `scripts/dev.ps1`: warns when port `8000` is already in use and prints the existing process command line (best-effort), so you can stop the old server before starting a new one.

### v1.4.0 (UI IA: Create/Continue Split + Pane Scaffolds)
- Web: top-level navigation splits “创作 / 续写” (Create/Continue) as separate tabs; removes the in-workspace “写作模式” toggle (mode is now determined by the top tab).
- Web: adds v2.0-ready pane scaffolds:
  - 创作: 项目管理 / 背景设定 / 大纲编辑 / 写作
  - 续写: 文章续写 / 书籍续写
  Non-writing panes are scaffolds for now and will be upgraded in subsequent minor releases.
- i18n (zh): replaces “KB” wording with “知识库” in user-facing copy (keeps internal key names unchanged).

### v1.5.0 (Background: KB CRUD + List/Export + Web Search Config)
- API: KB router adds chunk update/delete endpoints:
  - `PATCH /api/projects/{id}/kb/chunks/{chunk_id}`
  - `DELETE /api/projects/{id}/kb/chunks/{chunk_id}`
- Web → 创作 → 背景设定:
  - Shows an explicit KB item list (with checkbox selection), supports drag reorder, edit, and delete.
  - Adds export for selected KB items in `json` or `txt`.
  - Moves “知识库模式（弱/强）” and “联网检索工具（开关/提供商）” controls into this pane for faster iteration.

### v1.6.0 (Outline Import/Export + Book Source Upload + Project Quick Actions)
- Web:
  - 创作 → 大纲编辑: 支持上传 `.txt/.json` 导入大纲，导出 `json/txt`，清空大纲（保存到 `story.outline`）。
  - 续写 → 书籍续写: 支持上传 `.txt/.json` 作为本地“书籍源”（落盘 + 头/尾截取预览）；长文本续写流程留到 v2.x。
  - 项目列表: 每个项目块增加快捷按钮（进入写作 / 文章续写（上传） / 书籍续写（上传））。
  - 运行中章节列表刷新: 不再随每条 SSE 事件拉取章节列表，改为写手产物（`chapter_markdown`）到达时刷新（降低请求风暴风险）。
- API:
  - Continue/Extract text: 支持 `.json` 作为纯文本输入（`extract_text` + `continue_sources/upload`）。
- Tests:
  - Added regressions for json extract + continue source upload.

### v1.7.0 (Outline: Explicit Block Editor)
- Web → 创作 → 大纲编辑:
  - 新增“大纲块编辑（草稿）”：支持块的增删改、拖拽排序、标题/简介/目标编辑。
  - 显式“保存大纲”与“重置”按钮；未保存状态会提示（不会静默覆盖）。
  - 右侧展示“已保存的大纲（用于写作）”，让用户区分草稿 vs 已保存版本。
  - 仍保留 `.txt/.json` 导入与 `json/txt` 导出能力。
