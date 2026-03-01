"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";

export type OutlineNodeKind =
  | "chapter"
  | "plot"
  | "character"
  | "time"
  | "place"
  | "item"
  | "foreshadow";

export type OutlineEdgeKind =
  | "next"
  | "contains"
  | "causes"
  | "relates"
  | "conflicts";

export type OutlineNodeData = {
  kind: OutlineNodeKind;
  title: string;
  text?: string;
  summary?: string;
  goal?: string;
  order?: number;
};

export type OutlineEdgeData = {
  kind: OutlineEdgeKind;
  label?: string;
};

export type OutlineGraph = {
  version: 1;
  nodes: Node<OutlineNodeData>[];
  edges: Edge<OutlineEdgeData>[];
};

function makeId(prefix: string): string {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function kindColor(kind: OutlineNodeKind): string {
  switch (kind) {
    case "chapter":
      return "#F97316";
    case "plot":
      return "#3B82F6";
    case "character":
      return "#10B981";
    case "time":
      return "#A855F7";
    case "place":
      return "#14B8A6";
    case "item":
      return "#F59E0B";
    case "foreshadow":
      return "#EF4444";
    default:
      return "#64748B";
  }
}

function kindLabel(kind: OutlineNodeKind, lang: "zh" | "en"): string {
  const zh: Record<OutlineNodeKind, string> = {
    chapter: "章节",
    plot: "情节",
    character: "人物",
    time: "时间",
    place: "地点",
    item: "物件",
    foreshadow: "伏笔",
  };
  const en: Record<OutlineNodeKind, string> = {
    chapter: "Chapter",
    plot: "Plot",
    character: "Character",
    time: "Time",
    place: "Place",
    item: "Item",
    foreshadow: "Foreshadow",
  };
  return (lang === "zh" ? zh : en)[kind] ?? kind;
}

function OutlineNodeView({ data }: { data: OutlineNodeData }) {
  const color = kindColor(data.kind);
  const title = (data.title || "").trim() || "(untitled)";
  return (
    <div
      className="rounded-lg border border-zinc-200 bg-[var(--ui-control)] shadow-sm"
      style={{ width: 220 }}
    >
      <div
        className="h-2 rounded-t-lg"
        style={{ background: color, opacity: 0.9 }}
      />
      <div className="p-3">
        <div className="text-sm font-medium text-[var(--ui-control-text)]">
          {title}
        </div>
        {data.kind === "chapter" && Number.isFinite(data.order) ? (
          <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
            #{Math.max(1, Math.floor(data.order ?? 1))}
          </div>
        ) : (
          <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
            {data.kind}
          </div>
        )}
      </div>
    </div>
  );
}

export function OutlineGraphEditor({
  lang,
  graph,
  onChange,
  readOnly = false,
}: {
  lang: "zh" | "en";
  graph: OutlineGraph;
  onChange: (next: OutlineGraph) => void;
  readOnly?: boolean;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const nextSpawnRef = useRef<number>(0);

  const nodeTypes = useMemo(() => ({ outlineNode: OutlineNodeView }), []);

  const nodes = graph.nodes;
  const edges = graph.edges;

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [nodes, selectedNodeId]);

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId) return null;
    return edges.find((e) => e.id === selectedEdgeId) ?? null;
  }, [edges, selectedEdgeId]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const nextNodes = applyNodeChanges(changes, graph.nodes) as unknown as Node<
        OutlineNodeData
      >[];
      onChange({ ...graph, nodes: nextNodes });
    },
    [graph, onChange],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const nextEdges = applyEdgeChanges(changes, graph.edges) as unknown as Edge<
        OutlineEdgeData
      >[];
      onChange({ ...graph, edges: nextEdges });
    },
    [graph, onChange],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      const id = makeId("e");
      const e: Edge<OutlineEdgeData> = {
        id,
        source: conn.source ?? "",
        target: conn.target ?? "",
        type: "smoothstep",
        data: { kind: "relates" },
        markerEnd: { type: MarkerType.ArrowClosed },
      };
      const nextEdges = addEdge(e, graph.edges) as unknown as Edge<OutlineEdgeData>[];
      onChange({ ...graph, edges: nextEdges });
    },
    [graph, onChange],
  );

  const spawnNode = useCallback(
    (kind: OutlineNodeKind) => {
      const i = nextSpawnRef.current++;
      const id = makeId("n");
      const n: Node<OutlineNodeData> = {
        id,
        type: "outlineNode",
        position: { x: 40 + (i % 4) * 260, y: 40 + Math.floor(i / 4) * 160 },
        data: {
          kind,
          title:
            lang === "zh"
              ? `${kindLabel(kind, "zh")}节点`
              : `${kindLabel(kind, "en")} node`,
        },
      };
      onChange({ ...graph, nodes: [...graph.nodes, n] });
      setSelectedEdgeId(null);
      setSelectedNodeId(id);
    },
    [graph, lang, onChange],
  );

  const deleteSelected = useCallback(() => {
    if (selectedNodeId) {
      const nextNodes = graph.nodes.filter((n) => n.id !== selectedNodeId);
      const nextEdges = graph.edges.filter(
        (e) => e.source !== selectedNodeId && e.target !== selectedNodeId,
      );
      onChange({ ...graph, nodes: nextNodes, edges: nextEdges });
      setSelectedNodeId(null);
      return;
    }
    if (selectedEdgeId) {
      onChange({
        ...graph,
        edges: graph.edges.filter((e) => e.id !== selectedEdgeId),
      });
      setSelectedEdgeId(null);
    }
  }, [graph, onChange, selectedEdgeId, selectedNodeId]);

  const updateNodeData = useCallback(
    (patch: Partial<OutlineNodeData>) => {
      if (!selectedNodeId) return;
      onChange({
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === selectedNodeId
            ? (() => {
                const prev = n.data;
                const next: OutlineNodeData = {
                  kind: prev.kind,
                  title: prev.title,
                  text: prev.text,
                  summary: prev.summary,
                  goal: prev.goal,
                  order: prev.order,
                };
                if (patch.kind !== undefined) next.kind = patch.kind;
                if (patch.title !== undefined) next.title = patch.title;
                if ("text" in patch) next.text = patch.text;
                if ("summary" in patch) next.summary = patch.summary;
                if ("goal" in patch) next.goal = patch.goal;
                if ("order" in patch) next.order = patch.order;
                return { ...n, data: next };
              })()
            : n,
        ),
      });
    },
    [graph, onChange, selectedNodeId],
  );

  const updateEdgeData = useCallback(
    (patch: Partial<OutlineEdgeData>) => {
      if (!selectedEdgeId) return;
      onChange({
        ...graph,
        edges: graph.edges.map((e) =>
          e.id === selectedEdgeId
            ? (() => {
                const prev = (e.data ?? { kind: "relates" }) as OutlineEdgeData;
                const next: OutlineEdgeData = {
                  kind: prev.kind ?? "relates",
                  label: prev.label,
                };
                if (patch.kind !== undefined) next.kind = patch.kind;
                if ("label" in patch) next.label = patch.label;
                return { ...e, data: next, label: next.label ?? e.label };
              })()
            : e,
        ),
      });
    },
    [graph, onChange, selectedEdgeId],
  );

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs text-[var(--ui-muted)]">
          {readOnly
            ? lang === "zh"
              ? "只读预览：可拖拽画布/缩放查看。"
              : "Read-only view: pan/zoom to inspect."
            : lang === "zh"
              ? "拖拽节点；拖拽连线生成关系箭头；点击节点/边可编辑。"
              : "Drag nodes; connect to create edges; click nodes/edges to edit."}
        </div>
        {!readOnly ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => spawnNode("chapter")}
              className="rounded-md bg-[var(--ui-accent)] px-2 py-1 text-xs text-[var(--ui-accent-foreground)] hover:opacity-90"
            >
              {lang === "zh" ? "新增章节" : "Add chapter"}
            </button>
            <button
              type="button"
              onClick={() => spawnNode("plot")}
              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
            >
              {lang === "zh" ? "新增情节" : "Add plot"}
            </button>
            <button
              type="button"
              onClick={() => spawnNode("character")}
              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
            >
              {lang === "zh" ? "新增人物" : "Add character"}
            </button>
            <button
              type="button"
              onClick={deleteSelected}
              className="rounded-md border border-zinc-200 bg-[var(--ui-control)] px-2 py-1 text-xs text-[var(--ui-control-text)] hover:bg-[var(--ui-bg)]"
            >
              {lang === "zh" ? "删除选中" : "Delete selected"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <div className="h-[520px] rounded-lg border border-zinc-200 bg-[var(--ui-surface)]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            nodeTypes={nodeTypes}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable={!readOnly}
            onNodeClick={
              readOnly
                ? undefined
                : (_, n) => {
                    setSelectedEdgeId(null);
                    setSelectedNodeId(n.id);
                  }
            }
            onEdgeClick={
              readOnly
                ? undefined
                : (_, e) => {
                    setSelectedNodeId(null);
                    setSelectedEdgeId(e.id);
                  }
            }
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed },
              style: { stroke: "rgba(100,116,139,0.9)", strokeWidth: 2 },
            }}
            fitView
          >
            <Background gap={20} size={1} />
            <MiniMap
              nodeColor={(n) =>
                kindColor(((n.data as OutlineNodeData)?.kind ?? "plot") as OutlineNodeKind)
              }
              nodeStrokeWidth={2}
              pannable
              zoomable
            />
            <Controls />
          </ReactFlow>
        </div>

        {!readOnly ? (
        <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-3">
          <div className="text-sm font-medium">
            {lang === "zh" ? "检查器" : "Inspector"}
          </div>
          {!selectedNode && !selectedEdge ? (
            <div className="mt-2 text-xs text-[var(--ui-muted)]">
              {lang === "zh"
                ? "点击一个节点或关系箭头以编辑。"
                : "Click a node or edge to edit."}
            </div>
          ) : null}

          {selectedNode ? (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-[var(--ui-muted)]">
                {lang === "zh" ? "节点" : "Node"}:{" "}
                <span className="font-mono">{selectedNode.id}</span>
              </div>

              <div className="grid gap-1">
                <div className="text-xs text-[var(--ui-muted)]">
                  {lang === "zh" ? "类型" : "Kind"}
                </div>
                <select
                  value={selectedNode.data.kind}
                  onChange={(e) =>
                    updateNodeData({ kind: e.target.value as OutlineNodeKind })
                  }
                  className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)]"
                >
                  {(
                    [
                      "chapter",
                      "plot",
                      "character",
                      "time",
                      "place",
                      "item",
                      "foreshadow",
                    ] as const
                  ).map((k) => (
                    <option key={k} value={k}>
                      {kindLabel(k, lang)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-1">
                <div className="text-xs text-[var(--ui-muted)]">
                  {lang === "zh" ? "标题" : "Title"}
                </div>
                <input
                  value={selectedNode.data.title ?? ""}
                  onChange={(e) => updateNodeData({ title: e.target.value })}
                  className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)]"
                />
              </div>

              {selectedNode.data.kind === "chapter" ? (
                <>
                  <div className="grid gap-1">
                    <div className="text-xs text-[var(--ui-muted)]">
                      {lang === "zh" ? "章节顺序" : "Order"}
                    </div>
                    <input
                      value={
                        selectedNode.data.order !== undefined
                          ? String(selectedNode.data.order)
                          : ""
                      }
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        updateNodeData({
                          order: Number.isFinite(v) ? v : undefined,
                        });
                      }}
                      className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)]"
                      placeholder={lang === "zh" ? "1,2,3..." : "1,2,3..."}
                    />
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-[var(--ui-muted)]">
                      {lang === "zh" ? "简介" : "Summary"}
                    </div>
                    <textarea
                      value={selectedNode.data.summary ?? ""}
                      onChange={(e) =>
                        updateNodeData({ summary: e.target.value })
                      }
                      className="min-h-[76px] w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)]"
                      placeholder={lang === "zh" ? "可选" : "Optional"}
                    />
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-[var(--ui-muted)]">
                      {lang === "zh" ? "目标" : "Goal"}
                    </div>
                    <input
                      value={selectedNode.data.goal ?? ""}
                      onChange={(e) => updateNodeData({ goal: e.target.value })}
                      className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)]"
                      placeholder={lang === "zh" ? "可选" : "Optional"}
                    />
                  </div>
                </>
              ) : (
                <div className="grid gap-1">
                  <div className="text-xs text-[var(--ui-muted)]">
                    {lang === "zh" ? "内容" : "Notes"}
                  </div>
                  <textarea
                    value={selectedNode.data.text ?? ""}
                    onChange={(e) => updateNodeData({ text: e.target.value })}
                    className="min-h-[110px] w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)]"
                    placeholder={
                      lang === "zh"
                        ? "可写：设定/冲突/动机/伏笔等"
                        : "Notes: facts / conflict / motivation / foreshadow..."
                    }
                  />
                </div>
              )}
            </div>
          ) : null}

          {selectedEdge ? (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-[var(--ui-muted)]">
                {lang === "zh" ? "关系" : "Edge"}:{" "}
                <span className="font-mono">{selectedEdge.id}</span>
              </div>
              <div className="text-xs text-[var(--ui-muted)]">
                {lang === "zh" ? "从" : "From"}:{" "}
                <span className="font-mono">{selectedEdge.source}</span>
                {"  →  "}
                {lang === "zh" ? "到" : "To"}:{" "}
                <span className="font-mono">{selectedEdge.target}</span>
              </div>

              <div className="grid gap-1">
                <div className="text-xs text-[var(--ui-muted)]">
                  {lang === "zh" ? "类型" : "Kind"}
                </div>
                <select
                  value={(selectedEdge.data?.kind ?? "relates") as string}
                  onChange={(e) =>
                    updateEdgeData({ kind: e.target.value as OutlineEdgeKind })
                  }
                  className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)]"
                >
                  {(["next", "contains", "causes", "relates", "conflicts"] as const).map(
                    (k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ),
                  )}
                </select>
              </div>

              <div className="grid gap-1">
                <div className="text-xs text-[var(--ui-muted)]">
                  {lang === "zh" ? "标签" : "Label"}
                </div>
                <input
                  value={selectedEdge.data?.label ?? ""}
                  onChange={(e) => updateEdgeData({ label: e.target.value })}
                  className="w-full rounded-md border border-zinc-200 bg-[var(--ui-control)] px-3 py-2 text-xs text-[var(--ui-control-text)]"
                  placeholder={lang === "zh" ? "可选" : "Optional"}
                />
              </div>
            </div>
          ) : null}
        </div>
        ) : (
          <div className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] p-3">
            <div className="text-sm font-medium">
              {lang === "zh" ? "图例" : "Legend"}
            </div>
            <div className="mt-2 grid gap-1 text-xs text-[var(--ui-muted)]">
              {lang === "zh" ? (
                <>
                  <div>• 橙：章节</div>
                  <div>• 蓝：情节</div>
                  <div>• 绿：人物</div>
                  <div>• 紫：时间</div>
                  <div>• 青：地点</div>
                  <div>• 黄：物件</div>
                  <div>• 红：伏笔</div>
                </>
              ) : (
                <>
                  <div>• Orange: chapter</div>
                  <div>• Blue: plot</div>
                  <div>• Green: character</div>
                  <div>• Purple: time</div>
                  <div>• Teal: place</div>
                  <div>• Yellow: item</div>
                  <div>• Red: foreshadow</div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
