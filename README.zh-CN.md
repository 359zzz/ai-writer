# ai-writer

本项目是一个本地运行、单用户的「多智能体协作小说写作平台」。

[English](README.md) | [简体中文](README.zh-CN.md)

## 快速开始（Windows）

1) 将你的 API Key 填入 `api.txt`（该文件已 **gitignore**，不会提交到仓库）。
2) 运行：

```powershell
.\scripts\dev.ps1
```

启动后：
- API: http://localhost:8000
- Web: http://localhost:3000

## 冒烟测试（LLM）

本项目会从环境变量或本地 `api.txt`（已 gitignore）加载密钥。

运行一个短小、安全的冒烟测试（输出不超过 500 字/500 词）：

```powershell
.\apps\api\.venv\Scripts\python.exe .\apps\api\scripts\smoke_llm.py --provider openai
```

## 项目结构

- `apps/api`：FastAPI 后端
- `apps/web`：Next.js 前端
- `scripts`：本地一键启动脚本
- `AGENTS.md`：整体架构约束 + 按版本迭代记录（Codex/Agent 项目脑）

## 安全说明

- 不要提交 `api.txt` 或 `.env*` 文件。
- UI 不会显示完整 API Key。

## 备注

- 一些 OpenAI-compatible 网关在某些推理模型上可能出现输出为空等差异。
  如果遇到该问题，请在 `Settings` 里切换 provider/model。

