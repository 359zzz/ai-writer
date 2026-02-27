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
  | "idle"
  | "active_task"
  | "progress"
  | "error"
  | "writing"
  | "writing_desc"
  | "guide_title"
  | "guide_step_projects"
  | "guide_step_settings"
  | "guide_step_kb"
  | "guide_step_run"
  | "guide_step_export"
  | "guide_dismiss"
  | "writing_mode"
  | "writing_mode_create"
  | "writing_mode_continue"
  | "writing_mode_create_desc"
  | "writing_mode_continue_desc"
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
  | "research_query_desc"
  | "write_chapter_llm"
  | "uses_settings"
  | "continue_mode"
  | "continue_desc"
  | "continue_upload_file"
  | "continue_upload_button"
  | "continue_upload_desc"
  | "continue_extracting_file"
  | "continue_selected_file"
  | "continue_remove_file"
  | "continue_source_box"
  | "continue_source_desc"
  | "continue_selected_source"
  | "continue_excerpt_mode"
  | "continue_excerpt_tail"
  | "continue_excerpt_head"
  | "continue_excerpt_chars"
  | "continue_source_placeholder"
  | "continue_or_paste"
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
  | "api_keys"
  | "api_keys_hint"
  | "api_key_placeholder"
  | "save"
  | "secrets_save_not_found"
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
  | "gpt_wire_api"
  | "gpt_wire_chat"
  | "gpt_wire_responses"
  | "gpt_wire_desc"
  | "gemini_model"
  | "gemini_base_url"
  | "optional_use_api_txt"
  | "optional_use_backend_defaults"
  | "temperature"
  | "max_tokens"
  | "chapter_words"
  | "chapter_count"
  | "kb_mode"
  | "kb_weak"
  | "kb_strong"
  | "web_search_tool"
  | "web_search_provider"
  | "web_search_provider_auto"
  | "web_search_provider_bing"
  | "web_search_provider_duckduckgo"
  | "web_search_provider_desc"
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
  | "run_history"
  | "search"
  | "web_search_placeholder"
  | "research_query_placeholder"
  | "generated_markdown_placeholder"
  | "kb_chunk_title"
  | "kb_chunk_tags"
  | "kb_chunk_title_placeholder"
  | "kb_chunk_tags_placeholder"
  | "kb_chunk_content_placeholder"
  | "not_available_backend"
  | "no_runs"
  | "no_agents_in_events"
  | "score"
  | "accent"
  | "accent_text"
  | "view_edit"
  | "view_preview"
  | "view_split"
  | "preview_empty"
  | "theme_bg"
  | "theme_surface"
  | "theme_text"
  | "theme_muted"
  | "theme_control"
  | "theme_control_text"
  | "logo"
  | "background_image"
  | "upload_image"
  | "remove_image"
  | "opacity"
  | "blur"
  | "enabled"
  | "disabled"
  | "settings_nav_ui"
  | "settings_nav_model"
  | "settings_nav_project"
  | "settings_nav_export"
  | "settings_nav_debug";

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
  idle: "空闲",
  active_task: "正在执行",
  progress: "进度",
  error: "错误",
  writing: "写作",
  writing_desc: "Notion 风格工作台（持续增强中）。",
  guide_title: "快速上手",
  guide_step_projects: "左侧新建/选择项目",
  guide_step_settings: "在设置页选择模型并配置 API Key（本地保存 / 环境变量）",
  guide_step_kb: "（可选）右侧 Local KB 添加设定；Strong 模式更依赖 KB",
  guide_step_run: "在右侧面板运行：生成大纲 / 写章节 / 续写",
  guide_step_export: "写完后在 Export 导出 DOCX/EPUB/PDF",
  guide_dismiss: "不再提示",
  writing_mode: "写作模式",
  writing_mode_create: "创作",
  writing_mode_continue: "续写",
  writing_mode_create_desc: "从设定/大纲开始写新章节。",
  writing_mode_continue_desc: "粘贴已有文本，抽取信息后在此基础上续写。",
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
  research_query_desc:
    "在写章节/续写前先联网搜索一轮，并把简短结果作为上下文（不会自动写入 KB）。",
  write_chapter_llm: "写章节（LLM）",
  uses_settings: "使用 设置→模型/知识库/联网检索 等配置。",
  continue_mode: "续写模式",
  continue_desc: "粘贴已有文本 → 抽取 StoryState → 在此基础上续写。",
  continue_upload_file: "上传续写文件",
  continue_upload_button: "上传",
  continue_upload_desc:
    "支持 .txt/.docx/.pdf/.epub；会自动提取文本填入下方。",
  continue_extracting_file: "提取中...",
  continue_selected_file: "已选择",
  continue_remove_file: "移除",
  continue_source_box: "续写素材（拖拽/上传/粘贴）",
  continue_source_desc:
    "把文件拖进输入框 / 点击上传 / 直接粘贴文本或文件。大文件会保存到本地，只显示预览（不再回传全文）。",
  continue_selected_source: "已加载",
  continue_excerpt_mode: "预览/截断位置",
  continue_excerpt_tail: "尾部（推荐）",
  continue_excerpt_head: "开头",
  continue_excerpt_chars: "截断长度（字符）",
  continue_source_placeholder: "拖拽文件到这里，或点击上传，或直接粘贴文本/文件…",
  continue_or_paste: "或直接粘贴文本：",
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
  secrets_desc:
    "密钥来自环境变量 / 后端本地密钥存储（data/secrets.local.json，gitignored）/ api.txt 兼容（不会在 UI 中显示完整密钥）。",
  api_keys: "API Keys",
  api_keys_hint:
    "仅保存在本机后端（gitignored），不会回显完整 key；保存后输入框会清空。环境变量优先。",
  api_key_placeholder: "输入 API Key（不会回显）",
  save: "保存",
  secrets_save_not_found:
    "后端缺少 /api/secrets/set（可能正在运行旧版本）。请重启后端并确认 /api/health 版本 >= 1.2.10。",
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
  gpt_wire_api: "OpenAI 接口类型（wire API）",
  gpt_wire_chat: "chat/completions（兼容）",
  gpt_wire_responses: "responses（推荐）",
  gpt_wire_desc:
    "部分网关（例如 PackyAPI/Codex）更偏好 responses；如果你遇到 502/空返回，可切换为 responses。",
  gemini_model: "Gemini 模型",
  gemini_base_url: "Gemini Base URL",
  optional_use_api_txt: "可选：留空则使用 api.txt / 环境变量",
  optional_use_backend_defaults:
    "可选：留空则使用后端默认（环境变量 / 本地密钥 / api.txt 兼容）",
  temperature: "温度",
  max_tokens: "最大 tokens",
  chapter_words: "单章字数",
  chapter_count: "章节数",
  kb_mode: "KB 模式",
  kb_weak: "弱依赖（优先 KB）",
  kb_strong: "强依赖（canon-locked）",
  web_search_tool: "联网搜索工具",
  web_search_provider: "联网搜索提供商",
  web_search_provider_auto: "自动（推荐）",
  web_search_provider_bing: "Bing（无需 Key）",
  web_search_provider_duckduckgo: "DuckDuckGo",
  web_search_provider_desc:
    "某些网络环境下 DDG 可能超时；自动模式会优先尝试 Bing。",
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
  search: "搜索",
  web_search_placeholder: "输入联网检索关键词...",
  research_query_placeholder: "例如：唐代服饰细节",
  generated_markdown_placeholder: "生成的 Markdown 将显示在这里...",
  kb_chunk_title: "标题（可选）",
  kb_chunk_tags: "标签（可选）",
  kb_chunk_title_placeholder: "条目标题",
  kb_chunk_tags_placeholder: "标签（逗号分隔）",
  kb_chunk_content_placeholder: "在此添加世界观/文风/设定等笔记...",
  not_available_backend: "不可用（后端不可达？）",
  no_runs: "暂无运行记录",
  no_agents_in_events: "事件中未找到 agent 信息。",
  score: "相关度",
  accent: "强调色",
  accent_text: "强调色文字",
  view_edit: "编辑",
  view_preview: "预览",
  view_split: "分屏",
  preview_empty: "暂无内容",
  theme_bg: "背景色",
  theme_surface: "面板色",
  theme_text: "普通文字",
  theme_muted: "辅助文字",
  theme_control: "框底色",
  theme_control_text: "框内文字",
  logo: "Logo",
  background_image: "背景图片",
  upload_image: "上传图片",
  remove_image: "移除图片",
  opacity: "透明度",
  blur: "虚化",
  enabled: "启用",
  disabled: "关闭",
  settings_nav_ui: "界面偏好",
  settings_nav_model: "模型与工具",
  settings_nav_project: "项目设置",
  settings_nav_export: "导出",
  settings_nav_debug: "调试",
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
  idle: "Idle",
  active_task: "Active task",
  progress: "Progress",
  error: "Error",
  writing: "Writing",
  writing_desc: "Notion-like workspace (iterating).",
  guide_title: "Quick Start",
  guide_step_projects: "Create/select a project (left panel)",
  guide_step_settings:
    "Pick a model & set API keys in Settings (stored locally or via env vars)",
  guide_step_kb: "(Optional) Add lore/style to Local KB; Strong mode relies on KB",
  guide_step_run: "Run: outline / chapter / continue (right panel)",
  guide_step_export: "Export DOCX/EPUB/PDF from Export",
  guide_dismiss: "Dismiss",
  writing_mode: "Writing mode",
  writing_mode_create: "Create",
  writing_mode_continue: "Continue",
  writing_mode_create_desc: "Draft new chapters from your settings/outline.",
  writing_mode_continue_desc:
    "Paste an existing manuscript, extract state, then continue writing.",
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
  research_query_desc:
    "Runs a lightweight web search before writing and feeds short results as context (not saved to the KB).",
  write_chapter_llm: "Write Chapter (LLM)",
  uses_settings: "Uses Settings → model/KB/web search config.",
  continue_mode: "Continue Mode",
  continue_desc: "Paste text → extract StoryState → continue writing.",
  continue_upload_file: "Upload continue file",
  continue_upload_button: "Upload",
  continue_upload_desc:
    "Supports .txt/.docx/.pdf/.epub; extracted text will fill the box below.",
  continue_extracting_file: "Extracting...",
  continue_selected_file: "Selected",
  continue_remove_file: "Remove",
  continue_source_box: "Continue source (drop/upload/paste)",
  continue_source_desc:
    "Drop a file into the box / click Upload / paste text or a file. Large sources are stored locally and only a preview is shown (no full round-trip).",
  continue_selected_source: "Loaded",
  continue_excerpt_mode: "Excerpt position",
  continue_excerpt_tail: "Tail (recommended)",
  continue_excerpt_head: "Head",
  continue_excerpt_chars: "Excerpt length (chars)",
  continue_source_placeholder: "Drop a file here, click Upload, or paste text/file…",
  continue_or_paste: "Or paste text:",
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
    "Keys are loaded from env vars / backend local secrets (gitignored) / legacy api.txt (never shown in full).",
  api_keys: "API Keys",
  api_keys_hint:
    "Stored locally on the backend (gitignored) and never shown in full; inputs are cleared after saving. Env vars take precedence.",
  api_key_placeholder: "Enter API key (never shown back)",
  save: "Save",
  secrets_save_not_found:
    "Backend is missing /api/secrets/set (likely an older version). Restart the API and ensure /api/health version >= 1.2.10.",
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
  gpt_wire_api: "OpenAI wire API",
  gpt_wire_chat: "chat/completions (compat)",
  gpt_wire_responses: "responses (recommended)",
  gpt_wire_desc:
    "Some gateways (e.g. PackyAPI/Codex) prefer the Responses API. Switch to responses if you see 502/empty content.",
  gemini_model: "Gemini Model",
  gemini_base_url: "Gemini Base URL",
  optional_use_api_txt: "Optional (leave empty to use api.txt/env)",
  optional_use_backend_defaults:
    "Optional (leave empty to use backend defaults: env/local secrets/legacy api.txt)",
  temperature: "Temperature",
  max_tokens: "Max tokens",
  chapter_words: "Chapter words",
  chapter_count: "Chapter count",
  kb_mode: "KB Mode",
  kb_weak: "Weak (prefer KB)",
  kb_strong: "Strong (canon-locked)",
  web_search_tool: "Web search tool",
  web_search_provider: "Web search provider",
  web_search_provider_auto: "Auto (recommended)",
  web_search_provider_bing: "Bing (no key)",
  web_search_provider_duckduckgo: "DuckDuckGo",
  web_search_provider_desc:
    "DDG may time out in some networks; auto mode tries Bing first.",
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
  search: "Search",
  web_search_placeholder: "Search the web for research...",
  research_query_placeholder: "e.g. Tang dynasty clothing details",
  generated_markdown_placeholder: "Generated markdown will appear here...",
  kb_chunk_title: "Title (optional)",
  kb_chunk_tags: "Tags (optional)",
  kb_chunk_title_placeholder: "Chunk title",
  kb_chunk_tags_placeholder: "tags (comma-separated)",
  kb_chunk_content_placeholder: "Add lore/style/world notes here...",
  not_available_backend: "Not available (backend unreachable?)",
  no_runs: "No runs",
  no_agents_in_events: "No agents found in events.",
  score: "score",
  accent: "Accent",
  accent_text: "Accent text",
  view_edit: "Edit",
  view_preview: "Preview",
  view_split: "Split",
  preview_empty: "(empty)",
  theme_bg: "Background",
  theme_surface: "Surface",
  theme_text: "Text",
  theme_muted: "Muted text",
  theme_control: "Control bg",
  theme_control_text: "Control text",
  logo: "Logo",
  background_image: "Background image",
  upload_image: "Upload",
  remove_image: "Remove",
  opacity: "Opacity",
  blur: "Blur",
  enabled: "Enabled",
  disabled: "Disabled",
  settings_nav_ui: "UI Preferences",
  settings_nav_model: "Model & Tools",
  settings_nav_project: "Project",
  settings_nav_export: "Export",
  settings_nav_debug: "Debug",
};

export function t(lang: Lang, key: I18nKey): string {
  return (lang === "zh" ? ZH : EN)[key] ?? key;
}
