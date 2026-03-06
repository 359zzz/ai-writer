# HANDOFF

本文件是 `ai-writer` 的共享交接文档，用于帮助人类开发者或 agent 快速接手当前项目。

它的定位比 `AGENTS.md` 更偏操作与交接：
- `AGENTS.md`：长期项目脑，记录产品目标、架构约束、术语约定、长期维护热点
- `HANDOFF.md`：共享接手说明、阅读顺序、热点文件、操作建议
- `CHANGELOG.md`：版本更新与发布沿革
- `ROADMAP.md`：未来规划、已确认决策、待讨论方向

## 这个项目是什么

`ai-writer` 是一个本地单用户的多 Agent 小说工作台，当前已经覆盖：
- 创作：项目管理、背景设定、本地知识库、大纲编辑、章节写作、批量生成
- 续写：文章续写、书籍续写、长书状态编译与基于状态续写
- 图谱：大纲图、书籍结构图、人物关系图、运行聚合图谱
- Agent 协作：时间线、工具调用、产物、错误与回放
- 设置与导出：模型配置、密钥、本地项目参数、DOCX / EPUB / PDF 导出

技术栈：
- `apps/api`：FastAPI + SQLite + SSE
- `apps/web`：Next.js 工作台
- `scripts`：Windows PowerShell 本地开发脚本

## 接手时先读什么

推荐先读下面这些文件：
- `AGENTS.md`
- `CHANGELOG.md`
- `ROADMAP.md`
- `README.md`
- `apps/api/ai_writer_api/routers/runs.py`
- `apps/api/ai_writer_api/llm.py`
- `apps/web/src/app/page.tsx`
- `apps/api/tests/test_runs.py`

如果你是以“继续上一轮工作”为目标接手，还应先看：
- `git status --short`
- `git diff --stat`
- `C:\Users\zhang\.codex\memories\ai-writer-takeover.md`

## 当前架构事实

接手时优先记住这几件事：
- 后端运行编排主入口在 `apps/api/ai_writer_api/routers/runs.py`
- 每次 `run` 都会产生 `trace` 事件流，既会经 SSE 输出，也会持久化到 SQLite
- LLM 配置会在 `run` 开始时快照，避免中途改设置导致一次运行内混用模型配置
- 本地知识库使用 SQLite + FTS5
- 文章 / 书籍续写来源保存在 `apps/api/data/continue_sources/`
- 密钥保存在 `apps/api/data/secrets.local.json`，不能出现在日志或界面明文中
- `<think>...</think>` 内容在持久化和显示前会被剥离

## 当前关键链路

今天最重要的运行类型包括：
- `outline`
- `chapter`
- `continue`
- `book_summarize`
- `book_compile`
- `book_relations`
- `book_characters`
- `book_continue`

这些链路都通过 `POST /api/projects/{project_id}/runs/stream` 进入后端编排主流程。

## 当前维护热点

高风险 / 高变更频率文件：
- `apps/api/ai_writer_api/routers/runs.py`
- `apps/web/src/app/page.tsx`
- `apps/api/ai_writer_api/llm.py`
- `apps/api/ai_writer_api/tools/chapter_index.py`

为什么这些文件要优先谨慎处理：
- `runs.py` 集中了编排、长书链路、SSE、重试与错误处理
- `page.tsx` 仍然承载大量前端业务状态与工作区逻辑
- `llm.py` 集中了模型兼容、fallback、重试、PackyAPI 策略
- `chapter_index.py` 是规则密集型章节识别逻辑，容易因为小改动引发长书回归问题

## 安全工作规则

- 在热点文件中优先做小而精确的修改
- 不得在界面、日志、trace 中暴露完整 API Key
- 涉及真实 LLM API 的测试必须保持输出短小
- 涉及模型兼容、长书续写、图谱生成的改动，应优先补或更新回归测试
- 联网检索结果不能自动视为知识库规范事实
- 强依赖模式下，不要脱离知识库 / 配置 / 正文证据擅自编造设定

## 本地运行与验证

常见本地启动方式：
- `./scripts/dev.ps1`

常见后端检查：
- `GET /api/health`
- 优先运行 `apps/api/tests/` 下与改动最相关的测试
- 可选烟测：`apps/api/scripts/smoke_llm.py`
- 端到端辅助脚本：`apps/api/scripts/e2e_book_flow.py`

## 推荐接手顺序

开始新任务时，推荐按这个顺序进入：
1. 阅读 `AGENTS.md`，确认长期约束与当前北极星
2. 阅读 `CHANGELOG.md`，了解最近版本演进
3. 阅读 `ROADMAP.md`，了解已确认决策与待讨论方向
4. 查看 `git status` / `git diff --stat`，确认当前工作树状态
5. 定位改动落点：后端编排、前端工作台、图谱组件或工具模块
6. 修改前先读最近的相关回归测试
7. 验证时从最小相关测试范围开始

## 交接清单

在你准备把工作交给下一个人或下一个 agent 之前，建议补充：
- 这次改了哪些文件
- 为什么要这样改
- 跑了哪些测试
- 还有哪些风险或已知未解问题
- 下一个接手者应该先看哪几个文件

## 维护说明

- `AGENTS.md` 仍然是权威的长期项目脑
- `HANDOFF.md` 应保持简洁、偏操作、偏接手
- 如果这份文件开始变得像版本史，应把内容迁到 `CHANGELOG.md`
- 如果这份文件开始变得像长期规划，应把内容迁到 `ROADMAP.md`
