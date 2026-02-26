"use client";

import { useEffect, useMemo, useState } from "react";

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

export default function Home() {
  const [tab, setTab] = useState<TabKey>("writing");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [newProjectTitle, setNewProjectTitle] = useState<string>("My Novel");
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
  const [runError, setRunError] = useState<string | null>(null);
  const [runInProgress, setRunInProgress] = useState<boolean>(false);
  const [generatedMarkdown, setGeneratedMarkdown] = useState<string>("");

  const apiBase = useMemo(() => {
    return process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  }, []);

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

  async function runDemoPipeline() {
    if (!selectedProjectId) return;
    setRunError(null);
    setRunInProgress(true);
    setRunEvents([]);

    const res = await fetch(
      `${apiBase}/api/projects/${selectedProjectId}/runs/stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "demo" }),
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
        } catch {
          // ignore partial/bad events
        }
      }
    }
    setRunInProgress(false);
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-zinc-900 dark:bg-zinc-100" />
            <div className="leading-tight">
              <div className="text-sm font-semibold">ai-writer</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                Multi-agent novel workspace (MVP)
              </div>
            </div>
          </div>

          <nav className="flex items-center gap-2">
            {(
              [
                ["writing", "Writing"],
                ["agents", "Agent Collaboration"],
                ["settings", "Settings"],
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
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-4">
            <div className="font-medium">Backend</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              {apiBase}
            </div>
          </div>
          <div className="mt-2 text-zinc-700 dark:text-zinc-200">
            {health ? (
              <span>
                OK ({health.service ?? "unknown"}
                {health.version ? ` v${health.version}` : ""})
              </span>
            ) : healthError ? (
              <span className="text-red-600 dark:text-red-400">
                Unreachable: {healthError}
              </span>
            ) : (
              <span>Checking...</span>
            )}
          </div>
        </div>

        {tab === "writing" ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h1 className="text-lg font-semibold">Writing</h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              This is the Notion-like writing workspace (coming next). For now,
              it is a placeholder.
            </p>

            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="text-sm font-medium">Projects</div>
                <div className="mt-3 flex gap-2">
                  <input
                    value={newProjectTitle}
                    onChange={(e) => setNewProjectTitle(e.target.value)}
                    className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                    placeholder="Project title"
                  />
                  <button
                    onClick={() => {
                      createProject().catch((e) =>
                        setProjectsError((e as Error).message),
                      );
                    }}
                    className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    Create
                  </button>
                </div>

                {projectsError ? (
                  <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                    {projectsError}
                  </div>
                ) : null}

                <div className="mt-3 max-h-64 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
                  {projects.length === 0 ? (
                    <div className="p-3 text-sm text-zinc-500 dark:text-zinc-400">
                      No projects yet.
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

              <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="text-sm font-medium">Selected Project</div>
                <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
                  {selectedProjectId ? (
                    <span>Project ID: {selectedProjectId}</span>
                  ) : (
                    <span>None</span>
                  )}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    disabled={!selectedProjectId || runInProgress}
                    onClick={() => {
                      runDemoPipeline().catch((e) =>
                        setRunError((e as Error).message),
                      );
                    }}
                    className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    {runInProgress ? "Running..." : "Run Demo Pipeline"}
                  </button>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    Streams events and updates the Agents tab.
                  </span>
                </div>
                {runError ? (
                  <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                    {runError}
                  </div>
                ) : null}

                <div className="mt-4">
                  <div className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Latest Markdown (demo)
                  </div>
                  <textarea
                    value={generatedMarkdown}
                    onChange={(e) => setGeneratedMarkdown(e.target.value)}
                    className="h-40 w-full rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-950"
                    placeholder="Generated markdown will appear here..."
                  />
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {tab === "agents" ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h1 className="text-lg font-semibold">Agent Collaboration</h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              This tab will visualize multi-agent traces (timeline + graph) from
              the backend runs.
            </p>

            <div className="mt-6 rounded-lg border border-zinc-200 dark:border-zinc-800">
              {runEvents.length === 0 ? (
                <div className="p-4 text-sm text-zinc-500 dark:text-zinc-400">
                  No run events yet. Run the demo pipeline in the Writing tab.
                </div>
              ) : (
                <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
                  {runEvents.map((e) => (
                    <li key={`${e.run_id}:${e.seq}`} className="p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium">
                          {e.seq}. {e.type}
                          {e.agent ? ` · ${e.agent}` : ""}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {new Date(e.ts).toLocaleTimeString()}
                        </div>
                      </div>
                      {"text" in e.data ? (
                        <div className="mt-1 text-zinc-600 dark:text-zinc-300">
                          {String(e.data.text)}
                        </div>
                      ) : null}
                      {"artifact_type" in e.data ? (
                        <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          artifact: {String(e.data.artifact_type)}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}

        {tab === "settings" ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h1 className="text-lg font-semibold">Settings</h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              Model/provider selection (GPT vs Gemini), KB mode, web search, and
              other runtime settings will live here.
            </p>

            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="text-sm font-medium">Secrets Status</div>
                <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  Keys are loaded from environment variables or local{" "}
                  <code className="rounded bg-zinc-100 px-1 py-0.5 text-[11px] dark:bg-zinc-800">
                    api.txt
                  </code>{" "}
                  (never shown in UI).
                </div>
                <div className="mt-3 space-y-2 text-sm">
                  {secretsStatus ? (
                    <>
                      <div>
                        GPT key:{" "}
                        {secretsStatus.openai_api_key_present ? "present" : "missing"}
                      </div>
                      <div>
                        Gemini key:{" "}
                        {secretsStatus.gemini_api_key_present ? "present" : "missing"}
                      </div>
                    </>
                  ) : (
                    <div className="text-zinc-500 dark:text-zinc-400">
                      Not available (backend unreachable?)
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="text-sm font-medium">Project Settings</div>
                <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  Select a project first in the Writing tab.
                </div>

                {selectedProject ? (
                  <div className="mt-4 grid gap-3">
                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        Provider
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
                        className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                      >
                        <option value="openai">GPT (OpenAI-compatible)</option>
                        <option value="gemini">Gemini</option>
                      </select>
                    </label>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        KB Mode
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
                        className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                      >
                        <option value="weak">Weak (prefer KB)</option>
                        <option value="strong">Strong (canon-locked)</option>
                      </select>
                    </label>

                    <label className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                      <span>Web Search Tool</span>
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

                    {settingsError ? (
                      <div className="text-sm text-red-600 dark:text-red-400">
                        {settingsError}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                    No project selected.
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
