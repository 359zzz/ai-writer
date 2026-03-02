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

### v1.8.0 (Writing: Batch Chapter Generation)
- Web → 创作 → 写作:
  - 新增“一次生成章数” + “批量写 N 章”按钮：一次点击顺序生成 N 章，每章写完立刻落库并出现在章节列表。
  - 写章节默认 `skip_outliner=true`：避免反复调用 Outliner 覆盖已编辑的大纲（更稳定/更省调用）。
- API:
  - 修复 runs pipeline 中 `chapter_index/chapter_plan` 的变量断裂导致的运行时错误。
- Tests:
  - Added regression test for `skip_outliner=true` (OutlinerAgent is skipped but chapter artifacts still emit).

### v1.8.1 (Writing: Batch Controls + Better Failure Surface)
- Web → 创作 → 写作:
  - 批量写章新增“停止（当前章完成后停止）/继续剩余/清除”控制，减少误操作与重复调用。
  - 批量写章在失败时记录并显示最近一次错误（便于定位是哪个 Agent/网关失败）。

### v1.9.0 (Continue: Batch Continuation + Book → Workspace)
- Web → 续写 → 文章续写（工作台）:
  - 新增“一次续写章数”与“批量续写 N 章”：顺序续写多章，每章完成后立刻落库并在章节列表可见。
  - 批量续写支持“停止（当前章完成后停止）/继续剩余/清除”，并在失败时展示最近一次错误。
- Web → 续写 → 书籍续写:
  - 增加“用此书籍源进入续写工作台”按钮：把已上传的书籍源加载到文章续写工作台，方便编辑与批量续写。

### v1.10.0 (Book Continue: Chunk Index + Summarize Into KB)
- API:
  - `GET /api/tools/continue_sources/{source_id}/book_index`：对已上传的书籍源做字符级分片索引（不调用 LLM），返回分片列表与预览。
  - Runs: 新增 `kind=book_summarize`：按分片顺序调用 LLM 做简要总结，并逐片写入本地知识库（`source_type=book_summary`，带 `book_source:...` 标签）。
- Web → 续写 → 书籍续写:
  - 新增“书籍分片索引 / 总结入库（MVP）”卡片：可配置分片长度/重叠/最大分片数，一键生成索引与总结入库。
  - 总结完成后展示入库统计，并提供快捷按钮跳转到「创作 → 背景设定」查看知识库条目。
- Tests:
  - Added regressions for `book_index` tool endpoint and `book_summarize` run kind.

### v1.11.0 (Book Continue: Compile Book State + Resumable Summaries)
- API:
  - Runs: 新增 `kind=book_compile`：把已入库的 `book_summary` 分片总结编译为“书籍状态”（世界观/角色卡/时间线/悬念/续写起点），写入 KB（`source_type=book_state`）。
  - `book_summarize` 支持断点续跑：`replace_existing=false` 时会跳过已存在的分片总结（避免重复入库与重复调用）。
- Web → 续写 → 书籍续写:
  - “总结入库（LLM）”旁新增“编译书籍状态（LLM）”，并在页面内展示编译结果预览与 KB 编号。
- Tests:
  - Added regression test for `book_compile` run kind.

### v1.12.0 (Book Continue: State-Based Writing + Workspace Toggle)
- API:
  - Runs: 新增 `kind=book_continue`：基于已编译的 `book_state`（来自 `book_compile`）+ 书籍源最新截取，生成“下一章”并落库。
  - BookContinue: 运行内会加载书籍截取（`continue_sources.load_excerpt`）并把 `book_state + book_summary` 合并进 Writer 的 KB 上下文（便于 Strong 模式引用 [KB#ID]）。
  - BookPlanner: 新增轻量规划步骤（JSON 章计划），用于把长书的“下一章目标/摘要”显式传给 Writer，提高连续性与可控性。
  - ConfigAutofill: 对 `book_*` 流程自动跳过（避免随机补全污染长书既有设定）。
- Web → 续写 → 文章续写（工作台）:
  - 新增“续写类型”切换：`文章续写（抽取+续写）` / `书籍续写（基于书籍状态）`。
  - 批量续写复用同一套控制（停止/继续剩余/清除），并在批量状态里记录本次运行的 kind（避免切换后恢复跑错链路）。
- Web → 续写 → 书籍续写:
  - “进入续写工作台（书籍模式）”：一键把书籍源加载到工作台，并切换到 `book_continue` 链路进行续写与批量生成。
- Tests:
  - Added regression test for `book_continue` (writes chapter + strips `<think>`).

### v1.12.1 (Book Continue: Better Multi-Chapter Continuity)
- API:
  - `book_continue` 在 BookPlanner/Writer 提示词中自动加入“最近已写章节”（来自本项目章节库，截取尾部），提高批量多章生成的连续性。
  - KB 检索（`kb_search`）的 query 构造增强：当 Story 设置较少时，会额外利用 `StoryState`（world/角色名）做检索，提高命中“既有章节/设定”的概率。
  - 修复：确保 `book_state + book_summary` 上下文在 `kb_search` 成功/失败两种情况下都会合并进 Writer 提示词（避免偶发丢上下文）。

### v1.12.2 (Reliability: PackyAPI Gemini Writer Prompt Budget + Rescue Retry)
- API:
  - `book_compile`: 对编译出的 `book_state.state` 做结构化压缩（限制字符串/列表长度），避免后续提示词过长导致网关断连。
  - `book_continue`: 读取 `book_state` 后先做 compact，再转换为 Writer 的 `StoryState`（`summary_so_far/world/current_status/relationships` 等字段都有上限）。
  - Writer: 新增提示词预算（对大 JSON 做截断标记），并对 PackyAPI Gemini 写作阶段更保守地限制 `max_tokens`；遇到可重试网关错误（ConnectError/timeout/429/5xx）时会用更小上下文 + Flash 模型重试一次。
- Tests:
  - Added regression test to ensure超长 `book_summary` 不会原样进入 Writer 提示词（降低 `openai_network_error:ConnectError` 概率）。
- Web:
  - `apps/web/package-lock.json` 的 version 字段与 `package.json` 对齐（避免长时间迭代后版本漂移）。

### v1.13.0 (OutlineGraph: Mindmap Outline Editor MVP)
- Web → 创作 → 大纲编辑:
  - 新增“大纲思维导图（草稿）”模式（基于 `@xyflow/react`）：自由拖拽节点、连线生成关系箭头、节点/边检查器编辑。
  - 节点类型（typed nodes）：至少支持 `chapter/plot/character/time/place/item/foreshadow`，并有基础配色与标签。
  - 互转能力：
    - `大纲块草稿 (story.outline 的草稿编辑器)` → “从草稿生成导图”
    - “导图 → 草稿”（用导图生成大纲块草稿）
  - 保存导图：写入 `story.outline_graph`，并同步更新 `story.outline`（保证后续写章节链路可直接使用）。
- Web:
  - 全局样式引入 `@xyflow/react/dist/style.css`（保证控件/连线样式稳定）。

### v1.13.1 (OutlineGraph: Import/Export + Chapter Auto-Order)
- Web → 创作 → 大纲编辑（导图模式）:
  - 支持导图 `JSON` 导入/导出（`outline_mindmap.json`）。
  - 新增“章节排序”：按当前节点 Y 坐标对章节节点自动编号，并顺带整理章节节点布局（更利于 `导图 → 草稿` 转换）。
  - 导图 JSON 有更稳健的解析/校验（避免非法数据导致页面崩溃）。

### v1.14.0 (Book: Chapter Index Tool)
- API（不调用 LLM）:
  - 新增章节索引端点：
    - `GET /api/tools/continue_sources/{source_id}/chapter_index`：构建/读取章节索引（`overwrite=false` 默认读缓存）。
    - `PATCH /api/tools/continue_sources/{source_id}/chapter_index`：手动微调后保存（重算 end_char/预览）。
- Backend tools:
  - 新增 `tools/chapter_index.py`：规则识别“第X章/回/卷/节”，将 `chapter_index.json` 落盘到书籍源目录旁。
- Tests:
  - 新增 tools 侧回归：章节索引构建 + 更新 + 无标题报错。

### v1.15.0 (Book: Per-Chapter Summaries + Compile)
- API runs:
  - `book_summarize` 支持 `segment_mode=chapter/auto`：优先读取/构建 `chapter_index.json`，按章总结入库（tags：`book_chapter:n`）。
  - `book_summarize` 的 stats artifact 增加 `segment_mode` 与相关 params（便于前端展示“章/片”）。
  - `book_compile` 在同时存在分片总结与章节总结时，优先编译“章节总结”（更贴近用户心智）。
- LLM（PackyAPI/Gemini）:
  - network_error/timeout 在 Packy base 上也会触发模型 fallback（更易从 ConnectError 中自救；同时保持探测次数保守，避免像异常流量）。
- Tests:
  - 新增 runs 回归：章节模式 `book_summarize` + `book_compile` 优先章节总结。

### v1.16.0 (Web: Chapter Tuning UI + Trace Graph)
- Web → 续写 → 书籍续写:
  - 新增“章节分块 / 手动微调（MVP）”卡片：加载/重新识别/保存微调/导出 `json/txt`。
  - “总结入库（LLM）”在存在章节索引时默认走 `segment_mode=chapter`（未保存微调时会禁用，避免索引不一致）。
  - 统计展示会根据 `segment_mode` 自动显示“章/片”。
- Web → Agent 协作:
  - Graph 视图升级为 ReactFlow 图谱：按 Agent 汇总 tool/artifact，并展示产物类型计数（对 book_summarize 这类长流程更友好）。
- i18n:
  - Graph 文案从“图”升级为“图谱”，并更新描述为“聚合图谱”。

### v2.0.0 (Milestone: Million-Word Book Continuation, Usable & Robust)
- 书籍续写（推荐流程）:
  - 上传书籍源（本地落盘，gitignored）→ 章节分块 → 手动微调 → 按章节总结入库（LLM）→ 编译书籍状态（LLM）→ 进入续写工作台（书籍模式）生成章节（支持批量与落库可见）。
- 章节能力:
  - 规则优先识别“第X章/回/卷/节”，生成 `chapter_index.json`，并支持在前端做删除/改标题并保存（微调后会重算边界与预览）。
- 可用性与健壮性:
  - BookSummarizer/BookCompiler 优先按章节工作（更贴近用户心智）；同时保留分片模式作为无标题文本兜底。
  - PackyAPI/Gemini 在 `network_error/timeout` 场景下会做保守的模型 fallback；Writer 阶段也有“缩短上下文 + 更含蓄写作模式”的救援重试，降低断连风险。
- 可观测性:
  - Agent 协作页新增 ReactFlow 图谱视图（按 Agent 聚合 tool/artifact，并展示产物类型计数），用于理解长流程与排障。

### v2.1.0 (Graph Workspace + Job/Progress Polling)
- Job/Progress（长任务机制，SQLite 持久化）:
  - 新增轮询友好的 Run 查询能力：`GET /api/runs/{run_id}` 返回 `status + last_seq`；`GET /api/runs/{run_id}/events?after_seq=...&limit=...` 支持增量拉取事件，刷新页面也可恢复进度。
- 图谱工作区（Writing 内）:
  - 顶部导航新增 `图谱`（与 `创作/续写` 并列），不改变既有 Agent 协作与设置页。
  - 图谱工作区先提供三类只读图：
    - 运行流程图（Run DAG）：基于 trace events 聚合 agent/耗时/tool/artifact/错误（ReactFlow）。
    - 大纲图（OutlineGraph）：把已保存的大纲导图/文字大纲可视化回放（只读预览）。
    - 书籍结构图：章节链（chapter_index）+ 章节总结（book_summary）+ 书籍状态（book_state）+ 续写章节（manuscript）关联展示。
- KB 大书优化:
  - 新增 `GET /kb/chunks_meta` 仅返回 KB 元数据（不返回大段 content），便于长书图谱与统计。
  - `book_continue` 生成章节写入 manuscript KB 时会附带 `book_source:*` 标签，支持书籍结构图关联续写产物。

### v2.1.1 (Graph: Project Selector + De-duplicate Run DAG)
- 图谱工作区:
  - 顶部新增“项目”选择器：大纲图/书籍结构图支持切换项目回放（用于查看历史项目产物）。
  - 运行流程图（Run DAG）从图谱页移除，统一在「Agent 协作」页查看（避免重复视图）。
  - 书籍结构图在缺少 `chapter_index` 时仍可展示已入库的总结/状态/续写产物，并提示用户先执行章节分块（兼容历史数据）。
- Docs:
  - 更新 `README.md` / `README.zh-CN.md` 的图谱使用说明。

### v2.1.2 (Book: Chapter Split — Inline Headings + Dedupe Heuristics)
- 章节分块（`chapter_index`）增强:
  - 支持“标题藏在正文里”的情况：章节识别不再强依赖“标题必须独占一行”。
  - 当同一个“第X章/回”出现多次（目录/引用/页眉重复等），会结合“绝大多数章节长度”做去噪与选择，更倾向于选出真实章节边界。
- Tests:
  - 新增回归：正文内标题 + 重复标题（目录/引用）去噪应能得到正确章节数。

### v2.1.3 (Book: Chapter Split — Navigation Noise + “第X回中” Reference Guard)
- 章节分块（`chapter_index`）增强:
  - 支持“回目录/回首页/上一页/下一页”等导航噪声与标题粘连的情况：如 `...回目录回首页第二回 标题` 也能正确识别章回边界。
  - 降低误识别：对“第X回中/里/内...”这类正文引用（非标题）做降权，避免被选成真实章节起点。
- Tests:
  - 扩展回归：覆盖“导航噪声 + 标题粘连”与“第X回中...”引用场景。

### v2.1.4 (Dev: Auto-Kill Stale Ports on Startup)
- Dev Script（`scripts/dev.ps1`）增强:
  - 默认启动前会尝试自动清理被旧进程占用的端口（8000/3000），避免“启动成功但实际上仍在跑旧版本”的困惑。
  - API 端口（8000）会先探测 `/api/health` 是否为 ai-writer-api，再做更安全的自动停止；对 `uvicorn --reload` 孤儿子进程（`spawn_main(parent_pid=...)`）也会尝试清理。
  - 可用参数：`-NoAutoKill`（禁用自动清理），`-ForceKill`（强制清理未知占用者，谨慎使用）。

### v2.1.5 (Dev: Fix dev.ps1 Interpolation Parse Error)
- 修复 `scripts/dev.ps1` 中的 PowerShell 字符串插值解析错误（`PID=$p: ...` 在某些情况下会被当作 `$p:` 解析导致脚本无法运行）。
- 现在 `.\scripts\dev.ps1` 可正常执行端口检测与自动清理逻辑。

### v2.1.6 (Book: Summarize — Non-JSON Output Tolerance)
- 书籍总结入库（`book_summarize`）增强:
  - Gemini/网关偶尔不按要求输出 JSON 时，不再因为 JSON 解析失败而直接中断 SSE（避免前端出现 `Error in input stream`）。
  - 解析失败会以 `text` 兜底保存到 KB，并在 stats 里记录 `json_parse_failed` 计数，便于排障与选择更稳的模型（建议 Flash）。
- Tests:
  - 新增回归：BookSummarizer 返回非 JSON 文本时也应完成并落库。

---

### Roadmap (Planned, Living Doc)
本段是“可变计划”：我们会在迭代过程中不断调整；当某个版本真正发布后，会把对应条目落实到上方的 `### vX.Y.Z (...)` 发布说明中。

#### Confirmed Decisions (2026-03-01)
- 依赖策略：接受新增成熟依赖以换取更稳定的交互体验（尤其是图/流程编辑与可视化）。
- 大纲编辑：引入思维导图式编辑，节点有类型（人物/情节/时间/地点/章节/伏笔...），并支持关系箭头（边）表达因果/包含/先后/对立等关系。
- 书籍来源：以中文网文/古典小说为主，通常存在明确标题（如“第X章/回/卷”）→ 章节识别以**规则优先**，LLM 仅做兜底（避免不稳定与额外成本）。
- 模型与网关：使用 PackyAPI + Gemini → 需要更保守的并发与更严格的输入预算，避免被网关视为异常/攻击流量。
- “手动微调”定义：这里指“章节分块后由用户手动调整边界/标题/编号/合并拆分”，不是训练意义上的 fine-tune。

#### How We Adopt MiroFish Ideas (Engineering Reference)
- 长任务机制：把“长文本→分块→多阶段产出”变成一等公民能力：
  - 后端落地 `Job/Progress`（SQLite 持久化）用于章节分块、逐章总结、编译书籍状态、批量生成等流程。
  - 前端优先用 SSE 实时展示；同时提供可轮询/可恢复的 job 查询（刷新页面也能恢复进度与产物）。
- 图谱展示：将“图谱/流程”作为 `Writing` 内的一个工作区模式（与 `创作/续写` 并列），不改变 North Star 的顶层 Tabs 结构。
  - 同一套图渲染能力会复用在：大纲图（可编辑）、流程图（run DAG）、书籍结构图（章节链路/产物关联）。
- 关键差异：MiroFish 的任务管理是内存为主；本项目以本地单机为目标，优先做 SQLite 持久化与断点续跑（更贴合“百万字级”使用场景）。

#### Planned Versions (Post v1.12.1 → v2.0.0)
- v1.14.0 (Book: Chapter Split — Auto Draft)
  - 新增“章节分块”按钮：对书籍源做章节识别，产出 `chapter_index`（每章 start/end + 标题/编号 + 预览）。
  - 规则优先：识别“第X章/回/卷”等标题；LLM 仅用于规则低置信度场景的兜底。
  - 章节索引落库：作为书籍源的结构化资源，供后续 BookSummarizer 按章处理。

- v1.14.1 (Book: Chapter Split — Manual Tuning)
  - 章节微调 UI：合并/拆分相邻章节、编辑标题/编号、局部预览边界上下文、手动新增/删除章节。
  - 增量重算：微调确认后，仅对受影响章节重跑“逐章总结入库/编译”，未变更章节复用既有结果，避免重复调用与网关压力。
  - `json/txt`：支持导入/导出微调后的章节索引（便于回滚与共享模板）。

- v1.15.0 (Book: Per-Chapter Summaries + Compile)
  - BookSummarizer 按 `chapter_index` 逐章总结并写入 KB（`book_summary` 以 `book_chapter:n` 标签区分）。
  - 编译书籍状态（BookCompile）以“逐章总结”为输入构建：角色卡/世界观/时间线/悬念/续写起点。
  - 可恢复：断点续跑（跳过已存在章节总结/已存在状态版本）。

- v1.16.0 (Graph Workspace: Process / Outline / Book Structure)
  - `Writing` 内新增工作区模式：`创作 / 续写 / 图谱`（不新增顶层 Tab）。
  - 图谱页先做“可视化优先”：流程 DAG（run→agents→artifacts）、大纲图、章节结构图（按章索引+产物挂载）。
  - Job/Progress 贯穿：长任务在图谱页也可查看进度与阶段。

- v1.17.0 (Writing: Multi-Chapter Generation)
  - 支持“一次生成 N 章”，每章写完立刻落库并在 UI 可见（章节列表即时更新）。
  - 生成完成后由 Editor 做统一连续性检查（必要时给出 minimal 修订建议或自动轻量修订）。

- v1.18.x (Hardening + Guardrails)
  - 更强的输入预算、并发限制与失败恢复；更清晰的 trace 可视化；对敏感内容触发断连场景提供“更含蓄写法/安全写作模式”。

- v2.0.0 (Milestone: Million-Word Book Continuation, Usable & Robust)
  - 验收口径：章节识别准确 + 章节微调好用 + 逐章总结稳定可恢复 + 书籍状态编译可靠 + 续写稳定产出 + 图谱/流程可用于理解与排障。
