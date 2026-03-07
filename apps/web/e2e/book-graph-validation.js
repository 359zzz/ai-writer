/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const WEB_BASE_URL = 'http://localhost:3000';
const API_BASE_URL = 'http://127.0.0.1:8000';
const BOOK_ROOT = path.resolve(process.cwd(), '..', '..');
const EXCERPT_PATH = path.resolve(BOOK_ROOT, '_tmp_book_validation_excerpt.txt');
const TEST_BOOK_PATH = process.env.AI_WRITER_TEST_BOOK;
const TEXT = {
  topContinue: '\u7eed\u5199',
  topGraphs: '\u56fe\u8c31',
  bookStructureGraph: '\u4e66\u7c4d\u7ed3\u6784\u56fe',
  characterGraph: '\u4eba\u7269\u5173\u7cfb\u56fe',
  dismissHint: '\u4e0d\u518d\u63d0\u793a',
  continueBook: '\u4e66\u7c4d\u7eed\u5199',
  detectChapters: '\u7ae0\u8282\u5206\u5757',
  uploadBook: '\u4e0a\u4f20\u4e66\u7c4d\u6587\u4ef6\uff08\u63a8\u8350\uff09',
  summarize: '\u603b\u7ed3\u5165\u5e93\uff08LLM\uff09',
  replaceExisting: '\u8986\u76d6\u65e7\u7684\u4e66\u7c4d\u603b\u7ed3',
  retryFailed: '\u91cd\u65b0\u603b\u7ed3\u5931\u8d25\u7ae0\u8282',
  chapterReady: '\u7ae0\u8282\uff1a',
  scanBooks: '\u626b\u63cf\u5df2\u5165\u5e93\u4e66\u7c4d',
  buildRelations: '\u751f\u6210\u7ae0\u8282\u5173\u7cfb\uff08LLM\uff09',
  buildCharacters: '\u751f\u6210\u4eba\u7269\u5173\u7cfb\uff08LLM\uff09',
};

function log(...args) {
  console.log('[book-validate]', ...args);
}

function resolveSourceBookPath() {
  if (TEST_BOOK_PATH && fs.existsSync(TEST_BOOK_PATH)) {
    return TEST_BOOK_PATH;
  }
  const candidates = fs
    .readdirSync(BOOK_ROOT)
    .filter((name) => name.toLowerCase().endsWith('.txt'))
    .filter((name) => !['api.txt', path.basename(EXCERPT_PATH).toLowerCase()].includes(name.toLowerCase()))
    .map((name) => path.join(BOOK_ROOT, name))
    .sort((left, right) => fs.statSync(right).size - fs.statSync(left).size);
  if (!candidates.length) {
    throw new Error(`No source .txt test book found under ${BOOK_ROOT}`);
  }
  return candidates[0];
}

function ensureExcerptFile() {
  if (fs.existsSync(EXCERPT_PATH)) {
    return EXCERPT_PATH;
  }
  const sourceBookPath = resolveSourceBookPath();
  const text = fs.readFileSync(sourceBookPath, 'utf8');
  const excerpt = text.slice(0, 60000);
  fs.writeFileSync(EXCERPT_PATH, excerpt, 'utf8');
  log('created excerpt', EXCERPT_PATH, 'from', path.basename(sourceBookPath));
  return EXCERPT_PATH;
}

async function apiJson(urlPath, init) {
  const res = await fetch(`${API_BASE_URL}${urlPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method || 'GET'} ${urlPath} failed: ${res.status} ${txt}`);
  }
  return txt ? JSON.parse(txt) : null;
}

async function updateProjectSettings(projectId, { model, baseUrl = 'https://www.packyapi.com/v1' }) {
  const settings = {
    writing: { chapter_words: 600 },
    llm: {
      provider: 'openai',
      temperature: 0.4,
      max_tokens: 1000,
      openai: {
        model,
        base_url: baseUrl,
        wire_api: 'chat',
      },
    },
  };
  await apiJson(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ settings }),
  });
}

async function listRuns(projectId) {
  return await apiJson(`/api/projects/${projectId}/runs`);
}

async function waitForNewRun(projectId, knownRunIds, kind, timeoutMs = 12 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runs = await listRuns(projectId);
    const hit = runs.find((run) => run.kind === kind && !knownRunIds.has(run.id));
    if (hit && (hit.status === 'completed' || hit.status === 'failed' || hit.status === 'stopped')) {
      return hit;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${kind} run`);
}

async function runStream(projectId, payload) {
  const res = await fetch(`${API_BASE_URL}/api/projects/${projectId}/runs/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) {
    throw new Error(`stream failed: ${res.status} ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part
        .split('\n')
        .map((x) => x.trim())
        .find((x) => x.startsWith('data:'));
      if (!line) continue;
      const evt = JSON.parse(line.replace(/^data:\s*/, ''));
      events.push(evt);
      if (evt.type === 'run_completed') {
        return events;
      }
    }
  }
  return events;
}

async function fetchChunkMeta(projectId, sourceType, sourceId) {
  const qs = new URLSearchParams({
    source_type: sourceType,
    tag_contains: `book_source:${sourceId}`,
    limit: '200',
  });
  return await apiJson(`/api/projects/${projectId}/kb/chunks_meta?${qs.toString()}`);
}

async function fetchChunk(projectId, chunkId) {
  return await apiJson(`/api/projects/${projectId}/kb/chunks/${chunkId}`);
}

async function dismissHintIfPresent(page) {
  const btn = page.getByRole('button', { name: TEXT.dismissHint }).first();
  if (await btn.count()) {
    await btn.click().catch(() => {});
  }
}

async function selectProject(page, projectId, projectTitle) {
  await page.addInitScript((pid) => {
    localStorage.setItem('ai-writer:project_order:v1', JSON.stringify([pid]));
  }, projectId);
  await page.goto(WEB_BASE_URL, { waitUntil: 'networkidle' });
  await dismissHintIfPresent(page);
  const title = page.getByText(projectTitle, { exact: true }).first();
  await title.waitFor({ state: 'visible', timeout: 60_000 });
  await title.click();
}

async function clickButton(page, name, index = 0, exact = true) {
  const btn = page.getByRole('button', { name, exact }).nth(index);
  await btn.waitFor({ state: 'visible', timeout: 60_000 });
  await btn.click();
}

async function setCheckbox(page, labelText, checked) {
  const label = page.locator('label').filter({ hasText: labelText }).first();
  await label.waitFor({ state: 'visible', timeout: 30_000 });
  const input = label.locator('input[type="checkbox"]').first();
  const current = await input.isChecked();
  if (current !== checked) {
    await input.click();
  }
}

async function selectSourceOnAnyDropdown(page, sourceId) {
  const selects = page.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i += 1) {
    const select = selects.nth(i);
    const hasOption = await select.evaluate((el, value) => {
      return Array.from(el.options).some((opt) => opt.value === value);
    }, sourceId).catch(() => false);
    if (hasOption) {
      await select.selectOption(sourceId);
    }
  }
}

(async () => {
  const excerptPath = ensureExcerptFile();
  const secrets = await apiJson('/api/secrets/status');
  if (!secrets.openai_api_key_present) {
    throw new Error('OpenAI-compatible key missing in backend secrets');
  }

  const projectTitle = `pw-book-graph-${Date.now()}`;
  const project = await apiJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ title: projectTitle }),
  });
  await updateProjectSettings(project.id, { model: 'gpt-5.2' });
  log('project', project.id, projectTitle);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await selectProject(page, project.id, projectTitle);
    await clickButton(page, TEXT.topContinue, 0, true);
    await clickButton(page, TEXT.continueBook, 0, true);
    await page.getByText(TEXT.uploadBook, { exact: false }).waitFor({ state: "visible", timeout: 60_000 });

    const uploadPromise = page.waitForResponse((resp) => {
      return resp.url().includes('/api/tools/continue_sources/upload') && resp.request().method() === 'POST';
    });
    await page.locator('input[type="file"]').first().setInputFiles(excerptPath);
    const uploadRes = await uploadPromise;
    const uploadJson = await uploadRes.json();
    const sourceId = uploadJson.source_id;
    if (!sourceId) {
      throw new Error('upload response missing source_id');
    }
    log('uploaded source', sourceId);

    await clickButton(page, TEXT.detectChapters);
    await page.getByText(TEXT.chapterReady, { exact: false }).waitFor({ state: 'visible', timeout: 120_000 });
    log('chapter index ready');

    log('bootstrap summarize chapters 1-3 via API');
    const bootstrapParams = {
      kind: 'book_summarize',
      source_id: sourceId,
      segment_mode: 'chapter',
      max_chapters: 12,
      segment_indices: [1, 2, 3],
      replace_existing: true,
      summary_chars: 360,
    };
    let bootstrapEvents = await runStream(project.id, bootstrapParams);
    let bootstrapStats = bootstrapEvents.find((evt) => evt.type === 'artifact' && evt.agent === 'BookSummarizer' && evt.data?.artifact_type === 'book_summarize_stats');
    let bootstrapSummaryCount = (await fetchChunkMeta(project.id, 'book_summary', sourceId)).length;
    const bootstrapFailed = Array.isArray(bootstrapStats?.data?.failed_indices) ? bootstrapStats.data.failed_indices : [];
    if (bootstrapSummaryCount < 3 && bootstrapFailed.length) {
      log('bootstrap retry failed chapters', bootstrapFailed);
      bootstrapEvents = await runStream(project.id, {
        ...bootstrapParams,
        segment_indices: bootstrapFailed,
      });
      bootstrapStats = bootstrapEvents.find((evt) => evt.type === 'artifact' && evt.agent === 'BookSummarizer' && evt.data?.artifact_type === 'book_summarize_stats');
      bootstrapSummaryCount = (await fetchChunkMeta(project.id, 'book_summary', sourceId)).length;
    }
    if (bootstrapSummaryCount < 3) {
      throw new Error(`bootstrap summarize did not create expected summaries: ${JSON.stringify(bootstrapStats?.data || null)}`);
    }
    log('bootstrap summaries created', bootstrapSummaryCount);

    await updateProjectSettings(project.id, {
      model: 'gpt-5.2',
      baseUrl: 'http://127.0.0.1:1/v1',
    });
    await setCheckbox(page, TEXT.replaceExisting, false);
    const knownBeforeFailure = new Set((await listRuns(project.id)).map((run) => run.id));
    await clickButton(page, TEXT.summarize);
    const failedRun = await waitForNewRun(project.id, knownBeforeFailure, 'book_summarize', 6 * 60 * 1000);
    log('failure-mode summarize finished', failedRun.status);
    await page.getByRole('button', { name: TEXT.retryFailed }).waitFor({ state: 'visible', timeout: 120_000 });
    log('retry button visible');

    await updateProjectSettings(project.id, { model: 'gpt-5.2' });
    const knownBeforeRetry = new Set((await listRuns(project.id)).map((run) => run.id));
    await page.getByRole('button', { name: TEXT.retryFailed }).click();
    const retryRun = await waitForNewRun(project.id, knownBeforeRetry, 'book_summarize', 12 * 60 * 1000);
    log('retry summarize finished', retryRun.status);

    const summaryMeta = await fetchChunkMeta(project.id, 'book_summary', sourceId);
    if (summaryMeta.length < 4) {
      throw new Error(`expected >=4 book summaries after retry, got ${summaryMeta.length}`);
    }
    log('book summaries', summaryMeta.length);

    await clickButton(page, TEXT.topGraphs, 0, true);
    await clickButton(page, TEXT.bookStructureGraph, 0, true);
    await clickButton(page, TEXT.scanBooks, 0, true);
    await page.waitForTimeout(1500);
    await selectSourceOnAnyDropdown(page, sourceId);
    log('graph source selected');

    const knownBeforeRelations = new Set((await listRuns(project.id)).map((run) => run.id));
    await clickButton(page, TEXT.buildRelations, 0, true);
    const relationRun = await waitForNewRun(project.id, knownBeforeRelations, 'book_relations', 12 * 60 * 1000);
    log('relations run finished', relationRun.status);
    const relationMeta = await fetchChunkMeta(project.id, 'book_relations', sourceId);
    if (!relationMeta.length) {
      throw new Error('no book_relations chunk created');
    }
    const relationChunk = await fetchChunk(project.id, relationMeta[0].id);
    const relationRecord = JSON.parse(relationChunk.content);
    const relationEdges = (((relationRecord || {}).graph || {}).edges) || [];
    if (!Array.isArray(relationEdges) || relationEdges.length <= 0) {
      throw new Error('book_relations graph has no edges');
    }
    const meaningfulRelation = relationEdges.some((edge) => {
      const type = String(edge.type || '');
      const label = String(edge.label || '');
      return (type && type !== 'structure') || (label && label !== 'book_progression');
    });
    if (!meaningfulRelation) {
      throw new Error(`book_relations edges are still too generic: ${JSON.stringify(relationEdges.slice(0, 5))}`);
    }
    log('relation edges', relationEdges.length);

    await clickButton(page, TEXT.characterGraph, 0, true);
    await clickButton(page, TEXT.scanBooks, 0, true);
    await page.waitForTimeout(1500);
    await selectSourceOnAnyDropdown(page, sourceId);

    const knownBeforeCharacters = new Set((await listRuns(project.id)).map((run) => run.id));
    await clickButton(page, TEXT.buildCharacters, 0, true);
    const characterRun = await waitForNewRun(project.id, knownBeforeCharacters, 'book_characters', 12 * 60 * 1000);
    log('characters run finished', characterRun.status);
    const characterMeta = await fetchChunkMeta(project.id, 'book_characters', sourceId);
    if (!characterMeta.length) {
      throw new Error('no book_characters chunk created');
    }
    const characterChunk = await fetchChunk(project.id, characterMeta[0].id);
    const characterRecord = JSON.parse(characterChunk.content);
    const graph = (characterRecord || {}).graph || {};
    const characters = graph.characters || [];
    const relations = graph.relations || [];
    if (!Array.isArray(characters) || characters.length < 2) {
      throw new Error(`book_characters graph missing characters: ${JSON.stringify(graph).slice(0, 400)}`);
    }
    if (!Array.isArray(relations) || relations.length < 1) {
      throw new Error(`book_characters graph missing relations: ${JSON.stringify(graph).slice(0, 400)}`);
    }
    log('character graph', { characters: characters.length, relations: relations.length });

    const result = {
      projectId: project.id,
      sourceId,
      summaries: summaryMeta.length,
      relationEdges: relationEdges.length,
      characterCount: characters.length,
      characterRelations: relations.length,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
