"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { MarkdownPreview } from "@/components/MarkdownPreview";
import {
  OutlineGraphEditor,
  type OutlineEdgeData,
  type OutlineGraph,
  type OutlineNodeData,
} from "@/components/OutlineGraphEditor";
import { t, type I18nKey, type Lang } from "@/lib/i18n";
import {
  DEFAULT_THEMES,
  DEFAULT_UI_PREFS,
  applyUiTheme,
  loadUiPrefs,
  normalizeHexColor,
  saveUiPrefs,
  type UiTheme,
} from "@/lib/uiPrefs";

type TabKey = "create" | "continue" | "agents" | "settings";

type Health = {
  ok: boolean;
  service?: string;
  version?: string;
};

type Project = {
  id: string;
  title: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type SecretsStatus = {
  openai_api_key_present: boolean;
  openai_base_url_present: boolean;
  openai_model_present: boolean;
  gemini_api_key_present: boolean;
  gemini_model_present: boolean;
  gemini_base_url_present: boolean;
};

type ChapterItem = {
  id: string;
  project_id: string;
  chapter_index: number;
  title: string;
  markdown: string;
  created_at: string;
  updated_at: string;
};

type RunItem = {
  id: string;
  project_id: string;
  kind: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  error: string | null;
};

type OutlineChapter = {
  id?: string;
  index: number;
  title: string;
  summary?: string;
  goal?: string;
};

type OutlineBlock = {
  id: string;
  index: number;
  title: string;
  summary?: string;
  goal?: string;
};

type KBChunkItem = {
  id: number;
  project_id: string;
  source_type: string;
  title: string;
  content: string;
  tags: string;
  created_at: string;
};

type BookIndexChunk = {
  index: number;
  start_char: number;
  end_char: number;
  chars: number;
  preview_head: string;
  preview_tail: string;
};

type BookIndexResult = {
  source_id: string;
  meta: Record<string, unknown>;
  params: {
    chunk_chars: number;
    overlap_chars: number;
    max_chunks: number;
    preview_chars: number;
  };
  chunks: BookIndexChunk[];
  total_chunks: number;
  truncated: boolean;
};

type BookSummarizeStats = {
  source_id: string;
  filename?: string;
  processed: number;
  created: number;
  failed: number;
  params?: Record<string, unknown>;
};

type BookStateArtifact = {
  source_id: string;
  kb_chunk_id: number;
  state: unknown;
  preview?: string;
};

const PROJECT_ORDER_KEY = "ai-writer:project_order:v1";

function loadProjectOrder(): string[] {
  try {
    const raw = localStorage.getItem(PROJECT_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function saveProjectOrder(order: string[]) {
  try {
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(order));
  } catch {
    // ignore
  }
}

function applyProjectOrder(list: Project[]): Project[] {
  const order = loadProjectOrder();
  const uniqOrder = Array.from(new Set(order));
  const byId = new Map(list.map((p) => [p.id, p]));
  const ordered: Project[] = [];
  for (const id of uniqOrder) {
    const p = byId.get(id);
    if (p) ordered.push(p);
  }
  const remaining = list
    .filter((p) => !uniqOrder.includes(p.id))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const merged = [...ordered, ...remaining];
  saveProjectOrder(merged.map((p) => p.id));
  return merged;
}

function moveById<T extends { id: string }>(
  list: T[],
  movingId: string,
  beforeId: string,
): T[] {
  const from = list.findIndex((x) => x.id === movingId);
  const to = list.findIndex((x) => x.id === beforeId);
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  const insertAt = from < to ? to - 1 : to;
  next.splice(insertAt, 0, item);
  return next;
}

function moveByNumId<T extends { id: number }>(
  list: T[],
  movingId: number,
  beforeId: number,
): T[] {
  const from = list.findIndex((x) => x.id === movingId);
  const to = list.findIndex((x) => x.id === beforeId);
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  const insertAt = from < to ? to - 1 : to;
  next.splice(insertAt, 0, item);
  return next;
}

function normalizeOutline(raw: OutlineChapter[]): OutlineChapter[] {
  const cleaned = raw
    .map((c) => ({
      id:
        typeof c.id === "string" && c.id.trim().length > 0 ? c.id.trim() : undefined,
      index: Number.isFinite(c.index) && c.index >= 1 ? Math.floor(c.index) : 0,
      title: String(c.title ?? "").trim(),
      summary: typeof c.summary === "string" ? c.summary.trim() : undefined,
      goal: typeof c.goal === "string" ? c.goal.trim() : undefined,
    }))
    .filter((c) => c.title.length > 0);

  if (cleaned.length === 0) return [];

  const hasValidUniqueIndexes = (() => {
    const idxs = cleaned.map((c) => c.index).filter((x) => x >= 1);
    if (idxs.length !== cleaned.length) return false;
    const uniq = new Set(idxs);
    return uniq.size === idxs.length;
  })();

  if (hasValidUniqueIndexes) return cleaned;

  return cleaned.map((c, i) => ({ ...c, index: i + 1 }));
}

function makeOutlineId(): string {
  try {
    // Available in modern browsers.
    return crypto.randomUUID();
  } catch {
    return `ol_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function reindexOutlineBlocks(list: OutlineBlock[]): OutlineBlock[] {
  return list.map((c, i) => ({ ...c, index: i + 1 }));
}

function toOutlineBlocks(list: OutlineChapter[]): OutlineBlock[] {
  const blocks: OutlineBlock[] = [];
  for (const c of list) {
    const title = typeof c.title === "string" ? c.title.trim() : "";
    if (!title) continue;
    blocks.push({
      id:
        typeof c.id === "string" && c.id.trim().length > 0
          ? c.id.trim()
          : makeOutlineId(),
      index: Number.isFinite(c.index) && c.index >= 1 ? Math.floor(c.index) : 0,
      title,
      summary: typeof c.summary === "string" ? c.summary : undefined,
      goal: typeof c.goal === "string" ? c.goal : undefined,
    });
  }
  // Persisted indexes can be non-sequential after edits/import; normalize for UI.
  return reindexOutlineBlocks(blocks);
}

function loadOutlineBlocksFromProject(p: Project | null): OutlineBlock[] {
  const settings = p?.settings as Record<string, unknown> | undefined;
  const story = settings?.story as Record<string, unknown> | undefined;
  const raw = story?.outline;
  const items = Array.isArray(raw) ? raw : [];
  const chapters: OutlineChapter[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const idx = Number(rec.index);
    const title = typeof rec.title === "string" ? rec.title : "";
    if (!title.trim()) continue;
    chapters.push({
      id: typeof rec.id === "string" ? rec.id : undefined,
      index: Number.isFinite(idx) ? idx : 0,
      title: title.trim(),
      summary: typeof rec.summary === "string" ? rec.summary : undefined,
      goal: typeof rec.goal === "string" ? rec.goal : undefined,
    });
  }
  return toOutlineBlocks(normalizeOutline(chapters));
}

function coerceOutlineGraph(raw: unknown): OutlineGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const nodesRaw = Array.isArray(rec.nodes) ? rec.nodes : [];
  const edgesRaw = Array.isArray(rec.edges) ? rec.edges : [];

  const nodes: Array<{
    id: string;
    type?: string;
    position: { x: number; y: number };
    data: OutlineNodeData;
  }> = [];
  for (const it of nodesRaw) {
    if (!it || typeof it !== "object") continue;
    const n = it as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id : "";
    const pos = n.position as Record<string, unknown> | undefined;
    const x = Number(pos?.x);
    const y = Number(pos?.y);
    const data = n.data as Record<string, unknown> | undefined;
    const kind = typeof data?.kind === "string" ? data.kind : "";
    const title = typeof data?.title === "string" ? data.title : "";
    if (!id || !Number.isFinite(x) || !Number.isFinite(y) || !kind || !title) continue;
    nodes.push({
      id,
      type: typeof n.type === "string" ? n.type : "outlineNode",
      position: { x, y },
      data: {
        kind: kind as OutlineNodeData["kind"],
        title,
        text: typeof data?.text === "string" ? data.text : undefined,
        summary: typeof data?.summary === "string" ? data.summary : undefined,
        goal: typeof data?.goal === "string" ? data.goal : undefined,
        order: Number.isFinite(Number(data?.order)) ? Number(data?.order) : undefined,
      },
    });
  }

  const edges: Array<{
    id: string;
    source: string;
    target: string;
    type?: string;
    data?: OutlineEdgeData;
    label?: string;
  }> = [];
  for (const it of edgesRaw) {
    if (!it || typeof it !== "object") continue;
    const e = it as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const source = typeof e.source === "string" ? e.source : "";
    const target = typeof e.target === "string" ? e.target : "";
    if (!id || !source || !target) continue;
    const data = e.data as Record<string, unknown> | undefined;
    const kind = typeof data?.kind === "string" ? data.kind : undefined;
    const label = typeof (data?.label ?? e.label) === "string" ? String(data?.label ?? e.label) : undefined;
    edges.push({
      id,
      source,
      target,
      type: typeof e.type === "string" ? e.type : "smoothstep",
      data: kind ? ({ kind, label } as OutlineEdgeData) : undefined,
      label,
    });
  }

  if (nodes.length === 0) return null;
  return {
    version: 1,
    nodes: nodes as unknown as OutlineGraph["nodes"],
    edges: edges as unknown as OutlineGraph["edges"],
  };
}

function loadOutlineGraphFromProject(p: Project | null): OutlineGraph | null {
  const settings = p?.settings as Record<string, unknown> | undefined;
  const story = settings?.story as Record<string, unknown> | undefined;
  const raw = story?.outline_graph as unknown;
  return coerceOutlineGraph(raw);
}

function outlineGraphFromBlocks(blocks: OutlineBlock[]): OutlineGraph {
  const nodes = blocks.map((b, i) => ({
    id: b.id,
    type: "outlineNode",
    position: { x: 40, y: 40 + i * 140 },
    data: {
      kind: "chapter",
      title: b.title,
      summary: b.summary,
      goal: b.goal,
      order: i + 1,
    } satisfies OutlineNodeData,
  }));
  const edges = nodes.slice(1).map((n, i) => ({
    id: `e_${nodes[i].id}_${n.id}_next`,
    source: nodes[i].id,
    target: n.id,
    type: "smoothstep",
    data: { kind: "next" } satisfies OutlineEdgeData,
  }));
  return {
    version: 1,
    nodes: nodes as unknown as OutlineGraph["nodes"],
    edges: edges as unknown as OutlineGraph["edges"],
  };
}

function outlineBlocksFromGraph(graph: OutlineGraph): OutlineBlock[] {
  const chapters = (graph.nodes ?? []).filter((n) => n?.data?.kind === "chapter");
  const sorted = [...chapters].sort((a, b) => {
    const ao = Number(a.data?.order);
    const bo = Number(b.data?.order);
    const aHas = Number.isFinite(ao) && ao > 0;
    const bHas = Number.isFinite(bo) && bo > 0;
    if (aHas && bHas) return ao - bo;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    const ay = Number((a.position as { x: number; y: number } | undefined)?.y ?? 0);
    const by = Number((b.position as { x: number; y: number } | undefined)?.y ?? 0);
    if (ay !== by) return ay - by;
    const ax = Number((a.position as { x: number; y: number } | undefined)?.x ?? 0);
    const bx = Number((b.position as { x: number; y: number } | undefined)?.x ?? 0);
    return ax - bx;
  });

  const out: OutlineBlock[] = [];
  for (const n of sorted) {
    const title = String(n.data?.title ?? "").trim();
    if (!title) continue;
    out.push({
      id: n.id,
      index: 0,
      title,
      summary: typeof n.data?.summary === "string" ? n.data.summary : undefined,
      goal: typeof n.data?.goal === "string" ? n.data.goal : undefined,
    });
  }
  return reindexOutlineBlocks(out);
}

export default function Home() {
  const [uiLoaded, setUiLoaded] = useState<boolean>(false);
  const [lang, setLang] = useState<Lang>(DEFAULT_UI_PREFS.lang);
  const [themes, setThemes] = useState<UiTheme[]>(DEFAULT_UI_PREFS.themes);
  const [themeId, setThemeId] = useState<string>(DEFAULT_UI_PREFS.theme_id);
  const [uiBackground, setUiBackground] = useState(
    DEFAULT_UI_PREFS.background,
  );
  const [brandLogoDataUrl, setBrandLogoDataUrl] = useState<string | null>(
    DEFAULT_UI_PREFS.brand.logo_data_url,
  );

  const [tab, setTab] = useState<TabKey>("create");
  const [createPane, setCreatePane] = useState<
    "projects" | "background" | "outline" | "writing"
  >("writing");
  const [continuePane, setContinuePane] = useState<"article" | "book">("article");
  const [showQuickStart, setShowQuickStart] = useState<boolean>(false);
  const [agentsView, setAgentsView] = useState<"timeline" | "graph">("timeline");
  const [expandedEventKey, setExpandedEventKey] = useState<string | null>(null);
  const [settingsPane, setSettingsPane] = useState<
    "ui" | "model" | "project" | "export" | "debug"
  >("ui");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [newProjectTitle, setNewProjectTitle] = useState<string>(
    DEFAULT_UI_PREFS.lang === "zh" ? "我的小说" : "My Novel",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [secretsStatus, setSecretsStatus] = useState<SecretsStatus | null>(null);
  const [openaiApiKeyDraft, setOpenaiApiKeyDraft] = useState<string>("");
  const [geminiApiKeyDraft, setGeminiApiKeyDraft] = useState<string>("");
  const [secretsSaving, setSecretsSaving] = useState<boolean>(false);
  const [secretsSaveError, setSecretsSaveError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState<boolean>(false);
  const pendingSecretsSaveRef = useRef<Promise<void> | null>(null);
  const pendingProjectSettingsSaveRef = useRef<Promise<void> | null>(null);
  const outlineFileInputRef = useRef<HTMLInputElement | null>(null);
  const outlineMindmapFileInputRef = useRef<HTMLInputElement | null>(null);
  const bookFileInputRef = useRef<HTMLInputElement | null>(null);
  const [runEvents, setRunEvents] = useState<
    Array<{
      run_id: string;
      seq: number;
      ts: string;
      type: string;
      agent: string | null;
      data: Record<string, unknown>;
    }>
  >([]);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runInProgress, setRunInProgress] = useState<boolean>(false);
  const [activeRunKind, setActiveRunKind] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [generatedMarkdown, setGeneratedMarkdown] = useState<string>("");
  const [editorView, setEditorView] = useState<"split" | "edit" | "preview">(
    "split",
  );
  const [outline, setOutline] = useState<unknown>(null);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [chapterIndex, setChapterIndex] = useState<number>(1);
  const [writeChapterCount, setWriteChapterCount] = useState<number>(1);
  const [batchWriting, setBatchWriting] = useState<
    | {
        status: "running" | "stopping" | "stopped" | "failed" | "completed";
        startIndex: number;
        total: number;
        done: number;
        lastError?: string;
      }
    | null
  >(null);
  const batchStopRequestedRef = useRef<boolean>(false);
  const [batchContinuing, setBatchContinuing] = useState<
    | {
        status: "running" | "stopping" | "stopped" | "failed" | "completed";
        kind: "continue" | "book_continue";
        sourceId: string;
        startIndex: number;
        total: number;
        done: number;
        lastError?: string;
      }
    | null
  >(null);
  const batchContinueStopRequestedRef = useRef<boolean>(false);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [draggingChapterId, setDraggingChapterId] = useState<string | null>(null);
  const [researchQuery, setResearchQuery] = useState<string>("");
  // Continue Mode input can be either:
  // - A stored local source_id (recommended for large files)
  // - A small pasted/typed text (which we will store to backend on-demand)
  const [continueSourceId, setContinueSourceId] = useState<string | null>(null);
  const [continueSourceMeta, setContinueSourceMeta] = useState<
    { filename?: string; chars?: number } | null
  >(null);
  const [continueInputText, setContinueInputText] = useState<string>("");
  const [continueSourceLoading, setContinueSourceLoading] = useState<boolean>(false);
  const [continueSourceError, setContinueSourceError] = useState<string | null>(null);
  const [continueSourceToken, setContinueSourceToken] = useState<number>(0);
  const [continueExcerptMode, setContinueExcerptMode] = useState<"head" | "tail">(
    "tail",
  );
  const [continueExcerptChars, setContinueExcerptChars] = useState<number>(8000);
  const [continueDropActive, setContinueDropActive] = useState<boolean>(false);
  const [continueRunKind, setContinueRunKind] = useState<
    "continue" | "book_continue"
  >("continue");
  // Book Continue (scaffold): file upload first, store as a local continue_source.
  const [bookSourceId, setBookSourceId] = useState<string | null>(null);
  const [bookSourceMeta, setBookSourceMeta] = useState<
    { filename?: string; chars?: number } | null
  >(null);
  const [bookInputText, setBookInputText] = useState<string>("");
  const [bookSourceLoading, setBookSourceLoading] = useState<boolean>(false);
  const [bookSourceError, setBookSourceError] = useState<string | null>(null);
  const [bookSourceToken, setBookSourceToken] = useState<number>(0);
  const [bookDropActive, setBookDropActive] = useState<boolean>(false);
  const [bookChunkChars, setBookChunkChars] = useState<number>(6000);
  const [bookOverlapChars, setBookOverlapChars] = useState<number>(400);
  const [bookMaxChunks, setBookMaxChunks] = useState<number>(200);
  const [bookIndexLoading, setBookIndexLoading] = useState<boolean>(false);
  const [bookIndexError, setBookIndexError] = useState<string | null>(null);
  const [bookIndex, setBookIndex] = useState<BookIndexResult | null>(null);
  const [bookSummarizeReplaceExisting, setBookSummarizeReplaceExisting] =
    useState<boolean>(true);
  const [bookSummarizeStats, setBookSummarizeStats] =
    useState<BookSummarizeStats | null>(null);
  const [bookState, setBookState] = useState<BookStateArtifact | null>(null);
  const [outlinePaneError, setOutlinePaneError] = useState<string | null>(null);
  const [outlineDraft, setOutlineDraft] = useState<OutlineBlock[]>([]);
  const [outlineDraftProjectId, setOutlineDraftProjectId] = useState<string | null>(
    null,
  );
  const [outlineDirty, setOutlineDirty] = useState<boolean>(false);
  const [draggingOutlineId, setDraggingOutlineId] = useState<string | null>(null);
  const [outlineEditorMode, setOutlineEditorMode] = useState<
    "blocks" | "mindmap"
  >("blocks");
  const [outlineGraphDraft, setOutlineGraphDraft] = useState<OutlineGraph | null>(
    null,
  );
  const [outlineGraphProjectId, setOutlineGraphProjectId] = useState<
    string | null
  >(null);
  const [outlineGraphDirty, setOutlineGraphDirty] = useState<boolean>(false);
  // Local KB chunk fields. Keep defaults empty to avoid confusing users
  // with pre-filled values like "设定" in multiple inputs.
  const [kbTitle, setKbTitle] = useState<string>("");
  const [kbTags, setKbTags] = useState<string>("");
  const [kbContent, setKbContent] = useState<string>("");
  const [kbQuery, setKbQuery] = useState<string>("");
  const [kbResults, setKbResults] = useState<
    Array<{ id: number; title: string; content: string; score: number }>
  >([]);
  const [kbError, setKbError] = useState<string | null>(null);
  const [kbChunks, setKbChunks] = useState<KBChunkItem[]>([]);
  const [kbChunksError, setKbChunksError] = useState<string | null>(null);
  const [kbEditingId, setKbEditingId] = useState<number | null>(null);
  const [kbSelectedIds, setKbSelectedIds] = useState<number[]>([]);
  const [kbExportFormat, setKbExportFormat] = useState<"json" | "txt">("json");
  const [draggingKbId, setDraggingKbId] = useState<number | null>(null);
  const [webQuery, setWebQuery] = useState<string>("");
  const [webResults, setWebResults] = useState<
    Array<{ title: string; url: string; snippet: string }>
  >([]);
  const [webError, setWebError] = useState<string | null>(null);
  const [webLoading, setWebLoading] = useState<boolean>(false);
  const [exportFormat, setExportFormat] = useState<"docx" | "epub" | "pdf">(
    "docx",
  );
  const [exporting, setExporting] = useState<boolean>(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const writingMode: "create" | "continue" =
    tab === "continue" ? "continue" : "create";

  const apiBase = useMemo(() => {
    return process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  }, []);

  const tt = (key: I18nKey) => t(lang, key);

  const formatEventType = (type: string): string => {
    if (lang !== "zh") return type;
    const map: Record<string, string> = {
      run_started: "运行开始",
      run_completed: "运行结束",
      run_error: "运行错误",
      agent_started: "Agent 开始",
      agent_finished: "Agent 结束",
      agent_output: "Agent 输出",
      tool_call: "工具调用",
      tool_result: "工具结果",
      artifact: "产物",
    };
    return map[type] ?? type;
  };

  const formatAgentName = (agent: string): string => {
    if (lang !== "zh") return agent;
    const map: Record<string, string> = {
      Director: "导演",
      ConfigAutofill: "设定补全",
      Outliner: "大纲",
      Writer: "写手",
      Editor: "编辑",
      LoreKeeper: "设定校对",
      Extractor: "抽取器",
      Researcher: "检索",
      WebSearch: "联网搜索",
      Retriever: "检索器",
      BookSummarizer: "书籍总结",
      BookCompiler: "书籍编译",
      BookContinue: "书籍续写准备",
      BookPlanner: "书籍续写规划",
    };
    const zh = map[agent];
    return zh ? `${zh}（${agent}）` : agent;
  };

  const agentColor = (agent: string | null): string => {
    const a = (agent ?? "").trim();
    const palette: Record<string, string> = {
      Director: "#8B5CF6",
      ConfigAutofill: "#22C55E",
      Outliner: "#0EA5E9",
      Writer: "#EF4444",
      Editor: "#F59E0B",
      LoreKeeper: "#10B981",
      Extractor: "#6366F1",
      Researcher: "#06B6D4",
      WebSearch: "#64748B",
      Retriever: "#64748B",
      BookSummarizer: "#A855F7",
      BookCompiler: "#06B6D4",
      BookContinue: "#7C3AED",
      BookPlanner: "#EC4899",
    };
    return palette[a] ?? "rgba(120,120,120,0.35)";
  };

  const formatRunStatus = (status: string): string => {
    if (lang !== "zh") return status;
    const map: Record<string, string> = {
      running: "运行中",
      completed: "完成",
      failed: "失败",
    };
    return map[status] ?? status;
  };

  const formatRunKind = (kind: string): string => {
    if (lang !== "zh") return kind;
    const map: Record<string, string> = {
      demo: "示例",
      outline: "大纲",
      chapter: "章节",
      continue: "续写",
      book_summarize: "书籍总结入库",
      book_compile: "书籍编译",
      book_continue: "书籍续写",
    };
    return map[kind] ?? kind;
  };

  const formatDurationMs = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return "0s";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m${s}s`;
  };

  const clipText = (input: string, maxLen: number): string => {
    const s = input.trim();
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen).trimEnd()}...`;
  };

  const fileToCompressedDataUrl = async (
    file: File,
    opts: { maxSize: number; quality: number },
  ): Promise<string> => {
    const readAsDataUrl = (f: File) =>
      new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error("file_read_failed"));
        r.onload = () => resolve(String(r.result ?? ""));
        r.readAsDataURL(f);
      });

    const raw = await readAsDataUrl(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image_decode_failed"));
        img.src = raw;
      });

      const maxSide = Math.max(img.width, img.height);
      const scale =
        maxSide > opts.maxSize ? opts.maxSize / Math.max(1, maxSide) : 1;
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return raw;
      ctx.drawImage(img, 0, 0, w, h);

      // Use JPEG for size control. (LocalStorage has a quota; keep images small.)
      return canvas.toDataURL("image/jpeg", opts.quality);
    } catch {
      return raw;
    }
  };

  useEffect(() => {
    const prefs = loadUiPrefs();
    setLang(prefs.lang);
    setThemes(prefs.themes);
    setThemeId(prefs.theme_id);
    setUiBackground(prefs.background);
    setBrandLogoDataUrl(prefs.brand.logo_data_url);
    setUiLoaded(true);
  }, []);

  useEffect(() => {
    try {
      const dismissed = localStorage.getItem("ai-writer:quickstart:dismissed");
      setShowQuickStart(dismissed !== "1");
    } catch {
      setShowQuickStart(true);
    }
  }, []);

  useEffect(() => {
    const active = themes.find((th) => th.id === themeId) ?? themes[0];
    if (!active) return;
    applyUiTheme(active);
  }, [themeId, themes]);

  useEffect(() => {
    if (!uiLoaded) return;
    saveUiPrefs({
      version: 2,
      lang,
      theme_id: themeId,
      themes,
      background: uiBackground,
      brand: { logo_data_url: brandLogoDataUrl },
    });
  }, [uiLoaded, lang, themeId, themes, uiBackground, brandLogoDataUrl]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    // Avoid mixed-language defaults in inputs when toggling UI language.
    setNewProjectTitle((prev) => {
      if (prev !== "My Novel" && prev !== "我的小说") return prev;
      return lang === "zh" ? "我的小说" : "My Novel";
    });
    setKbTitle((prev) => {
      if (prev !== "Lore" && prev !== "设定") return prev;
      return lang === "zh" ? "设定" : "Lore";
    });
    setKbTags((prev) => {
      if (prev !== "lore" && prev !== "设定") return prev;
      return lang === "zh" ? "设定" : "lore";
    });
  }, [lang]);

  const refreshContinuePreview = useCallback(
    async (sourceId: string) => {
      const res = await fetch(
        `${apiBase}/api/tools/continue_sources/${encodeURIComponent(sourceId)}/preview?mode=${encodeURIComponent(continueExcerptMode)}&limit_chars=${encodeURIComponent(String(continueExcerptChars))}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { detail?: unknown };
          if (typeof parsed?.detail === "string") detail = parsed.detail;
        } catch {
          // ignore
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        text?: unknown;
        meta?: { filename?: unknown; chars?: unknown };
      };
      const text = typeof data.text === "string" ? data.text : "";
      setContinueInputText(text);
      const filename =
        typeof data.meta?.filename === "string" ? data.meta.filename : undefined;
      const chars = typeof data.meta?.chars === "number" ? data.meta.chars : undefined;
      setContinueSourceMeta({ filename, chars });
    },
    [apiBase, continueExcerptMode, continueExcerptChars],
  );

  useEffect(() => {
    if (!continueSourceId) return;
    if (continueSourceLoading) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      refreshContinuePreview(continueSourceId)
        .then(() => {
          if (!cancelled) setContinueSourceError(null);
        })
        .catch((e) => {
          if (!cancelled) setContinueSourceError((e as Error).message);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [continueSourceId, continueSourceLoading, refreshContinuePreview]);

  const refreshBookContinuePreview = useCallback(
    async (sourceId: string) => {
      const res = await fetch(
        `${apiBase}/api/tools/continue_sources/${encodeURIComponent(sourceId)}/preview?mode=${encodeURIComponent(continueExcerptMode)}&limit_chars=${encodeURIComponent(String(continueExcerptChars))}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { detail?: unknown };
          if (typeof parsed?.detail === "string") detail = parsed.detail;
        } catch {
          // ignore
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        text?: unknown;
        meta?: { filename?: unknown; chars?: unknown };
      };
      const text = typeof data.text === "string" ? data.text : "";
      setBookInputText(text);
      const filename =
        typeof data.meta?.filename === "string" ? data.meta.filename : undefined;
      const chars = typeof data.meta?.chars === "number" ? data.meta.chars : undefined;
      setBookSourceMeta({ filename, chars });
    },
    [apiBase, continueExcerptMode, continueExcerptChars],
  );

  useEffect(() => {
    if (!bookSourceId) return;
    if (bookSourceLoading) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      refreshBookContinuePreview(bookSourceId)
        .then(() => {
          if (!cancelled) setBookSourceError(null);
        })
        .catch((e) => {
          if (!cancelled) setBookSourceError((e as Error).message);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bookSourceId, bookSourceLoading, refreshBookContinuePreview]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        setHealthError(null);
        const res = await fetch(`${apiBase}/api/health`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Health;
        if (!cancelled) setHealth(data);
      } catch (e) {
        if (!cancelled) setHealthError((e as Error).message);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        setProjectsError(null);
        const res = await fetch(`${apiBase}/api/projects`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Project[];
        if (cancelled) return;
        const sorted = applyProjectOrder(data);
        setProjects(sorted);
        if (!selectedProjectId && sorted.length > 0) {
          setSelectedProjectId(sorted[0].id);
        }
      } catch (e) {
        if (!cancelled) setProjectsError((e as Error).message);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [apiBase, selectedProjectId]);

  const selectedProject = useMemo(() => {
    if (!selectedProjectId) return null;
    return projects.find((p) => p.id === selectedProjectId) ?? null;
  }, [projects, selectedProjectId]);

  const outlineChapters = useMemo((): OutlineChapter[] | null => {
    const coerce = (raw: unknown): OutlineChapter[] | null => {
      if (!Array.isArray(raw)) return null;
      const out: OutlineChapter[] = [];
      for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const idx = Number(rec.index);
        const id = typeof rec.id === "string" ? rec.id : undefined;
        const title = typeof rec.title === "string" ? rec.title : "";
        if (!Number.isFinite(idx) || !title.trim()) continue;
        out.push({
          id,
          index: idx,
          title: title.trim(),
          summary: typeof rec.summary === "string" ? rec.summary : undefined,
          goal: typeof rec.goal === "string" ? rec.goal : undefined,
        });
      }
      return out.length > 0 ? out : null;
    };

    // Prefer the latest outline artifact from the last run (if present).
    if (outline && typeof outline === "object") {
      const o = outline as Record<string, unknown>;
      const fromRun = coerce(o.chapters);
      if (fromRun) return fromRun;
    }

    // Fallback to the persisted project settings (story.outline).
    const settings = selectedProject?.settings as Record<string, unknown> | undefined;
    const story = settings?.story as Record<string, unknown> | undefined;
    const fromSettings = coerce(story?.outline);
    if (fromSettings) return fromSettings;

    return null;
  }, [outline, selectedProject]);

  useEffect(() => {
    // Keep the outline editor draft bound to the selected project settings.
    if (!selectedProjectId) {
      setOutlineDraft([]);
      setOutlineDraftProjectId(null);
      setOutlineDirty(false);
      setDraggingOutlineId(null);
      setOutlinePaneError(null);
      return;
    }

    // When switching projects, always load the new project's outline draft.
    if (outlineDraftProjectId !== selectedProjectId) {
      setOutlineDraft(loadOutlineBlocksFromProject(selectedProject));
      setOutlineDraftProjectId(selectedProjectId);
      setOutlineDirty(false);
      setDraggingOutlineId(null);
      setOutlinePaneError(null);
      return;
    }

    // When in the Outline pane and not editing, refresh draft from saved settings
    // (e.g. after importing outline JSON/TXT).
    if (tab === "create" && createPane === "outline" && !outlineDirty) {
      setOutlineDraft(loadOutlineBlocksFromProject(selectedProject));
      setOutlinePaneError(null);
    }
  }, [
    tab,
    createPane,
    selectedProjectId,
    selectedProject,
    outlineDraftProjectId,
    outlineDirty,
  ]);

  useEffect(() => {
    // Keep the outline mindmap draft bound to the selected project settings.
    if (!selectedProjectId) {
      setOutlineGraphDraft(null);
      setOutlineGraphProjectId(null);
      setOutlineGraphDirty(false);
      return;
    }

    if (outlineGraphProjectId !== selectedProjectId) {
      setOutlineGraphDraft(loadOutlineGraphFromProject(selectedProject));
      setOutlineGraphProjectId(selectedProjectId);
      setOutlineGraphDirty(false);
      return;
    }

    if (tab === "create" && createPane === "outline" && outlineEditorMode === "mindmap" && !outlineGraphDirty) {
      setOutlineGraphDraft(loadOutlineGraphFromProject(selectedProject));
    }
  }, [
    tab,
    createPane,
    outlineEditorMode,
    selectedProjectId,
    selectedProject,
    outlineGraphProjectId,
    outlineGraphDirty,
  ]);

  useEffect(() => {
    setRuns([]);
    setSelectedRunId(null);
    setRunEvents([]);
    setExpandedEventKey(null);
  }, [selectedProjectId]);

  const agentFlow = useMemo(() => {
    const seq = runEvents
      .map((e) => e.agent)
      .filter((a): a is string => typeof a === "string" && a.trim().length > 0);
    const compressed: string[] = [];
    for (const a of seq) {
      if (compressed.length === 0 || compressed[compressed.length - 1] !== a) {
        compressed.push(a);
      }
    }
    return compressed;
  }, [runEvents]);

  const agentStats = useMemo(() => {
    type Stats = {
      total_ms: number;
      starts: number;
      finishes: number;
      tool_calls: number;
      tool_results: number;
      outputs: number;
      artifacts: number;
    };
    const stats: Record<string, Stats> = {};
    const open: Record<string, number[]> = {};

    for (const e of runEvents) {
      const agent = typeof e.agent === "string" ? e.agent.trim() : "";
      if (!agent) continue;
      const st =
        stats[agent] ??
        (stats[agent] = {
          total_ms: 0,
          starts: 0,
          finishes: 0,
          tool_calls: 0,
          tool_results: 0,
          outputs: 0,
          artifacts: 0,
        });

      if (e.type === "agent_started") {
        const ts = Date.parse(e.ts);
        if (Number.isFinite(ts)) (open[agent] ??= []).push(ts);
        st.starts += 1;
      } else if (e.type === "agent_finished") {
        const ts = Date.parse(e.ts);
        const startTs = (open[agent] ?? []).pop();
        if (
          Number.isFinite(ts) &&
          typeof startTs === "number" &&
          Number.isFinite(startTs) &&
          ts >= startTs
        ) {
          st.total_ms += ts - startTs;
        }
        st.finishes += 1;
      } else if (e.type === "tool_call") {
        st.tool_calls += 1;
      } else if (e.type === "tool_result") {
        st.tool_results += 1;
      } else if (e.type === "agent_output") {
        st.outputs += 1;
      } else if (e.type === "artifact") {
        st.artifacts += 1;
      }
    }

    return stats;
  }, [runEvents]);

  const runEventsRunId = useMemo(() => {
    return runEvents[0]?.run_id ?? null;
  }, [runEvents]);

  const fetchChapters = useCallback(
    async (projectId: string): Promise<ChapterItem[]> => {
      const res = await fetch(`${apiBase}/api/projects/${projectId}/chapters`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ChapterItem[];
    },
    [apiBase],
  );

  const refreshChapters = useCallback(
    async (projectId: string) => {
      const data = await fetchChapters(projectId);
      setChapters(data);
    },
    [fetchChapters],
  );

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!selectedProjectId) {
        setChapters([]);
        return;
      }
      try {
        const data = await fetchChapters(selectedProjectId);
        if (!cancelled) setChapters(data);
      } catch {
        if (!cancelled) setChapters([]);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, fetchChapters]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!selectedProjectId) {
        setKbChunks([]);
        setKbSelectedIds([]);
        return;
      }
      try {
        setKbChunksError(null);
        const res = await fetch(
          `${apiBase}/api/projects/${selectedProjectId}/kb/chunks`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(txt || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as KBChunkItem[];

        // Apply persisted order (if any) from settings.
        const kb = (selectedProject?.settings as Record<string, unknown> | undefined)?.kb;
        const raw =
          kb && typeof kb === "object"
            ? (kb as Record<string, unknown>).chunk_order
            : null;
        const order: number[] = [];
        if (Array.isArray(raw)) {
          for (const x of raw) {
            const n = typeof x === "number" ? x : Number(x);
            if (Number.isFinite(n)) order.push(n);
          }
        }
        const byId = new Map(data.map((c) => [c.id, c]));
        const ordered: KBChunkItem[] = [];
        for (const id of order) {
          const item = byId.get(id);
          if (item) ordered.push(item);
        }
        const seen = new Set(ordered.map((c) => c.id));
        const remaining = data.filter((c) => !seen.has(c.id));
        const merged = order.length > 0 ? [...ordered, ...remaining] : data;

        if (cancelled) return;
        setKbChunks(merged);
        setKbSelectedIds((prev) => {
          if (prev.length === 0) return prev;
          const live = new Set(data.map((c) => c.id));
          return prev.filter((id) => live.has(id));
        });
      } catch (e) {
        if (cancelled) return;
        setKbChunks([]);
        setKbChunksError((e as Error).message);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [apiBase, selectedProjectId, selectedProject]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (tab !== "agents") return;
      if (!selectedProjectId) return;
      if (runInProgress) return;

      try {
        const r1 = await fetch(
          `${apiBase}/api/projects/${selectedProjectId}/runs`,
          { cache: "no-store" },
        );
        if (!r1.ok) throw new Error(`HTTP ${r1.status}`);
        const runList = (await r1.json()) as RunItem[];
        if (cancelled) return;
        setRuns(runList);

        const rid = selectedRunId ?? runList[0]?.id ?? null;
        if (!rid) return;
        if (selectedRunId !== rid) setSelectedRunId(rid);

        const currentRunId = runEventsRunId;
        if (currentRunId === rid && runEvents.length > 0) return;

        const r2 = await fetch(`${apiBase}/api/runs/${rid}/events`, {
          cache: "no-store",
        });
        if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
        const evts = (await r2.json()) as Array<{
          run_id: string;
          seq: number;
          ts: string;
          event_type: string;
          agent: string | null;
          payload: Record<string, unknown>;
        }>;
        if (cancelled) return;
        setRunEvents(
          evts.map((e) => ({
            run_id: e.run_id,
            seq: e.seq,
            ts: e.ts,
            type: e.event_type,
            agent: e.agent,
            data: e.payload ?? {},
          })),
        );
      } catch {
        if (!cancelled) setRuns([]);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [
    tab,
    apiBase,
    selectedProjectId,
    selectedRunId,
    runInProgress,
    runEventsRunId,
    runEvents.length,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await fetch(`${apiBase}/api/secrets/status`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SecretsStatus;
        if (!cancelled) setSecretsStatus(data);
      } catch {
        if (!cancelled) setSecretsStatus(null);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  async function saveSecrets(update: Record<string, unknown>) {
    setSecretsSaveError(null);
    setSecretsSaving(true);
    const p = (async () => {
    try {
      const res = await fetch(`${apiBase}/api/secrets/set`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(tt("secrets_save_not_found"));
        }
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as SecretsStatus;
      setSecretsStatus(data);

      // Do not keep keys in memory longer than needed.
      if (Object.prototype.hasOwnProperty.call(update, "openai_api_key")) {
        setOpenaiApiKeyDraft("");
      }
      if (Object.prototype.hasOwnProperty.call(update, "gemini_api_key")) {
        setGeminiApiKeyDraft("");
      }
    } catch (err) {
      setSecretsSaveError((err as Error).message);
      throw err;
    }
    })();

    pendingSecretsSaveRef.current = p;
    try {
      await p;
    } finally {
      if (pendingSecretsSaveRef.current === p) {
        setSecretsSaving(false);
      }
    }
  }

  async function deleteProject(projectId: string) {
    if (!projectId) return;
    const ok = window.confirm(
      lang === "zh" ? "确定删除该项目？（不可恢复）" : "Delete this project? (cannot be undone)",
    );
    if (!ok) return;
    const res = await fetch(`${apiBase}/api/projects/${projectId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== projectId);
      saveProjectOrder(next.map((p) => p.id));
      if (selectedProjectId === projectId) {
        setSelectedProjectId(next[0]?.id ?? null);
      }
      return next;
    });
  }

  async function deleteChapter(chapterId: string) {
    if (!selectedProjectId) return;
    if (!chapterId) return;
    const ok = window.confirm(
      lang === "zh" ? "确定删除该章节？（不可恢复）" : "Delete this chapter? (cannot be undone)",
    );
    if (!ok) return;
    const res = await fetch(
      `${apiBase}/api/projects/${selectedProjectId}/chapters/${chapterId}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    setChapters((prev) => prev.filter((c) => c.id !== chapterId));
  }

  async function persistChapterOrder(nextChapters: ChapterItem[]) {
    if (!selectedProjectId) return;
    setChapters(nextChapters);
    const res = await fetch(
      `${apiBase}/api/projects/${selectedProjectId}/chapters/reorder`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chapter_ids: nextChapters.map((c) => c.id),
          start_index: 1,
        }),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    const data = (await res.json()) as ChapterItem[];
    setChapters(data);
  }

  async function createProject() {
    const title = newProjectTitle.trim();
    if (!title) return;
    const res = await fetch(`${apiBase}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    const p = (await res.json()) as Project;
    setProjects((prev) => {
      const next = [p, ...prev.filter((x) => x.id !== p.id)];
      saveProjectOrder([p.id, ...loadProjectOrder().filter((id) => id !== p.id)]);
      return applyProjectOrder(next);
    });
    setSelectedProjectId(p.id);
  }

  function getSettingsValue(path: string, fallback: string): string {
    const parts = path.split(".");
    let cur: unknown = selectedProject?.settings ?? {};
    for (const p of parts) {
      if (!cur || typeof cur !== "object") return fallback;
      cur = (cur as Record<string, unknown>)[p];
    }
    return typeof cur === "string" ? cur : fallback;
  }

  function getSettingsBool(path: string, fallback: boolean): boolean {
    const parts = path.split(".");
    let cur: unknown = selectedProject?.settings ?? {};
    for (const p of parts) {
      if (!cur || typeof cur !== "object") return fallback;
      cur = (cur as Record<string, unknown>)[p];
    }
    return typeof cur === "boolean" ? cur : fallback;
  }

  async function saveProjectSettings(next: Record<string, unknown>) {
    if (!selectedProject) return;
    setSettingsError(null);
    setSettingsSaving(true);
    const p = (async () => {
      const res = await fetch(`${apiBase}/api/projects/${selectedProject.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: next }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as Project;
      setProjects((prev) => prev.map((pp) => (pp.id === updated.id ? updated : pp)));
    })();
    pendingProjectSettingsSaveRef.current = p;
    try {
      await p;
    } catch (e) {
      setSettingsError((e as Error).message);
      throw e;
    } finally {
      if (pendingProjectSettingsSaveRef.current === p) {
        setSettingsSaving(false);
      }
    }
  }

  async function runPipeline(
    kind: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; error?: string }> {
    if (!selectedProjectId) return { ok: false };
    const projectId = selectedProjectId;
    setRunError(null);
    setRunInProgress(true);
    setRunEvents([]);
    setActiveRunKind(kind);
    setActiveRunId(null);
    // Clear previous outputs early to avoid confusing "old success" content
    // lingering when a new run fails mid-pipeline.
    setGeneratedMarkdown("");
    setOutline(null);
    if (kind === "book_summarize") {
      setBookSummarizeStats(null);
    }
    if (kind === "book_compile") {
      setBookState(null);
    }

    let sawRunError = false;
    let lastError: string | null = null;
    try {
      // Ensure any in-flight Settings/Secrets save completes before starting a run,
      // otherwise the backend may start with stale provider/model/base_url.
      if (pendingProjectSettingsSaveRef.current) {
        await pendingProjectSettingsSaveRef.current;
      }
      if (pendingSecretsSaveRef.current) {
        await pendingSecretsSaveRef.current;
      }

      const res = await fetch(
        `${apiBase}/api/projects/${projectId}/runs/stream`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind, ui_lang: lang, ...extra }),
        },
      );
      if (!res.ok || !res.body) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE blocks separated by blank lines.
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.startsWith("data:"));
          if (!line) continue;
          const jsonText = line.replace(/^data:\s*/, "");
          try {
            const evt = JSON.parse(jsonText) as {
              run_id: string;
              seq: number;
              ts: string;
              type: string;
              agent: string | null;
              data: Record<string, unknown>;
            };
            setActiveRunId((prev) => prev ?? evt.run_id);
            setRunEvents((prev) => [...prev, evt]);
            if (evt.type === "run_error") {
              sawRunError = true;
              const err =
                typeof evt.data.error === "string"
                  ? evt.data.error
                  : "unknown_error";
              const agent = evt.agent ? formatAgentName(evt.agent) : "Director";
              lastError = `${agent}: ${err}`;
              setRunError(`${agent}: ${err}`);
            }
            if (
              evt.type === "artifact" &&
              evt.agent === "Writer" &&
              evt.data.artifact_type === "chapter_markdown" &&
              typeof evt.data.markdown === "string"
            ) {
              setGeneratedMarkdown(evt.data.markdown);
              // Chapter is persisted by backend before emitting this artifact.
              // Refresh chapter list once per chapter (avoid fetching on every SSE event).
              refreshChapters(projectId).catch(() => {
                // ignore refresh failures (non-critical for showing the markdown)
              });
            }
            if (
              evt.type === "artifact" &&
              evt.agent === "Outliner" &&
              evt.data.artifact_type === "outline"
            ) {
              setOutline(evt.data.outline ?? null);
            }
            if (
              evt.type === "artifact" &&
              evt.agent === "BookSummarizer" &&
              evt.data.artifact_type === "book_summarize_stats"
            ) {
              const createdRaw = evt.data.created;
              const failedRaw = evt.data.failed;
              const processedRaw = evt.data.processed;
              const created =
                typeof createdRaw === "number"
                  ? createdRaw
                  : Number(createdRaw ?? 0);
              const failed =
                typeof failedRaw === "number"
                  ? failedRaw
                  : Number(failedRaw ?? 0);
              const processed =
                typeof processedRaw === "number"
                  ? processedRaw
                  : Number(processedRaw ?? 0);
              const sid =
                typeof evt.data.source_id === "string" ? evt.data.source_id : "";
              const filename =
                typeof evt.data.filename === "string" ? evt.data.filename : undefined;
              setBookSummarizeStats({
                source_id: sid,
                filename,
                processed: Number.isFinite(processed) ? processed : 0,
                created: Number.isFinite(created) ? created : 0,
                failed: Number.isFinite(failed) ? failed : 0,
                params:
                  evt.data.params && typeof evt.data.params === "object"
                    ? (evt.data.params as Record<string, unknown>)
                    : undefined,
              });
            }
            if (
              evt.type === "artifact" &&
              evt.agent === "BookCompiler" &&
              evt.data.artifact_type === "book_state"
            ) {
              const sid =
                typeof evt.data.source_id === "string" ? evt.data.source_id : "";
              const kbIdRaw = evt.data.kb_chunk_id;
              const kb_chunk_id =
                typeof kbIdRaw === "number" ? kbIdRaw : Number(kbIdRaw ?? 0);
              const preview =
                typeof evt.data.preview === "string" ? evt.data.preview : undefined;
              setBookState({
                source_id: sid,
                kb_chunk_id: Number.isFinite(kb_chunk_id) ? kb_chunk_id : 0,
                state: evt.data.state,
                preview,
              });
            }
          } catch {
            // ignore partial/bad events
          }
        }
      }
    } finally {
      setRunInProgress(false);
      setActiveRunKind(null);
      setActiveRunId(null);
    }
    return { ok: !sawRunError, error: lastError ?? undefined };
  }

  async function runBatchWriteChapters(
    opts: { startIndex?: number; total?: number } = {},
  ) {
    if (!selectedProjectId) return;
    if (!outlineChapters) {
      setRunError(
        lang === "zh"
          ? "批量写章需要【已保存的大纲】。请先在「大纲编辑」保存/导入大纲，或先点击「生成大纲」。"
          : "Batch writing requires a saved outline. Please save/import an outline first (or generate one).",
      );
      return;
    }

    const startIndex = Math.max(
      1,
      Number.isFinite(opts.startIndex) ? Number(opts.startIndex) : chapterIndex,
    );
    const totalRaw = Number(opts.total ?? writeChapterCount);
    const total = Math.max(1, Math.min(10, Number.isFinite(totalRaw) ? totalRaw : 1));

    batchStopRequestedRef.current = false;
    setBatchWriting({ status: "running", startIndex, total, done: 0 });

    let done = 0;
    for (let i = 0; i < total; i += 1) {
      if (batchStopRequestedRef.current) {
        setBatchWriting({ status: "stopped", startIndex, total, done });
        return;
      }

      const idx = Math.max(1, startIndex + i);
      try {
        const r = await runPipeline("chapter", {
          chapter_index: idx,
          research_query: researchQuery.trim() || undefined,
          // Batch writing is meant to use the explicitly saved outline and avoid
          // repeated Outliner calls (more stable + won't overwrite the outline draft).
          skip_outliner: true,
        });
        if (!r.ok) {
          setBatchWriting({
            status: "failed",
            startIndex,
            total,
            done,
            lastError: r.error ?? undefined,
          });
          return;
        }
      } catch (e) {
        setBatchWriting({
          status: "failed",
          startIndex,
          total,
          done,
          lastError: (e as Error).message,
        });
        return;
      }

      done = i + 1;
      setBatchWriting({ status: "running", startIndex, total, done });
      setChapterIndex(idx + 1);
    }

    setBatchWriting({ status: "completed", startIndex, total, done });
  }

  async function runBatchContinueChapters(
    sourceId: string,
    opts: { startIndex?: number; total?: number; kind?: "continue" | "book_continue" } = {},
  ) {
    if (!selectedProjectId) return;
    const sid = (sourceId || "").trim();
    if (!sid) {
      setRunError(lang === "zh" ? "缺少续写源（source_id）" : "Missing continue source (source_id)");
      return;
    }

    const runKind = opts.kind ?? "continue";
    const startIndex = Math.max(
      1,
      Number.isFinite(opts.startIndex) ? Number(opts.startIndex) : chapterIndex,
    );
    const totalRaw = Number(opts.total ?? writeChapterCount);
    const total = Math.max(1, Math.min(10, Number.isFinite(totalRaw) ? totalRaw : 1));

    const hasSavedOutline = Boolean(outlineChapters && outlineChapters.length > 0);

    batchContinueStopRequestedRef.current = false;
    setBatchContinuing({ status: "running", kind: runKind, sourceId: sid, startIndex, total, done: 0 });

    let done = 0;
    for (let i = 0; i < total; i += 1) {
      if (batchContinueStopRequestedRef.current) {
        setBatchContinuing({ status: "stopped", kind: runKind, sourceId: sid, startIndex, total, done });
        return;
      }

      const idx = Math.max(1, startIndex + i);
      try {
        const payload: Record<string, unknown> = {
          chapter_index: idx,
          source_id: sid,
          source_slice_mode: continueExcerptMode,
          source_slice_chars: continueExcerptChars,
          research_query: researchQuery.trim() || undefined,
        };
        if (runKind === "continue") {
          // If the user already has an explicitly saved outline, avoid re-running
          // Outliner; otherwise, run it once for the first chapter then skip.
          payload.skip_outliner = hasSavedOutline ? true : i > 0;
        }
        const r = await runPipeline(runKind, payload);
        if (!r.ok) {
          setBatchContinuing({
            status: "failed",
            kind: runKind,
            sourceId: sid,
            startIndex,
            total,
            done,
            lastError: r.error ?? undefined,
          });
          return;
        }
      } catch (e) {
        setBatchContinuing({
          status: "failed",
          kind: runKind,
          sourceId: sid,
          startIndex,
          total,
          done,
          lastError: (e as Error).message,
        });
        return;
      }

      done = i + 1;
      setBatchContinuing({ status: "running", kind: runKind, sourceId: sid, startIndex, total, done });
      setChapterIndex(idx + 1);
    }

    setBatchContinuing({ status: "completed", kind: runKind, sourceId: sid, startIndex, total, done });
  }

  async function addKbChunk() {
    if (!selectedProjectId) return;
    setKbError(null);
    setKbChunksError(null);
    const res = await fetch(`${apiBase}/api/projects/${selectedProjectId}/kb/chunks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: kbTitle,
        tags: kbTags.split(",").map((t) => t.trim()).filter(Boolean),
        content: kbContent,
        source_type: "note",
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    const created = (await res.json()) as KBChunkItem;

    // Keep a visible list in sync (best-effort; background pane uses it).
    setKbChunks((prev) => {
      const next = [created, ...prev.filter((x) => x.id !== created.id)];
      return next;
    });
    // Keep the saved order stable and prepend the new chunk so it shows up first.
    const prevOrder = (() => {
      const kb = (selectedProject?.settings as Record<string, unknown> | undefined)?.kb;
      const raw =
        kb && typeof kb === "object"
          ? (kb as Record<string, unknown>).chunk_order
          : null;
      if (!Array.isArray(raw)) return [] as number[];
      const out: number[] = [];
      for (const x of raw) {
        const n = typeof x === "number" ? x : Number(x);
        if (Number.isFinite(n)) out.push(n);
      }
      return out;
    })();
    const nextOrder = [created.id, ...prevOrder.filter((id) => id !== created.id)];
    saveProjectSettings({ kb: { chunk_order: nextOrder } }).catch(() => {
      // ignore order persistence failures (non-critical)
    });

    setKbEditingId(null);
    setKbContent("");
  }

  async function refreshKbChunks() {
    if (!selectedProjectId) return;
    setKbChunksError(null);
    const res = await fetch(`${apiBase}/api/projects/${selectedProjectId}/kb/chunks`, {
      cache: "no-store",
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    const data = (await res.json()) as KBChunkItem[];

    // Apply persisted order (if any) from settings.
    const kb = (selectedProject?.settings as Record<string, unknown> | undefined)?.kb;
    const raw =
      kb && typeof kb === "object" ? (kb as Record<string, unknown>).chunk_order : null;
    const order: number[] = [];
    if (Array.isArray(raw)) {
      for (const x of raw) {
        const n = typeof x === "number" ? x : Number(x);
        if (Number.isFinite(n)) order.push(n);
      }
    }
    if (order.length > 0) {
      const byId = new Map(data.map((c) => [c.id, c]));
      const ordered: KBChunkItem[] = [];
      for (const id of order) {
        const item = byId.get(id);
        if (item) ordered.push(item);
      }
      const seen = new Set(ordered.map((c) => c.id));
      const remaining = data.filter((c) => !seen.has(c.id));
      setKbChunks([...ordered, ...remaining]);
    } else {
      setKbChunks(data);
    }

    setKbSelectedIds((prev) => {
      if (prev.length === 0) return prev;
      const live = new Set(data.map((c) => c.id));
      return prev.filter((id) => live.has(id));
    });
  }

  async function updateKbChunk(chunkId: number) {
    if (!selectedProjectId) return;
    setKbChunksError(null);
    const res = await fetch(
      `${apiBase}/api/projects/${selectedProjectId}/kb/chunks/${chunkId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: kbTitle,
          tags: kbTags.split(",").map((t) => t.trim()).filter(Boolean),
          content: kbContent,
        }),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    const updated = (await res.json()) as KBChunkItem;
    setKbChunks((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    setKbEditingId(null);
    setKbTitle("");
    setKbTags("");
    setKbContent("");
  }

  async function deleteKbChunk(chunkId: number) {
    if (!selectedProjectId) return;
    const ok = window.confirm(
      lang === "zh" ? "确定删除该知识库条目？（不可恢复）" : "Delete this KB item? (cannot be undone)",
    );
    if (!ok) return;
    setKbChunksError(null);
    const res = await fetch(
      `${apiBase}/api/projects/${selectedProjectId}/kb/chunks/${chunkId}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    setKbChunks((prev) => prev.filter((x) => x.id !== chunkId));
    setKbSelectedIds((prev) => prev.filter((id) => id !== chunkId));
    if (kbEditingId === chunkId) {
      setKbEditingId(null);
      setKbTitle("");
      setKbTags("");
      setKbContent("");
    }
    // Persist updated order (best-effort).
    const nextOrder = kbChunks.filter((x) => x.id !== chunkId).map((x) => x.id);
    saveProjectSettings({ kb: { chunk_order: nextOrder } }).catch(() => {
      // ignore
    });
  }

  function exportSelectedKbChunks() {
    if (!selectedProjectId) return;
    const ids = new Set(kbSelectedIds);
    const chosen = kbChunks.filter((c) => ids.has(c.id));
    if (chosen.length === 0) {
      window.alert(lang === "zh" ? "请先勾选要导出的条目。" : "Select items to export first.");
      return;
    }

    const safeTitle = (selectedProject?.title || "project")
      .replace(/[\\/:*?\"<>|]+/g, "-")
      .slice(0, 40);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");

    let content = "";
    let filename = "";
    let mime = "text/plain;charset=utf-8";

    if (kbExportFormat === "json") {
      mime = "application/json;charset=utf-8";
      filename = `ai-writer_kb_${safeTitle}_${ts}.json`;
      content = JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          project_id: selectedProjectId,
          project_title: selectedProject?.title ?? null,
          chunks: chosen,
        },
        null,
        2,
      );
    } else {
      filename = `ai-writer_kb_${safeTitle}_${ts}.txt`;
      content = chosen
        .map((c) => {
          const header = c.title?.trim()
            ? `# ${c.title.trim()}`
            : `# Chunk #${c.id}`;
          const tags = (c.tags || "").trim();
          const meta = [
            tags ? `Tags: ${tags}` : "",
            c.source_type ? `Source: ${c.source_type}` : "",
            c.created_at ? `Created: ${c.created_at}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          return `${header}\n${meta}\n\n${c.content}\n`;
        })
        .join("\n---\n\n");
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadTextFile(filename: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const parseOutlineText = (text: string): OutlineChapter[] => {
    const lines = String(text ?? "")
      .split(/\r?\n/g)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const out: OutlineChapter[] = [];
    for (const ln of lines) {
      // Accept formats like:
      // - "1. Title"
      // - "第1章：Title"
      // - "# Title"
      // - "Title"
      const m =
        /^(?:第?\s*(\d+)\s*(?:章|回|节)?\s*[:：.\-—]?\s*)?(.+)$/.exec(ln) ?? null;
      const idx = m?.[1] ? Number(m[1]) : NaN;
      const rest = (m?.[2] ?? ln).replace(/^#+\s*/, "").trim();
      out.push({ index: Number.isFinite(idx) ? idx : 0, title: rest });
    }
    return normalizeOutline(out);
  };

  const parseOutlineJson = (jsonText: string): OutlineChapter[] => {
    const parsed = JSON.parse(jsonText) as unknown;
    const extract = (x: unknown): unknown => {
      if (Array.isArray(x)) return x;
      if (x && typeof x === "object") {
        const rec = x as Record<string, unknown>;
        if (Array.isArray(rec.chapters)) return rec.chapters;
        if (Array.isArray(rec.outline)) return rec.outline;
      }
      return null;
    };
    const raw = extract(parsed);
    if (!Array.isArray(raw)) return [];
    const out: OutlineChapter[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const idx = Number(rec.index);
      const title = typeof rec.title === "string" ? rec.title : "";
      if (!title.trim()) continue;
      out.push({
        index: Number.isFinite(idx) ? idx : 0,
        title: title.trim(),
        summary: typeof rec.summary === "string" ? rec.summary : undefined,
        goal: typeof rec.goal === "string" ? rec.goal : undefined,
      });
    }
    return normalizeOutline(out);
  };

  async function importOutlineFile(file: File) {
    if (!selectedProjectId) return;
    setOutlinePaneError(null);
    const name = (file?.name ?? "").toLowerCase();
    const rawText = await file.text();

    const chapters =
      name.endsWith(".json") ? parseOutlineJson(rawText) : parseOutlineText(rawText);
    if (chapters.length === 0) {
      throw new Error("outline_import_failed:no_chapters");
    }

    await saveProjectSettings({ story: { outline: chapters } });
  }

  function exportOutline(format: "json" | "txt") {
    const chapters = outlineChapters ?? [];
    if (format === "json") {
      downloadTextFile(
        "outline.json",
        JSON.stringify({ chapters }, null, 2),
        "application/json",
      );
      return;
    }
    const lines = chapters.map((ch) => {
      const base = `${ch.index}. ${ch.title}`;
      const parts: string[] = [];
      if (ch.summary) parts.push(ch.summary);
      if (ch.goal) parts.push(lang === "zh" ? `目标：${ch.goal}` : `Goal: ${ch.goal}`);
      return parts.length > 0 ? `${base} - ${parts.join(" | ")}` : base;
    });
    downloadTextFile(
      "outline.txt",
      lines.join("\n") + "\n",
      "text/plain;charset=utf-8",
    );
  }

  async function clearOutline() {
    if (!selectedProjectId) return;
    setOutlinePaneError(null);
    await saveProjectSettings({ story: { outline: [] } });
    setOutline({ chapters: [] });
    setOutlineDraft([]);
    setOutlineDirty(false);
  }

  function updateOutlineBlock(blockId: string, patch: Partial<OutlineBlock>) {
    setOutlinePaneError(null);
    setOutlineDraft((prev) => {
      const next = prev.map((c) => (c.id === blockId ? { ...c, ...patch } : c));
      return reindexOutlineBlocks(next);
    });
    setOutlineDirty(true);
  }

  function addOutlineBlock() {
    const nextIndex = outlineDraft.length + 1;
    const title =
      lang === "zh" ? `第${nextIndex}章：` : `Chapter ${nextIndex}: `;
    setOutlinePaneError(null);
    setOutlineDraft((prev) =>
      reindexOutlineBlocks([
        ...prev,
        { id: makeOutlineId(), index: nextIndex, title, summary: "", goal: "" },
      ]),
    );
    setOutlineDirty(true);
  }

  function deleteOutlineBlock(blockId: string) {
    setOutlinePaneError(null);
    setOutlineDraft((prev) => reindexOutlineBlocks(prev.filter((c) => c.id !== blockId)));
    setOutlineDirty(true);
  }

  function moveOutlineBlock(movingId: string, beforeId: string) {
    setOutlinePaneError(null);
    setOutlineDraft((prev) => reindexOutlineBlocks(moveById(prev, movingId, beforeId)));
    setOutlineDirty(true);
    setDraggingOutlineId(null);
  }

  function resetOutlineDraft() {
    if (outlineDirty) {
      const ok = window.confirm(
        lang === "zh"
          ? "丢弃未保存的大纲修改并恢复为已保存版本？"
          : "Discard unsaved outline changes and reload the saved version?",
      );
      if (!ok) return;
    }
    setOutlinePaneError(null);
    setOutlineDraft(loadOutlineBlocksFromProject(selectedProject));
    setOutlineDirty(false);
    setDraggingOutlineId(null);
  }

  async function saveOutlineDraft() {
    if (!selectedProjectId) return;
    setOutlinePaneError(null);
    const trimmed = outlineDraft.map((c) => ({
      ...c,
      title: String(c.title ?? "").trim(),
      summary: typeof c.summary === "string" ? c.summary.trim() : undefined,
      goal: typeof c.goal === "string" ? c.goal.trim() : undefined,
    }));
    for (let i = 0; i < trimmed.length; i += 1) {
      if (!trimmed[i].title) {
        setOutlinePaneError(
          lang === "zh"
            ? `第 ${i + 1} 个块的标题不能为空。`
            : `Title is required for block #${i + 1}.`,
        );
        return;
      }
    }
    const normalized = reindexOutlineBlocks(
      trimmed.map((c) => ({
        ...c,
        summary: c.summary ? c.summary : undefined,
        goal: c.goal ? c.goal : undefined,
      })),
    );

    await saveProjectSettings({ story: { outline: normalized } });
    // Keep the UI outline view consistent even if the last run outline artifact exists.
    setOutline({ chapters: normalized });
    setOutlineDraft(normalized);
    setOutlineDirty(false);
    setOutlineDraftProjectId(selectedProjectId);
  }

  function ensureOutlineGraphDraft() {
    if (outlineGraphDraft && outlineGraphDraft.nodes.length > 0) return;
    const saved = loadOutlineGraphFromProject(selectedProject);
    if (saved) {
      setOutlineGraphDraft(saved);
      setOutlineGraphDirty(false);
      setOutlineGraphProjectId(selectedProjectId);
      return;
    }

    const sourceBlocks =
      outlineDraft.length > 0
        ? outlineDraft
        : loadOutlineBlocksFromProject(selectedProject);
    const g = outlineGraphFromBlocks(sourceBlocks);
    setOutlineGraphDraft(g);
    setOutlineGraphDirty(true);
    setOutlineGraphProjectId(selectedProjectId);
  }

  function resetOutlineGraphDraft() {
    if (!selectedProjectId) return;
    if (outlineGraphDirty) {
      const ok = window.confirm(
        lang === "zh"
          ? "丢弃未保存的导图修改并恢复为已保存版本？"
          : "Discard unsaved mindmap changes and reload the saved version?",
      );
      if (!ok) return;
    }
    setOutlinePaneError(null);
    const saved = loadOutlineGraphFromProject(selectedProject);
    if (saved) {
      setOutlineGraphDraft(saved);
      setOutlineGraphDirty(false);
      setOutlineGraphProjectId(selectedProjectId);
      return;
    }
    // No saved graph yet; regenerate from the currently saved outline blocks.
    const blocks = loadOutlineBlocksFromProject(selectedProject);
    setOutlineGraphDraft(outlineGraphFromBlocks(blocks));
    setOutlineGraphDirty(true);
    setOutlineGraphProjectId(selectedProjectId);
  }

  function syncOutlineGraphFromBlocks() {
    if (!selectedProjectId) return;
    if (outlineGraphDirty) {
      const ok = window.confirm(
        lang === "zh"
          ? "当前导图有未保存修改。用大纲块重新生成会覆盖这些修改，继续？"
          : "Mindmap has unsaved changes. Regenerating from outline blocks will overwrite them. Continue?",
      );
      if (!ok) return;
    }
    setOutlinePaneError(null);
    setOutlineGraphDraft(outlineGraphFromBlocks(outlineDraft));
    setOutlineGraphDirty(true);
    setOutlineGraphProjectId(selectedProjectId);
  }

  function syncOutlineBlocksFromGraph() {
    if (!outlineGraphDraft) return;
    if (outlineDirty) {
      const ok = window.confirm(
        lang === "zh"
          ? "当前大纲块有未保存修改。用导图生成草稿会覆盖这些修改，继续？"
          : "Outline blocks have unsaved changes. Syncing from mindmap will overwrite them. Continue?",
      );
      if (!ok) return;
    }
    setOutlinePaneError(null);
    const blocks = outlineBlocksFromGraph(outlineGraphDraft);
    setOutlineDraft(blocks);
    setOutlineDirty(true);
    setDraggingOutlineId(null);
  }

  async function saveOutlineGraph() {
    if (!selectedProjectId) return;
    if (!outlineGraphDraft) return;
    setOutlinePaneError(null);

    const blocks = outlineBlocksFromGraph(outlineGraphDraft);
    if (blocks.length === 0) {
      setOutlinePaneError(
        lang === "zh"
          ? "导图里没有可用的“章节”节点（chapter）。请先添加章节节点并填写标题。"
          : "No usable chapter nodes found in mindmap. Add chapter nodes and fill titles first.",
      );
      return;
    }

    const chapters = blocks.map((b) => ({
      id: b.id,
      index: b.index,
      title: b.title,
      summary: b.summary,
      goal: b.goal,
    }));

    await saveProjectSettings({
      story: { outline_graph: outlineGraphDraft, outline: chapters },
    });
    // Keep UI consistent with saved outline.
    setOutline({ chapters });
    setOutlineDraft(blocks);
    setOutlineDirty(false);
    setOutlineDraftProjectId(selectedProjectId);
    setOutlineGraphDirty(false);
    setOutlineGraphProjectId(selectedProjectId);
  }

  function exportOutlineMindmap() {
    if (!outlineGraphDraft) return;
    downloadTextFile(
      "outline_mindmap.json",
      JSON.stringify(outlineGraphDraft, null, 2),
      "application/json",
    );
  }

  async function importOutlineMindmapFile(file: File) {
    if (!selectedProjectId) return;
    setOutlinePaneError(null);
    const raw = await file.text();
    const parsed = JSON.parse(raw) as unknown;
    const g = coerceOutlineGraph(parsed);
    if (!g) {
      throw new Error("mindmap_import_failed:invalid_graph");
    }
    setOutlineGraphDraft(g);
    setOutlineGraphDirty(true);
    setOutlineGraphProjectId(selectedProjectId);
    setOutlineEditorMode("mindmap");
  }

  function autoOrderMindmapChapters() {
    if (!outlineGraphDraft) return;
    const chapters = outlineGraphDraft.nodes
      .filter((n) => n?.data?.kind === "chapter")
      .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
    if (chapters.length === 0) return;

    const chapterIds = new Set(chapters.map((n) => n.id));
    const posById = new Map<string, { x: number; y: number }>();
    const orderById = new Map<string, number>();
    chapters.forEach((n, i) => {
      posById.set(n.id, { x: 40, y: 40 + i * 140 });
      orderById.set(n.id, i + 1);
    });

    const next = {
      ...outlineGraphDraft,
      nodes: outlineGraphDraft.nodes.map((n) => {
        if (!chapterIds.has(n.id)) return n;
        const pos = posById.get(n.id);
        const order = orderById.get(n.id);
        return {
          ...n,
          position: pos ?? n.position,
          data: { ...n.data, order: order ?? n.data.order },
        };
      }),
    };
    setOutlineGraphDraft(next);
    setOutlineGraphDirty(true);
  }

  async function searchKb() {
    if (!selectedProjectId) return;
    setKbError(null);
    const res = await fetch(
      `${apiBase}/api/projects/${selectedProjectId}/kb/search?q=${encodeURIComponent(kbQuery)}&limit=8`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    const data = (await res.json()) as Array<{
      id: number;
      title: string;
      content: string;
      score: number;
    }>;
    setKbResults(data);
  }

  async function webSearch() {
    if (!webQuery.trim()) return;
    setWebError(null);
    setWebLoading(true);
    try {
      const provider = getSettingsValue("tools.web_search.provider", "auto");
      const res = await fetch(
        `${apiBase}/api/tools/web_search?q=${encodeURIComponent(webQuery)}&limit=6&provider=${encodeURIComponent(provider)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { detail?: unknown };
          if (typeof parsed?.detail === "string") detail = parsed.detail;
        } catch {
          // ignore
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as Array<{
        title: string;
        url: string;
        snippet: string;
      }>;
      setWebResults(data);
    } finally {
      setWebLoading(false);
    }
  }

  function clearContinueInput() {
    setContinueSourceId(null);
    setContinueSourceMeta(null);
    setContinueInputText("");
    setContinueSourceError(null);
    setContinueSourceToken((x) => x + 1);
  }

  function clearBookContinueInput() {
    setBookSourceId(null);
    setBookSourceMeta(null);
    setBookInputText("");
    setBookSourceError(null);
    setBookSourceToken((x) => x + 1);
    setBookIndex(null);
    setBookIndexError(null);
    setBookSummarizeStats(null);
    setBookState(null);
  }

  async function uploadContinueFile(file: File): Promise<string> {
    setContinueSourceError(null);
    setContinueSourceLoading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(
        `${apiBase}/api/tools/continue_sources/upload?preview_mode=${encodeURIComponent(continueExcerptMode)}&preview_chars=${encodeURIComponent(String(continueExcerptChars))}`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { detail?: unknown };
          if (typeof parsed?.detail === "string") detail = parsed.detail;
        } catch {
          // ignore
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        source_id?: unknown;
        preview?: unknown;
        meta?: { filename?: unknown; chars?: unknown };
      };
      const sid = typeof data.source_id === "string" ? data.source_id : null;
      if (!sid) throw new Error("bad_response");
      const preview = typeof data.preview === "string" ? data.preview : "";
      const filename = typeof data.meta?.filename === "string" ? data.meta.filename : file.name;
      const chars = typeof data.meta?.chars === "number" ? data.meta.chars : undefined;
      setContinueSourceId(sid);
      setContinueSourceMeta({ filename, chars });
      setContinueInputText(preview);
      setContinueSourceToken((x) => x + 1);
      return sid;
    } finally {
      setContinueSourceLoading(false);
    }
  }

  async function uploadBookContinueFile(file: File): Promise<string> {
    setBookSourceError(null);
    setBookSourceLoading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(
        `${apiBase}/api/tools/continue_sources/upload?preview_mode=${encodeURIComponent(continueExcerptMode)}&preview_chars=${encodeURIComponent(String(continueExcerptChars))}`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { detail?: unknown };
          if (typeof parsed?.detail === "string") detail = parsed.detail;
        } catch {
          // ignore
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        source_id?: unknown;
        preview?: unknown;
        meta?: { filename?: unknown; chars?: unknown };
      };
      const sid = typeof data.source_id === "string" ? data.source_id : null;
      if (!sid) throw new Error("bad_response");
      const preview = typeof data.preview === "string" ? data.preview : "";
      const filename =
        typeof data.meta?.filename === "string" ? data.meta.filename : file.name;
      const chars = typeof data.meta?.chars === "number" ? data.meta.chars : undefined;
      setBookSourceId(sid);
      setBookSourceMeta({ filename, chars });
      setBookInputText(preview);
      setBookSourceToken((x) => x + 1);
      setBookIndex(null);
      setBookIndexError(null);
      setBookSummarizeStats(null);
      setBookState(null);
      return sid;
    } finally {
      setBookSourceLoading(false);
    }
  }

  async function buildBookIndex(sourceId: string): Promise<BookIndexResult> {
    setBookIndexError(null);
    setBookIndexLoading(true);
    try {
      const sid = (sourceId || "").trim();
      if (!sid) throw new Error("source_id_required");

      const params = new URLSearchParams();
      params.set("chunk_chars", String(Math.max(500, Math.min(30000, bookChunkChars))));
      params.set("overlap_chars", String(Math.max(0, Math.min(10000, bookOverlapChars))));
      params.set("max_chunks", String(Math.max(1, Math.min(2000, bookMaxChunks))));
      params.set("preview_chars", "160");

      const res = await fetch(
        `${apiBase}/api/tools/continue_sources/${encodeURIComponent(sid)}/book_index?${params.toString()}`,
      );
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { detail?: unknown };
          if (typeof parsed?.detail === "string") detail = parsed.detail;
        } catch {
          // ignore
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as BookIndexResult;
      setBookIndex(data);
      return data;
    } catch (e) {
      setBookIndexError((e as Error).message);
      throw e;
    } finally {
      setBookIndexLoading(false);
    }
  }

  async function uploadContinueText(text: string): Promise<string> {
    setContinueSourceError(null);
    setContinueSourceLoading(true);
    try {
      const res = await fetch(
        `${apiBase}/api/tools/continue_sources/text?preview_mode=${encodeURIComponent(continueExcerptMode)}&preview_chars=${encodeURIComponent(String(continueExcerptChars))}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, filename: "pasted.txt" }),
        },
      );
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { detail?: unknown };
          if (typeof parsed?.detail === "string") detail = parsed.detail;
        } catch {
          // ignore
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        source_id?: unknown;
        preview?: unknown;
        meta?: { filename?: unknown; chars?: unknown };
      };
      const sid = typeof data.source_id === "string" ? data.source_id : null;
      if (!sid) throw new Error("bad_response");
      const preview = typeof data.preview === "string" ? data.preview : "";
      const filename = typeof data.meta?.filename === "string" ? data.meta.filename : "pasted.txt";
      const chars = typeof data.meta?.chars === "number" ? data.meta.chars : undefined;
      setContinueSourceId(sid);
      setContinueSourceMeta({ filename, chars });
      setContinueInputText(preview);
      return sid;
    } finally {
      setContinueSourceLoading(false);
    }
  }

  async function uploadBookContinueText(text: string): Promise<string> {
    setBookSourceError(null);
    setBookSourceLoading(true);
    try {
      const res = await fetch(
        `${apiBase}/api/tools/continue_sources/text?preview_mode=${encodeURIComponent(continueExcerptMode)}&preview_chars=${encodeURIComponent(String(continueExcerptChars))}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, filename: "book_pasted.txt" }),
        },
      );
      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { detail?: unknown };
          if (typeof parsed?.detail === "string") detail = parsed.detail;
        } catch {
          // ignore
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        source_id?: unknown;
        preview?: unknown;
        meta?: { filename?: unknown; chars?: unknown };
      };
      const sid = typeof data.source_id === "string" ? data.source_id : null;
      if (!sid) throw new Error("bad_response");
      const preview = typeof data.preview === "string" ? data.preview : "";
      const filename =
        typeof data.meta?.filename === "string"
          ? data.meta.filename
          : "book_pasted.txt";
      const chars = typeof data.meta?.chars === "number" ? data.meta.chars : undefined;
      setBookSourceId(sid);
      setBookSourceMeta({ filename, chars });
      setBookInputText(preview);
      setBookIndex(null);
      setBookIndexError(null);
      setBookSummarizeStats(null);
      setBookState(null);
      return sid;
    } finally {
      setBookSourceLoading(false);
    }
  }

  async function importWebResultToKb(r: {
    title: string;
    url: string;
    snippet: string;
  }) {
    if (!selectedProjectId) return;
    setWebError(null);
    const res = await fetch(`${apiBase}/api/projects/${selectedProjectId}/kb/chunks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: r.title,
        tags: ["web_import"],
        content: `${r.snippet}\n\nSource: ${r.url}`,
        source_type: "web_import",
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
  }

  async function exportProject() {
    if (!selectedProjectId) return;
    setExportError(null);
    setExporting(true);
    try {
      const res = await fetch(
        `${apiBase}/api/projects/${selectedProjectId}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format: exportFormat }),
        },
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") ?? "";
      const m = /filename=\"?([^\";]+)\"?/i.exec(cd);
      const filename = m?.[1] ?? `export.${exportFormat}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  const runProgress = useMemo(() => {
    if (!runInProgress || !activeRunKind) return null;

    const expectedAgents: Record<string, string[]> = {
      demo: ["ConfigAutofill", "Outliner", "Writer", "LoreKeeper", "Editor"],
      outline: ["ConfigAutofill", "Outliner"],
      chapter: ["ConfigAutofill", "Outliner", "Writer", "LoreKeeper", "Editor"],
      continue: [
        "ConfigAutofill",
        "Extractor",
        "Outliner",
        "Writer",
        "LoreKeeper",
        "Editor",
      ],
      book_summarize: ["BookSummarizer"],
      book_compile: ["BookCompiler"],
      book_continue: [
        "ConfigAutofill",
        "BookContinue",
        "BookPlanner",
        "Writer",
        "LoreKeeper",
        "Editor",
      ],
    };

    const plan = expectedAgents[activeRunKind] ?? [];
    const finished = new Set<string>();
    for (const evt of runEvents) {
      if (evt.type === "agent_finished" && evt.agent) finished.add(evt.agent);
    }

    let current: string | null = null;
    for (let i = runEvents.length - 1; i >= 0; i -= 1) {
      const evt = runEvents[i];
      if (evt.type === "agent_started" && evt.agent && !finished.has(evt.agent)) {
        current = evt.agent;
        break;
      }
    }

    const total = plan.length > 0 ? plan.length : Math.max(1, finished.size);
    const done = Math.min(total, finished.size);
    const inflight = current && !finished.has(current) ? 0.35 : 0;
    const pct = Math.min(99, Math.round(((done + inflight) / total) * 100));

    return {
      kind: activeRunKind,
      run_id: activeRunId,
      current_agent: current,
      done,
      total,
      pct,
    };
  }, [runInProgress, activeRunKind, activeRunId, runEvents]);

  const showBgImage = uiBackground.enabled && Boolean(uiBackground.image_data_url);

  return (
    <div className="relative min-h-screen bg-[var(--ui-bg)] text-[var(--ui-text)]">
      {showBgImage ? (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        >
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{
              backgroundImage: `url(${uiBackground.image_data_url})`,
              opacity: uiBackground.opacity,
              filter: `blur(${uiBackground.blur_px}px)`,
              transform: "scale(1.05)",
            }}
          />
        </div>
      ) : null}

      <div className="relative z-10">
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-[var(--ui-surface)] backdrop-blur">
          <div className="mx-auto flex w-full items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              {brandLogoDataUrl ? (
                <img
                  src={brandLogoDataUrl}
                  alt={tt("app_name")}
                  className="h-8 w-8 rounded-lg object-cover ring-1 ring-black/10"
                />
              ) : (
                <div className="h-8 w-8 rounded-lg bg-[var(--ui-accent)]" />
              )}
              <div className="leading-tight">
                <div className="text-sm font-semibold">{tt("app_name")}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  {tt("app_tagline")}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <nav className="flex items-center gap-2">
                {(
                  [
                    ["create", tt("tab_writing")],
                    ["continue", tt("tab_continue")],
                    ["agents", tt("tab_agents")],
                    ["settings", tt("tab_settings")],
                  ] as const
                ).map(([k, label]) => {
                  const active = tab === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setTab(k)}
                      className={[
                        "rounded-lg px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  );
                })}
              </nav>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-[var(--ui-control)] p-1 text-xs text-[var(--ui-control-text)]">
                  <button
                    onClick={() => setLang("zh")}
                    className={[
                      "rounded-md px-2 py-1 transition-colors",
                      lang === "zh"
                        ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                        : "opacity-80 hover:bg-[var(--ui-bg)]",
                    ].join(" ")}
                  >
                    中文
                  </button>
                  <button
                    onClick={() => setLang("en")}
                    className={[
                      "rounded-md px-2 py-1 transition-colors",
                      lang === "en"
                        ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                        : "opacity-80 hover:bg-[var(--ui-bg)]",
                    ].join(" ")}
                  >
                    EN
                  </button>
                </div>

              <select
                value={themeId}
                onChange={(e) => setThemeId(e.target.value)}
                className="rounded-lg border border-zinc-200 bg-[var(--ui-control)] px-2 py-2 text-xs text-[var(--ui-control-text)]"
                aria-label={tt("theme")}
              >
                {themes.map((th) => (
                  <option key={th.id} value={th.id}>
                      {th.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full px-6 py-8">
        <div className="mb-6 rounded-xl border border-zinc-200 bg-[var(--ui-surface)] p-4 text-sm dark:border-zinc-800">
          <div className="flex items-center justify-between gap-4">
            <div className="font-medium">{tt("backend")}</div>
            <div className="text-xs text-[var(--ui-muted)]">
              {apiBase}
            </div>
          </div>
          <div className="mt-2 text-[var(--ui-text)]">
            {health ? (
              <span>
                {tt("ok")} ({health.service ?? "unknown"}
                {health.version ? ` v${health.version}` : ""})
              </span>
            ) : healthError ? (
              <span className="text-red-600 dark:text-red-400">
                {tt("unreachable")}: {healthError}
              </span>
            ) : (
              <span>{tt("checking")}</span>
            )}
          </div>
          <div className="mt-3 rounded-md border border-zinc-200 bg-[var(--ui-bg)] p-3 dark:border-zinc-800">
            {runProgress ? (
              <>
                <div className="flex items-center justify-between gap-3 text-xs text-[var(--ui-muted)]">
                  <div className="min-w-0 truncate">
                    {tt("active_task")}: {formatRunKind(runProgress.kind)} ·{" "}
                    {formatAgentName(runProgress.current_agent ?? "Director")}
                    {runProgress.run_id
                      ? ` (#${runProgress.run_id.slice(0, 8)})`
                      : ""}
                  </div>
                  <div className="shrink-0">
                    {tt("progress")}: {runProgress.pct}%
                  </div>
                </div>
                <div className="mt-2 h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className="h-2 rounded-full bg-[var(--ui-accent)]"
                    style={{ width: `${runProgress.pct}%` }}
                  />
                </div>
                {runError ? (
                  <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                    {tt("error")}: {runError}
                  </div>
                ) : null}
              </>
            ) : runError ? (
              <div className="text-xs text-red-600 dark:text-red-400">
                {tt("error")}: {runError}
              </div>
            ) : (
              <div className="text-xs text-[var(--ui-muted)]">{tt("idle")}</div>
            )}
          </div>
        </div>

        {tab === "create" || tab === "continue" ? (
          <section className="rounded-xl border border-zinc-200 bg-transparent p-6 dark:border-zinc-800">
            <h1 className="text-lg font-semibold">
              {tab === "create" ? tt("tab_writing") : tt("tab_continue")}
            </h1>
            <p className="mt-2 text-sm text-[var(--ui-muted)]">
              {tt("writing_desc")}
            </p>

            {tab === "create" && createPane === "writing" && showQuickStart ? (
              <div className="mt-4 rounded-xl border border-zinc-200 bg-[var(--ui-surface)] p-4 text-sm dark:border-zinc-800">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium">{tt("guide_title")}</div>
                    <div className="mt-2 grid gap-1 text-xs text-[var(--ui-muted)]">
                      <div>1) {tt("guide_step_projects")}</div>
                      <div>2) {tt("guide_step_settings")}</div>
                      <div>3) {tt("guide_step_kb")}</div>
                      <div>4) {tt("guide_step_run")}</div>
                      <div>5) {tt("guide_step_export")}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setShowQuickStart(false);
                      try {
                        localStorage.setItem(
                          "ai-writer:quickstart:dismissed",
                          "1",
                        );
                      } catch {
                        // ignore
                      }
                    }}
                    className="shrink-0 rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                  >
                    {tt("guide_dismiss")}
                  </button>
                </div>
              </div>
            ) : null}

            {tab === "create" ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {(
                  [
                    ["projects", tt("create_nav_projects")],
                    ["background", tt("create_nav_background")],
                    ["outline", tt("create_nav_outline")],
                    ["writing", tt("create_nav_writing")],
                  ] as const
                ).map(([k, label]) => {
                  const active = createPane === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setCreatePane(k)}
                      className={[
                        "rounded-lg px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                          : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {(
                  [
                    ["article", tt("continue_nav_article")],
                    ["book", tt("continue_nav_book")],
                  ] as const
                ).map(([k, label]) => {
                  const active = continuePane === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setContinuePane(k)}
                      className={[
                        "rounded-lg px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                          : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}

            {((tab === "create" && createPane === "writing") ||
              (tab === "continue" && continuePane === "article")) ? (
              <div className="mt-6 h-[calc(100vh-260px)] min-h-[560px]">
              <PanelGroup
                direction="horizontal"
                autoSaveId="ai-writer:writing:outer"
                className="flex h-full min-h-0"
              >
                <Panel
                  defaultSize={24}
                  minSize={16}
                  className="min-w-0 pr-3 h-full min-h-0"
                >
                  <div className="grid gap-6 h-full min-h-0 overflow-auto pr-1">
                    <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                  <div className="text-sm font-medium">{tt("projects")}</div>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={newProjectTitle}
                      onChange={(e) => setNewProjectTitle(e.target.value)}
                      className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                      placeholder={tt("project_title_placeholder")}
                    />
                    <button
                      onClick={() => {
                        createProject().catch((e) =>
                          setProjectsError((e as Error).message),
                        );
                      }}
                      className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90"
                    >
                      {tt("create")}
                    </button>
                  </div>

                  {projectsError ? (
                    <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                      {projectsError}
                    </div>
                  ) : null}

                  <div className="mt-3 max-h-64 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                    {projects.length === 0 ? (
                      <div className="p-3 text-sm text-[var(--ui-muted)]">
                        {tt("no_projects")}
                      </div>
                    ) : (
                      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                        {projects.map((p) => {
                          const active = p.id === selectedProjectId;
                          return (
                            <li key={p.id}>
                              <div
                                onClick={() => setSelectedProjectId(p.id)}
                                onDragOver={(e) => {
                                  if (!draggingProjectId) return;
                                  e.preventDefault();
                                }}
                                onDrop={(e) => {
                                  const moving =
                                    draggingProjectId ||
                                    e.dataTransfer.getData("text/plain");
                                  if (!moving || moving === p.id) return;
                                  e.preventDefault();
                                  setProjects((prev) => {
                                    const next = moveById(prev, moving, p.id);
                                    saveProjectOrder(next.map((x) => x.id));
                                    return next;
                                  });
                                  setDraggingProjectId(null);
                                }}
                                className={[
                                  "px-3 py-3 text-left text-sm",
                                  active
                                    ? "bg-zinc-100 dark:bg-zinc-800"
                                    : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                                ].join(" ")}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedProjectId(p.id);
                                      setTab("create");
                                      setCreatePane("writing");
                                    }}
                                    className="rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90"
                                  >
                                    {lang === "zh" ? "进入写作" : "Go to Writing"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedProjectId(p.id);
                                      setTab("continue");
                                      setContinuePane("article");
                                      setContinueRunKind("continue");
                                      clearContinueInput();
                                    }}
                                    className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                  >
                                    {lang === "zh"
                                      ? "文章续写（上传）"
                                      : "Continue Article (upload)"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedProjectId(p.id);
                                      setTab("continue");
                                      setContinuePane("book");
                                      setContinueRunKind("book_continue");
                                      clearBookContinueInput();
                                    }}
                                    className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                  >
                                    {lang === "zh"
                                      ? "书籍续写（上传）"
                                      : "Continue Book (upload)"}
                                  </button>
                                </div>

                                <div className="mt-2 flex items-center gap-2">
                                  <button
                                    type="button"
                                    draggable
                                    onClick={(e) => e.stopPropagation()}
                                    onDragStart={(e) => {
                                      setDraggingProjectId(p.id);
                                      e.dataTransfer.setData("text/plain", p.id);
                                      e.dataTransfer.effectAllowed = "move";
                                    }}
                                    onDragEnd={() => setDraggingProjectId(null)}
                                    className="cursor-grab select-none rounded px-1 text-xs text-[var(--ui-muted)] hover:text-[var(--ui-text)]"
                                    title={
                                      lang === "zh"
                                        ? "拖拽排序"
                                        : "Drag to reorder"
                                    }
                                  >
                                    ⋮⋮
                                  </button>
                                  <div className="min-w-0 flex-1 truncate font-medium">
                                    {p.title}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      deleteProject(p.id).catch((err) =>
                                        setProjectsError((err as Error).message),
                                      );
                                    }}
                                    className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                  >
                                    {lang === "zh" ? "删除" : "Delete"}
                                  </button>
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>

                    <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                  <div className="text-sm font-medium">{tt("outline_latest")}</div>
                  {selectedProjectId ? (
                    outlineChapters ? (
                      <ol className="mt-3 space-y-2 text-sm">
                        {outlineChapters.map((ch) => (
                          <li key={ch.index} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                            <div className="font-medium">
                              {ch.index}. {ch.title}
                            </div>
                            {ch.summary ? (
                              <div className="mt-1 text-xs text-[var(--ui-muted)]">
                                {ch.summary}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <div className="mt-2 text-sm text-[var(--ui-muted)]">
                        {tt("no_outline")}
                      </div>
                    )
                  ) : (
                    <div className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                      {tt("select_project_first")}
                    </div>
                  )}
                </div>

                    <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                  <div className="text-sm font-medium">{tt("chapters")}</div>
                  {!selectedProjectId ? (
                    <div className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                      {tt("select_project_first")}
                    </div>
                  ) : chapters.length === 0 ? (
                    <div className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                      {tt("no_chapters")}
                    </div>
                  ) : (
                    <div className="mt-3 max-h-80 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                      <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                        {chapters.map((ch) => (
                          <li
                            key={ch.id}
                            className="p-3"
                            onDragOver={(e) => {
                              if (!draggingChapterId) return;
                              e.preventDefault();
                            }}
                            onDrop={(e) => {
                              const moving =
                                draggingChapterId ||
                                e.dataTransfer.getData("text/plain");
                              if (!moving || moving === ch.id) return;
                              e.preventDefault();
                              const next = moveById(chapters, moving, ch.id);
                              persistChapterOrder(next).catch((err) =>
                                setRunError((err as Error).message),
                              );
                              setDraggingChapterId(null);
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                draggable
                                onClick={(e) => e.stopPropagation()}
                                onDragStart={(e) => {
                                  setDraggingChapterId(ch.id);
                                  e.dataTransfer.setData("text/plain", ch.id);
                                  e.dataTransfer.effectAllowed = "move";
                                }}
                                onDragEnd={() => setDraggingChapterId(null)}
                                className="cursor-grab select-none rounded px-1 text-xs text-[var(--ui-muted)] hover:text-[var(--ui-text)]"
                                title={lang === "zh" ? "拖拽排序" : "Drag to reorder"}
                              >
                                ⋮⋮
                              </button>
                              <div className="min-w-0 flex-1 truncate font-medium">
                                {ch.chapter_index}. {ch.title}
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setGeneratedMarkdown(ch.markdown);
                                  setEditorView("split");
                                }}
                                className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                              >
                                {tt("open")}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  deleteChapter(ch.id).catch((err) =>
                                    setRunError((err as Error).message),
                                  );
                                }}
                                className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                              >
                                {lang === "zh" ? "删除" : "Delete"}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                  </div>
                </Panel>

                <PanelResizeHandle className="group flex w-6 cursor-col-resize items-center justify-center">
                  <div className="h-full w-px rounded-full bg-zinc-200 transition-colors group-hover:bg-zinc-400 dark:bg-zinc-800 dark:group-hover:bg-zinc-600" />
                </PanelResizeHandle>

                <Panel
                  defaultSize={76}
                  minSize={40}
                  className="min-w-0 pl-3 h-full min-h-0"
                >
                  <PanelGroup
                    direction="horizontal"
                    autoSaveId="ai-writer:writing:inner"
                    className="flex h-full min-h-0"
                  >
                    <Panel
                      defaultSize={70}
                      minSize={45}
                      className="min-w-0 pr-3 h-full min-h-0"
                    >
                <div className="min-w-0 h-full min-h-0 rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800 flex flex-col">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-medium">{tt("markdown_editor")}</div>
                    <div className="flex items-center gap-1 rounded-md border border-zinc-200 bg-[var(--ui-control)] p-1 text-xs text-[var(--ui-control-text)]">
                      {(
                        [
                          ["edit", tt("view_edit")],
                          ["preview", tt("view_preview")],
                          ["split", tt("view_split")],
                        ] as const
                      ).map(([k, label]) => (
                        <button
                          key={k}
                          onClick={() => setEditorView(k)}
                          className={[
                            "rounded-md px-2 py-1 transition-colors",
                            editorView === k
                              ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                              : "opacity-80 hover:bg-[var(--ui-bg)]",
                          ].join(" ")}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {editorView === "edit" ? (
                    <textarea
                      value={generatedMarkdown}
                      onChange={(e) => setGeneratedMarkdown(e.target.value)}
                      className="mt-3 min-h-0 flex-1 w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 font-mono text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                      placeholder={tt("generated_markdown_placeholder")}
                    />
                  ) : editorView === "preview" ? (
                    <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-md border border-zinc-200 bg-[var(--ui-control)] p-4 text-[var(--ui-control-text)]">
                      <MarkdownPreview
                        markdown={generatedMarkdown}
                        emptyLabel={tt("preview_empty")}
                      />
                    </div>
                  ) : (
                    <div className="mt-3 min-h-0 flex-1 grid gap-3 lg:grid-cols-2">
                      <textarea
                        value={generatedMarkdown}
                        onChange={(e) => setGeneratedMarkdown(e.target.value)}
                        className="min-h-0 h-full w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 font-mono text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                        placeholder={tt("generated_markdown_placeholder")}
                      />
                      <div className="min-h-0 h-full overflow-auto rounded-md border border-zinc-200 bg-[var(--ui-control)] p-4 text-[var(--ui-control-text)]">
                        <MarkdownPreview
                          markdown={generatedMarkdown}
                          emptyLabel={tt("preview_empty")}
                        />
                      </div>
                    </div>
                  )}
                </div>

                    </Panel>

                    <PanelResizeHandle className="group flex w-6 cursor-col-resize items-center justify-center">
                      <div className="h-full w-px rounded-full bg-zinc-200 transition-colors group-hover:bg-zinc-400 dark:bg-zinc-800 dark:group-hover:bg-zinc-600" />
                    </PanelResizeHandle>

                    <Panel
                      defaultSize={30}
                      minSize={20}
                      className="min-w-0 pl-3 h-full min-h-0"
                    >
                      <PanelGroup
                        direction="vertical"
                        autoSaveId="ai-writer:writing:right"
                        className="flex h-full min-h-0 flex-col"
                      >
                        <Panel defaultSize={45} minSize={18} className="min-h-0">
                          <div className="h-full min-h-0 overflow-auto rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                    <div className="text-sm font-medium">{tt("selected_project")}</div>
                    <div className="mt-2 text-sm text-[var(--ui-muted)]">
                      {selectedProjectId ? (
                        <span>
                          {tt("project_id")}: {selectedProjectId}
                        </span>
                      ) : (
                        <span>{tt("none")}</span>
                      )}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        disabled={
                          !selectedProjectId ||
                          runInProgress ||
                          settingsSaving ||
                          secretsSaving
                        }
                        onClick={() => {
                          runPipeline("demo").catch((e) =>
                            setRunError((e as Error).message),
                          );
                        }}
                        className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                      >
                        {runInProgress ? tt("running") : tt("run_demo")}
                      </button>
                      <button
                        disabled={
                          !selectedProjectId ||
                          runInProgress ||
                          settingsSaving ||
                          secretsSaving
                        }
                        onClick={() => {
                          runPipeline("outline").catch((e) =>
                            setRunError((e as Error).message),
                          );
                        }}
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                      >
                        {tt("generate_outline")}
                      </button>
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("streams_to_agents")}
                      </span>
                    </div>
                    {runError ? (
                      <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                        {runError}
                      </div>
                    ) : null}

                    <div className="mt-4 rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                      <div className="text-sm font-medium">
                        {tt("research_query_optional")}
                      </div>
                      <div className="mt-2 text-xs text-[var(--ui-muted)]">
                        {tt("research_query_desc")}
                      </div>
                      <input
                        value={researchQuery}
                        onChange={(e) => setResearchQuery(e.target.value)}
                        className="mt-3 w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                        placeholder={tt("research_query_placeholder")}
                      />
                    </div>

                    {writingMode === "create" ? (
                      <div className="mt-4 rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                        <div className="text-sm font-medium">
                          {tt("write_chapter")}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs text-[var(--ui-muted)]">
                              {tt("chapter_index")}
                            </span>
                            <input
                              type="number"
                              min={1}
                              value={chapterIndex}
                              onChange={(e) =>
                                setChapterIndex(Number(e.target.value))
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                            />
                          </label>
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs text-[var(--ui-muted)]">
                              {tt("write_chapter_count")}
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={10}
                              step={1}
                              value={writeChapterCount}
                              onChange={(e) =>
                                setWriteChapterCount(Number(e.target.value))
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                            />
                          </label>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            disabled={
                              !selectedProjectId ||
                              runInProgress ||
                              settingsSaving ||
                              secretsSaving ||
                              batchWriting?.status === "running"
                              || batchWriting?.status === "stopping"
                            }
                            onClick={() => {
                              runPipeline("chapter", {
                                chapter_index: chapterIndex,
                                research_query: researchQuery.trim() || undefined,
                                skip_outliner: true,
                              }).catch((e) =>
                                setRunError((e as Error).message),
                              );
                            }}
                            className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                          >
                            {tt("write_chapter_llm")}
                          </button>
                          <button
                            disabled={
                              !selectedProjectId ||
                              runInProgress ||
                              settingsSaving ||
                              secretsSaving ||
                              batchWriting?.status === "running"
                              || batchWriting?.status === "stopping"
                            }
                            onClick={() => {
                              runBatchWriteChapters().catch((e) =>
                                setRunError((e as Error).message),
                              );
                            }}
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                          >
                            {batchWriting?.status === "running"
                              ? `${tt("batch_writing")} (${batchWriting.done}/${batchWriting.total})`
                              : lang === "zh"
                                ? `批量写 ${writeChapterCount} 章`
                                : `Write ${writeChapterCount} chapters`}
                          </button>
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("uses_settings")}
                          </span>
                        </div>
                        {batchWriting ? (
                          <div className="mt-2 rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] dark:border-zinc-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-[var(--ui-muted)]">
                                {lang === "zh"
                                  ? `批量状态：${batchWriting.status}（${batchWriting.done}/${batchWriting.total}）`
                                  : `Batch: ${batchWriting.status} (${batchWriting.done}/${batchWriting.total})`}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                {batchWriting.status === "running" ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      batchStopRequestedRef.current = true;
                                      setBatchWriting((prev) =>
                                        prev && prev.status === "running"
                                          ? { ...prev, status: "stopping" }
                                          : prev,
                                      );
                                    }}
                                    className="rounded-md border border-zinc-200 bg-[var(--ui-bg)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-surface)] dark:border-zinc-800"
                                    title={
                                      lang === "zh"
                                        ? "会在当前章节完成后停止"
                                        : "Stops after the current chapter finishes"
                                    }
                                  >
                                    {lang === "zh" ? "停止批量" : "Stop"}
                                  </button>
                                ) : batchWriting.status === "stopping" ? (
                                  <button
                                    type="button"
                                    disabled
                                    className="rounded-md border border-zinc-200 bg-[var(--ui-bg)] px-2 py-1 text-xs text-[var(--ui-control-text)] opacity-60 dark:border-zinc-800"
                                    title={
                                      lang === "zh"
                                        ? "会在当前章节完成后停止"
                                        : "Stops after the current chapter finishes"
                                    }
                                  >
                                    {lang === "zh" ? "停止中…" : "Stopping…"}
                                  </button>
                                ) : null}
                                {(batchWriting.status === "stopped" ||
                                  batchWriting.status === "failed") &&
                                batchWriting.done < batchWriting.total ? (
                                  <button
                                    type="button"
                                    disabled={runInProgress || settingsSaving || secretsSaving}
                                    onClick={() => {
                                      // Resume remaining chapters from the next index.
                                      const nextIndex = Math.max(
                                        1,
                                        batchWriting.startIndex + batchWriting.done,
                                      );
                                      const remaining = Math.max(
                                        1,
                                        batchWriting.total - batchWriting.done,
                                      );
                                      setChapterIndex(nextIndex);
                                      setWriteChapterCount(remaining);
                                      runBatchWriteChapters({
                                        startIndex: nextIndex,
                                        total: remaining,
                                      }).catch((e) => setRunError((e as Error).message));
                                    }}
                                    className="rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                                  >
                                    {lang === "zh" ? "继续剩余" : "Resume"}
                                  </button>
                                ) : null}
                                {batchWriting.status !== "running" &&
                                batchWriting.status !== "stopping" ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setBatchWriting(null);
                                      batchStopRequestedRef.current = false;
                                    }}
                                    className="rounded-md border border-zinc-200 bg-[var(--ui-bg)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-surface)] dark:border-zinc-800"
                                  >
                                    {lang === "zh" ? "清除" : "Clear"}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                            {batchWriting.lastError ? (
                              <div className="mt-2 text-red-600 dark:text-red-400">
                                {batchWriting.lastError}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="mt-2 text-xs text-[var(--ui-muted)]">
                          {tt("batch_write_chapters_hint")}
                        </div>
                      </div>
                    ) : null}

                    {writingMode === "continue" ? (
                      <div className="mt-4 rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                        <div className="text-sm font-medium">
                          {tt("continue_mode")}
                        </div>
                        <div className="mt-2 text-xs text-[var(--ui-muted)]">
                          {tt("continue_desc")}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs text-[var(--ui-muted)]">
                              {tt("chapter_index")}
                            </span>
                            <input
                              type="number"
                              min={1}
                              value={chapterIndex}
                              onChange={(e) =>
                                setChapterIndex(Number(e.target.value))
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                            />
                          </label>
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs text-[var(--ui-muted)]">
                              {tt("write_chapter_count")}
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={10}
                              step={1}
                              value={writeChapterCount}
                              onChange={(e) =>
                                setWriteChapterCount(Number(e.target.value))
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                            />
                          </label>
                        </div>

                        <div className="mt-3 rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-[var(--ui-control-text)]">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-xs text-[var(--ui-muted)]">
                                {tt("continue_source_box")}
                              </div>
                              <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
                                {tt("continue_source_desc")}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <label className="cursor-pointer rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90">
                                {continueSourceLoading
                                  ? tt("continue_extracting_file")
                                  : tt("continue_upload_button")}
                                <input
                                  key={continueSourceToken}
                                  type="file"
                                  accept=".txt,.md,.markdown,.docx,.pdf,.epub"
                                  className="hidden"
                                  onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    if (!f) return;
                                    uploadContinueFile(f).catch((err) =>
                                      setContinueSourceError(
                                        (err as Error).message,
                                      ),
                                    );
                                  }}
                                />
                              </label>
                              <button
                                disabled={
                                  continueSourceLoading ||
                                  (!continueSourceId &&
                                    !continueInputText.trim())
                                }
                                onClick={() => clearContinueInput()}
                                className="rounded-md border border-zinc-200 bg-[var(--ui-bg)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                              >
                                {tt("clear")}
                              </button>
                            </div>
                          </div>

                          {continueSourceId ? (
                            <div className="mt-2 text-[11px] text-[var(--ui-muted)]">
                              {tt("continue_selected_source")}:{" "}
                              {continueSourceMeta?.filename ?? continueSourceId}
                              {typeof continueSourceMeta?.chars === "number"
                                ? lang === "zh"
                                  ? `（${continueSourceMeta.chars} 字符）`
                                  : ` (${continueSourceMeta.chars} chars)`
                                : ""}
                            </div>
                          ) : null}

                          <div className="mt-3 grid gap-2 md:grid-cols-2">
                            <label className="grid gap-1 text-sm">
                              <span className="text-xs text-[var(--ui-muted)]">
                                {tt("continue_excerpt_mode")}
                              </span>
                              <select
                                value={continueExcerptMode}
                                onChange={(e) =>
                                  setContinueExcerptMode(
                                    e.target.value === "head"
                                      ? "head"
                                      : "tail",
                                  )
                                }
                                className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                              >
                                <option value="tail">
                                  {tt("continue_excerpt_tail")}
                                </option>
                                <option value="head">
                                  {tt("continue_excerpt_head")}
                                </option>
                              </select>
                            </label>
                            <label className="grid gap-1 text-sm">
                              <span className="text-xs text-[var(--ui-muted)]">
                                {tt("continue_excerpt_chars")}
                              </span>
                              <input
                                type="number"
                                min={200}
                                max={50000}
                                value={continueExcerptChars}
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  if (!Number.isFinite(n)) return;
                                  setContinueExcerptChars(
                                    Math.max(200, Math.min(50000, n)),
                                  );
                                }}
                                className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                              />
                            </label>
                          </div>

                          {continueSourceError ? (
                            <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                              {continueSourceError}
                            </div>
                          ) : null}

                          <textarea
                            value={continueInputText}
                            readOnly={Boolean(continueSourceId)}
                            onChange={(e) => {
                              if (continueSourceId) return;
                              setContinueInputText(e.target.value);
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              setContinueDropActive(true);
                            }}
                            onDragLeave={() => setContinueDropActive(false)}
                            onDrop={(e) => {
                              e.preventDefault();
                              setContinueDropActive(false);
                              const f = e.dataTransfer.files?.[0];
                              if (!f) return;
                              uploadContinueFile(f).catch((err) =>
                                setContinueSourceError(
                                  (err as Error).message,
                                ),
                              );
                            }}
                            onPaste={(e) => {
                              const f = e.clipboardData.files?.[0];
                              if (f) {
                                e.preventDefault();
                                uploadContinueFile(f).catch((err) =>
                                  setContinueSourceError(
                                    (err as Error).message,
                                  ),
                                );
                                return;
                              }
                              // For very large pasted text, avoid pushing it into React state
                              // (textarea rendering can freeze). Store it directly to backend.
                              const txt = e.clipboardData.getData("text") || "";
                              if (
                                !continueSourceId &&
                                txt &&
                                txt.length > 60000
                              ) {
                                e.preventDefault();
                                uploadContinueText(txt).catch((err) =>
                                  setContinueSourceError(
                                    (err as Error).message,
                                  ),
                                );
                              }
                            }}
                            className={[
                              "mt-3 h-40 w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]",
                              continueDropActive
                                ? "ring-2 ring-[var(--ui-accent)]"
                                : "",
                              continueSourceId ? "opacity-90" : "",
                            ].join(" ")}
                            placeholder={tt("continue_source_placeholder")}
                          />

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <span className="text-xs text-[var(--ui-muted)]">
                              {lang === "zh" ? "续写类型" : "Continue type"}
                            </span>
                            <select
                              value={continueRunKind}
                              disabled={
                                runInProgress ||
                                batchContinuing?.status === "running" ||
                                batchContinuing?.status === "stopping"
                              }
                              onChange={(e) =>
                                setContinueRunKind(
                                  e.target.value === "book_continue"
                                    ? "book_continue"
                                    : "continue",
                                )
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)]"
                            >
                              <option value="continue">
                                {lang === "zh"
                                  ? "文章续写（抽取+续写）"
                                  : "Article (extract + continue)"}
                              </option>
                              <option value="book_continue">
                                {lang === "zh"
                                  ? "书籍续写（基于书籍状态）"
                                  : "Book (compiled state)"}
                              </option>
                            </select>
                            {continueRunKind === "book_continue" ? (
                              <span className="text-xs text-[var(--ui-muted)]">
                                {lang === "zh"
                                  ? "需要先在「书籍续写」完成：总结入库 → 编译书籍状态。"
                                  : "Requires: Summarize into KB → Compile book state first."}
                              </span>
                            ) : null}
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button
                              disabled={
                                !selectedProjectId ||
                                runInProgress ||
                                settingsSaving ||
                                secretsSaving ||
                                continueSourceLoading ||
                                !(continueSourceId || continueInputText.trim()) ||
                                batchContinuing?.status === "running" ||
                                batchContinuing?.status === "stopping"
                              }
                              onClick={async () => {
                                try {
                                  let sid = continueSourceId;
                                  if (!sid) {
                                    sid = await uploadContinueText(
                                      continueInputText,
                                    );
                                  }
                                  await runPipeline(continueRunKind, {
                                    chapter_index: chapterIndex,
                                    source_id: sid,
                                    source_slice_mode: continueExcerptMode,
                                    source_slice_chars: continueExcerptChars,
                                    research_query:
                                      researchQuery.trim() || undefined,
                                  });
                                } catch (e) {
                                  setRunError((e as Error).message);
                                }
                              }}
                              className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                            >
                              {continueRunKind === "book_continue"
                                ? lang === "zh"
                                  ? "书籍续写（生成下一章）"
                                  : "Continue book (next chapter)"
                                : tt("extract_continue")}
                            </button>
                            <button
                              disabled={
                                !selectedProjectId ||
                                runInProgress ||
                                settingsSaving ||
                                secretsSaving ||
                                continueSourceLoading ||
                                !(continueSourceId || continueInputText.trim()) ||
                                batchContinuing?.status === "running" ||
                                batchContinuing?.status === "stopping"
                              }
                              onClick={async () => {
                                try {
                                  let sid = continueSourceId;
                                  if (!sid) {
                                    sid = await uploadContinueText(
                                      continueInputText,
                                    );
                                  }
                                  await runBatchContinueChapters(sid, {
                                    startIndex: chapterIndex,
                                    total: writeChapterCount,
                                    kind: continueRunKind,
                                  });
                                } catch (e) {
                                  setRunError((e as Error).message);
                                }
                              }}
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                            >
                              {batchContinuing?.status === "running"
                                ? `${lang === "zh"
                                    ? batchContinuing.kind === "book_continue"
                                      ? "批量书籍续写中…"
                                      : "批量续写中…"
                                    : batchContinuing.kind === "book_continue"
                                      ? "Batch book continuing…"
                                      : "Batch continuing…"} (${batchContinuing.done}/${batchContinuing.total})`
                                : continueRunKind === "book_continue"
                                  ? lang === "zh"
                                    ? `批量书籍续写 ${writeChapterCount} 章`
                                    : `Continue book ${writeChapterCount} chapters`
                                  : lang === "zh"
                                    ? `批量续写 ${writeChapterCount} 章`
                                    : `Continue ${writeChapterCount} chapters`}
                            </button>
                            <span className="text-xs text-[var(--ui-muted)]">
                              {tt("uses_settings")}
                            </span>
                          </div>
                          {batchContinuing ? (
                            <div className="mt-2 rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] dark:border-zinc-800">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-[var(--ui-muted)]">
                                  {lang === "zh"
                                    ? `批量状态：${batchContinuing.status}（${batchContinuing.done}/${batchContinuing.total}）`
                                    : `Batch: ${batchContinuing.status} (${batchContinuing.done}/${batchContinuing.total})`}
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  {batchContinuing.status === "running" ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        batchContinueStopRequestedRef.current = true;
                                        setBatchContinuing((prev) =>
                                          prev && prev.status === "running"
                                            ? { ...prev, status: "stopping" }
                                            : prev,
                                        );
                                      }}
                                      className="rounded-md border border-zinc-200 bg-[var(--ui-bg)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-surface)] dark:border-zinc-800"
                                      title={
                                        lang === "zh"
                                          ? "会在当前章节完成后停止"
                                          : "Stops after the current chapter finishes"
                                      }
                                    >
                                      {lang === "zh" ? "停止批量" : "Stop"}
                                    </button>
                                  ) : batchContinuing.status === "stopping" ? (
                                    <button
                                      type="button"
                                      disabled
                                      className="rounded-md border border-zinc-200 bg-[var(--ui-bg)] px-2 py-1 text-xs text-[var(--ui-control-text)] opacity-60 dark:border-zinc-800"
                                      title={
                                        lang === "zh"
                                          ? "会在当前章节完成后停止"
                                          : "Stops after the current chapter finishes"
                                      }
                                    >
                                      {lang === "zh" ? "停止中…" : "Stopping…"}
                                    </button>
                                  ) : null}
                                  {(batchContinuing.status === "stopped" ||
                                    batchContinuing.status === "failed") &&
                                  batchContinuing.done < batchContinuing.total ? (
                                    <button
                                      type="button"
                                      disabled={runInProgress || settingsSaving || secretsSaving}
                                      onClick={() => {
                                        const nextIndex = Math.max(
                                          1,
                                          batchContinuing.startIndex + batchContinuing.done,
                                        );
                                        const remaining = Math.max(
                                          1,
                                          batchContinuing.total - batchContinuing.done,
                                        );
                                        setChapterIndex(nextIndex);
                                        setWriteChapterCount(remaining);
                                        runBatchContinueChapters(
                                          batchContinuing.sourceId,
                                          {
                                            startIndex: nextIndex,
                                            total: remaining,
                                            kind: batchContinuing.kind,
                                          },
                                        ).catch((e) =>
                                          setRunError((e as Error).message),
                                        );
                                      }}
                                      className="rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                                    >
                                      {lang === "zh" ? "继续剩余" : "Resume"}
                                    </button>
                                  ) : null}
                                  {batchContinuing.status !== "running" &&
                                  batchContinuing.status !== "stopping" ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setBatchContinuing(null);
                                        batchContinueStopRequestedRef.current = false;
                                      }}
                                      className="rounded-md border border-zinc-200 bg-[var(--ui-bg)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-surface)] dark:border-zinc-800"
                                    >
                                      {lang === "zh" ? "清除" : "Clear"}
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                              {batchContinuing.lastError ? (
                                <div className="mt-2 text-red-600 dark:text-red-400">
                                  {batchContinuing.lastError}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="mt-2 text-xs text-[var(--ui-muted)]">
                            {tt("batch_continue_hint")}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>

                        </Panel>

                        <PanelResizeHandle className="group flex h-6 cursor-row-resize items-center justify-center">
                          <div className="h-px w-full rounded-full bg-zinc-200 transition-colors group-hover:bg-zinc-400 dark:bg-zinc-800 dark:group-hover:bg-zinc-600" />
                        </PanelResizeHandle>

                        <Panel defaultSize={14} minSize={8} className="min-h-0">
                          <div className="h-full min-h-0 overflow-auto rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                    <div className="text-sm font-medium">{tt("export")}</div>
                    <div className="mt-2 text-xs text-[var(--ui-muted)]">
                      {tt("export_desc")}
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <select
                        value={exportFormat}
                        onChange={(e) =>
                          setExportFormat(
                            e.target.value as "docx" | "epub" | "pdf",
                          )
                        }
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                      >
                        <option value="docx">DOCX</option>
                        <option value="epub">EPUB</option>
                        <option value="pdf">PDF</option>
                      </select>
                      <button
                        disabled={exporting || chapters.length === 0}
                        onClick={() => {
                          exportProject().catch((e) =>
                            setExportError((e as Error).message),
                          );
                        }}
                        className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                      >
                        {exporting ? tt("exporting") : tt("export")}
                      </button>
                    </div>
                    {exportError ? (
                      <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                        {exportError}
                      </div>
                    ) : null}
                          </div>
                        </Panel>

                        <PanelResizeHandle className="group flex h-6 cursor-row-resize items-center justify-center">
                          <div className="h-px w-full rounded-full bg-zinc-200 transition-colors group-hover:bg-zinc-400 dark:bg-zinc-800 dark:group-hover:bg-zinc-600" />
                        </PanelResizeHandle>

                        <Panel defaultSize={26} minSize={12} className="min-h-0">
                          <div className="h-full min-h-0 overflow-auto rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                    <div className="text-sm font-medium">{tt("local_kb")}</div>
                    <div className="mt-2 grid gap-2">
                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="grid gap-1 text-sm">
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("kb_chunk_title")}
                          </span>
                          <input
                            value={kbTitle}
                            onChange={(e) => setKbTitle(e.target.value)}
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                            placeholder={tt("kb_chunk_title_placeholder")}
                          />
                        </label>
                        <label className="grid gap-1 text-sm">
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("kb_chunk_tags")}
                          </span>
                          <input
                            value={kbTags}
                            onChange={(e) => setKbTags(e.target.value)}
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                            placeholder={tt("kb_chunk_tags_placeholder")}
                          />
                        </label>
                      </div>
                      <textarea
                        value={kbContent}
                        onChange={(e) => setKbContent(e.target.value)}
                        className="h-24 w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                        placeholder={tt("kb_chunk_content_placeholder")}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          disabled={!kbContent.trim()}
                          onClick={() => {
                            addKbChunk().catch((e) =>
                              setKbError((e as Error).message),
                            );
                          }}
                          className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                        >
                          {tt("save_to_kb")}
                        </button>
                        <span className="text-xs text-[var(--ui-muted)]">
                          {tt("stored_locally")}
                        </span>
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        <input
                          value={kbQuery}
                          onChange={(e) => setKbQuery(e.target.value)}
                          className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                          placeholder={`${tt("search_kb")}...`}
                        />
                        <button
                          disabled={!kbQuery.trim()}
                          onClick={() => {
                            searchKb().catch((e) =>
                              setKbError((e as Error).message),
                            );
                          }}
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                        >
                          {tt("search_kb")}
                        </button>
                      </div>

                      {kbError ? (
                        <div className="text-sm text-red-600 dark:text-red-400">
                          {kbError}
                        </div>
                      ) : null}

                      {kbResults.length > 0 ? (
                        <div className="mt-2 max-h-48 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                          <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                            {kbResults.map((r) => (
                              <li key={r.id} className="p-3">
                                <div className="font-medium">
                                  {r.title || `Chunk #${r.id}`}
                                </div>
                                <div className="mt-1 line-clamp-3 text-xs text-[var(--ui-muted)]">
                                  {r.content}
                                </div>
                                <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
                                  {tt("score")}: {r.score.toFixed(2)}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </div>

                        </Panel>

                        <PanelResizeHandle className="group flex h-6 cursor-row-resize items-center justify-center">
                          <div className="h-px w-full rounded-full bg-zinc-200 transition-colors group-hover:bg-zinc-400 dark:bg-zinc-800 dark:group-hover:bg-zinc-600" />
                        </PanelResizeHandle>

                        <Panel defaultSize={15} minSize={10} className="min-h-0">
                          <div className="h-full min-h-0 overflow-auto rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                    <div className="text-sm font-medium">{tt("web_search")}</div>
                    <div className="mt-2 text-xs text-[var(--ui-muted)]">
                      {tt("web_search_desc")}
                    </div>

                    {!getSettingsBool("tools.web_search.enabled", true) ? (
                      <div className="mt-3 text-sm text-[var(--ui-muted)]">
                        {tt("web_search_disabled")}
                      </div>
                    ) : (
                      <>
                        <div className="mt-3 flex items-center gap-2">
                          <input
                            value={webQuery}
                            onChange={(e) => setWebQuery(e.target.value)}
                            className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                            placeholder={tt("web_search_placeholder")}
                          />
                          <button
                            disabled={!webQuery.trim() || webLoading}
                            onClick={() => {
                              webSearch().catch((e) =>
                                setWebError((e as Error).message),
                              );
                            }}
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                          >
                            {webLoading ? "..." : tt("search")}
                          </button>
                        </div>

                        {webError ? (
                          <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                            {webError}
                          </div>
                        ) : null}

                        {webResults.length > 0 ? (
                          <div className="mt-3 max-h-64 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                            <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                              {webResults.map((r) => (
                                <li key={r.url} className="p-3">
                                  <div className="font-medium">{r.title}</div>
                                  <div className="mt-1 text-xs text-[var(--ui-muted)]">
                                    {r.snippet}
                                  </div>
                                  <div className="mt-1 break-all text-[11px] text-[var(--ui-muted)]">
                                    {r.url}
                                  </div>
                                  <div className="mt-2">
                                    <button
                                      onClick={() => {
                                        importWebResultToKb(r).catch((e) =>
                                          setWebError((e as Error).message),
                                        );
                                      }}
                                      className="rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90"
                                    >
                                      {tt("import_to_kb")}
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </Panel>
                      </PanelGroup>
                    </Panel>
                  </PanelGroup>
                </Panel>
              </PanelGroup>
            </div>
            ) : tab === "create" ? (
              createPane === "projects" ? (
                <div className="mt-6 rounded-xl border border-zinc-200 bg-[var(--ui-surface)] p-6 dark:border-zinc-800">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{tt("create_nav_projects")}</div>
                      <div className="mt-2 text-xs text-[var(--ui-muted)]">
                        {lang === "zh"
                          ? "在这里管理项目：支持拖拽排序/删除，并提供每个项目的快捷入口按钮。后续会加入项目简介/统计与一键生成简介。"
                          : "Manage projects here: drag reorder / delete, plus quick-action buttons per project. Next: synopsis + stats + AI synopsis."
                        }
                      </div>
                    </div>
                    <button
                      onClick={() => setCreatePane("writing")}
                      className="shrink-0 rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                    >
                      {lang === "zh" ? "去写作" : "Go to Writing"}
                    </button>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                      <div className="text-sm font-medium">
                        {lang === "zh" ? "新建项目" : "New project"}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <input
                          value={newProjectTitle}
                          onChange={(e) => setNewProjectTitle(e.target.value)}
                          className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                          placeholder={tt("project_title_placeholder")}
                        />
                        <button
                          onClick={() => {
                            createProject().catch((e) =>
                              setProjectsError((e as Error).message),
                            );
                          }}
                          className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90"
                        >
                          {tt("create")}
                        </button>
                      </div>
                      {projectsError ? (
                        <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                          {projectsError}
                        </div>
                      ) : null}
                    </div>

                    <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                      <div className="text-sm font-medium">{tt("projects")}</div>
                      <div className="mt-3 rounded-md border border-zinc-200 dark:border-zinc-800">
                        {projects.length === 0 ? (
                          <div className="p-3 text-sm text-[var(--ui-muted)]">
                            {tt("no_projects")}
                          </div>
                        ) : (
                          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                            {projects.map((p) => {
                              const active = p.id === selectedProjectId;
                              return (
                                <li key={p.id}>
                                  <div
                                    onClick={() => setSelectedProjectId(p.id)}
                                    onDragOver={(e) => {
                                      if (!draggingProjectId) return;
                                      e.preventDefault();
                                    }}
                                    onDrop={(e) => {
                                      const moving =
                                        draggingProjectId ||
                                        e.dataTransfer.getData("text/plain");
                                      if (!moving || moving === p.id) return;
                                      e.preventDefault();
                                      setProjects((prev) => {
                                        const next = moveById(prev, moving, p.id);
                                        saveProjectOrder(next.map((x) => x.id));
                                        return next;
                                      });
                                      setDraggingProjectId(null);
                                    }}
                                    className={[
                                      "px-3 py-3 text-left text-sm",
                                      active
                                        ? "bg-zinc-100 dark:bg-zinc-800"
                                        : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                                    ].join(" ")}
                                  >
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedProjectId(p.id);
                                          setTab("create");
                                          setCreatePane("writing");
                                        }}
                                        className="rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90"
                                      >
                                        {lang === "zh" ? "进入写作" : "Go to Writing"}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedProjectId(p.id);
                                          setTab("continue");
                                          setContinuePane("article");
                                          setContinueRunKind("continue");
                                          clearContinueInput();
                                        }}
                                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                      >
                                        {lang === "zh"
                                          ? "文章续写（上传）"
                                          : "Continue Article (upload)"}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedProjectId(p.id);
                                          setTab("continue");
                                          setContinuePane("book");
                                          setContinueRunKind("book_continue");
                                          clearBookContinueInput();
                                        }}
                                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                      >
                                        {lang === "zh"
                                          ? "书籍续写（上传）"
                                          : "Continue Book (upload)"}
                                      </button>
                                    </div>

                                    <div className="mt-2 flex items-center gap-2">
                                      <button
                                        type="button"
                                        draggable
                                        onClick={(e) => e.stopPropagation()}
                                        onDragStart={(e) => {
                                          setDraggingProjectId(p.id);
                                          e.dataTransfer.setData("text/plain", p.id);
                                          e.dataTransfer.effectAllowed = "move";
                                        }}
                                        onDragEnd={() => setDraggingProjectId(null)}
                                        className="cursor-grab select-none rounded px-1 text-xs text-[var(--ui-muted)] hover:text-[var(--ui-text)]"
                                        title={
                                          lang === "zh"
                                            ? "拖拽排序"
                                            : "Drag to reorder"
                                        }
                                      >
                                        ⋮⋮
                                      </button>
                                      <div className="min-w-0 flex-1 truncate font-medium">
                                        {p.title}
                                      </div>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          deleteProject(p.id).catch((err) =>
                                            setProjectsError(
                                              (err as Error).message,
                                            ),
                                          );
                                        }}
                                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                      >
                                        {lang === "zh" ? "删除" : "Delete"}
                                      </button>
                                    </div>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : createPane === "background" ? (
                <div className="mt-6 rounded-xl border border-zinc-200 bg-[var(--ui-surface)] p-6 dark:border-zinc-800">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">
                        {tt("create_nav_background")}
                      </div>
                      <div className="mt-2 text-xs text-[var(--ui-muted)]">
                        {lang === "zh"
                          ? "在这里维护知识库与联网检索配置。支持：条目显式列表 / 拖拽排序 / 编辑 / 删除 / 选中导出（json/txt）。"
                          : "Manage your local KB and web research config here. Supports: list / drag reorder / edit / delete / export selection (json/txt)."}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        disabled={!selectedProjectId}
                        onClick={() => {
                          refreshKbChunks().catch((e) =>
                            setKbChunksError((e as Error).message),
                          );
                        }}
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                      >
                        {lang === "zh" ? "刷新列表" : "Refresh"}
                      </button>
                      <button
                        onClick={() => {
                          setKbEditingId(null);
                          setKbTitle("");
                          setKbTags("");
                          setKbContent("");
                          setKbError(null);
                        }}
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                      >
                        {tt("clear")}
                      </button>
                    </div>
                  </div>

                  {!selectedProjectId ? (
                    <div className="mt-4 text-sm text-[var(--ui-muted)]">
                      {tt("select_project_first")}
                    </div>
                  ) : (
                    <div className="mt-4 grid gap-6 lg:grid-cols-2">
                      <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium">{tt("local_kb")}</div>
                          {kbEditingId ? (
                            <div className="text-xs text-[var(--ui-muted)]">
                              {lang === "zh"
                                ? `编辑中 #${kbEditingId}`
                                : `Editing #${kbEditingId}`}
                            </div>
                          ) : null}
                        </div>

                        <div className="mt-3 grid gap-2">
                          <div className="grid gap-2 md:grid-cols-2">
                            <label className="grid gap-1 text-sm">
                              <span className="text-xs text-[var(--ui-muted)]">
                                {tt("kb_chunk_title")}
                              </span>
                              <input
                                value={kbTitle}
                                onChange={(e) => setKbTitle(e.target.value)}
                                className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                                placeholder={tt("kb_chunk_title_placeholder")}
                              />
                            </label>
                            <label className="grid gap-1 text-sm">
                              <span className="text-xs text-[var(--ui-muted)]">
                                {tt("kb_chunk_tags")}
                              </span>
                              <input
                                value={kbTags}
                                onChange={(e) => setKbTags(e.target.value)}
                                className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                                placeholder={tt("kb_chunk_tags_placeholder")}
                              />
                            </label>
                          </div>

                          <textarea
                            value={kbContent}
                            onChange={(e) => setKbContent(e.target.value)}
                            className="min-h-[180px] w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                            placeholder={tt("kb_chunk_content_placeholder")}
                          />

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              disabled={!kbContent.trim() || settingsSaving}
                              onClick={() => {
                                const p = kbEditingId
                                  ? updateKbChunk(kbEditingId)
                                  : addKbChunk();
                                p.catch((e) => setKbError((e as Error).message));
                              }}
                              className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                            >
                              {kbEditingId
                                ? lang === "zh"
                                  ? "更新条目"
                                  : "Update"
                                : tt("save_to_kb")}
                            </button>
                            {kbEditingId ? (
                              <button
                                onClick={() => {
                                  setKbEditingId(null);
                                  setKbTitle("");
                                  setKbTags("");
                                  setKbContent("");
                                }}
                                className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                              >
                                {lang === "zh" ? "取消编辑" : "Cancel"}
                              </button>
                            ) : null}
                            <span className="text-xs text-[var(--ui-muted)]">
                              {tt("stored_locally")}
                            </span>
                          </div>

                          {kbError ? (
                            <div className="text-sm text-red-600 dark:text-red-400">
                              {kbError}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-sm font-medium">
                            {lang === "zh" ? "知识库条目" : "KB Items"}
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              value={kbExportFormat}
                              onChange={(e) =>
                                setKbExportFormat(e.target.value as "json" | "txt")
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-2 text-xs text-[var(--ui-control-text)]"
                              aria-label={lang === "zh" ? "导出格式" : "Export format"}
                            >
                              <option value="json">JSON</option>
                              <option value="txt">TXT</option>
                            </select>
                            <button
                              disabled={kbSelectedIds.length === 0}
                              onClick={() => exportSelectedKbChunks()}
                              className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                            >
                              {lang === "zh" ? "导出选中" : "Export"}
                            </button>
                          </div>
                        </div>

                        <div className="mt-2 text-xs text-[var(--ui-muted)]">
                          {lang === "zh"
                            ? "拖拽 ⋮⋮ 调整顺序；勾选后可导出。"
                            : "Drag ⋮⋮ to reorder; select items to export."}
                        </div>

                        {kbChunksError ? (
                          <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                            {kbChunksError}
                          </div>
                        ) : null}

                        <div className="mt-3 max-h-[420px] overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                          {kbChunks.length === 0 ? (
                            <div className="p-3 text-sm text-[var(--ui-muted)]">
                              {lang === "zh" ? "暂无条目。" : "No items yet."}
                            </div>
                          ) : (
                            <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                              {kbChunks.map((c) => {
                                const checked = kbSelectedIds.includes(c.id);
                                return (
                                  <li
                                    key={c.id}
                                    className="p-3"
                                    onDragOver={(e) => {
                                      if (draggingKbId == null) return;
                                      e.preventDefault();
                                    }}
                                    onDrop={(e) => {
                                      const movingRaw =
                                        draggingKbId ?? Number(e.dataTransfer.getData("text/plain"));
                                      const moving = Number(movingRaw);
                                      if (!Number.isFinite(moving) || moving === c.id) return;
                                      e.preventDefault();
                                      const next = moveByNumId(kbChunks, moving, c.id);
                                      setKbChunks(next);
                                      setDraggingKbId(null);
                                      saveProjectSettings({ kb: { chunk_order: next.map((x) => x.id) } }).catch(() => {
                                        // ignore
                                      });
                                    }}
                                  >
                                    <div className="flex items-start gap-2">
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => {
                                          setKbSelectedIds((prev) =>
                                            prev.includes(c.id)
                                              ? prev.filter((id) => id !== c.id)
                                              : [...prev, c.id],
                                          );
                                        }}
                                        className="mt-1 h-4 w-4"
                                      />
                                      <button
                                        type="button"
                                        draggable
                                        onClick={(e) => e.stopPropagation()}
                                        onDragStart={(e) => {
                                          setDraggingKbId(c.id);
                                          e.dataTransfer.setData("text/plain", String(c.id));
                                          e.dataTransfer.effectAllowed = "move";
                                        }}
                                        onDragEnd={() => setDraggingKbId(null)}
                                        className="mt-0.5 cursor-grab select-none rounded px-1 text-xs text-[var(--ui-muted)] hover:text-[var(--ui-text)]"
                                        title={lang === "zh" ? "拖拽排序" : "Drag to reorder"}
                                      >
                                        ⋮⋮
                                      </button>
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center justify-between gap-2">
                                          <div className="truncate font-medium">
                                            {c.title?.trim()
                                              ? c.title.trim()
                                              : `Chunk #${c.id}`}
                                          </div>
                                          <div className="shrink-0 text-[11px] text-[var(--ui-muted)]">
                                            {c.source_type}
                                          </div>
                                        </div>
                                        <div className="mt-1 line-clamp-2 text-xs text-[var(--ui-muted)]">
                                          {c.content}
                                        </div>
                                        {c.tags?.trim() ? (
                                          <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
                                            {c.tags}
                                          </div>
                                        ) : null}
                                      </div>
                                      <div className="flex shrink-0 flex-col gap-2">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setKbEditingId(c.id);
                                            setKbTitle(c.title || "");
                                            setKbTags(c.tags || "");
                                            setKbContent(c.content || "");
                                          }}
                                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                        >
                                          {lang === "zh" ? "编辑" : "Edit"}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            deleteKbChunk(c.id).catch((e) =>
                                              setKbChunksError((e as Error).message),
                                            );
                                          }}
                                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                        >
                                          {lang === "zh" ? "删除" : "Delete"}
                                        </button>
                                      </div>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ui-muted)]">
                          <div>
                            {lang === "zh"
                              ? `已选 ${kbSelectedIds.length} 条`
                              : `Selected: ${kbSelectedIds.length}`}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setKbSelectedIds(kbChunks.map((c) => c.id))}
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                            >
                              {lang === "zh" ? "全选" : "Select all"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setKbSelectedIds([])}
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                            >
                              {lang === "zh" ? "清空" : "Clear"}
                            </button>
                          </div>
                        </div>

                        <div className="mt-4 rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                          <div className="text-sm font-medium">{tt("kb_mode")}</div>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            {(["weak", "strong"] as const).map((mode) => {
                              const current = getSettingsValue("kb.mode", "weak");
                              const active = current === mode;
                              return (
                                <button
                                  key={mode}
                                  disabled={settingsSaving}
                                  onClick={() => {
                                    saveProjectSettings({ kb: { mode } }).catch((e) =>
                                      setSettingsError((e as Error).message),
                                    );
                                  }}
                                  className={[
                                    "rounded-md px-3 py-2 text-sm transition-colors",
                                    active
                                      ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                                      : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                                  ].join(" ")}
                                >
                                  {mode === "weak" ? tt("kb_weak") : tt("kb_strong")}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="mt-4 rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium">{tt("web_search_tool")}</div>
                            <button
                              type="button"
                              disabled={settingsSaving}
                              onClick={() => {
                                const cur = getSettingsBool("tools.web_search.enabled", true);
                                saveProjectSettings({ tools: { web_search: { enabled: !cur } } }).catch((e) =>
                                  setSettingsError((e as Error).message),
                                );
                              }}
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                            >
                              {getSettingsBool("tools.web_search.enabled", true)
                                ? tt("enabled")
                                : tt("disabled")}
                            </button>
                          </div>
                          <label className="mt-3 grid gap-1 text-sm">
                            <span className="text-xs text-[var(--ui-muted)]">
                              {tt("web_search_provider")}
                            </span>
                            <select
                              value={getSettingsValue("tools.web_search.provider", "auto")}
                              onChange={(e) => {
                                saveProjectSettings({
                                  tools: { web_search: { provider: e.target.value } },
                                }).catch((err) => setSettingsError((err as Error).message));
                              }}
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                            >
                              <option value="auto">{tt("web_search_provider_auto")}</option>
                              <option value="bing">{tt("web_search_provider_bing")}</option>
                              <option value="duckduckgo">{tt("web_search_provider_duckduckgo")}</option>
                            </select>
                            <span className="text-xs text-[var(--ui-muted)]">
                              {tt("web_search_provider_desc")}
                            </span>
                          </label>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-6 rounded-xl border border-zinc-200 bg-[var(--ui-surface)] p-6 dark:border-zinc-800">
                  <div className="text-sm font-semibold">{tt("create_nav_outline")}</div>
                  <div className="mt-2 text-xs text-[var(--ui-muted)]">
                    {lang === "zh"
                      ? "在这里维护大纲：支持上传 .txt/.json 导入，并可导出为 json/txt。更复杂的图形大纲（节点/连线）会在后续版本加入。"
                      : "Manage outline here: import via .txt/.json upload and export to json/txt. A richer graph outline (nodes/edges) will land in later versions."
                    }
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <input
                      ref={outlineFileInputRef}
                      type="file"
                      accept=".txt,.json"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        e.currentTarget.value = "";
                        if (!f) return;
                        importOutlineFile(f).catch((err) =>
                          setOutlinePaneError((err as Error).message),
                        );
                      }}
                    />
                    <button
                      type="button"
                      disabled={!selectedProjectId || settingsSaving}
                      onClick={() => outlineFileInputRef.current?.click()}
                      className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                    >
                      {lang === "zh" ? "上传导入（txt/json）" : "Import (txt/json)"}
                    </button>
                    <button
                      type="button"
                      disabled={!outlineChapters || outlineChapters.length === 0}
                      onClick={() => exportOutline("json")}
                      className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                    >
                      {lang === "zh" ? "导出 JSON" : "Export JSON"}
                    </button>
                    <button
                      type="button"
                      disabled={!outlineChapters || outlineChapters.length === 0}
                      onClick={() => exportOutline("txt")}
                      className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                    >
                      {lang === "zh" ? "导出 TXT" : "Export TXT"}
                    </button>
                    <button
                      type="button"
                      disabled={!selectedProjectId || settingsSaving}
                      onClick={() => {
                        clearOutline().catch((err) =>
                          setOutlinePaneError((err as Error).message),
                        );
                      }}
                      className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                    >
                      {lang === "zh" ? "清空大纲" : "Clear outline"}
                    </button>
                    <span className="text-xs text-[var(--ui-muted)]">
                      {lang === "zh"
                        ? "会保存到项目设置（story.outline）。"
                        : "Saved to project settings (story.outline)."}
                    </span>
                  </div>

                  {outlinePaneError ? (
                    <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                      {outlinePaneError}
                    </div>
                  ) : null}

                  {!selectedProjectId ? (
                    <div className="mt-4 text-sm text-[var(--ui-muted)]">
                      {tt("select_project_first")}
                    </div>
                  ) : (
                    <div className="mt-4 grid gap-6 lg:grid-cols-2">
                      <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium">
                                {outlineEditorMode === "mindmap"
                                  ? lang === "zh"
                                    ? "大纲思维导图（草稿）"
                                    : "Outline mindmap (draft)"
                                  : lang === "zh"
                                    ? "大纲块编辑（草稿）"
                                    : "Outline blocks (draft)"}
                              </div>
                              {outlineEditorMode === "mindmap" ? (
                                outlineGraphDirty ? (
                                  <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                                    {lang === "zh" ? "未保存" : "Unsaved"}
                                  </span>
                                ) : null
                              ) : outlineDirty ? (
                                <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                                  {lang === "zh" ? "未保存" : "Unsaved"}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-2 text-xs text-[var(--ui-muted)]">
                              {outlineEditorMode === "mindmap"
                                ? lang === "zh"
                                  ? "拖拽节点 / 连线关系箭头；修改后点击“保存导图”（会同步到已保存大纲用于写作）。"
                                  : "Drag nodes / connect edges; click “Save mindmap” (also syncs to saved outline for writing)."
                                : lang === "zh"
                                  ? "拖拽排序 / 增删改块；修改后点击“保存大纲”。"
                                  : "Drag to reorder / add/edit/delete blocks; click “Save outline” to persist."}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="inline-flex overflow-hidden rounded-md border border-zinc-200 bg-[var(--ui-control)]">
                              <button
                                type="button"
                                onClick={() => setOutlineEditorMode("blocks")}
                                className={[
                                  "px-2 py-1 text-xs",
                                  outlineEditorMode === "blocks"
                                    ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                                    : "text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                                ].join(" ")}
                              >
                                {lang === "zh" ? "块" : "Blocks"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setOutlineEditorMode("mindmap");
                                  ensureOutlineGraphDraft();
                                }}
                                className={[
                                  "px-2 py-1 text-xs",
                                  outlineEditorMode === "mindmap"
                                    ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                                    : "text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                                ].join(" ")}
                              >
                                {lang === "zh" ? "导图" : "Mindmap"}
                              </button>
                            </div>

                            {outlineEditorMode === "blocks" ? (
                              <>
                                <button
                                  type="button"
                                  disabled={settingsSaving}
                                  onClick={() => addOutlineBlock()}
                                  className="rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                                >
                                  {lang === "zh" ? "添加块" : "Add block"}
                                </button>
                                <button
                                  type="button"
                                  disabled={settingsSaving || !outlineDirty}
                                  onClick={() => {
                                    saveOutlineDraft().catch((err) =>
                                      setOutlinePaneError((err as Error).message),
                                    );
                                  }}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                                >
                                  {lang === "zh" ? "保存大纲" : "Save outline"}
                                </button>
                                <button
                                  type="button"
                                  disabled={settingsSaving}
                                  onClick={() => resetOutlineDraft()}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                                >
                                  {lang === "zh" ? "重置" : "Reset"}
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  disabled={settingsSaving}
                                  onClick={() => syncOutlineGraphFromBlocks()}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                                >
                                  {lang === "zh"
                                    ? "从草稿生成导图"
                                    : "From blocks → mindmap"}
                                </button>
                                <button
                                  type="button"
                                  disabled={settingsSaving}
                                  onClick={() => outlineMindmapFileInputRef.current?.click()}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                                >
                                  {lang === "zh" ? "导入 JSON" : "Import JSON"}
                                </button>
                                <input
                                  ref={outlineMindmapFileInputRef}
                                  type="file"
                                  accept=".json,application/json"
                                  className="hidden"
                                  onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    e.currentTarget.value = "";
                                    if (!f) return;
                                    importOutlineMindmapFile(f).catch((err) =>
                                      setOutlinePaneError((err as Error).message),
                                    );
                                  }}
                                />
                                <button
                                  type="button"
                                  disabled={!outlineGraphDraft}
                                  onClick={() => exportOutlineMindmap()}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                                >
                                  {lang === "zh" ? "导出 JSON" : "Export JSON"}
                                </button>
                                <button
                                  type="button"
                                  disabled={!outlineGraphDraft}
                                  onClick={() => autoOrderMindmapChapters()}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                                >
                                  {lang === "zh" ? "章节排序" : "Auto order"}
                                </button>
                                <button
                                  type="button"
                                  disabled={settingsSaving || !outlineGraphDraft}
                                  onClick={() => syncOutlineBlocksFromGraph()}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                                >
                                  {lang === "zh"
                                    ? "导图 → 草稿"
                                    : "Mindmap → blocks"}
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    settingsSaving || !outlineGraphDirty || !outlineGraphDraft
                                  }
                                  onClick={() => {
                                    saveOutlineGraph().catch((err) =>
                                      setOutlinePaneError((err as Error).message),
                                    );
                                  }}
                                  className="rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                                >
                                  {lang === "zh" ? "保存导图" : "Save mindmap"}
                                </button>
                                <button
                                  type="button"
                                  disabled={settingsSaving}
                                  onClick={() => resetOutlineGraphDraft()}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                                >
                                  {lang === "zh" ? "重置" : "Reset"}
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {outlineEditorMode === "blocks" ? (
                          outlineDraft.length === 0 ? (
                            <div className="mt-3 text-sm text-[var(--ui-muted)]">
                              {lang === "zh"
                                ? "还没有大纲块。你可以先上传导入，或点击“添加块”。"
                                : "No outline blocks yet. Import a file or click “Add block”."}
                            </div>
                          ) : (
                            <ul className="mt-3 space-y-3">
                              {outlineDraft.map((b) => (
                                <li
                                  key={b.id}
                                  onDragOver={(e) => {
                                    if (!draggingOutlineId) return;
                                    e.preventDefault();
                                  }}
                                  onDrop={(e) => {
                                    const moving =
                                      draggingOutlineId ||
                                      e.dataTransfer.getData("text/plain");
                                    if (!moving || moving === b.id) return;
                                    e.preventDefault();
                                    moveOutlineBlock(moving, b.id);
                                  }}
                                  className={[
                                    "rounded-lg border p-3",
                                    draggingOutlineId && draggingOutlineId !== b.id
                                      ? "border-zinc-200"
                                      : "border-zinc-200",
                                  ].join(" ")}
                                >
                                  <div className="flex items-start gap-2">
                                    <button
                                      type="button"
                                      draggable
                                      onClick={(e) => e.stopPropagation()}
                                      onDragStart={(e) => {
                                        setDraggingOutlineId(b.id);
                                        e.dataTransfer.setData("text/plain", b.id);
                                        e.dataTransfer.effectAllowed = "move";
                                      }}
                                      onDragEnd={() => setDraggingOutlineId(null)}
                                      className="mt-1 cursor-grab select-none rounded px-1 text-xs text-[var(--ui-muted)] hover:text-[var(--ui-text)]"
                                      title={
                                        lang === "zh" ? "拖拽排序" : "Drag to reorder"
                                      }
                                    >
                                      ⋮⋮
                                    </button>

                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs text-[var(--ui-muted)]">
                                          {lang === "zh"
                                            ? `第${b.index}章`
                                            : `#${b.index}`}
                                        </span>
                                        <input
                                          value={b.title}
                                          onChange={(e) =>
                                            updateOutlineBlock(b.id, {
                                              title: e.target.value,
                                            })
                                          }
                                          className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                                          placeholder={
                                            lang === "zh"
                                              ? "标题（必填）"
                                              : "Title (required)"
                                          }
                                        />
                                      </div>
                                      <textarea
                                        value={b.summary ?? ""}
                                        onChange={(e) =>
                                          updateOutlineBlock(b.id, {
                                            summary: e.target.value,
                                          })
                                        }
                                        className="mt-2 h-20 w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                                        placeholder={
                                          lang === "zh"
                                            ? "简介/剧情概要（可选）"
                                            : "Summary (optional)"
                                        }
                                      />
                                      <input
                                        value={b.goal ?? ""}
                                        onChange={(e) =>
                                          updateOutlineBlock(b.id, {
                                            goal: e.target.value,
                                          })
                                        }
                                        className="mt-2 w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                                        placeholder={
                                          lang === "zh"
                                            ? "本章目标（可选）"
                                            : "Chapter goal (optional)"
                                        }
                                      />
                                    </div>

                                    <button
                                      type="button"
                                      onClick={() => {
                                        const ok = window.confirm(
                                          lang === "zh"
                                            ? "删除这个大纲块？（不会影响已生成章节）"
                                            : "Delete this outline block? (Won't delete generated chapters)",
                                        );
                                        if (!ok) return;
                                        deleteOutlineBlock(b.id);
                                      }}
                                      className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                    >
                                      {lang === "zh" ? "删除" : "Delete"}
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )
                        ) : (
                          <div className="mt-3">
                            {outlineGraphDraft ? (
                              <OutlineGraphEditor
                                lang={lang}
                                graph={outlineGraphDraft}
                                onChange={(next) => {
                                  setOutlineGraphDraft(next);
                                  setOutlineGraphDirty(true);
                                }}
                              />
                            ) : (
                              <div className="text-sm text-[var(--ui-muted)]">
                                {lang === "zh"
                                  ? "还没有导图。你可以点击上方“导图”，或用“从草稿生成导图”。"
                                  : "No mindmap yet. Click “Mindmap” or use “From blocks → mindmap”."}
                              </div>
                            )}
                            <div className="mt-2 text-xs text-[var(--ui-muted)]">
                              {lang === "zh"
                                ? "保存导图会写入 story.outline_graph，并同步更新 story.outline（用于写作/写章节）。"
                                : "Saving mindmap writes story.outline_graph and also updates story.outline for writing."}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                        <div className="text-sm font-medium">
                          {lang === "zh"
                            ? "已保存的大纲（用于写作）"
                            : "Saved outline (used for writing)"}
                        </div>
                        {outlineChapters ? (
                          <ol className="mt-3 space-y-2 text-sm">
                            {outlineChapters.map((ch) => (
                              <li
                                key={`${ch.index}:${ch.title}`}
                                className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
                              >
                                <div className="font-medium">
                                  {ch.index}. {ch.title}
                                </div>
                                {ch.summary ? (
                                  <div className="mt-1 text-xs text-[var(--ui-muted)]">
                                    {ch.summary}
                                  </div>
                                ) : null}
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <div className="mt-2 text-sm text-[var(--ui-muted)]">
                            {tt("no_outline")}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            ) : (
              <div className="mt-6 rounded-xl border border-zinc-200 bg-[var(--ui-surface)] p-6 dark:border-zinc-800">
                <div className="text-sm font-semibold">{tt("continue_nav_book")}</div>
                <div className="mt-2 text-xs text-[var(--ui-muted)]">
                  {lang === "zh"
                    ? "v1.6.0：先支持上传 .txt/.json 作为“书籍源”（本地落盘 + 预览截取）。v2.0.0：再落地百万字级书籍续写（分片→并行总结→角色卡→世界观/时间线→续写）。"
                    : "v1.6.0: Upload .txt/.json as a local book source (stored on disk with preview slicing). v2.0.0: million-word book continuation (chunk → parallel summaries → character cards → world/timeline → continue)."
                  }
                </div>

                {!selectedProjectId ? (
                  <div className="mt-4 text-sm text-[var(--ui-muted)]">
                    {tt("select_project_first")}
                  </div>
                ) : (
                  <div className="mt-4 grid gap-6 lg:grid-cols-2">
                    <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                      <div className="text-sm font-medium">
                        {lang === "zh" ? "上传书籍文件（推荐）" : "Upload a book file (recommended)"}
                      </div>
                      <div className="mt-2 text-xs text-[var(--ui-muted)]">
                        {lang === "zh"
                          ? "现支持：上传书籍源（txt/json）→ 预览截取 → 分片索引 → 总结入库 → 编译书籍状态（角色卡/时间线）→ 书籍续写（工作台）。"
                          : "Now supports: upload (txt/json) → sliced preview → chunk index → chunk summaries into KB → compile book state (character cards/timeline) → continue book (workspace)."}
                      </div>

                      <div
                        className={[
                          "mt-3 rounded-lg border border-dashed p-4 transition-colors",
                          bookDropActive
                            ? "border-[var(--ui-accent)] bg-[var(--ui-surface)]"
                            : "border-zinc-200 bg-[var(--ui-surface)]",
                        ].join(" ")}
                        onDragEnter={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setBookDropActive(true);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setBookDropActive(true);
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setBookDropActive(false);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setBookDropActive(false);
                          const f = e.dataTransfer.files?.[0] ?? null;
                          if (!f) return;
                          uploadBookContinueFile(f).catch((err) =>
                            setBookSourceError((err as Error).message),
                          );
                        }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-xs text-[var(--ui-muted)]">
                            {lang === "zh"
                              ? "拖拽文件到此处，或点击按钮选择文件。"
                              : "Drag & drop a file here, or click to choose."}
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              key={bookSourceToken}
                              type="file"
                              accept=".txt,.json"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0] ?? null;
                                e.currentTarget.value = "";
                                if (!f) return;
                                uploadBookContinueFile(f).catch((err) =>
                                  setBookSourceError((err as Error).message),
                                );
                              }}
                              ref={bookFileInputRef}
                            />
                            <button
                              type="button"
                              disabled={bookSourceLoading}
                              onClick={() => {
                                bookFileInputRef.current?.click();
                              }}
                              className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                            >
                              {lang === "zh"
                                ? bookSourceLoading
                                  ? "提取中…"
                                  : "选择文件"
                                : bookSourceLoading
                                  ? "Extracting…"
                                  : "Choose file"}
                            </button>
                            <button
                              type="button"
                              disabled={bookSourceLoading && !bookSourceId}
                              onClick={() => clearBookContinueInput()}
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                            >
                              {lang === "zh" ? "清空" : "Clear"}
                            </button>
                          </div>
                        </div>

                        {bookSourceId ? (
                          <div className="mt-3 text-xs text-[var(--ui-muted)]">
                            {lang === "zh" ? "已保存书籍源：" : "Saved book source:"}{" "}
                            <span className="font-medium text-[var(--ui-text)]">
                              {bookSourceMeta?.filename ?? bookSourceId}
                            </span>
                            {typeof bookSourceMeta?.chars === "number" ? (
                              <span className="ml-2">
                                {lang === "zh"
                                  ? `字符数≈${bookSourceMeta.chars}`
                                  : `chars≈${bookSourceMeta.chars}`}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        <label className="grid gap-1 text-sm">
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("continue_excerpt_mode")}
                          </span>
                          <select
                            value={continueExcerptMode}
                            onChange={(e) =>
                              setContinueExcerptMode(
                                e.target.value === "head" ? "head" : "tail",
                              )
                            }
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                          >
                            <option value="tail">{tt("continue_excerpt_tail")}</option>
                            <option value="head">{tt("continue_excerpt_head")}</option>
                          </select>
                        </label>
                        <label className="grid gap-1 text-sm">
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("continue_excerpt_chars")}
                          </span>
                          <input
                            type="number"
                            min={1000}
                            max={200000}
                            value={continueExcerptChars}
                            onChange={(e) =>
                              setContinueExcerptChars(Number(e.target.value))
                            }
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                          />
                        </label>
                      </div>

                      {bookSourceError ? (
                        <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                          {bookSourceError}
                        </div>
                      ) : null}
                    </div>

                    <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium">
                          {lang === "zh" ? "书籍源预览（截取）" : "Book preview (sliced)"}
                        </div>
                        <button
                          type="button"
                          disabled={!bookSourceId || bookSourceLoading}
                          onClick={() => {
                            if (!bookSourceId) return;
                            refreshBookContinuePreview(bookSourceId).catch((err) =>
                              setBookSourceError((err as Error).message),
                            );
                          }}
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                        >
                          {lang === "zh" ? "刷新预览" : "Refresh"}
                        </button>
                      </div>
                      <textarea
                        value={bookInputText}
                        onChange={(e) => {
                          if (bookSourceId) return;
                          setBookInputText(e.target.value);
                        }}
                        readOnly={Boolean(bookSourceId)}
                        className="mt-3 h-64 w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                        placeholder={
                          lang === "zh"
                            ? "上传 .txt/.json 后会在这里显示预览（可配置头/尾截取）。也可以直接粘贴少量文本后点击“保存为书籍源”。"
                            : "Upload .txt/.json to preview here (head/tail slicing). Or paste a small snippet and click “Save as book source”."
                        }
                      />
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={Boolean(bookSourceId) || !bookInputText.trim()}
                          onClick={() => {
                            if (bookSourceId) return;
                            uploadBookContinueText(bookInputText).catch((err) =>
                              setBookSourceError((err as Error).message),
                            );
                          }}
                          className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                        >
                          {lang === "zh" ? "保存为书籍源" : "Save as book source"}
                        </button>
                        <span className="text-xs text-[var(--ui-muted)]">
                          {lang === "zh"
                            ? "这一步不调用 LLM，只是把文本保存在本地（gitignored）。"
                            : "No LLM call here — stored locally (gitignored)."}
                        </span>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={!bookSourceId}
                          onClick={() => {
                            if (!bookSourceId) return;
                            setContinueSourceError(null);
                            setContinueSourceId(bookSourceId);
                            setContinueSourceMeta(bookSourceMeta);
                            setContinueInputText(bookInputText);
                            setContinueRunKind("book_continue");
                            setContinuePane("article");
                          }}
                          className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                        >
                          {lang === "zh"
                            ? "进入续写工作台（书籍模式）"
                            : "Open Continue workspace (book mode)"}
                        </button>
                        <span className="text-xs text-[var(--ui-muted)]">
                          {lang === "zh"
                            ? "会把书籍源加载到工作台，并使用「书籍续写」链路（基于书籍状态）生成章节，支持批量与落库可见。"
                            : "Loads the book source into the workspace and uses the Book continuation pipeline (compiled book state), with batch + persisted chapters."}
                        </span>
                      </div>

                      <div className="mt-4 rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-4 dark:border-zinc-800">
                        <div className="text-sm font-medium">
                          {lang === "zh"
                            ? "书籍分片索引 / 总结入库（MVP）"
                            : "Book chunk index / summarize into KB (MVP)"}
                        </div>
                        <div className="mt-2 text-xs text-[var(--ui-muted)]">
                          {lang === "zh"
                            ? "先生成分片索引（不调用 LLM），再用 LLM 对每片做简要总结并写入本地知识库（为 v2.0 的百万字续写链路打底）。"
                            : "Build a chunk index (no LLM), then summarize each chunk via LLM and store into the local KB (foundation for v2.0 long-book continuation)."}
                        </div>

                        <div className="mt-3 grid gap-2 md:grid-cols-3">
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs text-[var(--ui-muted)]">
                              {lang === "zh" ? "分片长度（字符）" : "Chunk size (chars)"}
                            </span>
                            <input
                              type="number"
                              min={500}
                              max={30000}
                              value={bookChunkChars}
                              onChange={(e) =>
                                setBookChunkChars(Number(e.target.value))
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                            />
                          </label>
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs text-[var(--ui-muted)]">
                              {lang === "zh"
                                ? "重叠（字符）"
                                : "Overlap (chars)"}
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={10000}
                              value={bookOverlapChars}
                              onChange={(e) =>
                                setBookOverlapChars(Number(e.target.value))
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                            />
                          </label>
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs text-[var(--ui-muted)]">
                              {lang === "zh" ? "最多分片数" : "Max chunks"}
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={2000}
                              value={bookMaxChunks}
                              onChange={(e) =>
                                setBookMaxChunks(Number(e.target.value))
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                            />
                          </label>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={!bookSourceId || bookIndexLoading}
                            onClick={() => {
                              if (!bookSourceId) return;
                              buildBookIndex(bookSourceId).catch(() => {
                                // error already surfaced
                              });
                            }}
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                          >
                            {bookIndexLoading
                              ? lang === "zh"
                                ? "生成中..."
                                : "Building..."
                              : lang === "zh"
                                ? "生成分片索引"
                                : "Build index"}
                          </button>
                          <button
                            type="button"
                            disabled={
                              !bookSourceId ||
                              runInProgress ||
                              settingsSaving ||
                              secretsSaving
                            }
                            onClick={() => {
                              if (!bookSourceId) return;
                              runPipeline("book_summarize", {
                                source_id: bookSourceId,
                                chunk_chars: bookChunkChars,
                                overlap_chars: bookOverlapChars,
                                max_chunks: bookMaxChunks,
                                replace_existing: bookSummarizeReplaceExisting,
                                summary_chars: 500,
                              })
                                .then((r) => {
                                  if (r.ok) {
                                    // KB list is used in other panes; refresh best-effort.
                                    refreshKbChunks().catch(() => {
                                      // ignore
                                    });
                                  }
                                })
                                .catch((e) => setRunError((e as Error).message));
                            }}
                            className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                          >
                            {lang === "zh" ? "总结入库（LLM）" : "Summarize into KB (LLM)"}
                          </button>
                          <button
                            type="button"
                            disabled={
                              !bookSourceId ||
                              runInProgress ||
                              settingsSaving ||
                              secretsSaving
                            }
                            onClick={() => {
                              if (!bookSourceId) return;
                              runPipeline("book_compile", { source_id: bookSourceId })
                                .then((r) => {
                                  if (r.ok) {
                                    refreshKbChunks().catch(() => {
                                      // ignore
                                    });
                                  }
                                })
                                .catch((e) => setRunError((e as Error).message));
                            }}
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                          >
                            {lang === "zh" ? "编译书籍状态（LLM）" : "Compile book state (LLM)"}
                          </button>
                          <label className="flex items-center gap-2 text-xs text-[var(--ui-muted)]">
                            <input
                              type="checkbox"
                              checked={bookSummarizeReplaceExisting}
                              onChange={(e) =>
                                setBookSummarizeReplaceExisting(e.target.checked)
                              }
                            />
                            {lang === "zh"
                              ? "覆盖旧的书籍总结"
                              : "Replace existing summaries"}
                          </label>
                          <button
                            type="button"
                            disabled={!bookIndex && !bookSummarizeStats && !bookState}
                            onClick={() => {
                              setBookIndex(null);
                              setBookIndexError(null);
                              setBookSummarizeStats(null);
                              setBookState(null);
                            }}
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                          >
                            {lang === "zh" ? "清除结果" : "Clear results"}
                          </button>
                        </div>

                        {bookIndexError ? (
                          <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                            {bookIndexError}
                          </div>
                        ) : null}

                        {bookSummarizeStats ? (
                          <div className="mt-2 rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] dark:border-zinc-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-[var(--ui-muted)]">
                                {lang === "zh"
                                  ? `已处理 ${bookSummarizeStats.processed} 片，入库 ${bookSummarizeStats.created}，失败 ${bookSummarizeStats.failed}`
                                  : `Processed ${bookSummarizeStats.processed}, stored ${bookSummarizeStats.created}, failed ${bookSummarizeStats.failed}`}
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setTab("create");
                                  setCreatePane("background");
                                }}
                                className="rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90"
                              >
                                {lang === "zh"
                                  ? "去背景设定查看知识库"
                                  : "Open KB (Background)"}
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {bookState ? (
                          <div className="mt-2 rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] dark:border-zinc-800">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-[var(--ui-muted)]">
                                  {lang === "zh"
                                    ? `书籍状态已编译（KB#${bookState.kb_chunk_id}）`
                                    : `Book state compiled (KB#${bookState.kb_chunk_id})`}
                                </div>
                                {bookState.preview ? (
                                  <div className="mt-2 whitespace-pre-wrap text-[11px] text-[var(--ui-muted)]">
                                    {bookState.preview}
                                  </div>
                                ) : null}
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setTab("create");
                                  setCreatePane("background");
                                }}
                                className="shrink-0 rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90"
                              >
                                {lang === "zh"
                                  ? "去背景设定查看知识库"
                                  : "Open KB (Background)"}
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {bookIndex ? (
                          <div className="mt-3 rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] dark:border-zinc-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-[var(--ui-muted)]">
                                {lang === "zh"
                                  ? `索引：${bookIndex.total_chunks} 片${
                                      bookIndex.truncated ? "（可能被截断）" : ""
                                    }`
                                  : `Index: ${bookIndex.total_chunks} chunks${
                                      bookIndex.truncated ? " (maybe truncated)" : ""
                                    }`}
                              </div>
                              <button
                                type="button"
                                disabled={!bookSourceId}
                                onClick={() => {
                                  if (!bookSourceId) return;
                                  buildBookIndex(bookSourceId).catch(() => {
                                    // ignore
                                  });
                                }}
                                className="rounded-md border border-zinc-200 bg-[var(--ui-bg)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-surface)] dark:border-zinc-800"
                              >
                                {lang === "zh" ? "刷新索引" : "Refresh"}
                              </button>
                            </div>
                            {bookIndex.chunks.length > 0 ? (
                              <div className="mt-3 max-h-64 overflow-auto rounded-md border border-zinc-200 bg-[var(--ui-bg)] p-2 dark:border-zinc-800">
                                <ol className="space-y-2">
                                  {bookIndex.chunks.map((c) => (
                                    <li
                                      key={`${bookIndex.source_id}:${c.index}`}
                                      className="rounded-md border border-zinc-200 bg-[var(--ui-surface)] p-2 dark:border-zinc-800"
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="font-medium">
                                          #{c.index}
                                        </div>
                                        <div className="text-[11px] text-[var(--ui-muted)]">
                                          {lang === "zh"
                                            ? `字符≈${c.chars} · 起始≈${c.start_char}`
                                            : `chars≈${c.chars} · start≈${c.start_char}`}
                                        </div>
                                      </div>
                                      {c.preview_head ? (
                                        <div className="mt-2 whitespace-pre-wrap text-[11px] text-[var(--ui-muted)]">
                                          {c.preview_head}
                                        </div>
                                      ) : null}
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        ) : null}

        {tab === "agents" ? (
          <section className="rounded-xl border border-zinc-200 bg-[var(--ui-surface)] p-6">
            <h1 className="text-lg font-semibold">{tt("agents")}</h1>
            <p className="mt-2 text-sm text-[var(--ui-muted)]">
              {tt("agents_desc")}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <select
                value={selectedRunId ?? ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setSelectedRunId(v);
                  setRunEvents([]);
                  setExpandedEventKey(null);
                }}
                className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
              >
                {runs.length === 0 ? (
                  <option value="">{tt("no_runs")}</option>
                ) : (
                  runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {formatRunKind(r.kind)} · {formatRunStatus(r.status)} ·{" "}
                      {new Date(r.created_at).toLocaleString()}
                    </option>
                  ))
                )}
              </select>
              <button
                onClick={() => setAgentsView("timeline")}
                className={[
                  "rounded-md px-3 py-2 text-sm",
                  agentsView === "timeline"
                    ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                    : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                ].join(" ")}
              >
                {tt("timeline")}
              </button>
              <button
                onClick={() => setAgentsView("graph")}
                className={[
                  "rounded-md px-3 py-2 text-sm",
                  agentsView === "graph"
                    ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                    : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                ].join(" ")}
              >
                {tt("graph")}
              </button>
              <span className="text-xs text-[var(--ui-muted)]">
                {tt("events")}: {runEvents.length}
              </span>
            </div>

            <div className="mt-6 rounded-lg border border-zinc-200 dark:border-zinc-800">
              {runEvents.length === 0 ? (
                <div className="p-4 text-sm text-[var(--ui-muted)]">
                  {tt("no_events")}
                </div>
              ) : agentsView === "timeline" ? (
                <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                  {runEvents.map((e) => {
                    const eventKey = `${e.run_id}:${e.seq}`;
                    const d = e.data as Record<string, unknown>;
                    const tool = typeof d.tool === "string" ? d.tool : null;
                    const hits = typeof d.hits === "number" ? d.hits : null;
                    const warnings = Array.isArray(d.warnings)
                      ? (d.warnings.filter(
                          (w): w is string => typeof w === "string",
                        ) as string[])
                      : [];
                    const artifactType =
                      typeof d.artifact_type === "string" ? d.artifact_type : null;
                    const text = typeof d.text === "string" ? d.text : null;
                    const expanded = expandedEventKey === eventKey;

                    const detailPreview = (() => {
                      // Prevent rendering multi-KB JSON / full chapter markdown in the timeline.
                      const safe: Record<string, unknown> = { ...d };
                      if (typeof safe.markdown === "string") {
                        safe.markdown = clipText(safe.markdown, 1200);
                      }
                      if (typeof safe.text === "string") {
                        safe.text = clipText(safe.text, 1200);
                      }
                      const raw = JSON.stringify(safe, null, 2);
                      return clipText(raw, 4000);
                    })();

                    return (
                      <li
                        key={eventKey}
                        className="border-l-4 p-3"
                        style={{ borderLeftColor: agentColor(e.agent) }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">
                                {e.seq}. {formatEventType(e.type)}
                              </span>
                              {e.agent ? (
                                <span
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-0.5 text-xs text-[var(--ui-control-text)]"
                                  style={{ borderColor: agentColor(e.agent) }}
                                >
                                  {formatAgentName(e.agent)}
                                </span>
                              ) : null}
                              {tool ? (
                                <span className="text-xs text-[var(--ui-muted)]">
                                  tool: {tool}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <div className="shrink-0 text-xs text-[var(--ui-muted)]">
                            {new Date(e.ts).toLocaleTimeString()}
                          </div>
                        </div>

                        {text ? (
                          <div className="mt-1 text-[var(--ui-text)]">
                            {clipText(text, 520)}
                          </div>
                        ) : null}

                        {hits !== null ? (
                          <div className="mt-1 text-xs text-[var(--ui-muted)]">
                            hits: {hits}
                          </div>
                        ) : null}

                        {warnings.length > 0 ? (
                          <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                            {warnings.map((w, idx) => (
                              <div key={idx}>{w}</div>
                            ))}
                          </div>
                        ) : null}

                        {artifactType ? (
                          <div className="mt-1 text-xs text-[var(--ui-muted)]">
                            artifact: {artifactType}
                          </div>
                        ) : null}

                        {Object.keys(d).length > 0 ? (
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() =>
                                setExpandedEventKey((cur) =>
                                  cur === eventKey ? null : eventKey,
                                )
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                            >
                              {expanded
                                ? lang === "zh"
                                  ? "收起"
                                  : "Hide"
                                : lang === "zh"
                                  ? "详情"
                                  : "Details"}
                            </button>
                          </div>
                        ) : null}

                        {expanded ? (
                          <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)]">
                            {detailPreview}
                          </pre>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="p-4">
                  <div className="text-sm font-medium">{tt("execution_flow")}</div>
                  <div className="mt-3 overflow-auto">
                    {agentFlow.length === 0 ? (
                      <div className="text-sm text-[var(--ui-muted)]">
                        {tt("no_agents_in_events")}
                      </div>
                    ) : (
                      <div className="flex min-w-max items-center gap-2 pb-2">
                        {agentFlow.map((a, idx) => {
                          const st = agentStats[a];
                          return (
                            <div key={`${a}:${idx}`} className="flex items-center gap-2">
                              <div
                                className="rounded-lg border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)]"
                                style={{ borderColor: agentColor(a) }}
                              >
                                <div className="font-medium">{formatAgentName(a)}</div>
                                {st ? (
                                  <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
                                    t={formatDurationMs(st.total_ms)} · tools={st.tool_calls} · artifacts={st.artifacts}
                                  </div>
                                ) : null}
                              </div>
                              {idx < agentFlow.length - 1 ? (
                                <span className="text-xs text-zinc-400">→</span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="mt-4 text-xs text-[var(--ui-muted)]">
                    {tt("compressed_view")}
                  </div>
                </div>
              )}
            </div>
          </section>
        ) : null}

        {tab === "settings" ? (
          <section className="rounded-xl border border-zinc-200 bg-[var(--ui-surface)] p-6">
            <h1 className="text-lg font-semibold">{tt("settings")}</h1>
            <p className="mt-2 text-sm text-[var(--ui-muted)]">
              {tt("settings_desc")}
            </p>

            <div className="mt-6 grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
              <aside className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-3 dark:border-zinc-800">
                <div className="grid gap-1">
                  {(
                    [
                      ["ui", tt("settings_nav_ui")],
                      ["model", tt("settings_nav_model")],
                      ["project", tt("settings_nav_project")],
                      ["export", tt("settings_nav_export")],
                      ["debug", tt("settings_nav_debug")],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setSettingsPane(k)}
                      className={[
                        "w-full rounded-md px-3 py-2 text-left text-sm transition-colors",
                        settingsPane === k
                          ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                          : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-900",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </aside>

              <div className="min-w-0 grid gap-6">
                {settingsPane === "ui" ? (
                  <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                <div className="text-sm font-medium">{tt("ui_prefs")}</div>
                <div className="mt-4 grid gap-3">
                  <label className="grid gap-1 text-sm">
                    <span className="text-xs text-[var(--ui-muted)]">
                      {tt("language")}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setLang("zh")}
                        className={[
                          "rounded-md px-3 py-2 text-sm transition-colors",
                          lang === "zh"
                            ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                            : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                        ].join(" ")}
                      >
                        中文
                      </button>
                      <button
                        onClick={() => setLang("en")}
                        className={[
                          "rounded-md px-3 py-2 text-sm transition-colors",
                          lang === "en"
                            ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                            : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                        ].join(" ")}
                      >
                        EN
                      </button>
                    </div>
                  </label>

                  <label className="grid gap-1 text-sm">
                    <span className="text-xs text-[var(--ui-muted)]">
                      {tt("theme")}
                    </span>
                    <select
                      value={themeId}
                      onChange={(e) => setThemeId(e.target.value)}
                      className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                    >
                      {themes.map((th) => (
                        <option key={th.id} value={th.id}>
                          {th.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="mt-2 rounded-md border border-zinc-200 bg-[var(--ui-bg)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-medium text-[var(--ui-muted)]">
                        {tt("logo")}
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]">
                          {tt("upload_image")}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (!f) return;
                              (async () => {
                                const dataUrl = await fileToCompressedDataUrl(f, {
                                  maxSize: 160,
                                  quality: 0.85,
                                });
                                setBrandLogoDataUrl(dataUrl);
                              })().catch(() => {});
                              e.target.value = "";
                            }}
                          />
                        </label>
                        <button
                          disabled={!brandLogoDataUrl}
                          onClick={() => setBrandLogoDataUrl(null)}
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                        >
                          {tt("remove_image")}
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                      <div className="h-12 w-12 overflow-hidden rounded-lg ring-1 ring-black/10">
                        {brandLogoDataUrl ? (
                          <img
                            src={brandLogoDataUrl}
                            alt={tt("logo")}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="h-full w-full bg-[var(--ui-accent)]" />
                        )}
                      </div>
                      <div className="text-xs text-[var(--ui-muted)]">
                        {lang === "zh"
                          ? "将显示在左上角（仅本机浏览器保存）。"
                          : "Shown in the top-left (stored in this browser only)."}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 rounded-md border border-zinc-200 bg-[var(--ui-bg)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-medium text-[var(--ui-muted)]">
                        {tt("background_image")}
                      </div>
                      <label className="flex items-center gap-2 text-xs text-[var(--ui-muted)]">
                        <span>
                          {uiBackground.enabled ? tt("enabled") : tt("disabled")}
                        </span>
                        <input
                          type="checkbox"
                          checked={uiBackground.enabled}
                          onChange={(e) =>
                            setUiBackground((prev) => ({
                              ...prev,
                              enabled: e.target.checked,
                            }))
                          }
                        />
                      </label>
                    </div>

                    <div className="mt-3 grid gap-3">
                      <div className="flex items-center gap-2">
                        <label className="cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]">
                          {tt("upload_image")}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (!f) return;
                              (async () => {
                                const dataUrl = await fileToCompressedDataUrl(f, {
                                  maxSize: 1920,
                                  quality: 0.82,
                                });
                                setUiBackground((prev) => ({
                                  ...prev,
                                  enabled: true,
                                  image_data_url: dataUrl,
                                }));
                              })().catch(() => {});
                              e.target.value = "";
                            }}
                          />
                        </label>
                        <button
                          disabled={!uiBackground.image_data_url}
                          onClick={() =>
                            setUiBackground((prev) => ({
                              ...prev,
                              enabled: false,
                              image_data_url: null,
                            }))
                          }
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                        >
                          {tt("remove_image")}
                        </button>
                      </div>

                      {uiBackground.image_data_url ? (
                        <div className="h-20 overflow-hidden rounded-lg ring-1 ring-black/10">
                          <div
                            className="h-full w-full bg-cover bg-center"
                            style={{
                              backgroundImage: `url(${uiBackground.image_data_url})`,
                              filter: `blur(${uiBackground.blur_px}px)`,
                              opacity: uiBackground.opacity,
                            }}
                          />
                        </div>
                      ) : (
                        <div className="text-xs text-[var(--ui-muted)]">
                          {lang === "zh" ? "未设置背景图。" : "No background image set."}
                        </div>
                      )}

                      <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                        {tt("opacity")}: {uiBackground.opacity.toFixed(2)}
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={uiBackground.opacity}
                          onChange={(e) =>
                            setUiBackground((prev) => ({
                              ...prev,
                              opacity: Number(e.target.value),
                            }))
                          }
                        />
                      </label>

                      <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                        {tt("blur")}: {uiBackground.blur_px}px
                        <input
                          type="range"
                          min={0}
                          max={50}
                          step={1}
                          value={uiBackground.blur_px}
                          onChange={(e) =>
                            setUiBackground((prev) => ({
                              ...prev,
                              blur_px: Number(e.target.value),
                            }))
                          }
                        />
                      </label>
                    </div>
                  </div>

                  <div className="mt-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-[var(--ui-muted)]">
                        {tt("theme_manage")}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            // Add a new theme preset ("category") that the user can rename/recolor.
                            const id =
                              globalThis.crypto?.randomUUID?.() ??
                              `theme_${Date.now()}_${Math.random().toString(16).slice(2)}`;
                            const next: UiTheme = {
                              id,
                              name: lang === "zh" ? "自定义主题" : "Custom theme",
                              bg: "#FFFFFF",
                              surface: "#FFFFFF",
                              text: "#0B1020",
                              muted: "#52525B",
                              control: "#FFFFFF",
                              control_text: "#0B1020",
                              accent: "#22C55E",
                              accent_foreground: "#0B1020",
                            };
                            setThemes((prev) => [...prev, next]);
                            setThemeId(id);
                          }}
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                        >
                          {tt("add_theme")}
                        </button>
                        <button
                          onClick={() => {
                            setThemes(DEFAULT_THEMES);
                            setThemeId(DEFAULT_THEMES[0]?.id ?? "dawn");
                          }}
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                        >
                          {tt("reset_themes")}
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-3">
                      {themes.map((th) => {
                        const active = th.id === themeId;
                        return (
                          <div
                            key={th.id}
                            className={[
                              "rounded-md border p-3",
                              active
                                ? "border-[var(--ui-accent)]"
                                : "border-zinc-200 dark:border-zinc-800",
                            ].join(" ")}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-2">
                                <div className="flex h-4 w-10 shrink-0 overflow-hidden rounded-sm ring-1 ring-black/10">
                                  <div
                                    className="h-full w-1/3"
                                    style={{ backgroundColor: th.bg }}
                                  />
                                  <div
                                    className="h-full w-1/3"
                                    style={{ backgroundColor: th.surface }}
                                  />
                                  <div
                                    className="h-full w-1/3"
                                    style={{ backgroundColor: th.accent }}
                                  />
                                </div>
                                <input
                                  value={th.name}
                                  onChange={(e) => {
                                    const name = e.target.value;
                                    setThemes((prev) =>
                                      prev.map((x) =>
                                        x.id === th.id ? { ...x, name } : x,
                                      ),
                                    );
                                  }}
                                  className="w-full min-w-0 rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-sm text-[var(--ui-control-text)]"
                                  aria-label={tt("theme_name")}
                                />
                              </div>

                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => setThemeId(th.id)}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                                >
                                  {tt("theme")}
                                </button>
                                <button
                                  disabled={themes.length <= 1}
                                  onClick={() => {
                                    setThemes((prev) => {
                                      const next = prev.filter((x) => x.id !== th.id);
                                      const ensured = next.length > 0 ? next : DEFAULT_THEMES;
                                      setThemeId((cur) =>
                                        cur === th.id ? ensured[0]!.id : cur,
                                      );
                                      return ensured;
                                    });
                                  }}
                                  className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                                >
                                  {tt("delete_theme")}
                                </button>
                              </div>
                            </div>

                            <div className="mt-3 grid gap-2 md:grid-cols-2">
                              <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                                {tt("theme_bg")}
                                <input
                                  type="color"
                                  value={th.bg}
                                  onChange={(e) => {
                                    const v =
                                      normalizeHexColor(e.target.value) ?? th.bg;
                                    setThemes((prev) =>
                                      prev.map((x) =>
                                        x.id === th.id ? { ...x, bg: v } : x,
                                      ),
                                    );
                                  }}
                                  className="h-9 w-full cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] p-1"
                                />
                              </label>
                              <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                                {tt("theme_surface")}
                                <input
                                  type="color"
                                  value={th.surface}
                                  onChange={(e) => {
                                    const v =
                                      normalizeHexColor(e.target.value) ?? th.surface;
                                    setThemes((prev) =>
                                      prev.map((x) =>
                                        x.id === th.id ? { ...x, surface: v } : x,
                                      ),
                                    );
                                  }}
                                  className="h-9 w-full cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] p-1"
                                />
                              </label>
                              <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                                {tt("theme_text")}
                                <input
                                  type="color"
                                  value={th.text}
                                  onChange={(e) => {
                                    const v =
                                      normalizeHexColor(e.target.value) ?? th.text;
                                    setThemes((prev) =>
                                      prev.map((x) =>
                                        x.id === th.id ? { ...x, text: v } : x,
                                      ),
                                    );
                                  }}
                                  className="h-9 w-full cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] p-1"
                                />
                              </label>
                              <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                                {tt("theme_muted")}
                                <input
                                  type="color"
                                  value={th.muted}
                                  onChange={(e) => {
                                    const v =
                                      normalizeHexColor(e.target.value) ?? th.muted;
                                    setThemes((prev) =>
                                      prev.map((x) =>
                                        x.id === th.id ? { ...x, muted: v } : x,
                                      ),
                                    );
                                  }}
                                  className="h-9 w-full cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] p-1"
                                />
                              </label>
                              <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                                {tt("theme_control")}
                                <input
                                  type="color"
                                  value={th.control}
                                  onChange={(e) => {
                                    const v =
                                      normalizeHexColor(e.target.value) ?? th.control;
                                    setThemes((prev) =>
                                      prev.map((x) =>
                                        x.id === th.id ? { ...x, control: v } : x,
                                      ),
                                    );
                                  }}
                                  className="h-9 w-full cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] p-1"
                                />
                              </label>
                              <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                                {tt("theme_control_text")}
                                <input
                                  type="color"
                                  value={th.control_text}
                                  onChange={(e) => {
                                    const v =
                                      normalizeHexColor(e.target.value) ??
                                      th.control_text;
                                    setThemes((prev) =>
                                      prev.map((x) =>
                                        x.id === th.id
                                          ? { ...x, control_text: v }
                                          : x,
                                      ),
                                    );
                                  }}
                                  className="h-9 w-full cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] p-1"
                                />
                              </label>
                              <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                                {tt("accent")}
                                <input
                                  type="color"
                                  value={th.accent}
                                  onChange={(e) => {
                                    const v =
                                      normalizeHexColor(e.target.value) ?? th.accent;
                                    setThemes((prev) =>
                                      prev.map((x) =>
                                        x.id === th.id ? { ...x, accent: v } : x,
                                      ),
                                    );
                                  }}
                                  className="h-9 w-full cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] p-1"
                                />
                              </label>
                              <label className="grid gap-1 text-xs text-[var(--ui-muted)]">
                                {tt("accent_text")}
                                <input
                                  type="color"
                                  value={th.accent_foreground}
                                  onChange={(e) => {
                                    const v =
                                      normalizeHexColor(e.target.value) ??
                                      th.accent_foreground;
                                    setThemes((prev) =>
                                      prev.map((x) =>
                                        x.id === th.id
                                          ? { ...x, accent_foreground: v }
                                          : x,
                                      ),
                                    );
                                  }}
                                  className="h-9 w-full cursor-pointer rounded-md border border-zinc-200 bg-[var(--ui-control)] p-1"
                                />
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
                ) : null}

              {settingsPane === "debug" ? (
                <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                <div className="text-sm font-medium">{tt("secrets_status")}</div>
                <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {tt("secrets_desc")}
                </div>
                <div className="mt-3 space-y-2 text-sm">
                  {secretsStatus ? (
                    <>
                      <div>
                        {tt("gpt_key")}:{" "}
                        {secretsStatus.openai_api_key_present
                          ? tt("present")
                          : tt("missing")}
                      </div>
                      <div>
                        {tt("gemini_key")}:{" "}
                        {secretsStatus.gemini_api_key_present
                          ? tt("present")
                          : tt("missing")}
                      </div>
                    </>
                  ) : (
                    <div className="text-zinc-500 dark:text-zinc-400">
                      {tt("not_available_backend")}
                    </div>
                  )}
                </div>
              </div>
              ) : null}

              {settingsPane === "model" ? (
              <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                <div className="text-sm font-medium">{tt("settings_nav_model")}</div>
                <div className="mt-2 text-xs text-[var(--ui-muted)]">
                  {tt("select_project_first")}
                </div>

                <div className="mt-4 rounded-md border border-zinc-200 bg-[var(--ui-bg)] p-3">
                  <div className="text-xs font-medium text-[var(--ui-muted)]">
                    {tt("api_keys")}
                  </div>
                  <div className="mt-2 text-[11px] text-[var(--ui-muted)]">
                    {tt("api_keys_hint")}
                  </div>

                  {secretsStatus ? (
                    <div className="mt-3 grid gap-3">
                      <div className="grid gap-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("gpt_key")}
                          </span>
                          <span className="text-[11px] text-[var(--ui-muted)]">
                            {secretsStatus.openai_api_key_present
                              ? tt("present")
                              : tt("missing")}
                          </span>
                        </div>
                        <div className="flex flex-col gap-2 md:flex-row md:items-center">
                          <input
                            type="password"
                            value={openaiApiKeyDraft}
                            onChange={(e) => setOpenaiApiKeyDraft(e.target.value)}
                            placeholder={tt("api_key_placeholder")}
                            className="flex-1 rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                          />
                          <div className="flex gap-2">
                            <button
                              disabled={secretsSaving || !openaiApiKeyDraft.trim()}
                              onClick={() =>
                                saveSecrets({
                                  openai_api_key: openaiApiKeyDraft,
                                }).catch(() => {})
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                            >
                              {tt("save")}
                            </button>
                            <button
                              disabled={secretsSaving}
                              onClick={() =>
                                saveSecrets({ openai_api_key: "" }).catch(() => {})
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                            >
                              {tt("clear")}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("gemini_key")}
                          </span>
                          <span className="text-[11px] text-[var(--ui-muted)]">
                            {secretsStatus.gemini_api_key_present
                              ? tt("present")
                              : tt("missing")}
                          </span>
                        </div>
                        <div className="flex flex-col gap-2 md:flex-row md:items-center">
                          <input
                            type="password"
                            value={geminiApiKeyDraft}
                            onChange={(e) => setGeminiApiKeyDraft(e.target.value)}
                            placeholder={tt("api_key_placeholder")}
                            className="flex-1 rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                          />
                          <div className="flex gap-2">
                            <button
                              disabled={secretsSaving || !geminiApiKeyDraft.trim()}
                              onClick={() =>
                                saveSecrets({
                                  gemini_api_key: geminiApiKeyDraft,
                                }).catch(() => {})
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                            >
                              {tt("save")}
                            </button>
                            <button
                              disabled={secretsSaving}
                              onClick={() =>
                                saveSecrets({ gemini_api_key: "" }).catch(() => {})
                              }
                              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                            >
                              {tt("clear")}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-[var(--ui-muted)]">
                      {tt("not_available_backend")}
                    </div>
                  )}

                  {secretsSaveError ? (
                    <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                      {secretsSaveError}
                    </div>
                  ) : null}
                </div>

                {selectedProject ? (
                  <div className="mt-4 grid gap-3">
                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("provider")}
                      </span>
                      <select
                        defaultValue={getSettingsValue("llm.provider", "openai")}
                        onChange={(e) =>
                          saveProjectSettings({
                            llm: { provider: e.target.value },
                          }).catch((err) =>
                            setSettingsError((err as Error).message),
                          )
                        }
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                      >
                        <option value="openai">{tt("gpt_provider")}</option>
                        <option value="gemini">{tt("gemini_provider")}</option>
                      </select>
                    </label>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("gpt_model")}
                      </span>
                      <input
                        defaultValue={getSettingsValue(
                          "llm.openai.model",
                          "gpt-4o-mini",
                        )}
                        onBlur={(e) =>
                          saveProjectSettings({
                            llm: { openai: { model: e.target.value } },
                          }).catch((err) =>
                            setSettingsError((err as Error).message),
                          )
                        }
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                      />
                    </label>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("gpt_base_url")}
                      </span>
                      <input
                        defaultValue={getSettingsValue(
                          "llm.openai.base_url",
                          "",
                        )}
                        onBlur={(e) =>
                          saveProjectSettings({
                            llm: { openai: { base_url: e.target.value } },
                          }).catch((err) =>
                            setSettingsError((err as Error).message),
                          )
                        }
                        placeholder={tt("optional_use_backend_defaults")}
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                      />
                    </label>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("gpt_wire_api")}
                      </span>
                      <select
                        defaultValue={getSettingsValue(
                          "llm.openai.wire_api",
                          "chat",
                        )}
                        onChange={(e) =>
                          saveProjectSettings({
                            llm: { openai: { wire_api: e.target.value } },
                          }).catch((err) =>
                            setSettingsError((err as Error).message),
                          )
                        }
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                      >
                        <option value="chat">{tt("gpt_wire_chat")}</option>
                        <option value="responses">
                          {tt("gpt_wire_responses")}
                        </option>
                      </select>
                      <div className="text-[11px] text-[var(--ui-muted)]">
                        {tt("gpt_wire_desc")}
                      </div>
                    </label>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("gemini_model")}
                      </span>
                      <input
                          defaultValue={getSettingsValue(
                            "llm.gemini.model",
                            "gemini-3-pro-preview",
                          )}
                        onBlur={(e) =>
                          saveProjectSettings({
                            llm: { gemini: { model: e.target.value } },
                          }).catch((err) =>
                            setSettingsError((err as Error).message),
                          )
                        }
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                      />
                    </label>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("gemini_base_url")}
                      </span>
                      <input
                        defaultValue={getSettingsValue(
                          "llm.gemini.base_url",
                          "",
                        )}
                        onBlur={(e) =>
                          saveProjectSettings({
                            llm: { gemini: { base_url: e.target.value } },
                          }).catch((err) =>
                            setSettingsError((err as Error).message),
                          )
                        }
                        placeholder={tt("optional_use_backend_defaults")}
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                      />
                    </label>

                    <div className="grid gap-2 md:grid-cols-2">
                      <label className="grid gap-1 text-sm">
                        <span className="text-xs text-[var(--ui-muted)]">
                          {tt("temperature")}
                        </span>
                        <input
                          type="number"
                          step="0.1"
                          defaultValue={getSettingsValue("llm.temperature", "0.7")}
                          onBlur={(e) =>
                            saveProjectSettings({
                              llm: { temperature: Number(e.target.value) },
                            }).catch((err) =>
                              setSettingsError((err as Error).message),
                            )
                          }
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                        />
                      </label>

                      <label className="grid gap-1 text-sm">
                        <span className="text-xs text-[var(--ui-muted)]">
                          {tt("max_tokens")}
                        </span>
                        <input
                          type="number"
                          step="50"
                          defaultValue={getSettingsValue("llm.max_tokens", "800")}
                          onBlur={(e) =>
                            saveProjectSettings({
                              llm: { max_tokens: Number(e.target.value) },
                            }).catch((err) =>
                              setSettingsError((err as Error).message),
                            )
                          }
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                        />
                      </label>
                    </div>

                    <div className="grid gap-2 md:grid-cols-2">
                      <label className="grid gap-1 text-sm">
                        <span className="text-xs text-[var(--ui-muted)]">
                          {tt("chapter_words")}
                        </span>
                        <input
                          type="number"
                          step="100"
                          defaultValue={getSettingsValue(
                            "writing.chapter_words",
                            "1200",
                          )}
                          onBlur={(e) =>
                            saveProjectSettings({
                              writing: {
                                chapter_words: Number(e.target.value),
                              },
                            }).catch((err) =>
                              setSettingsError((err as Error).message),
                            )
                          }
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                        />
                      </label>

                      <label className="grid gap-1 text-sm">
                        <span className="text-xs text-[var(--ui-muted)]">
                          {tt("chapter_count")}
                        </span>
                        <input
                          type="number"
                          step="1"
                          defaultValue={getSettingsValue(
                            "writing.chapter_count",
                            "10",
                          )}
                          onBlur={(e) =>
                            saveProjectSettings({
                              writing: { chapter_count: Number(e.target.value) },
                            }).catch((err) =>
                              setSettingsError((err as Error).message),
                            )
                          }
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                        />
                      </label>
                    </div>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("kb_mode")}
                      </span>
                      <select
                        defaultValue={getSettingsValue("kb.mode", "weak")}
                        onChange={(e) =>
                          saveProjectSettings({
                            kb: { mode: e.target.value },
                          }).catch((err) =>
                            setSettingsError((err as Error).message),
                          )
                        }
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                      >
                        <option value="weak">{tt("kb_weak")}</option>
                        <option value="strong">{tt("kb_strong")}</option>
                      </select>
                    </label>

                    <label className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                      <span>{tt("web_search_tool")}</span>
                      <input
                        type="checkbox"
                        defaultChecked={getSettingsBool(
                          "tools.web_search.enabled",
                          true,
                        )}
                        onChange={(e) =>
                          saveProjectSettings({
                            tools: { web_search: { enabled: e.target.checked } },
                          }).catch((err) =>
                            setSettingsError((err as Error).message),
                          )
                        }
                      />
                    </label>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("web_search_provider")}
                      </span>
                      <select
                        defaultValue={getSettingsValue(
                          "tools.web_search.provider",
                          "auto",
                        )}
                        onChange={(e) =>
                          saveProjectSettings({
                            tools: { web_search: { provider: e.target.value } },
                          }).catch((err) =>
                            setSettingsError((err as Error).message),
                          )
                        }
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                      >
                        <option value="auto">
                          {tt("web_search_provider_auto")}
                        </option>
                        <option value="bing">
                          {tt("web_search_provider_bing")}
                        </option>
                        <option value="duckduckgo">
                          {tt("web_search_provider_duckduckgo")}
                        </option>
                      </select>
                      <div className="text-[11px] text-[var(--ui-muted)]">
                        {tt("web_search_provider_desc")}
                      </div>
                    </label>

                    {settingsError ? (
                      <div className="text-sm text-red-600 dark:text-red-400">
                        {settingsError}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-3 text-sm text-[var(--ui-muted)]">
                    {lang === "zh" ? "未选择项目。" : "No project selected."}
                  </div>
                )}
              </div>
              ) : null}

              {settingsPane === "project" ? (
                <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                  <div className="text-sm font-medium">
                    {tt("settings_nav_project")}
                  </div>
                  <div className="mt-2 text-xs text-[var(--ui-muted)]">
                    {tt("select_project_first")}
                  </div>

                  {selectedProject ? (
                    <div className="mt-4 grid gap-3">
                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="grid gap-1 text-sm">
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("chapter_words")}
                          </span>
                          <input
                            type="number"
                            step="100"
                            defaultValue={getSettingsValue(
                              "writing.chapter_words",
                              "1200",
                            )}
                            onBlur={(e) =>
                              saveProjectSettings({
                                writing: {
                                  chapter_words: Number(e.target.value),
                                },
                              }).catch((err) =>
                                setSettingsError((err as Error).message),
                              )
                            }
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                          />
                        </label>

                        <label className="grid gap-1 text-sm">
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("chapter_count")}
                          </span>
                          <input
                            type="number"
                            step="1"
                            defaultValue={getSettingsValue(
                              "writing.chapter_count",
                              "10",
                            )}
                            onBlur={(e) =>
                              saveProjectSettings({
                                writing: {
                                  chapter_count: Number(e.target.value),
                                },
                              }).catch((err) =>
                                setSettingsError((err as Error).message),
                              )
                            }
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                          />
                        </label>
                      </div>

                      <label className="grid gap-1 text-sm">
                        <span className="text-xs text-[var(--ui-muted)]">
                          {tt("kb_mode")}
                        </span>
                        <select
                          defaultValue={getSettingsValue("kb.mode", "weak")}
                          onChange={(e) =>
                            saveProjectSettings({
                              kb: { mode: e.target.value },
                            }).catch((err) =>
                              setSettingsError((err as Error).message),
                            )
                          }
                          className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)]"
                        >
                          <option value="weak">{tt("kb_weak")}</option>
                          <option value="strong">{tt("kb_strong")}</option>
                        </select>
                      </label>

                      {settingsError ? (
                        <div className="text-sm text-red-600 dark:text-red-400">
                          {settingsError}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-3 text-sm text-[var(--ui-muted)]">
                      {lang === "zh" ? "未选择项目。" : "No project selected."}
                    </div>
                  )}
                </div>
              ) : null}

              {settingsPane === "export" ? (
                <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 text-sm dark:border-zinc-800">
                  <div className="text-sm font-medium">
                    {tt("settings_nav_export")}
                  </div>
                  <div className="mt-2 grid gap-2 text-[var(--ui-muted)]">
                    {lang === "zh" ? (
                      <>
                        <div>导出入口在「写作」页右侧面板。</div>
                        <div>
                          DOCX/EPUB/PDF 优先使用 <code>pandoc</code>{" "}
                          与更漂亮模板；如果环境缺少依赖，会自动降级到基础导出。
                        </div>
                        <div>
                          提示：若你希望 PDF 排版更好，通常需要额外安装 LaTeX 引擎（如 MiKTeX）。
                        </div>
                      </>
                    ) : (
                      <>
                        <div>Export controls live in the Writing tab (right panel).</div>
                        <div>
                          DOCX/EPUB/PDF prefer <code>pandoc</code> with nicer templates; when missing,
                          the backend falls back to basic exporters.
                        </div>
                        <div>
                          Tip: high-quality PDF output usually requires a LaTeX engine (e.g. MiKTeX).
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : null}
              </div>
            </div>
          </section>
        ) : null}
        </main>
      </div>
    </div>
  );
}
