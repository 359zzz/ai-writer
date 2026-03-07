import fs from "node:fs";
import path from "node:path";
import { expect, test, Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.setTimeout(15 * 60 * 1000);

const WEB_BASE_URL = process.env.AI_WRITER_WEB_URL ?? "http://localhost:3000";
const API_BASE_URL = process.env.AI_WRITER_API_URL ?? "http://127.0.0.1:8000";
const DEFAULT_BOOK_ROOT = path.resolve(process.cwd(), "..", "..");
const TEST_BOOK_PATH =
  process.env.AI_WRITER_TEST_BOOK ??
  (() => {
    const candidates = fs
      .readdirSync(DEFAULT_BOOK_ROOT)
      .filter((name) => name.toLowerCase().endsWith(".txt") && name.toLowerCase() !== "api.txt")
      .map((name) => path.join(DEFAULT_BOOK_ROOT, name))
      .sort((left, right) => fs.statSync(right).size - fs.statSync(left).size);
    if (!candidates.length) {
      throw new Error(`No .txt test book found under ${DEFAULT_BOOK_ROOT}`);
    }
    return candidates[0];
  })();
const TEST_BOOK_NAME = path.basename(TEST_BOOK_PATH);

const TEXT = {
  topContinue: "\u7eed\u5199",
  topSettings: "\u8bbe\u7f6e",
  settingsModel: "\u6a21\u578b",
  runContinue: "\u62bd\u53d6 + \u7eed\u5199",
  dismissHint: "\u4e0d\u518d\u63d0\u793a",
};

type Provider = "openai" | "gemini";

type ModelCase = {
  label: string;
  provider: Provider;
  model: string;
};

type RunRecord = {
  id: string;
  status: string;
  kind: string;
};

type TraceEvent = {
  event_type?: string;
  agent?: string;
  payload?: Record<string, unknown> | null;
};

const CASES: ModelCase[] = [
  { label: "openai gpt-5.2", provider: "openai", model: "gpt-5.2" },
  { label: "openai gpt-5.4", provider: "openai", model: "gpt-5.4" },
  {
    label: "gemini gemini-3-flash-preview",
    provider: "gemini",
    model: "gemini-3-flash-preview",
  },
  {
    label: "gemini gemini-2.5-pro",
    provider: "gemini",
    model: "gemini-2.5-pro",
  },
];

async function apiJson<T>(urlPath: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${urlPath}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`${init?.method ?? "GET"} ${urlPath} failed: ${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

async function createAcceptanceProject(modelCase: ModelCase): Promise<{ id: string; title: string }> {
  const title = `pw-continue-${modelCase.provider}-${modelCase.model}-${Date.now()}`;
  const project = await apiJson<{ id: string }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  const settings: Record<string, unknown> = {
    writing: { chapter_words: 320 },
    llm: {
      provider: modelCase.provider,
      temperature: 0.7,
      max_tokens: 900,
      openai: {
        model: modelCase.provider === "openai" ? modelCase.model : "gpt-5.2",
        base_url: "https://www.packyapi.com/v1",
        wire_api: "chat",
      },
    },
  };
  if (modelCase.provider === "openai") {
    (settings.llm as Record<string, unknown>).openai = {
      model: modelCase.model,
      base_url: "https://www.packyapi.com/v1",
      wire_api: "chat",
    };
  } else {
    (settings.llm as Record<string, unknown>).gemini = {
      model: modelCase.model,
      base_url: "https://www.packyapi.com/v1",
    };
  }
  await apiJson(`/api/projects/${project.id}`, {
    method: "PATCH",
    body: JSON.stringify({ settings }),
  });
  return { id: project.id, title };
}

async function dismissHintIfPresent(page: Page): Promise<void> {
  const dismissButton = page.locator(`button:has-text("${TEXT.dismissHint}")`).first();
  if (await dismissButton.count()) {
    await dismissButton.click().catch(() => {});
  }
}

async function openProject(page: Page, title: string): Promise<void> {
  await page.goto(WEB_BASE_URL, { waitUntil: "networkidle" });
  await dismissHintIfPresent(page);
  await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByText(title, { exact: true }).click();
}

async function openSettingsAndVerify(page: Page, modelCase: ModelCase): Promise<void> {
  await page.locator(`button:has-text("${TEXT.topSettings}")`).click();
  await page.locator(`button:has-text("${TEXT.settingsModel}")`).click();
  const providerValue = await page.locator("select").evaluateAll((els) => {
    for (const el of els as HTMLSelectElement[]) {
      const values = Array.from(el.options).map((opt) => opt.value);
      if (values.includes("openai") && values.includes("gemini")) {
        return el.value;
      }
    }
    return null;
  });
  expect(providerValue).toBe(modelCase.provider);
  await expect(page.locator(`input[value="${modelCase.model}"]`).first()).toBeVisible({ timeout: 30_000 });
}

async function openContinueAndUpload(page: Page): Promise<void> {
  await page.locator(`button:has-text("${TEXT.topContinue}")`).click();
  await page.locator('input[type="file"]').first().setInputFiles(TEST_BOOK_PATH);
  await expect(page.locator("body")).toContainText(TEST_BOOK_NAME, { timeout: 120_000 });
}

async function waitForCompletedRun(projectId: string): Promise<RunRecord> {
  let latestRun: RunRecord | null = null;
  await expect
    .poll(
      async () => {
        const runs = await apiJson<RunRecord[]>(`/api/projects/${projectId}/runs`);
        latestRun = runs[0] ?? null;
        return latestRun?.status ?? "missing";
      },
      {
        timeout: 12 * 60 * 1000,
        intervals: [1000, 2000, 5000, 8000],
      },
    )
    .toBe("completed");
  if (!latestRun) {
    throw new Error(`No run found for project ${projectId}`);
  }
  return latestRun;
}

async function loadRunEvents(runId: string): Promise<TraceEvent[]> {
  return apiJson<TraceEvent[]>(`/api/runs/${runId}/events?limit=20000`);
}

function artifactTypes(events: TraceEvent[]): string[] {
  return events
    .filter((evt) => evt.event_type === "artifact")
    .map((evt) => String(evt.payload?.artifact_type ?? ""))
    .filter(Boolean);
}

function writerCalls(events: TraceEvent[]): Array<{ provider: string; model: string; note: string }> {
  return events
    .filter((evt) => evt.event_type === "tool_call" && evt.agent === "Writer")
    .map((evt) => ({
      provider: String(evt.payload?.provider ?? ""),
      model: String(evt.payload?.model ?? ""),
      note: String(evt.payload?.note ?? ""),
    }));
}

for (const modelCase of CASES) {
  test(`continue acceptance: ${modelCase.label}`, async ({ page }) => {
    const project = await createAcceptanceProject(modelCase);

    await openProject(page, project.title);
    await openSettingsAndVerify(page, modelCase);
    await openContinueAndUpload(page);

    await page.locator(`button:has-text("${TEXT.runContinue}")`).click();

    const completedRun = await waitForCompletedRun(project.id);
    const events = await loadRunEvents(completedRun.id);
    const artifacts = artifactTypes(events);
    const writerToolCalls = writerCalls(events);
    const markdownBox = page.locator("textarea.font-mono").first();

    expect(artifacts).toEqual(
      expect.arrayContaining(["story_state", "outline", "chapter_markdown"]),
    );
    expect(events.some((evt) => evt.event_type === "run_error")).toBeFalsy();
    expect(
      events.some(
        (evt) =>
          evt.event_type === "agent_output" && typeof evt.payload?.error === "string",
      ),
    ).toBeFalsy();
    expect(writerToolCalls[0]).toMatchObject({
      provider: modelCase.provider,
      model: modelCase.model,
    });
    if (modelCase.provider === "gemini") {
      expect(
        events.some(
          (evt) =>
            evt.event_type === "tool_call" &&
            evt.agent === "Editor" &&
            evt.payload?.note === "prefer_openai_editor_for_gemini_packy",
        ),
      ).toBeTruthy();
    }

    await expect(markdownBox).toHaveValue(/#/m, { timeout: 120_000 });
    const markdown = await markdownBox.inputValue();
    expect(markdown.length).toBeGreaterThan(200);
  });
}
