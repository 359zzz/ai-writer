"use client";

import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";

export type ChapterIndexChapter = {
  index: number;
  label: string;
  title: string;
  start_char: number;
  end_char: number;
  chars: number;
};

export type KBChunkMeta = {
  id: number;
  source_type: string;
  title: string;
  tags: string;
  created_at: string;
};

export type BookStructureGraphData = {
  source_id: string;
  chapters: ChapterIndexChapter[];
  summaries: KBChunkMeta[];
  book_state: KBChunkMeta | null;
  continuation_manuscripts: KBChunkMeta[];
  nonlinear_edges?: Array<{
    from: number;
    to: number;
    type: string;
    label?: string;
    strength?: number;
  }>;
};

type CardNodeData = {
  label: string;
  stats: string;
  color: string;
};

function CardNodeView({ data }: { data: CardNodeData }) {
  return (
    <div
      className="rounded-lg border border-zinc-200 bg-[var(--ui-control)] shadow-sm"
      style={{ width: 260, borderColor: data.color }}
    >
      <div className="p-3">
        <div className="text-sm font-medium text-[var(--ui-control-text)]">
          {data.label}
        </div>
        <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
          {data.stats}
        </div>
      </div>
    </div>
  );
}

function parseTagInt(tags: string, key: string): number | null {
  const raw = (tags || "")
    .split(",")
    .map((t) => t.trim())
    .find((t) => t.startsWith(`${key}:`));
  if (!raw) return null;
  const v = raw.slice(key.length + 1).trim();
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

function parseTagStr(tags: string, key: string): string | null {
  const raw = (tags || "")
    .split(",")
    .map((t) => t.trim())
    .find((t) => t.startsWith(`${key}=`));
  if (!raw) return null;
  const v = raw.slice(key.length + 1).trim();
  return v || null;
}

export function BookStructureGraph({
  lang,
  data,
  maxChapters = 120,
}: {
  lang: "zh" | "en";
  data: BookStructureGraphData;
  maxChapters?: number;
}) {
  const [layoutMode, setLayoutMode] = useState<"vertical" | "timeline">("vertical");
  const [showNonlinear, setShowNonlinear] = useState(true);
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const [minStrength, setMinStrength] = useState(0.45);

  const relationLegend = useMemo(() => {
    const items = [
      { type: "causal", color: "rgba(239,68,68,0.55)", zh: "因果", en: "Causal" },
      { type: "foreshadow", color: "rgba(168,85,247,0.55)", zh: "伏笔", en: "Foreshadow" },
      { type: "payoff", color: "rgba(34,197,94,0.55)", zh: "照应", en: "Payoff" },
      { type: "character_arc", color: "rgba(59,130,246,0.55)", zh: "人物弧光", en: "Character arc" },
      { type: "theme", color: "rgba(245,158,11,0.55)", zh: "主题", en: "Theme" },
      { type: "structure", color: "rgba(14,165,233,0.55)", zh: "结构", en: "Structure" },
      { type: "suspense", color: "rgba(244,63,94,0.55)", zh: "悬念", en: "Suspense" },
      { type: "parallel", color: "rgba(100,116,139,0.55)", zh: "平行", en: "Parallel" },
      { type: "contrast", color: "rgba(148,163,184,0.55)", zh: "对照", en: "Contrast" },
    ];
    return items.map((it) => ({
      type: it.type,
      color: it.color,
      label: lang === "zh" ? it.zh : it.en,
    }));
  }, [lang]);

  function cleanChapterTitle(raw: string): string {
    let t = (raw || "").replace(/\u00a0/g, " ").trim();
    if (!t) return "";
    // Strip common scraped navigation tails that sometimes leak into titles.
    for (const s of [
      "回目录回首页",
      "返回目录",
      "返回首页",
      "回目录",
      "回首页",
      "上一页",
      "下一页",
      "前一页",
      "后一页",
      "上一章",
      "下一章",
    ]) {
      t = t.replaceAll(s, " ");
    }
    t = t.replace(/[ \t　]{2,}/g, " ").trim();
    t = t.replace(/^[：:：\-—\.\s　]+/g, "").trim();
    return t;
  }

  function stripLeadingLabel(title: string, label: string): string {
    const t = (title || "").trim();
    const l = (label || "").trim();
    if (!t || !l) return t;
    if (!t.startsWith(l)) return t;
    let rest = t.slice(l.length).trim();
    rest = rest.replace(/^[·•:：\-—\.\s　]+/g, "").trim();
    return rest;
  }

  const { nodes, edges, nonlinearTotal, nonlinearShown } = useMemo(() => {
    const chapters = Array.isArray(data.chapters) ? data.chapters : [];
    const shown = chapters.slice(0, Math.max(1, Math.min(maxChapters, 2000)));
    const truncated = chapters.length > shown.length;

    const summaryByChapter = new Map<number, KBChunkMeta>();
    let summaryCount = 0;
    let chapterSummaryCount = 0;
    let chunkSummaryCount = 0;
    for (const s of data.summaries || []) {
      summaryCount += 1;
      const idx = parseTagInt(s.tags, "book_chapter");
      if (idx && idx > 0) {
        chapterSummaryCount += 1;
        if (!summaryByChapter.has(idx)) summaryByChapter.set(idx, s);
      } else {
        const chunkIdx = parseTagInt(s.tags, "book_chunk");
        if (chunkIdx && chunkIdx > 0) chunkSummaryCount += 1;
      }
    }

    const continuationByChapterId = new Map<string, KBChunkMeta>();
    for (const m of data.continuation_manuscripts || []) {
      const cid = parseTagStr(m.tags, "chapter_id");
      if (!cid) continue;
      continuationByChapterId.set(cid, m);
    }

    const nodesOut: Node[] = [];
    const edgesOut: Edge[] = [];

    const baseX = 0;
    const baseY = 200;
    const xGap = 340;
    const yGap = 150;

    const sourceColor = "rgba(249,115,22,0.9)";
    nodesOut.push({
      id: `book:${data.source_id}`,
      type: "bookCard",
      position: { x: 0, y: 20 },
      data: {
        label: lang === "zh" ? "书籍源" : "Book source",
        stats:
          (lang === "zh"
            ? `source_id=${data.source_id.slice(0, 10)}… · 章节=${chapters.length}`
            : `source_id=${data.source_id.slice(0, 10)}… · chapters=${chapters.length}`) +
          (summaryCount > 0
            ? lang === "zh"
              ? ` · 总结=${summaryCount} (章=${chapterSummaryCount},片=${chunkSummaryCount})`
              : ` · summaries=${summaryCount} (chapter=${chapterSummaryCount},chunk=${chunkSummaryCount})`
            : "") +
          (truncated ? (lang === "zh" ? " · 已截断显示" : " · truncated view") : ""),
        color: sourceColor,
      } satisfies CardNodeData,
    });

    for (let i = 0; i < shown.length; i++) {
      const c = shown[i];
      const x = layoutMode === "timeline" ? baseX + i * 320 : baseX;
      const y = layoutMode === "timeline" ? baseY : baseY + i * yGap;

      const label =
        c.label?.trim() ||
        (lang === "zh" ? `第${c.index}章` : `Chapter ${c.index}`);
      const nodeId = `chapter:${c.index}`;
      const sum = summaryByChapter.get(c.index);
      const titleFromIndex = cleanChapterTitle(c.title || "");
      const titleFromSummary = sum ? cleanChapterTitle(sum.title || "") : "";
      const titleRaw = titleFromIndex || titleFromSummary;
      const title = stripLeadingLabel(titleRaw, label);

      nodesOut.push({
        id: nodeId,
        type: "bookCard",
        position: { x, y },
        data: {
          label: title ? `${label} · ${title}` : label,
          stats:
            (lang === "zh"
              ? `chars≈${c.chars}${sum ? ` · 总结KB#${sum.id}` : ""}`
              : `chars≈${c.chars}${sum ? ` · summary KB#${sum.id}` : ""}`) || "",
          color: sum ? "rgba(16,185,129,0.8)" : "rgba(100,116,139,0.65)",
        } satisfies CardNodeData,
      });

      if (i === 0) {
        edgesOut.push({
          id: `e:book->ch1`,
          source: `book:${data.source_id}`,
          target: nodeId,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "rgba(100,116,139,0.6)", strokeWidth: 2 },
        });
      } else {
        const prev = shown[i - 1];
        edgesOut.push({
          id: `e:ch:${prev.index}->${c.index}`,
          source: `chapter:${prev.index}`,
          target: nodeId,
          type: layoutMode === "timeline" ? "bezier" : "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "rgba(100,116,139,0.6)", strokeWidth: 2.2 },
        });
      }
    }

    // Book state node (compiled).
    if (data.book_state) {
      const x = baseX + xGap;
      const y = 20;
      const st = data.book_state;
      const stateNodeId = "book_state";
      nodesOut.push({
        id: stateNodeId,
        type: "bookCard",
        position: { x, y },
        data: {
          label:
            lang === "zh"
              ? `书籍状态 KB#${st.id}`
              : `Book state KB#${st.id}`,
          stats: st.title || "",
          color: "rgba(59,130,246,0.75)",
        } satisfies CardNodeData,
      });
      edgesOut.push({
        id: "e:book->state",
        source: `book:${data.source_id}`,
        target: stateNodeId,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "rgba(59,130,246,0.55)", strokeWidth: 2 },
      });
    }

    // Optional: non-linear chapter relations (LLM-derived / persisted).
    let nonlinearTotal = 0;
    let nonlinearShown = 0;
    for (const rel of data.nonlinear_edges || []) {
      nonlinearTotal += 1;
      if (!showNonlinear) continue;
      const from = Number(rel.from);
      const to = Number(rel.to);
      const type = String(rel.type || "").trim() || "relation";
      const strength =
        typeof rel.strength === "number" ? rel.strength : Number(rel.strength ?? NaN);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      if (from <= 0 || to <= 0) continue;
      if (from === to) continue;
      const strengthOk =
        !Number.isFinite(strength) || strength >= Math.max(0, Math.min(1, minStrength));
      if (!strengthOk) continue;
      const srcId = `chapter:${Math.floor(from)}`;
      const dstId = `chapter:${Math.floor(to)}`;
      if (!nodesOut.some((n) => n.id === srcId) || !nodesOut.some((n) => n.id === dstId)) {
        continue;
      }

      const colorByType: Record<string, string> = {
        causal: "rgba(239,68,68,0.55)",
        foreshadow: "rgba(168,85,247,0.55)",
        payoff: "rgba(34,197,94,0.55)",
        character_arc: "rgba(59,130,246,0.55)",
        theme: "rgba(245,158,11,0.55)",
        structure: "rgba(14,165,233,0.55)",
        suspense: "rgba(244,63,94,0.55)",
        parallel: "rgba(100,116,139,0.55)",
        contrast: "rgba(148,163,184,0.55)",
      };
      const stroke = colorByType[type] ?? "rgba(99,102,241,0.5)";
      const s = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0.6;
      const strokeWidth = 1.4 + s * 2.8;
      const opacity = 0.18 + s * 0.78;

      const edgeLabel =
        showEdgeLabels || s >= 0.82 ? (rel.label ? String(rel.label) : undefined) : undefined;
      edgesOut.push({
        id: `e:nl:${srcId}->${dstId}:${type}`,
        source: srcId,
        target: dstId,
        type: "bezier",
        label: edgeLabel,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke, strokeWidth, opacity, strokeDasharray: "6 4" },
      });
      nonlinearShown += 1;
    }

    // Continuation manuscripts (written chapters linked to this book_source).
    const continuation = Array.from(continuationByChapterId.values())
      .slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (continuation.length > 0) {
      const x = baseX + xGap;
      const base = 200;
      const step = 140;
      const max = Math.min(continuation.length, 30);
      let prevId: string | null = data.book_state ? "book_state" : `book:${data.source_id}`;
      for (let i = 0; i < max; i++) {
        const m = continuation[i];
        const nodeId = `cont:${m.id}`;
        nodesOut.push({
          id: nodeId,
          type: "bookCard",
          position: { x, y: base + i * step },
          data: {
            label:
              lang === "zh"
                ? `续写章节 KB#${m.id}`
                : `Continuation KB#${m.id}`,
            stats: m.title || "",
            color: "rgba(249,115,22,0.65)",
          } satisfies CardNodeData,
        });
        if (prevId) {
          edgesOut.push({
            id: `e:${prevId}->${nodeId}`,
            source: prevId,
            target: nodeId,
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: "rgba(249,115,22,0.45)", strokeWidth: 2 },
          });
        }
        prevId = nodeId;
      }
      if (continuation.length > max) {
        const nodeId = "cont:more";
        nodesOut.push({
          id: nodeId,
          type: "bookCard",
          position: { x, y: base + max * step },
          data: {
            label: lang === "zh" ? "更多续写章节" : "More continuation",
            stats: lang === "zh" ? `+${continuation.length - max}` : `+${continuation.length - max}`,
            color: "rgba(249,115,22,0.45)",
          } satisfies CardNodeData,
        });
      }
    }

    if (truncated) {
      const nodeId = "chapters:more";
      const x = baseX;
      const y = baseY + shown.length * yGap + 60;
      nodesOut.push({
        id: nodeId,
        type: "bookCard",
        position: { x, y },
        data: {
          label: lang === "zh" ? "更多章节" : "More chapters",
          stats:
            lang === "zh"
              ? `+${chapters.length - shown.length} 章未渲染`
              : `+${chapters.length - shown.length} chapters not rendered`,
          color: "rgba(100,116,139,0.45)",
        } satisfies CardNodeData,
      });
    }

    return { nodes: nodesOut, edges: edgesOut, nonlinearTotal, nonlinearShown };
  }, [data, lang, maxChapters, layoutMode, minStrength, showEdgeLabels, showNonlinear]);

  const nodeTypes = useMemo(() => ({ bookCard: CardNodeView }), []);

  if (!data.source_id) {
    return (
      <div className="text-sm text-[var(--ui-muted)]">
        {lang === "zh" ? "暂无书籍源。" : "No book source."}
      </div>
    );
  }

  const hasChapters = Array.isArray(data.chapters) && data.chapters.length > 0;
  const hasAnyArtifacts =
    (data.book_state != null) ||
    (Array.isArray(data.summaries) && data.summaries.length > 0) ||
    (Array.isArray(data.continuation_manuscripts) && data.continuation_manuscripts.length > 0);

  if (!hasChapters && !hasAnyArtifacts) {
    return (
      <div className="text-sm text-[var(--ui-muted)]">
        {lang === "zh"
          ? "暂无可展示的书籍结构信息。"
          : "No book structure data to visualize yet."}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {!hasChapters ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          {lang === "zh"
            ? "提示：当前书籍源还没有章节索引（chapter_index）。你仍可查看已入库的总结/状态/续写产物；若需要章节链，请先在「续写 → 书籍续写」执行章节分块。"
            : "Tip: this book source has no chapter_index yet. You can still view summaries/state/continuations; to render a chapter chain, detect chapters first in Continue → Book Continue."}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ui-muted)]">
        <span className="font-medium text-[var(--ui-text)]">
          {lang === "zh" ? "布局" : "Layout"}:
        </span>
        <button
          type="button"
          onClick={() => setLayoutMode("vertical")}
          className={[
            "rounded-md px-2 py-1 transition-colors",
            layoutMode === "vertical"
              ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
              : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
          ].join(" ")}
        >
          {lang === "zh" ? "纵向" : "Vertical"}
        </button>
        <button
          type="button"
          onClick={() => setLayoutMode("timeline")}
          className={[
            "rounded-md px-2 py-1 transition-colors",
            layoutMode === "timeline"
              ? "bg-[var(--ui-accent)] text-[var(--ui-accent-foreground)]"
              : "border border-zinc-200 bg-[var(--ui-control)] text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]",
          ].join(" ")}
        >
          {lang === "zh" ? "时间线" : "Timeline"}
        </button>

        <label className="ml-auto inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showNonlinear}
            onChange={(e) => setShowNonlinear(e.target.checked)}
          />
          <span>{lang === "zh" ? "非线性关系" : "Non-linear"}</span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={showEdgeLabels}
            onChange={(e) => setShowEdgeLabels(e.target.checked)}
          />
          <span>{lang === "zh" ? "显示标签" : "Show labels"}</span>
        </label>
        <label className="inline-flex items-center gap-2">
          <span className="whitespace-nowrap">
            {lang === "zh" ? "强度阈值" : "Min strength"}:
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={minStrength}
            onChange={(e) => setMinStrength(Number(e.target.value))}
          />
          <span className="w-[44px] text-right tabular-nums">
            {minStrength.toFixed(2)}
          </span>
        </label>
      </div>
      {Array.isArray(data.nonlinear_edges) && data.nonlinear_edges.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ui-muted)]">
          <span className="font-medium text-[var(--ui-text)]">
            {lang === "zh" ? "非线性关系" : "Non-linear relations"}:
          </span>
          {relationLegend.map((it) => (
            <span key={it.type} className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: it.color }}
              />
              <span>{it.label}</span>
            </span>
          ))}
          <span className="ml-auto">
            {lang === "zh"
              ? `边数=${nonlinearShown}/${nonlinearTotal}`
              : `edges=${nonlinearShown}/${nonlinearTotal}`}
          </span>
        </div>
      ) : null}
      <div className="h-[620px] rounded-lg border border-zinc-200 bg-[var(--ui-surface)]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={{
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: "rgba(100,116,139,0.7)", strokeWidth: 2 },
          }}
          fitView
        >
          <Background gap={18} size={1} />
          <MiniMap
            nodeColor={(n) => {
              const d = n.data as { color?: string } | undefined;
              return d?.color ?? "rgba(100,116,139,0.45)";
            }}
            nodeStrokeWidth={2}
            pannable
            zoomable
          />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
