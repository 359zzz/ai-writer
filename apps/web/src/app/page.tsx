"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { MarkdownPreview } from "@/components/MarkdownPreview";
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

type TabKey = "writing" | "agents" | "settings";

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
  index: number;
  title: string;
  summary?: string;
  goal?: string;
};

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

  const [tab, setTab] = useState<TabKey>("writing");
  const [writingMode, setWritingMode] = useState<"create" | "continue">("create");
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
  const [settingsError, setSettingsError] = useState<string | null>(null);
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
  const [generatedMarkdown, setGeneratedMarkdown] = useState<string>("");
  const [editorView, setEditorView] = useState<"split" | "edit" | "preview">(
    "split",
  );
  const [outline, setOutline] = useState<unknown>(null);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [chapterIndex, setChapterIndex] = useState<number>(1);
  const [researchQuery, setResearchQuery] = useState<string>("");
  const [continueText, setContinueText] = useState<string>("");
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
        setProjects(data);
        if (!selectedProjectId && data.length > 0) {
          setSelectedProjectId(data[0].id);
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
        const title = typeof rec.title === "string" ? rec.title : "";
        if (!Number.isFinite(idx) || !title.trim()) continue;
        out.push({
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

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!selectedProjectId) {
        setChapters([]);
        return;
      }
      try {
        const res = await fetch(
          `${apiBase}/api/projects/${selectedProjectId}/chapters`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ChapterItem[];
        if (!cancelled) setChapters(data);
      } catch {
        if (!cancelled) setChapters([]);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [apiBase, selectedProjectId, runEvents.length]);

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
    setProjects((prev) => [p, ...prev]);
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
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  async function runPipeline(
    kind: string,
    extra: Record<string, unknown> = {},
  ) {
    if (!selectedProjectId) return;
    setRunError(null);
    setRunInProgress(true);
    setRunEvents([]);

    const res = await fetch(
      `${apiBase}/api/projects/${selectedProjectId}/runs/stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, ...extra }),
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
          setRunEvents((prev) => [...prev, evt]);
          if (
            evt.type === "artifact" &&
            evt.agent === "Writer" &&
            evt.data.artifact_type === "chapter_markdown" &&
            typeof evt.data.markdown === "string"
          ) {
            setGeneratedMarkdown(evt.data.markdown);
          }
          if (
            evt.type === "artifact" &&
            evt.agent === "Outliner" &&
            evt.data.artifact_type === "outline"
          ) {
            setOutline(evt.data.outline ?? null);
          }
        } catch {
          // ignore partial/bad events
        }
      }
    }
    setRunInProgress(false);
  }

  async function addKbChunk() {
    if (!selectedProjectId) return;
    setKbError(null);
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
    setKbContent("");
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
                    ["writing", tt("tab_writing")],
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
        </div>

        {tab === "writing" ? (
          <section className="rounded-xl border border-zinc-200 bg-transparent p-6 dark:border-zinc-800">
            <h1 className="text-lg font-semibold">{tt("writing")}</h1>
            <p className="mt-2 text-sm text-[var(--ui-muted)]">
              {tt("writing_desc")}
            </p>

            <div className="mt-6">
              <PanelGroup
                direction="horizontal"
                autoSaveId="ai-writer:writing:outer"
                className="flex"
              >
                <Panel defaultSize={24} minSize={16} className="min-w-0 pr-3">
                  <div className="grid gap-6">
                <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
                  <div className="text-sm font-medium">{tt("writing_mode")}</div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setWritingMode("create")}
                      className={[
                        "rounded-md px-3 py-2 text-sm transition-colors",
                        writingMode === "create"
                          ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                          : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                      ].join(" ")}
                    >
                      {tt("writing_mode_create")}
                    </button>
                    <button
                      onClick={() => setWritingMode("continue")}
                      className={[
                        "rounded-md px-3 py-2 text-sm transition-colors",
                        writingMode === "continue"
                          ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
                          : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
                      ].join(" ")}
                    >
                      {tt("writing_mode_continue")}
                    </button>
                  </div>
                  <div className="mt-2 text-xs text-[var(--ui-muted)]">
                    {writingMode === "create"
                      ? tt("writing_mode_create_desc")
                      : tt("writing_mode_continue_desc")}
                  </div>
                </div>

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
                              <button
                                onClick={() => setSelectedProjectId(p.id)}
                                className={[
                                  "w-full px-3 py-2 text-left text-sm",
                                  active
                                    ? "bg-zinc-100 dark:bg-zinc-800"
                                    : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                                ].join(" ")}
                              >
                                {p.title}
                              </button>
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
                          <li key={ch.id} className="p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="font-medium">
                                {ch.chapter_index}. {ch.title}
                              </div>
                              <button
                                onClick={() => {
                                  setGeneratedMarkdown(ch.markdown);
                                  setEditorView("split");
                                }}
                                className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
                              >
                                {tt("open")}
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

                <Panel defaultSize={76} minSize={40} className="min-w-0 pl-3">
                  <PanelGroup
                    direction="horizontal"
                    autoSaveId="ai-writer:writing:inner"
                    className="flex"
                  >
                    <Panel defaultSize={70} minSize={45} className="min-w-0 pr-3">
                <div className="min-w-0 rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
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
                      className="mt-3 h-[70vh] min-h-[520px] w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 font-mono text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                      placeholder={tt("generated_markdown_placeholder")}
                    />
                  ) : editorView === "preview" ? (
                    <div className="mt-3 h-[70vh] min-h-[520px] overflow-auto rounded-md border border-zinc-200 bg-[var(--ui-control)] p-4 text-[var(--ui-control-text)]">
                      <MarkdownPreview
                        markdown={generatedMarkdown}
                        emptyLabel={tt("preview_empty")}
                      />
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <textarea
                        value={generatedMarkdown}
                        onChange={(e) => setGeneratedMarkdown(e.target.value)}
                        className="h-[70vh] min-h-[520px] w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 font-mono text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                        placeholder={tt("generated_markdown_placeholder")}
                      />
                      <div className="h-[70vh] min-h-[520px] overflow-auto rounded-md border border-zinc-200 bg-[var(--ui-control)] p-4 text-[var(--ui-control-text)]">
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

                    <Panel defaultSize={30} minSize={20} className="min-w-0 pl-3">
                      <div className="grid gap-6">
                  <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
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
                        disabled={!selectedProjectId || runInProgress}
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
                        disabled={!selectedProjectId || runInProgress}
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
                        <div className="mt-3 grid gap-2">
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
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            disabled={!selectedProjectId || runInProgress}
                            onClick={() => {
                              runPipeline("chapter", {
                                chapter_index: chapterIndex,
                                research_query: researchQuery.trim() || undefined,
                              }).catch((e) =>
                                setRunError((e as Error).message),
                              );
                            }}
                            className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                          >
                            {tt("write_chapter_llm")}
                          </button>
                          <span className="text-xs text-[var(--ui-muted)]">
                            {tt("uses_settings")}
                          </span>
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
                        <label className="mt-3 grid gap-1 text-sm">
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
                        <textarea
                          value={continueText}
                          onChange={(e) => setContinueText(e.target.value)}
                          className="mt-3 h-24 w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] p-3 text-xs text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                          placeholder={tt("paste_manuscript")}
                        />
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            disabled={
                              !selectedProjectId ||
                              runInProgress ||
                              !continueText.trim()
                            }
                            onClick={() => {
                              runPipeline("continue", {
                                chapter_index: chapterIndex,
                                source_text: continueText,
                                research_query: researchQuery.trim() || undefined,
                              }).catch((e) =>
                                setRunError((e as Error).message),
                              );
                            }}
                            className="rounded-md bg-[var(--ui-accent)] px-3 py-2 text-sm text-[var(--ui-accent-foreground)] hover:opacity-90 disabled:opacity-50"
                          >
                            {tt("extract_continue")}
                          </button>
                          <button
                            disabled={!continueText}
                            onClick={() => setContinueText("")}
                            className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)] disabled:opacity-50"
                          >
                            {tt("clear")}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
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

                  <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
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

                  <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 dark:border-zinc-800">
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
                      </div>
                    </Panel>
                  </PanelGroup>
                </Panel>
              </PanelGroup>
            </div>
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
                  {lang === "zh"
                    ? "密钥来自环境变量或本地"
                    : "Keys are loaded from environment variables or local"}{" "}
                  <code className="rounded bg-zinc-100 px-1 py-0.5 text-[11px] dark:bg-zinc-800">
                    api.txt
                  </code>{" "}
                  {lang === "zh"
                    ? "（不会在 UI 中显示完整密钥）。"
                    : "(never shown in UI)."}
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
                        placeholder={tt("optional_use_api_txt")}
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-sm text-[var(--ui-control-text)] placeholder:text-[var(--ui-muted)]"
                      />
                    </label>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-[var(--ui-muted)]">
                        {tt("gemini_model")}
                      </span>
                      <input
                        defaultValue={getSettingsValue(
                          "llm.gemini.model",
                          "gemini-2.5-pro",
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
                        placeholder={tt("optional_use_api_txt")}
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
