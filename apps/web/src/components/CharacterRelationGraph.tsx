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

function buildAdjacency(
  nodes: Array<{ id: string }>,
  rels: CharacterRelation[],
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) {
    adj.set(n.id, new Set());
  }
  for (const r of rels) {
    const a = (r?.source || "").trim();
    const b = (r?.target || "").trim();
    if (!a || !b || a === b) continue;
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  return adj;
}

function computeComponents(adj: Map<string, Set<string>>): string[][] {
  const remaining = new Set(adj.keys());
  const comps: string[][] = [];
  while (remaining.size > 0) {
    const start = remaining.values().next().value as string;
    remaining.delete(start);
    const q: string[] = [start];
    const comp: string[] = [start];
    while (q.length > 0) {
      const cur = q.shift()!;
      for (const nb of adj.get(cur) ?? []) {
        if (!remaining.has(nb)) continue;
        remaining.delete(nb);
        q.push(nb);
        comp.push(nb);
      }
    }
    comps.push(comp);
  }
  return comps;
}

function bfsLayers(
  start: string,
  adj: Map<string, Set<string>>,
  allowed: Set<string>,
): Map<string, number> {
  const dist = new Map<string, number>();
  const q: string[] = [start];
  dist.set(start, 0);
  while (q.length > 0) {
    const cur = q.shift()!;
    const d = dist.get(cur) ?? 0;
    for (const nb of adj.get(cur) ?? []) {
      if (!allowed.has(nb)) continue;
      if (dist.has(nb)) continue;
      dist.set(nb, d + 1);
      q.push(nb);
    }
  }
  return dist;
}

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

  const neighborIds = useMemo(() => {
    if (!selected) return new Set<string>();
    const rels = Array.isArray(data.relations) ? data.relations : [];
    const out = new Set<string>();
    for (const r of rels) {
      if (!r || typeof r !== "object") continue;
      const src = String(r.source || "");
      const dst = String(r.target || "");
      if (src === selected.id && dst) out.add(dst);
      if (dst === selected.id && src) out.add(src);
    }
    return out;
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

    const rels = Array.isArray(data.relations) ? data.relations : [];
    const adj = buildAdjacency(characters, rels);
    const degree = new Map<string, number>();
    for (const [id, nbs] of adj.entries()) degree.set(id, nbs.size);

    const comps = computeComponents(adj);
    comps.sort((a, b) => {
      const da = Math.max(0, ...a.map((id) => degree.get(id) ?? 0));
      const db = Math.max(0, ...b.map((id) => degree.get(id) ?? 0));
      if (db !== da) return db - da;
      return b.length - a.length;
    });

    const xGap = 320;
    const yGap = 120;
    const compGap = 420;
    let xOffset = 0;

    const positions = new Map<string, { x: number; y: number }>();

    for (const comp of comps) {
      const allowed = new Set(comp);
      const center = [...comp]
        .slice()
        .sort((a, b) => {
          const da = degree.get(a) ?? 0;
          const db = degree.get(b) ?? 0;
          if (db !== da) return db - da;
          return a.localeCompare(b);
        })[0]!;

      const dist = bfsLayers(center, adj, allowed);
      const maxLayer = Math.max(0, ...comp.map((id) => dist.get(id) ?? 999));
      const layers: Record<number, string[]> = {};
      for (const id of comp) {
        const d = dist.get(id);
        const layer = typeof d === "number" ? d : maxLayer + 1;
        layers[layer] ??= [];
        layers[layer].push(id);
      }

      const layerKeys = Object.keys(layers)
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x))
        .sort((a, b) => a - b);

      for (const lk of layerKeys) {
        const ids = layers[lk] ?? [];
        ids.sort((a, b) => {
          const da = degree.get(a) ?? 0;
          const db = degree.get(b) ?? 0;
          if (db !== da) return db - da;
          return a.localeCompare(b);
        });
        const startY = -((ids.length - 1) * yGap) / 2;
        for (let i = 0; i < ids.length; i += 1) {
          const id = ids[i]!;
          positions.set(id, {
            x: xOffset + lk * xGap,
            y: startY + i * yGap,
          });
        }
      }

      const width = (Math.max(...layerKeys, 0) + 1) * xGap;
      xOffset += Math.max(520, width) + compGap;
    }

    for (const c of characters) {
      const pos = positions.get(c.id) ?? { x: 0, y: 0 };
      const subtitleParts: string[] = [];
      if (c.identity) subtitleParts.push(c.identity);
      if (c.gender) subtitleParts.push(c.gender);
      const subtitle = subtitleParts.filter(Boolean).join(" · ");

      const isSelected = selectedId === c.id;
      const isNeighbor = selectedId ? neighborIds.has(c.id) : false;
      const dim = selectedId && !isSelected && !isNeighbor;

      nodesOut.push({
        id: c.id,
        type: "charCard",
        position: pos,
        style: dim ? { opacity: 0.25 } : undefined,
        data: {
          name: c.name,
          subtitle: subtitle || undefined,
          color: isSelected
            ? "var(--ui-accent)"
            : isNeighbor
              ? "rgba(249,115,22,0.55)"
              : "rgba(100,116,139,0.65)",
        } satisfies CardNodeData,
      });
    }
    for (const r of rels) {
      if (!r || typeof r !== "object") continue;
      if (!r.source || !r.target) continue;
      if (r.source === r.target) continue;
      if (!nodesOut.some((nn) => nn.id === r.source)) continue;
      if (!nodesOut.some((nn) => nn.id === r.target)) continue;
      const color = colorByRelationType(r.type);

       const incidentToSelected =
         Boolean(selectedId) && (r.source === selectedId || r.target === selectedId);
       const dim = Boolean(selectedId) && !incidentToSelected;
      edgesOut.push({
        id: `e:${r.source}->${r.target}:${r.type}`,
        source: r.source,
        target: r.target,
        type: "smoothstep",
        label: r.label ? String(r.label) : relationTypeLabel(r.type, lang),
        markerEnd: { type: MarkerType.ArrowClosed },
        style: {
          stroke: color,
          strokeWidth: dim ? 1.6 : 2.4,
          opacity: dim ? 0.12 : 0.88,
        },
      });
    }

    return { nodes: nodesOut, edges: edgesOut };
  }, [characters, data.relations, lang, neighborIds, selectedId]);

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
