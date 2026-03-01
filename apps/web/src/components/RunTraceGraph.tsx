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

type TraceEvent = {
  run_id: string;
  seq: number;
  ts: string;
  type: string;
  agent: string | null;
  data: Record<string, unknown>;
};

type AgentNodeData = {
  label: string;
  stats: string;
  color: string;
};

type ArtifactNodeData = {
  label: string;
  stats: string;
  color: string;
};

function AgentNodeView({ data }: { data: AgentNodeData }) {
  return (
    <div
      className="rounded-lg border border-zinc-200 bg-[var(--ui-control)] shadow-sm"
      style={{ width: 220, borderColor: data.color }}
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

function ArtifactNodeView({ data }: { data: ArtifactNodeData }) {
  return (
    <div
      className="rounded-lg border border-zinc-200 bg-[var(--ui-bg)] shadow-sm"
      style={{ width: 240, borderColor: data.color }}
    >
      <div className="p-3">
        <div className="text-xs font-medium text-[var(--ui-text)]">
          {data.label}
        </div>
        <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
          {data.stats}
        </div>
      </div>
    </div>
  );
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export function RunTraceGraph({
  lang,
  events,
  formatAgentName,
  agentColor,
}: {
  lang: "zh" | "en";
  events: TraceEvent[];
  formatAgentName: (agent: string) => string;
  agentColor: (agent: string | null) => string;
}) {
  const { nodes, edges } = useMemo(() => {
    const agentOrder: string[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      if (!e?.agent) continue;
      if (e.type !== "agent_started" && e.type !== "agent_finished") continue;
      const a = String(e.agent);
      if (!seen.has(a)) {
        seen.add(a);
        agentOrder.push(a);
      }
    }
    if (agentOrder.length === 0) {
      for (const e of events) {
        if (!e?.agent) continue;
        const a = String(e.agent);
        if (!seen.has(a)) {
          seen.add(a);
          agentOrder.push(a);
        }
      }
    }

    type AgentStats = {
      total_ms: number;
      tool_calls: number;
      artifacts: number;
      errors: number;
    };
    const stats: Record<string, AgentStats> = {};
    const activeStarts: Record<string, number[]> = {};

    const getStats = (a: string) => {
      stats[a] ??= { total_ms: 0, tool_calls: 0, artifacts: 0, errors: 0 };
      return stats[a];
    };

    for (const e of events) {
      const a = e.agent ? String(e.agent) : null;
      const ts = Number.isFinite(Date.parse(e.ts)) ? Date.parse(e.ts) : null;

      if (a) {
        const st = getStats(a);
        if (e.type === "tool_call") st.tool_calls += 1;
        if (e.type === "artifact") st.artifacts += 1;
        if (e.type === "run_error") st.errors += 1;
        if (e.type === "agent_started" && ts != null) {
          activeStarts[a] ??= [];
          activeStarts[a].push(ts);
        }
        if (e.type === "agent_finished" && ts != null) {
          const stack = activeStarts[a] ?? [];
          const start = stack.pop();
          if (typeof start === "number") st.total_ms += Math.max(0, ts - start);
        }
      }
    }

    // Aggregate artifacts by (agent, artifact_type).
    const artifactsByAgent: Record<
      string,
      Record<string, { count: number; extra: string[] }>
    > = {};
    for (const e of events) {
      if (e.type !== "artifact") continue;
      if (!e.agent) continue;
      const a = String(e.agent);
      const d = e.data as Record<string, unknown>;
      const t = typeof d.artifact_type === "string" ? d.artifact_type : null;
      if (!t) continue;
      artifactsByAgent[a] ??= {};
      artifactsByAgent[a][t] ??= { count: 0, extra: [] };
      artifactsByAgent[a][t].count += 1;

      // Keep some compact detail for chapter_markdown only.
      if (t === "chapter_markdown" && artifactsByAgent[a][t].extra.length < 8) {
        const ci = d.chapter_index;
        const title = typeof d.title === "string" ? d.title : null;
        const idx = typeof ci === "number" ? ci : Number(ci ?? NaN);
        if (Number.isFinite(idx)) {
          artifactsByAgent[a][t].extra.push(
            title ? `#${idx}:${title}` : `#${idx}`,
          );
        }
      }
    }

    const nodesOut: Node[] = [];
    const edgesOut: Edge[] = [];

    const xGap = 280;
    const yAgent = 40;
    const yArtifacts = 220;
    const yStep = 130;

    for (let i = 0; i < agentOrder.length; i++) {
      const a = agentOrder[i];
      const color = agentColor(a);
      const st = stats[a];
      const statsText = st
        ? `t=${formatDurationMs(st.total_ms)} · tools=${st.tool_calls} · artifacts=${st.artifacts}${
            st.errors ? ` · errors=${st.errors}` : ""
          }`
        : "t=0s · tools=0 · artifacts=0";
      nodesOut.push({
        id: `agent:${a}`,
        type: "traceAgent",
        position: { x: i * xGap, y: yAgent },
        data: {
          label: formatAgentName(a),
          stats: statsText,
          color,
        } satisfies AgentNodeData,
      });
      if (i > 0) {
        edgesOut.push({
          id: `e:agent:${agentOrder[i - 1]}->${a}`,
          source: `agent:${agentOrder[i - 1]}`,
          target: `agent:${a}`,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "rgba(100,116,139,0.7)", strokeWidth: 2 },
        });
      }
    }

    for (let i = 0; i < agentOrder.length; i++) {
      const a = agentOrder[i];
      const groups = artifactsByAgent[a] ?? {};
      const types = Object.keys(groups);
      if (types.length === 0) continue;

      // Stable ordering: highest count first.
      types.sort((x, y) => (groups[y]?.count ?? 0) - (groups[x]?.count ?? 0));
      const maxRender = 8;
      const shown = types.slice(0, maxRender);
      const more = Math.max(0, types.length - shown.length);

      shown.forEach((t, j) => {
        const g = groups[t];
        const extra = (g?.extra ?? []).join(", ");
        const label =
          lang === "zh"
            ? `产物：${t}`
            : `Artifact: ${t}`;
        const statsText = `${g?.count ?? 0}x${extra ? ` · ${extra}` : ""}`;
        const nodeId = `artifact:${a}:${t}`;
        nodesOut.push({
          id: nodeId,
          type: "traceArtifact",
          position: { x: i * xGap, y: yArtifacts + j * yStep },
          data: {
            label,
            stats: statsText,
            color: agentColor(a),
          } satisfies ArtifactNodeData,
        });
        edgesOut.push({
          id: `e:agent:${a}->artifact:${t}`,
          source: `agent:${a}`,
          target: nodeId,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "rgba(100,116,139,0.55)", strokeWidth: 2 },
        });
      });

      if (more > 0) {
        const nodeId = `artifact:${a}:__more__`;
        nodesOut.push({
          id: nodeId,
          type: "traceArtifact",
          position: { x: i * xGap, y: yArtifacts + shown.length * yStep },
          data: {
            label: lang === "zh" ? "更多产物类型" : "More artifact types",
            stats: lang === "zh" ? `+${more} 种` : `+${more} types`,
            color: agentColor(a),
          } satisfies ArtifactNodeData,
        });
        edgesOut.push({
          id: `e:agent:${a}->artifact:more`,
          source: `agent:${a}`,
          target: nodeId,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "rgba(100,116,139,0.55)", strokeWidth: 2 },
        });
      }
    }

    return { nodes: nodesOut, edges: edgesOut };
  }, [agentColor, events, formatAgentName, lang]);

  const nodeTypes = useMemo(
    () => ({
      traceAgent: AgentNodeView,
      traceArtifact: ArtifactNodeView,
    }),
    [],
  );

  if (events.length === 0) {
    return (
      <div className="text-sm text-[var(--ui-muted)]">
        {lang === "zh" ? "暂无事件。" : "No events."}
      </div>
    );
  }

  return (
    <div className="h-[560px] rounded-lg border border-zinc-200 bg-[var(--ui-surface)]">
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

