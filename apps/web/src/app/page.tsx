"use client";

import { useEffect, useMemo, useState } from "react";

type TabKey = "writing" | "agents" | "settings";

type Health = {
  ok: boolean;
  service?: string;
};

export default function Home() {
  const [tab, setTab] = useState<TabKey>("writing");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

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
                OK ({health.service ?? "unknown"})
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
          </section>
        ) : null}

        {tab === "agents" ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h1 className="text-lg font-semibold">Agent Collaboration</h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              This tab will visualize multi-agent traces (timeline + graph) from
              the backend runs.
            </p>
          </section>
        ) : null}

        {tab === "settings" ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h1 className="text-lg font-semibold">Settings</h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              Model/provider selection (GPT vs Gemini), KB mode, web search, and
              other runtime settings will live here.
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
