# ai-writer

本项目是一个本地运行、单用户的「多智能体协作小说写作平台」（FastAPI + Next.js）。

[English](README.md) | [简体中文](README.zh-CN.md)

## 你将获得什么

- Notion 风格写作工作台：项目/大纲/章节 + Markdown 编辑/预览 + 工具面板
- 多智能体执行流（SSE 流式 trace）+ 可视化（时间线 + 图）
- 本地知识库（SQLite + FTS5），支持 **强/弱依赖** 模式
- 可选的联网搜索工具（默认不入库，必须手动导入到 KB）
- 续写模式：上传/粘贴作品 → 抽取 StoryState → 在此基础上续写
- 导出：DOCX / EPUB / PDF（优先 pandoc；缺失时自动降级）

## 环境要求

- Windows 10/11
- Python 3.11
- Node.js（建议 LTS）
- 可选（推荐）：
  - `pandoc`：更高质量的 DOCX/EPUB/PDF 导出
  - LaTeX 引擎（例如 MiKTeX）：更高质量 PDF 输出

## 快速开始（Windows）

1) 将你的 API Key 填入 `api.txt`（该文件已 **gitignore**，不会提交到仓库）。

2) 运行：

```powershell
.\scripts\dev.ps1
```

启动后：
- API: http://localhost:8000
- Web: http://localhost:3000

打开页面： http://localhost:3000

## 使用指南（UI）

### 1）新建/选择项目

- 写作页 → 左侧面板 → 项目 → 新建
- 在列表中选择该项目

注意：所有设定都不是必填；在 **KB 弱依赖** 模式下，缺失字段会由 LLM 随机/创意补全（不会覆盖你已填字段）。

### 2）设置模型与工具

- 设置页：
  - Provider：GPT（OpenAI-compatible）或 Gemini
  - Model / Base URL / temperature / max_tokens
  - KB 模式：
    - 弱依赖：优先 KB，允许创意补全
    - 强依赖：canon-locked；新增事实必须来自本地 KB/设定/已写稿件
  - 联网搜索工具：启用 + 选择 provider

安全说明：UI 只显示密钥“已配置/缺失”，绝不会展示完整 Key。

### 3）（可选）添加本地知识库 KB

- 写作页 → 右侧面板 → 本地知识库
- 添加 chunk：标题/标签/正文
- 使用搜索快速查找设定/风格/参考片段

### 4）创作 / 续写

- 创作模式：
  - 生成大纲
  - 写章节（LLM）+ 编辑器润色
- 续写模式：
  - 使用同一个“续写素材”输入框（拖拽文件 / 点击上传 / 粘贴文本或文件）
  - 选择“截断位置（尾部/开头）”与“截断长度（字符）”
  - 点击“抽取 + 续写”

大文件建议直接上传：后端会把全文保存到 `apps/api/data/continue_sources/`（已 gitignore），前端只拿到一段预览，
避免“把 60 万字全文塞进 textarea / 再次 POST”导致的卡死问题。

### 5）导出

- 写作页 → 右侧面板 → 导出
- 选择 DOCX / EPUB / PDF

## 冒烟测试（LLM）

本项目会从环境变量或本地 `api.txt`（已 gitignore）加载密钥。

运行一个短小、安全的冒烟测试（输出不超过 500 字/500 词）：

```powershell
.\apps\api\.venv\Scripts\python.exe .\apps\api\scripts\smoke_llm.py --provider openai
```

## 项目结构

- `apps/api`：FastAPI 后端
- `apps/web`：Next.js 前端
- `scripts`：本地一键启动脚本（PowerShell）
- `AGENTS.md`：整体架构约束 + 按版本迭代记录（项目脑）

## 排错 / FAQ

- “Health 正常但流程报错/没反应”：请打开 Agent 协作页查看 trace，通常能定位到具体 agent/tool。
- “联网搜索报错”：可能与网络环境有关，可在设置中切换 provider（auto/bing/duckduckgo）。
- “导出效果一般”：建议安装 `pandoc`；PDF 进一步建议安装 LaTeX 引擎。

## 安全说明

- 不要提交 `api.txt` 或 `.env*` 文件。
- UI 不会显示完整 API Key。
