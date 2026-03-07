# ROADMAP

本文件记录未来规划、已确认决策、里程碑与待讨论方向。

维护规则：
- 未来规划必须写入本文件。
- 已确认决策必须写入本文件。
- 已发布版本说明不再写入本文件，统一记录在 `CHANGELOG.md`。
- 当规划真正落地为已发布功能后，应把对应结果写入 `CHANGELOG.md`，并在本文件中调整或移除相关计划项。

## 已确认决策（2026-03-06）
- 文档职责正式拆分：`AGENTS.md` 负责长期项目脑，`HANDOFF.md` 负责共享交接，`CHANGELOG.md` 负责版本沿革，`ROADMAP.md` 负责未来规划 / 已确认决策，外部记忆文件负责 agent 工作记忆。
- `AGENTS.md` 必须保持精炼，优先保留长期有效、当前仍然成立的内容，不再承载完整版本历史。
- 每次版本更新必须写入 `CHANGELOG.md`。
- 未来规划 / 已确认决策必须写入 `ROADMAP.md`。
- 当产品目标、核心架构、关键工作流或长期维护热点发生变化时，必须同步更新 `AGENTS.md`。

## 已确认决策（2026-03-07）
- PackyAPI 下的文章续写链路，正式采用“分 lane 保产物”的稳定性策略，而不是要求单一 provider 独占全部 agent：
  - Gemini + Packy 的 `ConfigAutofill` / `Extractor` / `Outliner` 优先走稳定 OpenAI-compatible 结构化通道。
  - `Writer` 保持“先用界面中选中的模型”，只在模型不可用、空响应、明显过短或可重试网关错误时透明 fallback。
  - Gemini + Packy 的 `Editor` 优先走稳定 OpenAI-compatible 通道，确保最终章节产物更稳定。
- 文章续写的稳定性验收必须包含真实前端点击与真实产物校验；仅依赖 `soft_fail`、只看 SSE 不报错、或只做后端冒烟都不再视为通过。
- `apps/web/e2e/continue-acceptance.spec.ts` 作为正式回归入口，至少覆盖 `gpt-5.2`、`gpt-5.4`、`gemini-3-flash-preview`、`gemini-2.5-pro` 四个模型。

## 当前路线图状态
- 当前尚未整理新的正式版本排期；后续功能规划、里程碑与验收口径从本文件继续维护。
- 在新的功能方向被正式确认前，不应把推测性想法写入 `AGENTS.md`。

## 待讨论方向（基于当前版本沿革整理）
- 长书续写链路继续提升连续性、可恢复性、可诊断性与代理网关稳定性。
- 图谱链路继续提升生成可靠性、结构可读性与前端交互体验。
- 逐步拆分后端 `apps/api/ai_writer_api/routers/runs.py` 与前端 `apps/web/src/app/page.tsx` 的过大职责，降低长期维护成本。
