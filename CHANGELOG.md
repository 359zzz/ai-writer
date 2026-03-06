# CHANGELOG

本文件记录已发布版本与版本沿革。

维护规则：
- 每次版本更新必须写入本文件。
- `AGENTS.md` 只保留长期稳定、当前仍然有效的项目脑。
- `ROADMAP.md` 只记录未来规划、已确认决策与待讨论方向。

版本策略（从 v1.0.x 开始）：
- 较大迭代：提升 `minor`，并将 patch 归零 → `1.a.0`（例如 1.1.0、1.2.0）
- 较小迭代：提升 `patch` → `1.a.b`（例如 1.1.1、1.1.2）

### v0.0.0 （脚手架）
- 已创建仓库脚手架：monorepo 目录、gitignore、基础文档。
- 已添加开发脚本。

### v0.1.0（API + Web 基础联通）
- 后端使用 FastAPI，并提供 `/api/health`。
- 前端使用 Next.js，并提供标签页与健康检查显示。

### v0.2.0 （项目 + 设置）
- 使用 SQLite 持久化项目与设置。
- 设置页支持选择 provider / model、知识库模式与联网检索开关。

### v0.3.0（运行 + 多 Agent Trace）
- 提供 `Run` 接口与 SSE 流式输出。
- Trace 持久化保存，并在 Agents 页展示时间线。

### v0.4.0 （本地知识库）
- 本地知识库切片存储于 SQLite，并支持 FTS5 检索。
- UI 支持新增知识库笔记 / 片段并进行搜索。

### v0.5.0 （联网检索工具）
- 基于 DuckDuckGo 的联网检索工具（返回 URL + 摘要）。
- UI 支持将选中的联网检索结果手动、显式导入本地知识库。

### v0.6.0 （写作工作流）
- 支持生成大纲、写章节，并进行编辑润色。
- 续写模式：从已有文本中提取 StoryState。

### v0.7.0 （导出）
- Markdown 导出到 docx / epub / pdf 的流水线（优先 pandoc，必要时回退）。

### v0.8.0 （打磨 + 设置）
- 续写模式 UI：粘贴文本 → 抽取 → 继续写作。
- Agents 页：运行历史选择器 + 时间线 + 压缩图视图。
- 设置页支持可视化编辑 provider、model、base_url、temperature、max tokens、章节目标字数。

### v1.0.0 （MVP 完成）
- 写作工作区可端到端使用。
- 多 agent 协作可视化（时间线 + 基础图谱）。
- 已实现知识库强 / 弱依赖与 verifier 行为。
- 已补充文档与安全的 API 测试脚本。

#### 已知限制（v1.0.0）
- 某些 OpenAI-compatible 网关在面对偏重推理的模型时，可能返回空的 `message.content`（例如某些代理下的 Gemini 2.5 Pro）。
  - 临时解决方案：切换到 GPT，或在设置里选择非推理型 Gemini 模型（例如 Flash）。
- 导出质量会因环境不同而变化：
  - DOCX / EPUB 在可用时优先使用 pandoc；否则会退回到基础转换器。
  - PDF 回退方案更偏向纯文本导出。

### v1.0.1 （UI 偏好：语言 + 主题）
- UI 支持语言切换（中文 / EN），并持久化 UI 偏好（localStorage）。
- 为主 UI（标签 / 主按钮）加入主题 accent token，并提供主题管理器（新增 / 删除 / 重置预设）。

### v1.0.2 （文档 + i18n 打磨）
- 新增简体中文 README（`README.zh-CN.md`），并在 `README.md` 中加入语言入口。
- 修复中文模式下编辑器里残留的英文占位文本。
- Agents 页：前端侧为常见事件类型 / agent 名称提供中文映射。

### v1.1.0 （写作：类 Notion 三栏工作区）
- Writing 页升级为三栏布局：
  - 左侧：项目 + 大纲 + 章节
  - 中间：Markdown 编辑器 + 实时预览（编辑 / 预览 / 分栏）
  - 右侧：Runs + 导出 + 本地知识库 + 联网检索
- Markdown 预览使用 `react-markdown` + `remark-gfm`（支持表格 / 列表 / 代码块）。
- 大纲视图渲染为可读的章节列表（优先最新 run artifact，其次回退到项目设置）。

### v1.2.0 （强模式证据链 + 导出模板 + UI 打磨）
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

### v1.2.1 （主题默认值：恢复经典配色）
- Restored built-in theme colors to the original v1.x palette (e.g. `破晓` accent back to orange `#F97316`).
- Default UI background/surface reverted to a more neutral "classic" look (`#FAFAFA` / `#FFFFFF`).
- Added a small migration: users still on the untouched v1.2.0 default themes auto-upgrade to the classic defaults.

### v1.2.2 （UI 对比度 + 背景图修复）
- Fixed UI background image not showing: background layer now renders behind content reliably (z-index/stacking fix).
- Prevented OS-level dark mode from causing low-contrast text (Tailwind `dark:` variants are now class-based; app stays visually consistent until we add an explicit dark-mode toggle).

### v1.2.3 （主题：文字 + 控件颜色）
- Theme system expanded with more tokens: normal text color + muted text + control (input/button) background + control text.
- UI controls now use theme tokens so custom themes won't create "black boxes with unreadable text".

### v1.2.4 （联网检索稳健性 + 写作模式 + 可调尺寸工作区）
- Fixed web search failures in some networks: backend now supports provider routing (`auto` prefers Bing HTML scrape, falls back to DDG).
- Settings: added web search provider selector (still optional; results never auto-import into KB).
- Writing: added a left sidebar switch for `创作 / 续写` to make workflows clearer; research query is now shared across both flows.
- Writing layout: removed the narrow centered max-width and added draggable resizable panels (left / editor / tools) with auto-save sizing.
- Local KB: KB chunk inputs no longer prefill duplicate "设定"; title/tags now have explicit labels + clearer guidance.

### v1.2.5 （可调高度 + 续写文件上传）
- Writing layout now fills a fixed viewport height and supports vertical (height) resizing in the right tool panel (runs/export/KB/web cards are split into draggable panels).
- Continue mode supports uploading `.txt/.docx/.pdf/.epub` files (backend extracts plain text locally; no LLM call), and populates the continue textarea for editing.
- Backend: added `/api/tools/extract_text` and a reusable `tools/text_extract.py` utility; added `pypdf` for PDF extraction; added minimal tests for the new tool.

### v1.2.6 （续写来源：本地存储 + 预览 + 进度）
- Fixed `DetachedInstanceError` in SSE pipelines by using DB sessions with `expire_on_commit=False` (prevents project settings from expiring after commit).
- Continue mode upgraded for large manuscripts:
  - New backend endpoints store uploads/pasted text under `apps/api/data/continue_sources/` and return a `source_id` + short preview (no full-text round trip).
  - Runs now accept `source_id` + `source_slice_mode/head|tail` + `source_slice_chars`, and load excerpts from disk for the Extractor agent.
  - Writing UI merged “upload + paste” into a single dropzone textarea supporting drag-drop, click upload, and paste (file/text), plus excerpt preview/truncation controls.
- Continue text extraction improved with light pre-cleaning for PDF/EPUB (skip toc/nav docs, remove repeated PDF headers/footers, remove TOC dot-leader noise).
- Backend status card now shows active run + progress bar (front-end derived from SSE trace events).  

### v1.2.7 （LLM 重试 + 进度错误横幅）
- LLM calls are now more robust to transient gateway issues:
  - OpenAI-compatible calls try both `/chat/completions` and `/v1/chat/completions` even when one path returns 5xx (fixes some proxy/base_url combinations).
  - Added small retry/backoff for transient errors (502/503/504/429/timeouts) and slightly increased timeout.
- Writing → Backend progress bar now shows the run error message on abnormal exit (and during failure), sourced from SSE `run_error` events.

### v1.2.8 （Base URL 稳健性 + 更干净的 502 错误）
- OpenAI-compatible base_url handling is now safer:
  - Accepts base URLs with or without `/v1` without accidentally producing `/v1/v1/...`.
  - Keeps the most meaningful failure reason (e.g. 502) instead of being overwritten by a later 404.
- Sanitized HTML error pages in LLM errors to a short marker (`html_error_page`) to avoid flooding traces/UI.
- `apps/api/scripts/smoke_llm.py` can now be run from repo root reliably (adds `apps/api` to `sys.path`).

### v1.2.9 （API Key UI + OpenAI Responses + Gemini 代理修复）
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

### v1.2.10 （续写：ConfigAutofill 软失败 + 版本对齐）
- Continue/Chapter runs: `ConfigAutofill` is now **best-effort** in `weak` mode.
  - Transient LLM gateway failures (e.g. `openai_http_502:html_error_page`) no longer abort “抽取 + 续写”.
  - The pipeline continues with existing settings so Extractor/Outliner/Writer can still run.
- Backend tests: added a regression test to ensure continue runs still complete and emit chapter artifacts when ConfigAutofill fails.
- Version alignment: frontend bumped to `1.2.10` to match the API version.

### v1.3.0 （思考内容剥离 + Gemini 回退 + 管理 UI）
- Backend: strips `<think>...</think>` blocks before persisting chapter/agent outputs (prevents hidden reasoning from being saved/exported).
- Gemini (PackyAPI/proxy): detects “无可用渠道 / distributor” model-unavailable errors and falls back to `gemini-2.5-flash` / `gemini-2.0-flash` / `gemini-1.5-flash` automatically; default Gemini model switched to `gemini-2.5-flash`.
- Writing UI: added delete + drag-reorder for Projects (localStorage order) and Chapters (persisted `chapter_index` reorder + delete endpoint).
- API: added management endpoints:
  - `DELETE /api/projects/{project_id}` (cascade delete: runs/events/chapters/KB)
  - `DELETE /api/projects/{project_id}/chapters/{chapter_id}`
  - `POST /api/projects/{project_id}/chapters/reorder`
- Tests: added regressions for think-stripping + chapter/project delete/reorder APIs.

### v1.3.1 （PackyAPI Gemini：更好的默认值 + 更可靠的回退）
- PackyAPI Gemini: improved fallback model set to include Gemini 3 (`gemini-3-pro-preview` / `gemini-3-flash-preview` / `gemini-3.1-pro-preview`) and also triggers fallback on `empty_completion` (some gateways return reasoning-only outputs with empty text).
- Settings: default Gemini model updated to `gemini-3-pro-preview` (matches PackyAPI third-party client guidance and works more reliably than some 2.5 models in certain groups).

### v1.3.2 （PackyAPI Gemini：一致的运行配置 + 先保存再运行）
- Web: run buttons now wait for any in-flight Settings/Secrets save to complete before starting a run (prevents “I set gemini-3-* but tool_call still shows old gemini-2.5-*” races).
- API: run pipeline snapshots the LLM config at run start and includes it in `run_started` trace payload; prevents mid-run settings edits from mixing models across agents.
- Gemini (PackyAPI): prefer OpenAI-compatible `chat/completions` first (per PackyAPI third-party guidance), then fall back to Gemini v1beta + model fallback set.

### v1.3.3 （PackyAPI Gemini：Writer 503 韧性）
- Gemini (PackyAPI/proxy): strengthened retry + fallback behavior for flaky gateways so “Writer: gemini_http_503 无可用渠道（distributor）” is much less likely to abort runs:
  - OpenAI-compatible calls treat `empty_completion` as retryable (some distributors return reasoning-only outputs with empty text).
  - Gemini v1beta calls now retry/backoff on transient 5xx/429 **including** distributor-like 503s (previously raised immediately).
  - Fallback model set includes `gemini-2.5-pro`, and fallbacks also trigger on transient `http_5xx` errors (not only on “model unavailable”/empty outputs).

### v1.3.4 （可靠性：Outliner 软失败 + Editor 护栏 + Packy 节流）
- Web: clears previous outline/markdown at run start so a failed run won’t look “success” due to stale content.
- Runs pipeline:
  - Outliner: retries once when JSON parsing fails (with a stricter prompt and `gemini-3-flash-preview` fallback), and **soft-fails** on `chapter/continue` so writing can proceed even if outline generation is flaky.
  - Writer: per-run `max_tokens` is scaled by `chapter_words`; retries once on suspiciously short output (prefers `gemini-3-flash-preview` on Packy) and fails loudly if still too short (prevents “run completed but chapter is incomplete”).
  - Editor: prompt updated to preserve structure/length (no summarization); adds a guardrail to fall back to Writer output if the edited result looks truncated/incorrect.
- LLM (PackyAPI): reduces bursty traffic risk:
  - Adds gentle throttling + in-flight limiting for PackyAPI requests.
  - Uses only documented `/v1/...` endpoints for Packy base URLs; Gemini-on-Packy uses chat-only (avoids `/responses`) to reduce “probing noise”.

### v1.3.5 （开发脚本：稳定的后端 Python）
- `scripts/dev.ps1`: always launches backend with the project venv’s `python.exe` (instead of relying on PATH activation) to prevent “restarted but still running old API version” confusion under Uvicorn `--reload`.
- `scripts/dev.ps1`: warns when port `8000` is already in use and prints the existing process command line (best-effort), so you can stop the old server before starting a new one.

### v1.4.0 （UI 信息架构：创作/续写拆分 + 面板脚手架）
- Web: top-level navigation splits “创作 / 续写” (Create/Continue) as separate tabs; removes the in-workspace “写作模式” toggle (mode is now determined by the top tab).
- Web: adds v2.0-ready pane scaffolds:
  - 创作: 项目管理 / 背景设定 / 大纲编辑 / 写作
  - 续写: 文章续写 / 书籍续写
  Non-writing panes are scaffolds for now and will be upgraded in subsequent minor releases.
- i18n (zh): replaces “KB” wording with “知识库” in user-facing copy (keeps internal key names unchanged).

### v1.5.0 （背景设定：知识库 CRUD + 列表/导出 + 联网检索配置）
- API: KB router adds chunk update/delete endpoints:
  - `PATCH /api/projects/{id}/kb/chunks/{chunk_id}`
  - `DELETE /api/projects/{id}/kb/chunks/{chunk_id}`
- Web → 创作 → 背景设定:
  - Shows an explicit KB item list (with checkbox selection), supports drag reorder, edit, and delete.
  - Adds export for selected KB items in `json` or `txt`.
  - Moves “知识库模式（弱/强）” and “联网检索工具（开关/提供商）” controls into this pane for faster iteration.

### v1.6.0 （大纲导入/导出 + 书籍源上传 + 项目快捷操作）
- Web:
  - 创作 → 大纲编辑: 支持上传 `.txt/.json` 导入大纲，导出 `json/txt`，清空大纲（保存到 `story.outline`）。
  - 续写 → 书籍续写: 支持上传 `.txt/.json` 作为本地“书籍源”（落盘 + 头/尾截取预览）；长文本续写流程留到 v2.x。
  - 项目列表: 每个项目块增加快捷按钮（进入写作 / 文章续写（上传） / 书籍续写（上传））。
  - 运行中章节列表刷新: 不再随每条 SSE 事件拉取章节列表，改为写手产物（`chapter_markdown`）到达时刷新（降低请求风暴风险）。
- API:
  - Continue/Extract text: 支持 `.json` 作为纯文本输入（`extract_text` + `continue_sources/upload`）。
- Tests:
  - Added regressions for json extract + continue source upload.

### v1.7.0 （大纲：显式块编辑器）
- Web → 创作 → 大纲编辑:
  - 新增“大纲块编辑（草稿）”：支持块的增删改、拖拽排序、标题/简介/目标编辑。
  - 显式“保存大纲”与“重置”按钮；未保存状态会提示（不会静默覆盖）。
  - 右侧展示“已保存的大纲（用于写作）”，让用户区分草稿 vs 已保存版本。
  - 仍保留 `.txt/.json` 导入与 `json/txt` 导出能力。

### v1.8.0 （写作：批量生成章节）
- Web → 创作 → 写作:
  - 新增“一次生成章数” + “批量写 N 章”按钮：一次点击顺序生成 N 章，每章写完立刻落库并出现在章节列表。
  - 写章节默认 `skip_outliner=true`：避免反复调用 Outliner 覆盖已编辑的大纲（更稳定/更省调用）。
- API:
  - 修复 runs pipeline 中 `chapter_index/chapter_plan` 的变量断裂导致的运行时错误。
- Tests:
  - Added regression test for `skip_outliner=true` (OutlinerAgent is skipped but chapter artifacts still emit).

### v1.8.1 （写作：批量控制 + 更好的失败展示）
- Web → 创作 → 写作:
  - 批量写章新增“停止（当前章完成后停止）/继续剩余/清除”控制，减少误操作与重复调用。
  - 批量写章在失败时记录并显示最近一次错误（便于定位是哪个 Agent/网关失败）。

### v1.9.0 （续写：批量续写 + 书籍源进入工作台）
- Web → 续写 → 文章续写（工作台）:
  - 新增“一次续写章数”与“批量续写 N 章”：顺序续写多章，每章完成后立刻落库并在章节列表可见。
  - 批量续写支持“停止（当前章完成后停止）/继续剩余/清除”，并在失败时展示最近一次错误。
- Web → 续写 → 书籍续写:
  - 增加“用此书籍源进入续写工作台”按钮：把已上传的书籍源加载到文章续写工作台，方便编辑与批量续写。

### v1.10.0 （书籍续写：分块索引 + 总结入库）
- API:
  - `GET /api/tools/continue_sources/{source_id}/book_index`：对已上传的书籍源做字符级分片索引（不调用 LLM），返回分片列表与预览。
  - Runs: 新增 `kind=book_summarize`：按分片顺序调用 LLM 做简要总结，并逐片写入本地知识库（`source_type=book_summary`，带 `book_source:...` 标签）。
- Web → 续写 → 书籍续写:
  - 新增“书籍分片索引 / 总结入库（MVP）”卡片：可配置分片长度/重叠/最大分片数，一键生成索引与总结入库。
  - 总结完成后展示入库统计，并提供快捷按钮跳转到「创作 → 背景设定」查看知识库条目。
- Tests:
  - Added regressions for `book_index` tool endpoint and `book_summarize` run kind.

### v1.11.0 （书籍续写：编译书籍状态 + 可断点总结）
- API:
  - Runs: 新增 `kind=book_compile`：把已入库的 `book_summary` 分片总结编译为“书籍状态”（世界观/角色卡/时间线/悬念/续写起点），写入 KB（`source_type=book_state`）。
  - `book_summarize` 支持断点续跑：`replace_existing=false` 时会跳过已存在的分片总结（避免重复入库与重复调用）。
- Web → 续写 → 书籍续写:
  - “总结入库（LLM）”旁新增“编译书籍状态（LLM）”，并在页面内展示编译结果预览与 KB 编号。
- Tests:
  - Added regression test for `book_compile` run kind.

### v1.12.0 （书籍续写：基于状态写作 + 工作台切换）
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

### v1.12.1（书籍续写：更好的多章节连续性）
- API:
  - `book_continue` 在 BookPlanner/Writer 提示词中自动加入“最近已写章节”（来自本项目章节库，截取尾部），提高批量多章生成的连续性。
  - KB 检索（`kb_search`）的 query 构造增强：当 Story 设置较少时，会额外利用 `StoryState`（world/角色名）做检索，提高命中“既有章节/设定”的概率。
  - 修复：确保 `book_state + book_summary` 上下文在 `kb_search` 成功/失败两种情况下都会合并进 Writer 提示词（避免偶发丢上下文）。

### v1.12.2 （可靠性：PackyAPI Gemini Writer 提示预算 + 救援重试）
- API:
  - `book_compile`: 对编译出的 `book_state.state` 做结构化压缩（限制字符串/列表长度），避免后续提示词过长导致网关断连。
  - `book_continue`: 读取 `book_state` 后先做 compact，再转换为 Writer 的 `StoryState`（`summary_so_far/world/current_status/relationships` 等字段都有上限）。
  - Writer: 新增提示词预算（对大 JSON 做截断标记），并对 PackyAPI Gemini 写作阶段更保守地限制 `max_tokens`；遇到可重试网关错误（ConnectError/timeout/429/5xx）时会用更小上下文 + Flash 模型重试一次。
- Tests:
  - Added regression test to ensure超长 `book_summary` 不会原样进入 Writer 提示词（降低 `openai_network_error:ConnectError` 概率）。
- Web:
  - `apps/web/package-lock.json` 的 version 字段与 `package.json` 对齐（避免长时间迭代后版本漂移）。

### v1.13.0 （OutlineGraph：思维导图大纲编辑器 MVP）
- Web → 创作 → 大纲编辑:
  - 新增“大纲思维导图（草稿）”模式（基于 `@xyflow/react`）：自由拖拽节点、连线生成关系箭头、节点/边检查器编辑。
  - 节点类型（typed nodes）：至少支持 `chapter/plot/character/time/place/item/foreshadow`，并有基础配色与标签。
  - 互转能力：
    - `大纲块草稿 (story.outline 的草稿编辑器)` → “从草稿生成导图”
    - “导图 → 草稿”（用导图生成大纲块草稿）
  - 保存导图：写入 `story.outline_graph`，并同步更新 `story.outline`（保证后续写章节链路可直接使用）。
- Web:
  - 全局样式引入 `@xyflow/react/dist/style.css`（保证控件/连线样式稳定）。

### v1.13.1 （OutlineGraph：导入/导出 + 章节自动排序）
- Web → 创作 → 大纲编辑（导图模式）:
  - 支持导图 `JSON` 导入/导出（`outline_mindmap.json`）。
  - 新增“章节排序”：按当前节点 Y 坐标对章节节点自动编号，并顺带整理章节节点布局（更利于 `导图 → 草稿` 转换）。
  - 导图 JSON 有更稳健的解析/校验（避免非法数据导致页面崩溃）。

### v1.14.0 （书籍：章节索引工具）
- API（不调用 LLM）:
  - 新增章节索引端点：
    - `GET /api/tools/continue_sources/{source_id}/chapter_index`：构建/读取章节索引（`overwrite=false` 默认读缓存）。
    - `PATCH /api/tools/continue_sources/{source_id}/chapter_index`：手动微调后保存（重算 end_char/预览）。
- Backend tools:
  - 新增 `tools/chapter_index.py`：规则识别“第X章/回/卷/节”，将 `chapter_index.json` 落盘到书籍源目录旁。
- Tests:
  - 新增 tools 侧回归：章节索引构建 + 更新 + 无标题报错。

### v1.15.0 （书籍：按章总结 + 编译）
- API runs:
  - `book_summarize` 支持 `segment_mode=chapter/auto`：优先读取/构建 `chapter_index.json`，按章总结入库（tags：`book_chapter:n`）。
  - `book_summarize` 的 stats artifact 增加 `segment_mode` 与相关 params（便于前端展示“章/片”）。
  - `book_compile` 在同时存在分片总结与章节总结时，优先编译“章节总结”（更贴近用户心智）。
- LLM（PackyAPI/Gemini）:
  - network_error/timeout 在 Packy base 上也会触发模型 fallback（更易从 ConnectError 中自救；同时保持探测次数保守，避免像异常流量）。
- Tests:
  - 新增 runs 回归：章节模式 `book_summarize` + `book_compile` 优先章节总结。

### v1.16.0 （Web：章节微调 UI + Trace 图谱）
- Web → 续写 → 书籍续写:
  - 新增“章节分块 / 手动微调（MVP）”卡片：加载/重新识别/保存微调/导出 `json/txt`。
  - “总结入库（LLM）”在存在章节索引时默认走 `segment_mode=chapter`（未保存微调时会禁用，避免索引不一致）。
  - 统计展示会根据 `segment_mode` 自动显示“章/片”。
- Web → Agent 协作:
  - Graph 视图升级为 ReactFlow 图谱：按 Agent 汇总 tool/artifact，并展示产物类型计数（对 book_summarize 这类长流程更友好）。
- i18n:
  - Graph 文案从“图”升级为“图谱”，并更新描述为“聚合图谱”。

### v2.0.0 （里程碑：百万字长书续写，可用且稳健）
- 书籍续写（推荐流程）:
  - 上传书籍源（本地落盘，gitignored）→ 章节分块 → 手动微调 → 按章节总结入库（LLM）→ 编译书籍状态（LLM）→ 进入续写工作台（书籍模式）生成章节（支持批量与落库可见）。
- 章节能力:
  - 规则优先识别“第X章/回/卷/节”，生成 `chapter_index.json`，并支持在前端做删除/改标题并保存（微调后会重算边界与预览）。
- 可用性与健壮性:
  - BookSummarizer/BookCompiler 优先按章节工作（更贴近用户心智）；同时保留分片模式作为无标题文本兜底。
  - PackyAPI/Gemini 在 `network_error/timeout` 场景下会做保守的模型 fallback；Writer 阶段也有“缩短上下文 + 更含蓄写作模式”的救援重试，降低断连风险。
- 可观测性:
  - Agent 协作页新增 ReactFlow 图谱视图（按 Agent 聚合 tool/artifact，并展示产物类型计数），用于理解长流程与排障。

### v2.1.0 （图谱工作区 + Job/进度轮询）
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

### v2.1.1 （图谱：项目选择器 + 去重 Run DAG）
- 图谱工作区:
  - 顶部新增“项目”选择器：大纲图/书籍结构图支持切换项目回放（用于查看历史项目产物）。
  - 运行流程图（Run DAG）从图谱页移除，统一在「Agent 协作」页查看（避免重复视图）。
  - 书籍结构图在缺少 `chapter_index` 时仍可展示已入库的总结/状态/续写产物，并提示用户先执行章节分块（兼容历史数据）。
- Docs:
  - 更新 `README.md` / `README.zh-CN.md` 的图谱使用说明。

### v2.1.2（书籍：章节切分——内联标题 + 去重启发式）
- 章节分块（`chapter_index`）增强:
  - 支持“标题藏在正文里”的情况：章节识别不再强依赖“标题必须独占一行”。
  - 当同一个“第X章/回”出现多次（目录/引用/页眉重复等），会结合“绝大多数章节长度”做去噪与选择，更倾向于选出真实章节边界。
- Tests:
  - 新增回归：正文内标题 + 重复标题（目录/引用）去噪应能得到正确章节数。

### v2.1.3（书籍：章节切分——导航噪声 + “第X回中” 引用保护）
- 章节分块（`chapter_index`）增强:
  - 支持“回目录/回首页/上一页/下一页”等导航噪声与标题粘连的情况：如 `...回目录回首页第二回 标题` 也能正确识别章回边界。
  - 降低误识别：对“第X回中/里/内...”这类正文引用（非标题）做降权，避免被选成真实章节起点。
- Tests:
  - 扩展回归：覆盖“导航噪声 + 标题粘连”与“第X回中...”引用场景。

### v2.1.4 （开发：启动时自动清理陈旧端口）
- Dev Script（`scripts/dev.ps1`）增强:
  - 默认启动前会尝试自动清理被旧进程占用的端口（8000/3000），避免“启动成功但实际上仍在跑旧版本”的困惑。
  - API 端口（8000）会先探测 `/api/health` 是否为 ai-writer-api，再做更安全的自动停止；对 `uvicorn --reload` 孤儿子进程（`spawn_main(parent_pid=...)`）也会尝试清理。
  - 可用参数：`-NoAutoKill`（禁用自动清理），`-ForceKill`（强制清理未知占用者，谨慎使用）。

### v2.1.5 （开发：修复 dev.ps1 插值解析错误）
- 修复 `scripts/dev.ps1` 中的 PowerShell 字符串插值解析错误（`PID=$p: ...` 在某些情况下会被当作 `$p:` 解析导致脚本无法运行）。
- 现在 `.\scripts\dev.ps1` 可正常执行端口检测与自动清理逻辑。

### v2.1.6 （书籍：总结——非 JSON 输出容错）
- 书籍总结入库（`book_summarize`）增强:
  - Gemini/网关偶尔不按要求输出 JSON 时，不再因为 JSON 解析失败而直接中断 SSE（避免前端出现 `Error in input stream`）。
  - 解析失败会以 `text` 兜底保存到 KB，并在 stats 里记录 `json_parse_failed` 计数，便于排障与选择更稳的模型（建议 Flash）。
- Tests:
  - 新增回归：BookSummarizer 返回非 JSON 文本时也应完成并落库。

### v2.1.7 （书籍：编译/总结可靠性 + 步骤进度 + 书籍图谱）
- 修复（根因级）：Gemini 调用链的异常抛出缩进错误，导致部分书籍链路（总结/编译等）在代理网关下易失败或表现异常。
- PackyAPI/Gemini 更保守：
  - Packy base 下 OpenAI-compatible 调用默认 chat-only（避免 `/responses` 探测噪声），并加入轻度节流/并发限制，降低被网关误判为异常流量的概率。
- 书籍总结入库（`book_summarize`）更稳：
  - `replace_existing=true` 不再“开局全删”，改为逐段写入前只删对应 index 的旧 chunk（避免网关抖动导致“先删光成果”）。
  - 增加 `max_consecutive_failures` 断路器；章节模式下严格尊重 `max_chapters`（即使读取缓存 chapter_index 也会切片）。
- 书籍状态编译（`book_compile`）更稳：
  - 对长提示词做更严格的 compact；遇到可重试的网关错误会走一次“缩短上下文 + Flash 模型”救援重试。
- 可观测性：后端 SSE 增加 `step/step_index/step_total`，前端「后端」卡片显示到“每个 agent 的每一步”（含 BookSummarizer 的分段进度）。
- 图谱增强（书籍结构 / 章节关系 / 人物关系）：
  - 书籍结构图：章节标题清洗 + 从章节总结兜底补全；显示章节线性链路。
  - 新增 `book_relations`（章节非线性关系边）与 `book_characters`（人物卡 + 人物关系边）并在图谱工作区可生成/刷新与可视化。
- API：
  - 新增 KB 元数据列表 `/chunks_meta`（不返回全文 content），用于长书图谱/统计加载更快更稳。
- Tests：
  - 增加/扩展回归：book_summarize/book_compile 健壮性、图谱依赖的 KB meta 读取等。

### v2.1.8 （书籍：BookCompiler“卡住”心跳 + 硬超时）
- 修复体验问题：`book_compile` 的 LLM 调用阶段在 PackyAPI/Gemini 代理下偶尔会长时间无响应，看起来像“卡死”。
  - 后端在 `BookCompiler` 的 `llm.generate_text` 阶段加入 SSE 心跳（每 ~8s 发一次，带 `elapsed_s/attempt/selection`），让前端可持续更新“等待中”状态。
  - 增加外层 hard timeout（默认 120s/attempt）：超过即主动失败并给出明确错误，避免无限等待。
- 前端：`后端` 进度条与 agent 详情会显示 “等待 Ns / 尝试 k / selection=...”。

### v2.1.9（续写/图谱体验 + 图谱生成救援重试）
- Web：
  - Continue 页标题描述修复：`创作` 显示 writing_desc，`续写` 显示 continue_desc（避免误导）。
  - Continue source 在只读 `source_id` 模式下新增“转为可编辑 / Make editable”：一键清空 `source_id`，把当前预览转回可编辑文本，便于小幅修订后再运行。
  - 全局样式：`body` 使用 `--ui-*` 主题 token（背景/文字/字体），与项目主题系统一致。
  - Graph → 人物关系图：布局从“环形均匀分布”升级为“按关系组件分块 + BFS 分层”，并支持选中人物后仅高亮邻居与相关边（其余淡化），减少线团与卡片重叠。
  - Graph → 书籍结构图：默认布局改为 `timeline`，并优化非线性边构建时的节点存在性判断（Set）。
- API：
  - `book_relations` / `book_characters`：对输入 summaries 做更严格 compact + head/tail 选取 + 提示词体积上限收缩；遇到可重试网关错误时做一次“救援重试”（更小 selection + 更保守 max_tokens + PackyAPI Gemini 强制 Flash）。
  - Writer 的救援重试策略扩展到 `chapter` / `continue` / `book_continue`（与大书链路一致，降低代理网关抖动导致的中断）。
- Dev：
  - 增加 `apps/api/scripts/e2e_book_flow.py`：用 FastAPI TestClient 走通“上传红楼梦 → 章节索引 → 少量按章总结 → 编译书籍状态 → 生成 relations/characters → 书籍续写”链路，便于回归。
  - 增加 `pyrightconfig.json`（本地静态检查配置，避免缺失导入/复杂度警告阻塞迭代）。

### v2.1.10（图谱可靠性：No-Distributor 恢复 + 超时）
- API（图谱生成）：
  - `book_relations` / `book_characters` 的救援重试不再固定钉死 `gemini-3-flash-preview`，改为按错误动态挑选下一候选模型（优先避开“无可用渠道”已失败模型）。
  - 当 Gemini/Packy 在救援阶段继续报 `no distributor` 时，新增一次 `fallback_openai` 兜底尝试（沿用同一提示词与更保守 token 预算），避免图谱链路直接失败。
  - 为 `book_relations` / `book_characters` 增加 LLM 调用超时保护（默认 120s），避免 run 长时间卡在 `running`。
- Tests：
  - 新增回归：`test_book_relations_rescue_can_fallback_to_openai`，覆盖“flash 无渠道 → pro 无渠道 → openai 兜底成功并产出 artifact”。
- Frontend 实测（Playwright）：
  - 实际点击 `图谱 → 书籍结构图 → 生成章节关系（LLM）`，触发真实 run。
  - 该次 run trace 显示完整链路：`gemini-3-flash-preview` 失败 → `gemini-3-pro-preview` 救援失败 → `openai(gpt-5.2)` 兜底成功，最终 `status=completed` 且生成 `book_relations` artifact。

### v2.1.11（图谱：关系解析修复 + 默认可见）
- API（章节关系生成）：
  - `book_relations` 在 JSON 解析失败（`ValueError` 等）或 edges 为空时，会触发一次“修复输出为严格 JSON”的修复重试；若仍无法得到有效 edges，则启用启发式关系兜底，避免图谱空白。
  - `timeout` 错误标记为 `*_timeout`，进入既有救援重试链路（避免超时直接失败）。
- Web（书籍结构图显示）：
  - `kb/chunks_meta` 结果按 `created_at` 倒序排序，保证“最新 book_relations”优先被加载。
  - 当缺少 `chapter_index` 时，书籍结构图会用已入库 summaries 的 `book_chunk/book_chapter` 索引生成“可视化节点”，让章节关系边也能真实显示。
  - 默认 `强度阈值` 改为 `0`（可见性优先；需要筛选时再手动调高）。
- Docs / Repo：
  - 文档职责正式拆分为 `AGENTS.md` / `HANDOFF.md` / `CHANGELOG.md` / `ROADMAP.md`，并在 README 中同步接手入口。
  - `.gitignore` 新增本地 `.serena/` 与 `apps/api/api-boot.*.log`，避免把 agent 元数据与启动日志误提交到仓库。

