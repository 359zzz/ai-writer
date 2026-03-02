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

export type CharacterCard = {
  id: string;
  name: string;
  aliases?: string[];
  gender?: string;
  identity?: string;
  personality?: string;
  plot?: string;
  chapters?: number[];
  related_events?: string[];
};

export type CharacterRelation = {
  source: string;
  target: string;
  type: string;
  label?: string;
  detail?: string;
  chapters?: number[];
  strength?: number;
};

export type CharacterRelationGraphData = {
  source_id: string;
  generated_at?: string;
  characters: CharacterCard[];
  relations: CharacterRelation[];
};

type CardNodeData = {
  name: string;
  subtitle?: string;
  color: string;
};

function CardNodeView({ data }: { data: CardNodeData }) {
  return (
    <div
      className="rounded-lg border border-zinc-200 bg-[var(--ui-control)] shadow-sm"
      style={{ width: 240, borderColor: data.color }}
    >
      <div className="p-3">
        <div className="text-sm font-medium text-[var(--ui-control-text)]">
          {data.name}
        </div>
        {data.subtitle ? (
          <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
            {data.subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function colorByRelationType(type: string): string {
  const t = (type || "").trim().toLowerCase();
  const palette: Record<string, string> = {
    family: "rgba(239,68,68,0.55)",
    love: "rgba(244,63,94,0.55)",
    friend: "rgba(34,197,94,0.55)",
    enemy: "rgba(245,158,11,0.55)",
    master_servant: "rgba(59,130,246,0.55)",
    mentor: "rgba(99,102,241,0.55)",
    rival: "rgba(168,85,247,0.55)",
    ally: "rgba(14,165,233,0.55)",
    colleague: "rgba(100,116,139,0.55)",
  };
  return palette[t] ?? "rgba(100,116,139,0.55)";
}

function relationTypeLabel(type: string, lang: "zh" | "en"): string {
  const t = (type || "").trim().toLowerCase();
  const zh: Record<string, string> = {
    family: "亲属",
    love: "情感",
    friend: "朋友",
    enemy: "敌对",
    master_servant: "主仆",
    mentor: "师徒/导师",
    rival: "对手",
    ally: "盟友",
    colleague: "同僚/同事",
    other: "其他",
  };
  const en: Record<string, string> = {
    family: "Family",
    love: "Romance",
    friend: "Friend",
    enemy: "Enemy",
    master_servant: "Master/servant",
    mentor: "Mentor",
    rival: "Rival",
    ally: "Ally",
    colleague: "Colleague",
    other: "Other",
  };
  return lang === "zh" ? zh[t] ?? type : en[t] ?? type;
}

export function CharacterRelationGraph({
  lang,
  data,
  maxCharacters = 40,
}: {
  lang: "zh" | "en";
  data: CharacterRelationGraphData;
  maxCharacters?: number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const characters = useMemo(() => {
    const list = Array.isArray(data.characters) ? data.characters : [];
    const filtered = list
      .filter((c) => c && typeof c === "object" && typeof c.id === "string" && typeof c.name === "string")
      .slice(0, Math.max(1, Math.min(maxCharacters, 2000)));
    return filtered;
  }, [data.characters, maxCharacters]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return characters.find((c) => c.id === selectedId) ?? null;
  }, [characters, selectedId]);

  const relatedRelations = useMemo(() => {
    if (!selected) return [];
    const rels = Array.isArray(data.relations) ? data.relations : [];
    return rels.filter((r) => r && (r.source === selected.id || r.target === selected.id));
  }, [data.relations, selected]);

  const relationLegend = useMemo(() => {
    const rels = Array.isArray(data.relations) ? data.relations : [];
    const uniq: string[] = [];
    for (const r of rels) {
      if (!r || typeof r !== "object") continue;
      const t = (r.type || "other").trim() || "other";
      const low = t.toLowerCase();
      if (!uniq.some((x) => x.toLowerCase() === low)) uniq.push(t);
      if (uniq.length >= 16) break;
    }
    return uniq.map((t) => ({
      type: t,
      label: relationTypeLabel(t, lang),
      color: colorByRelationType(t),
    }));
  }, [data.relations, lang]);

  const { nodes, edges } = useMemo(() => {
    const nodesOut: Node[] = [];
    const edgesOut: Edge[] = [];

    const n = characters.length;
    const radius = Math.max(240, Math.min(520, 90 * n));
    const centerX = 0;
    const centerY = 0;

    for (let i = 0; i < characters.length; i += 1) {
      const c = characters[i];
      const angle = (Math.PI * 2 * i) / Math.max(1, n);
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      const subtitleParts: string[] = [];
      if (c.identity) subtitleParts.push(c.identity);
      if (c.gender) subtitleParts.push(c.gender);
      const subtitle = subtitleParts.filter(Boolean).join(" · ");
      nodesOut.push({
        id: c.id,
        type: "charCard",
        position: { x, y },
        data: {
          name: c.name,
          subtitle: subtitle || undefined,
          color: "rgba(100,116,139,0.65)",
        } satisfies CardNodeData,
      });
    }

    const rels = Array.isArray(data.relations) ? data.relations : [];
    for (const r of rels) {
      if (!r || typeof r !== "object") continue;
      if (!r.source || !r.target) continue;
      if (r.source === r.target) continue;
      if (!nodesOut.some((nn) => nn.id === r.source)) continue;
      if (!nodesOut.some((nn) => nn.id === r.target)) continue;
      const color = colorByRelationType(r.type);
      edgesOut.push({
        id: `e:${r.source}->${r.target}:${r.type}`,
        source: r.source,
        target: r.target,
        type: "smoothstep",
        label: r.label ? String(r.label) : relationTypeLabel(r.type, lang),
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: color, strokeWidth: 2 },
      });
    }

    return { nodes: nodesOut, edges: edgesOut };
  }, [characters, data.relations, lang]);

  const nodeTypes = useMemo(() => ({ charCard: CardNodeView }), []);

  if (!data.source_id) {
    return (
      <div className="text-sm text-[var(--ui-muted)]">
        {lang === "zh" ? "暂无书籍源。" : "No book source."}
      </div>
    );
  }

  if (characters.length === 0) {
    return (
      <div className="text-sm text-[var(--ui-muted)]">
        {lang === "zh"
          ? "暂无人物关系数据。请先生成/刷新人物关系图谱。"
          : "No character graph data yet. Build/refresh it first."}
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr,360px]">
      <div className="space-y-2">
        {relationLegend.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ui-muted)]">
            <span className="font-medium text-[var(--ui-text)]">
              {lang === "zh" ? "关系类型" : "Relation types"}:
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
          </div>
        ) : null}

        <div className="h-[620px] rounded-lg border border-zinc-200 bg-[var(--ui-surface)]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed },
              style: { stroke: "rgba(100,116,139,0.7)", strokeWidth: 2 },
            }}
            fitView
          >
            <Background gap={18} size={1} />
            <MiniMap
              nodeColor={() => "rgba(100,116,139,0.45)"}
              nodeStrokeWidth={2}
              pannable
              zoomable
            />
            <Controls />
          </ReactFlow>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-[var(--ui-surface)] p-4 text-sm">
        {selected ? (
          <div className="space-y-3">
            <div>
              <div className="text-base font-semibold text-[var(--ui-text)]">
                {selected.name}
              </div>
              <div className="mt-1 text-xs text-[var(--ui-muted)]">
                {[
                  selected.identity ? (lang === "zh" ? `身份：${selected.identity}` : `Identity: ${selected.identity}`) : "",
                  selected.gender ? (lang === "zh" ? `性别：${selected.gender}` : `Gender: ${selected.gender}`) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>

            {selected.personality ? (
              <div>
                <div className="text-xs font-medium text-[var(--ui-muted)]">
                  {lang === "zh" ? "性格" : "Personality"}
                </div>
                <div className="mt-1 whitespace-pre-wrap text-[var(--ui-text)]">
                  {selected.personality}
                </div>
              </div>
            ) : null}

            {selected.plot ? (
              <div>
                <div className="text-xs font-medium text-[var(--ui-muted)]">
                  {lang === "zh" ? "有关剧情" : "Plot relevance"}
                </div>
                <div className="mt-1 whitespace-pre-wrap text-[var(--ui-text)]">
                  {selected.plot}
                </div>
              </div>
            ) : null}

            {Array.isArray(selected.chapters) && selected.chapters.length > 0 ? (
              <div>
                <div className="text-xs font-medium text-[var(--ui-muted)]">
                  {lang === "zh" ? "有关章节" : "Chapters"}
                </div>
                <div className="mt-1 text-[var(--ui-text)]">
                  {selected.chapters.slice(0, 40).join(", ")}
                  {selected.chapters.length > 40 ? "…" : ""}
                </div>
              </div>
            ) : null}

            {Array.isArray(selected.aliases) && selected.aliases.length > 0 ? (
              <div>
                <div className="text-xs font-medium text-[var(--ui-muted)]">
                  {lang === "zh" ? "别名" : "Aliases"}
                </div>
                <div className="mt-1 text-[var(--ui-text)]">
                  {selected.aliases.slice(0, 12).join("、")}
                  {selected.aliases.length > 12 ? "…" : ""}
                </div>
              </div>
            ) : null}

            {relatedRelations.length > 0 ? (
              <div>
                <div className="text-xs font-medium text-[var(--ui-muted)]">
                  {lang === "zh" ? "人物关系" : "Relationships"}
                </div>
                <div className="mt-2 space-y-2">
                  {relatedRelations.slice(0, 30).map((r, idx) => {
                    const other = r.source === selected.id ? r.target : r.source;
                    const label = r.label ? String(r.label) : relationTypeLabel(r.type, lang);
                    const detail = r.detail ? String(r.detail) : "";
                    return (
                      <div
                        key={`${r.source}->${r.target}:${r.type}:${idx}`}
                        className="rounded-md border border-zinc-200 bg-[var(--ui-control)] p-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium text-[var(--ui-control-text)]">
                            {other}
                          </div>
                          <div className="text-[11px] text-[var(--ui-muted)]">
                            {label}
                          </div>
                        </div>
                        {detail ? (
                          <div className="mt-1 whitespace-pre-wrap text-[11px] text-[var(--ui-muted)]">
                            {detail}
                          </div>
                        ) : null}
                        {Array.isArray(r.chapters) && r.chapters.length > 0 ? (
                          <div className="mt-1 text-[11px] text-[var(--ui-muted)]">
                            {lang === "zh" ? "相关章：" : "Chapters: "}
                            {r.chapters.slice(0, 16).join(", ")}
                            {r.chapters.length > 16 ? "…" : ""}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-[var(--ui-muted)]">
            {lang === "zh"
              ? "点击一个人物节点查看详情。"
              : "Click a character node to view details."}
          </div>
        )}
      </div>
    </div>
  );
}
