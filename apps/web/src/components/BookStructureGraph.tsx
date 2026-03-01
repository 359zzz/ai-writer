"use client";

import { useMemo } from "react";
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
  const { nodes, edges, truncated } = useMemo(() => {
    const chapters = Array.isArray(data.chapters) ? data.chapters : [];
    const shown = chapters.slice(0, Math.max(1, Math.min(maxChapters, 2000)));
    const truncated = chapters.length > shown.length;

    const summaryByChapter = new Map<number, KBChunkMeta>();
    for (const s of data.summaries || []) {
      const idx = parseTagInt(s.tags, "book_chapter");
      if (!idx) continue;
      if (!summaryByChapter.has(idx)) summaryByChapter.set(idx, s);
    }

    const continuationByChapterId = new Map<string, KBChunkMeta>();
    for (const m of data.continuation_manuscripts || []) {
      const cid = parseTagStr(m.tags, "chapter_id");
      if (!cid) continue;
      continuationByChapterId.set(cid, m);
    }

    const nodesOut: Node[] = [];
    const edgesOut: Edge[] = [];

    const cols = 4;
    const xGap = 320;
    const yGap = 220;
    const baseY = 140;

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
          (truncated ? (lang === "zh" ? " · 已截断显示" : " · truncated view") : ""),
        color: sourceColor,
      } satisfies CardNodeData,
    });

    for (let i = 0; i < shown.length; i++) {
      const c = shown[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * xGap;
      const y = baseY + row * yGap;

      const label =
        c.label?.trim() ||
        (lang === "zh" ? `第${c.index}章` : `Chapter ${c.index}`);
      const title = (c.title || "").trim();
      const nodeId = `chapter:${c.index}`;
      const sum = summaryByChapter.get(c.index);

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
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "rgba(100,116,139,0.55)", strokeWidth: 2 },
        });
      }

      if (sum) {
        const sid = `summary:${c.index}`;
        nodesOut.push({
          id: sid,
          type: "bookCard",
          position: { x, y: y + 110 },
          data: {
            label:
              lang === "zh"
                ? `章节总结 KB#${sum.id}`
                : `Chapter summary KB#${sum.id}`,
            stats: (sum.title || "").slice(0, 48),
            color: "rgba(16,185,129,0.65)",
          } satisfies CardNodeData,
        });
        edgesOut.push({
          id: `e:ch:${c.index}->sum`,
          source: nodeId,
          target: sid,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "rgba(16,185,129,0.55)", strokeWidth: 2 },
        });
      }
    }

    // Book state node (compiled).
    if (data.book_state) {
      const x = cols * xGap + 40;
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

    // Continuation manuscripts (written chapters linked to this book_source).
    const continuation = Array.from(continuationByChapterId.values())
      .slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (continuation.length > 0) {
      const x = cols * xGap + 40;
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
      const x = (cols - 1) * xGap;
      const y = baseY + Math.floor(shown.length / cols) * yGap + 120;
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

    return { nodes: nodesOut, edges: edgesOut, truncated };
  }, [data, lang, maxChapters]);

  const nodeTypes = useMemo(() => ({ bookCard: CardNodeView }), []);

  if (!data.source_id) {
    return (
      <div className="text-sm text-[var(--ui-muted)]">
        {lang === "zh" ? "暂无书籍源。" : "No book source."}
      </div>
    );
  }

  if (!Array.isArray(data.chapters) || data.chapters.length === 0) {
    return (
      <div className="text-sm text-[var(--ui-muted)]">
        {lang === "zh"
          ? "暂无章节索引。请先在“书籍续写”里执行章节分块。"
          : "No chapter index yet. Detect chapters first in Book Continue."}
      </div>
    );
  }

  return (
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
  );
}

