export type Lang = "zh" | "en";

export type I18nKey =
  | "app_name"
  | "app_tagline"
  | "tab_writing"
  | "tab_agents"
  | "tab_settings"
  | "backend"
  | "checking"
  | "ok"
  | "unreachable"
  | "writing"
  | "writing_desc"
  | "projects"
  | "project_title_placeholder"
  | "create"
  | "no_projects"
  | "selected_project"
  | "project_id"
  | "none"
  | "run_demo"
  | "generate_outline"
  | "streams_to_agents"
  | "running"
  | "write_chapter"
  | "chapter_index"
  | "research_query_optional"
  | "write_chapter_llm"
  | "uses_settings"
  | "continue_mode"
  | "continue_desc"
  | "paste_manuscript"
  | "extract_continue"
  | "clear"
  | "markdown_editor"
  | "outline_latest"
  | "no_outline"
  | "chapters"
  | "no_chapters"
  | "open"
  | "export"
  | "export_desc"
  | "exporting"
  | "local_kb"
  | "stored_locally"
  | "save_to_kb"
  | "search_kb"
  | "web_search"
  | "web_search_desc"
  | "web_search_disabled"
  | "import_to_kb"
  | "agents"
  | "agents_desc"
  | "timeline"
  | "graph"
  | "events"
  | "no_events"
  | "execution_flow"
  | "compressed_view"
  | "settings"
  | "settings_desc"
  | "secrets_status"
  | "secrets_desc"
  | "gpt_key"
  | "gemini_key"
  | "present"
  | "missing"
  | "project_settings"
  | "select_project_first"
  | "provider"
  | "gpt_provider"
  | "gemini_provider"
  | "gpt_model"
  | "gpt_base_url"
  | "gemini_model"
  | "gemini_base_url"
  | "optional_use_api_txt"
  | "temperature"
  | "max_tokens"
  | "chapter_words"
  | "chapter_count"
  | "kb_mode"
  | "kb_weak"
  | "kb_strong"
  | "web_search_tool"
  | "ui_prefs"
  | "language"
  | "theme"
  | "theme_manage"
  | "add_theme"
  | "delete_theme"
  | "reset_themes"
  | "theme_name"
  | "categories"
  | "add_category"
  | "role"
  | "category_name"
  | "color"
  | "delete"
  | "run_history";

const ZH: Record<I18nKey, string> = {
  app_name: "ai-writer",
  app_tagline: "多智能体小说工作台（MVP）",
  tab_writing: "写作",
  tab_agents: "Agent 协作",
  tab_settings: "设置",
  backend: "后端",
  checking: "检测中...",
  ok: "正常",
  unreachable: "无法连接",
  writing: "写作",
  writing_desc: "Notion 风格工作台（持续增强中）。",
  projects: "项目",
  project_title_placeholder: "项目标题",
  create: "新建",
  no_projects: "还没有项目。",
  selected_project: "当前项目",
  project_id: "项目ID",
  none: "无",
  run_demo: "运行 Demo 流程",
  generate_outline: "生成大纲",
  streams_to_agents: "会流式输出事件到 Agent 协作页。",
  running: "运行中...",
  write_chapter: "写章节",
  chapter_index: "章节序号",
  research_query_optional: "联网检索（可选）",
  write_chapter_llm: "写章节（LLM）",
  uses_settings: "使用 设置→模型/知识库/联网检索 等配置。",
  continue_mode: "续写模式",
  continue_desc: "粘贴已有文本 → 抽取 StoryState → 在此基础上续写。",
  paste_manuscript: "粘贴已有作品...",
  extract_continue: "抽取 + 续写",
  clear: "清空",
  markdown_editor: "Markdown 编辑器",
  outline_latest: "最新大纲",
  no_outline: "暂无大纲。",
  chapters: "章节",
  no_chapters: "暂无章节。",
  open: "打开",
  export: "导出",
  export_desc: "导出全部章节为 DOCX/EPUB/PDF（优先 pandoc，否则使用降级转换）。",
  exporting: "导出中...",
  local_kb: "本地知识库",
  stored_locally: "本地存储（SQLite FTS）。",
  save_to_kb: "保存到 KB",
  search_kb: "搜索 KB",
  web_search: "联网搜索（Research）",
  web_search_desc: "搜索结果默认不入库，需手动导入到本地 KB。",
  web_search_disabled: "已在设置中关闭联网搜索工具。",
  import_to_kb: "导入到 KB",
  agents: "Agent 协作",
  agents_desc: "可视化多智能体执行轨迹（时间线 + 简易图）。",
  timeline: "时间线",
  graph: "图",
  events: "事件数",
  no_events: "暂无运行事件。请先在写作页运行一次流程。",
  execution_flow: "执行流",
  compressed_view: "压缩视图（相邻重复 agent 会合并）。",
  settings: "设置",
  settings_desc: "模型/Agent/API/知识库与界面偏好等设置。",
  secrets_status: "密钥状态",
  secrets_desc: "密钥来自环境变量或本地 api.txt（不会在 UI 中显示完整密钥）。",
  gpt_key: "GPT Key",
  gemini_key: "Gemini Key",
  present: "已配置",
  missing: "缺失",
  project_settings: "项目设置",
  select_project_first: "请先在写作页选择一个项目。",
  provider: "模型提供商",
  gpt_provider: "GPT（OpenAI-compatible）",
  gemini_provider: "Gemini",
  gpt_model: "GPT 模型",
  gpt_base_url: "GPT Base URL",
  gemini_model: "Gemini 模型",
  gemini_base_url: "Gemini Base URL",
  optional_use_api_txt: "可选：留空则使用 api.txt / 环境变量",
  temperature: "温度",
  max_tokens: "最大 tokens",
  chapter_words: "单章字数",
  chapter_count: "章节数",
  kb_mode: "KB 模式",
  kb_weak: "弱依赖（优先 KB）",
  kb_strong: "强依赖（canon-locked）",
  web_search_tool: "联网搜索工具",
  ui_prefs: "界面偏好",
  language: "语言",
  theme: "主题配色",
  theme_manage: "主题管理",
  add_theme: "新增主题",
  delete_theme: "删除主题",
  reset_themes: "重置为默认主题",
  theme_name: "主题名称",
  categories: "分类",
  add_category: "新增分类",
  role: "用途",
  category_name: "分类名称",
  color: "颜色",
  delete: "删除",
  run_history: "运行历史",
};

const EN: Record<I18nKey, string> = {
  app_name: "ai-writer",
  app_tagline: "Multi-agent novel workspace (MVP)",
  tab_writing: "Writing",
  tab_agents: "Agent Collaboration",
  tab_settings: "Settings",
  backend: "Backend",
  checking: "Checking...",
  ok: "OK",
  unreachable: "Unreachable",
  writing: "Writing",
  writing_desc: "Notion-like workspace (iterating).",
  projects: "Projects",
  project_title_placeholder: "Project title",
  create: "Create",
  no_projects: "No projects yet.",
  selected_project: "Selected Project",
  project_id: "Project ID",
  none: "None",
  run_demo: "Run Demo Pipeline",
  generate_outline: "Generate Outline",
  streams_to_agents: "Streams events and updates the Agents tab.",
  running: "Running...",
  write_chapter: "Write Chapter",
  chapter_index: "Chapter Index",
  research_query_optional: "Web research (optional)",
  write_chapter_llm: "Write Chapter (LLM)",
  uses_settings: "Uses Settings → model/KB/web search config.",
  continue_mode: "Continue Mode",
  continue_desc: "Paste text → extract StoryState → continue writing.",
  paste_manuscript: "Paste your manuscript...",
  extract_continue: "Extract + Continue",
  clear: "Clear",
  markdown_editor: "Markdown Editor",
  outline_latest: "Outline (latest)",
  no_outline: "No outline yet.",
  chapters: "Chapters",
  no_chapters: "No chapters yet.",
  open: "Open",
  export: "Export",
  export_desc:
    "Export all chapters to DOCX/EPUB/PDF (pandoc preferred; fallbacks available).",
  exporting: "Exporting...",
  local_kb: "Local Knowledge Base",
  stored_locally: "Stored locally (SQLite FTS).",
  save_to_kb: "Save to KB",
  search_kb: "Search KB",
  web_search: "Web Search (Research)",
  web_search_desc:
    "Results are not saved unless you import them into the local KB.",
  web_search_disabled: "Web search tool is disabled in Settings.",
  import_to_kb: "Import to KB",
  agents: "Agent Collaboration",
  agents_desc: "Visualize multi-agent traces (timeline + basic graph).",
  timeline: "Timeline",
  graph: "Graph",
  events: "Events",
  no_events: "No run events yet. Run a pipeline in the Writing tab.",
  execution_flow: "Execution Flow",
  compressed_view: "Compressed view (consecutive duplicates removed).",
  settings: "Settings",
  settings_desc: "Model/agent/api/tools and UI preferences.",
  secrets_status: "Secrets Status",
  secrets_desc:
    "Keys are loaded from environment variables or local api.txt (never shown).",
  gpt_key: "GPT key",
  gemini_key: "Gemini key",
  present: "present",
  missing: "missing",
  project_settings: "Project Settings",
  select_project_first: "Select a project first in the Writing tab.",
  provider: "Provider",
  gpt_provider: "GPT (OpenAI-compatible)",
  gemini_provider: "Gemini",
  gpt_model: "GPT Model",
  gpt_base_url: "GPT Base URL",
  gemini_model: "Gemini Model",
  gemini_base_url: "Gemini Base URL",
  optional_use_api_txt: "Optional (leave empty to use api.txt/env)",
  temperature: "Temperature",
  max_tokens: "Max tokens",
  chapter_words: "Chapter words",
  chapter_count: "Chapter count",
  kb_mode: "KB Mode",
  kb_weak: "Weak (prefer KB)",
  kb_strong: "Strong (canon-locked)",
  web_search_tool: "Web search tool",
  ui_prefs: "UI Preferences",
  language: "Language",
  theme: "Theme",
  theme_manage: "Theme manager",
  add_theme: "Add theme",
  delete_theme: "Delete theme",
  reset_themes: "Reset to defaults",
  theme_name: "Theme name",
  categories: "Categories",
  add_category: "Add category",
  role: "Role",
  category_name: "Name",
  color: "Color",
  delete: "Delete",
  run_history: "Run history",
};

export function t(lang: Lang, key: I18nKey): string {
  return (lang === "zh" ? ZH : EN)[key] ?? key;
}

