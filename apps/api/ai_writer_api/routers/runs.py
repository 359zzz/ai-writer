from __future__ import annotations

import asyncio
import json
import re
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any, AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlmodel import select

from ..db import ENGINE, get_session
from ..llm import LLMError, parse_json_loose, resolve_llm_config, generate_text
from ..models import Chapter, KBChunk, Project, Run, TraceEvent
from ..tools.continue_sources import ContinueSourceError, load_continue_source_excerpt
from ..util import deep_merge, json_dumps, strip_think_blocks


router = APIRouter(tags=["runs"])


class RunRequestPayload(dict):
    # Keep request schema flexible for now.
    pass


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _coerce_lang(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    if not v or v == "auto":
        return None
    if v in {"zh", "zh-cn", "zh_cn", "zh-hans", "zh_hans", "cn", "chinese", "中文", "简体", "简体中文"}:
        return "zh"
    if v in {"en", "en-us", "en_us", "english", "英文"}:
        return "en"
    if v.startswith("zh"):
        return "zh"
    if v.startswith("en"):
        return "en"
    return None


def _resolve_output_lang(payload: dict[str, Any], project: Project) -> str:
    """
    Decide which language to ask the LLM to write in.

    Priority:
    1) payload override (ui_lang/output_lang/output_language/lang)
    2) project settings (writing/story/ui fields if present)
    3) heuristic: if project title/settings contain CJK -> zh else en
    """

    for key in ("output_lang", "output_language", "ui_lang", "lang"):
        resolved = _coerce_lang(payload.get(key))
        if resolved:
            return resolved

    settings = project.settings or {}
    if isinstance(settings, dict):
        writing = settings.get("writing") if isinstance(settings.get("writing"), dict) else {}
        story = settings.get("story") if isinstance(settings.get("story"), dict) else {}
        ui = settings.get("ui") if isinstance(settings.get("ui"), dict) else {}

        for candidate in (
            (writing or {}).get("output_lang"),
            (writing or {}).get("language"),
            (story or {}).get("output_lang"),
            (story or {}).get("language"),
            (ui or {}).get("lang"),
        ):
            resolved = _coerce_lang(candidate)
            if resolved:
                return resolved

        # Heuristic fallback.
        blob = f"{project.title or ''}\n{json.dumps(settings, ensure_ascii=False)}"
        if _CJK_RE.search(blob):
            return "zh"

    return "en"


def _lang_hint_json(lang: str) -> str:
    if lang == "zh":
        return (
            "Output language: Simplified Chinese (zh-CN). "
            "所有自然语言字段请用简体中文。"
            "Keep JSON keys in English as in the schema."
        )
    return "Output language: English (en). Keep JSON keys in English as in the schema."


def _lang_hint_markdown(lang: str) -> str:
    if lang == "zh":
        return (
            "Output language: Simplified Chinese (zh-CN). "
            "全文用简体中文书写（包括标题/小节标题）。"
        )
    return "Output language: English (en)."


def _writer_title_example(lang: str, chapter_index: int) -> str:
    if lang == "zh":
        return f"# 第{chapter_index}章：标题"
    return "# Chapter X: Title"


def _default_chapter_title(lang: str, chapter_index: int) -> str:
    if lang == "zh":
        return f"第{chapter_index}章"
    return f"Chapter {chapter_index}"


@router.get("/api/projects/{project_id}/runs")
def list_runs(project_id: str) -> list[Run]:
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        return list(
            session.exec(select(Run).where(Run.project_id == project_id).order_by(Run.created_at.desc()))
        )


@router.get("/api/runs/{run_id}/events")
def list_run_events(run_id: str) -> list[TraceEvent]:
    with get_session() as session:
        return list(session.exec(select(TraceEvent).where(TraceEvent.run_id == run_id).order_by(TraceEvent.seq.asc())))


@router.post("/api/projects/{project_id}/runs/stream")
async def stream_run(project_id: str, payload: dict[str, Any]) -> StreamingResponse:
    """
    MVP streaming endpoint.

    Supported kinds:
    - demo: placeholder pipeline
    - outline: generate outline (LLM)
    - chapter: write a chapter (LLM)
    - continue: extract story state + continue (LLM; minimal)
    """
    with get_session() as session:
        project = session.get(Project, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        kind = str(payload.get("kind") or "demo")
        run = Run(project_id=project_id, kind=kind, status="running")
        session.add(run)
        session.commit()
        session.refresh(run)

    async def gen() -> AsyncGenerator[bytes, None]:
        seq = 0

        def emit(event_type: str, agent: str | None, data: dict[str, Any]) -> bytes:
            nonlocal seq
            seq += 1
            evt = {
                "run_id": run.id,
                "seq": seq,
                "ts": _now_utc().isoformat(),
                "type": event_type,
                "agent": agent,
                "data": data,
            }

            # Persist trace.
            with get_session() as s2:
                s2.add(
                    TraceEvent(
                        run_id=run.id,
                        seq=seq,
                        ts=_now_utc(),
                        event_type=event_type,
                        agent=agent,
                        payload=data,
                    )
                )
                s2.commit()

            return f"data: {json.dumps(evt, ensure_ascii=False)}\n\n".encode("utf-8")

        output_lang = _resolve_output_lang(payload, project)
        lang_hint_json = _lang_hint_json(output_lang)
        lang_hint_md = _lang_hint_markdown(output_lang)

        # Snapshot LLM config at run start to avoid mixing settings changes mid-run.
        run_llm_cfg = resolve_llm_config(project.settings or {})
        yield emit(
            "run_started",
            "Director",
            {
                "kind": kind,
                "project_id": project_id,
                "output_lang": output_lang,
                "llm": {
                    "provider": run_llm_cfg.provider,
                    "model": run_llm_cfg.model,
                    "base_url": run_llm_cfg.base_url,
                    "wire_api": run_llm_cfg.wire_api if run_llm_cfg.provider == "openai" else None,
                },
            },
        )

        def kb_search(query: str, limit: int = 5) -> list[dict[str, Any]]:
            sql = text(
                """
                SELECT kb_chunk.id AS id,
                       kb_chunk.title AS title,
                       kb_chunk.tags AS tags,
                       kb_chunk.source_type AS source_type,
                       kb_chunk.content AS content,
                       bm25(kb_chunk_fts) AS score
                FROM kb_chunk_fts
                JOIN kb_chunk ON kb_chunk_fts.rowid = kb_chunk.id
                WHERE kb_chunk.project_id = :project_id
                  AND kb_chunk_fts MATCH :query
                ORDER BY score
                LIMIT :limit;
                """
            )
            q = query.replace('"', " ").strip()
            if not q:
                return []
            with ENGINE.connect() as conn:
                rows = conn.execute(sql, {"project_id": project_id, "query": q, "limit": limit}).mappings().all()
            return [dict(r) for r in rows]

        def llm_cfg():
            return run_llm_cfg

        def mark_run_failed(msg: str) -> None:
            with get_session() as s3:
                r3 = s3.get(Run, run.id)
                if r3:
                    r3.status = "failed"
                    r3.finished_at = _now_utc()
                    r3.error = msg[:500]
                    s3.add(r3)
                    s3.commit()

        def mark_run_completed() -> None:
            with get_session() as s3:
                r3 = s3.get(Run, run.id)
                if r3:
                    r3.status = "completed"
                    r3.finished_at = _now_utc()
                    s3.add(r3)
                    s3.commit()

        if kind == "demo":
            # Demo agents (placeholders).
            for agent_name, content in [
                ("ConfigAutofill", "Filled missing settings (demo)."),
                ("Outliner", "Generated outline (demo)."),
                ("Writer", "Wrote chapter markdown (demo)."),
                ("LoreKeeper", "Checked consistency (demo)."),
                ("Editor", "Polished text (demo)."),
            ]:
                yield emit("agent_started", agent_name, {})
                await asyncio.sleep(0.15)
                yield emit("agent_output", agent_name, {"text": content})
                yield emit("agent_finished", agent_name, {})

            yield emit(
                "artifact",
                "Writer",
                {
                    "artifact_type": "chapter_markdown",
                    "markdown": "# Chapter 1 (Demo)\n\nThis is a placeholder chapter.\n",
                },
            )
            mark_run_completed()
            yield emit("run_completed", "Director", {})
            return

        # ---- LLM-backed runs ----
        kb_mode = "weak"
        try:
            kb_mode = str(((project.settings or {}).get("kb") or {}).get("mode") or "weak")
        except Exception:
            kb_mode = "weak"

        # Agent: ConfigAutofill
        # - Weak mode: LLM can creatively fill missing fields.
        # - Strong mode: avoid inventing canon/settings. (User should provide KB or explicit settings.)
        yield emit("agent_started", "ConfigAutofill", {"kb_mode": kb_mode})
        if kb_mode == "strong":
            yield emit(
                "agent_output",
                "ConfigAutofill",
                {
                    "skipped": True,
                    "reason": "strong_kb_mode_no_random_autofill",
                },
            )
            yield emit("agent_finished", "ConfigAutofill", {})
        else:
            # ConfigAutofill is best-effort. If the gateway is flaky (e.g. 502 HTML),
            # we should still allow the main pipeline (Extractor/Outliner/Writer) to run.
            patch: dict[str, Any] | None = None
            try:
                system = (
                    "You are ConfigAutofillAgent for a novel writing platform. "
                    f"{lang_hint_json} "
                    "Given a partial project settings JSON, produce a JSON patch that fills missing fields only. "
                    "Do not overwrite user-provided fields. Output JSON only."
                )
                user = (
                    "CurrentSettingsJSON:\n"
                    f"{json_dumps(project.settings or {})}\n\n"
                    "Return a JSON object with keys you want to add. Keep it small and practical.\n"
                    "Suggested schema (only include what is missing):\n"
                    "{\n"
                    '  "story": {\n'
                    '    "genre": "...",\n'
                    '    "logline": "...",\n'
                    '    "style_guide": "...",\n'
                    '    "world": "...",\n'
                    '    "characters": [ {"name":"...","role":"...","personality":"...","goal":"..."} ]\n'
                    "  },\n"
                    '  "writing": { "chapter_count": 10, "chapter_words": 1200 }\n'
                    "}\n"
                )
                cfg = llm_cfg()
                yield emit(
                    "tool_call",
                    "ConfigAutofill",
                    {"tool": "llm.generate_text", "provider": cfg.provider, "model": cfg.model},
                )
                autofill_text = await generate_text(system_prompt=system, user_prompt=user, cfg=cfg)
                parsed = parse_json_loose(autofill_text)
                if isinstance(parsed, dict):
                    patch = parsed
                    with get_session() as s4:
                        p4 = s4.get(Project, project_id)
                        if p4:
                            p4.settings = deep_merge(p4.settings or {}, patch)  # type: ignore[assignment]
                            p4.updated_at = _now_utc()
                            s4.add(p4)
                            s4.commit()
                            s4.refresh(p4)
                            project.settings = p4.settings
                yield emit(
                    "agent_output",
                    "ConfigAutofill",
                    {"patch_keys": list(patch.keys()) if isinstance(patch, dict) else []},
                )
            except LLMError as e:
                msg = str(e)
                yield emit(
                    "agent_output",
                    "ConfigAutofill",
                    {"error": msg, "soft_fail": True},
                )
            except Exception as e:
                msg = f"config_autofill_failed:{type(e).__name__}"
                yield emit(
                    "agent_output",
                    "ConfigAutofill",
                    {"error": msg, "soft_fail": True},
                )
            yield emit("agent_finished", "ConfigAutofill", {})

        # Agent: Extractor (continue mode)
        story_state: dict[str, Any] | None = None
        source_text = ""
        source_id = payload.get("source_id")
        excerpt_mode = str(payload.get("source_slice_mode") or "tail")
        try:
            excerpt_chars = int(payload.get("source_slice_chars") or 8000)
        except Exception:
            excerpt_chars = 8000
        excerpt_chars = max(200, min(excerpt_chars, 50_000))

        if kind == "continue":
            if isinstance(source_id, str) and source_id.strip():
                try:
                    yield emit(
                        "tool_call",
                        "Extractor",
                        {
                            "tool": "continue_sources.load_excerpt",
                            "source_id": source_id.strip(),
                            "mode": excerpt_mode,
                            "limit_chars": excerpt_chars,
                        },
                    )
                    source_text = load_continue_source_excerpt(
                        source_id=source_id.strip(),
                        mode=excerpt_mode,
                        limit_chars=excerpt_chars,
                    ).strip()
                    yield emit(
                        "tool_result",
                        "Extractor",
                        {
                            "tool": "continue_sources.load_excerpt",
                            "chars": len(source_text),
                        },
                    )
                except ContinueSourceError as e:
                    yield emit(
                        "agent_output",
                        "Extractor",
                        {"error": f"continue_source_load_failed:{str(e)}"},
                    )
                    source_text = ""
                except Exception as e:
                    yield emit(
                        "agent_output",
                        "Extractor",
                        {"error": f"continue_source_load_failed:{type(e).__name__}"},
                    )
                    source_text = ""
            else:
                source_text = str(payload.get("source_text") or "").strip()

        if kind == "continue" and source_text:
            try:
                yield emit("agent_started", "Extractor", {})
                system = (
                    "You are ExtractorAgent. Extract a structured StoryState from an existing manuscript excerpt. "
                    f"{lang_hint_json} "
                    "Output JSON only."
                )
                user = (
                    "Extract the following fields:\n"
                    "{\n"
                    '  "summary_so_far": "...",\n'
                    '  "characters": [ {"name":"...","current_status":"...","relationships":"..."} ],\n'
                    '  "world": "...",\n'
                    '  "timeline": [ {"event":"...","when":"..."} ],\n'
                    '  "open_loops": ["..."],\n'
                    '  "style_profile": {"pov":"...","tense":"...","tone":"..."}\n'
                    "}\n\n"
                    "Manuscript (excerpt):\n"
                    f"{source_text}\n"
                )
                cfg = llm_cfg()
                yield emit(
                    "tool_call",
                    "Extractor",
                    {"tool": "llm.generate_text", "provider": cfg.provider, "model": cfg.model},
                )
                extracted_text = await generate_text(system_prompt=system, user_prompt=user, cfg=cfg)
                parsed = parse_json_loose(extracted_text)
                if isinstance(parsed, dict):
                    story_state = parsed
                    with get_session() as s4b:
                        p4b = s4b.get(Project, project_id)
                        if p4b:
                            p4b.settings = deep_merge(p4b.settings or {}, {"story_state": story_state})  # type: ignore[assignment]
                            p4b.updated_at = _now_utc()
                            s4b.add(p4b)
                            s4b.commit()
                            s4b.refresh(p4b)
                            project.settings = p4b.settings
                yield emit("agent_output", "Extractor", {"keys": list(story_state.keys()) if story_state else []})
                yield emit("artifact", "Extractor", {"artifact_type": "story_state", "story_state": story_state})
                yield emit("agent_finished", "Extractor", {})
            except Exception as e:
                # Continue mode should degrade gracefully: keep going without story_state.
                yield emit("agent_output", "Extractor", {"error": f"extractor_failed:{type(e).__name__}"})
                yield emit("agent_finished", "Extractor", {})

        story = (project.settings or {}).get("story") if isinstance((project.settings or {}).get("story"), dict) else {}
        writing = (project.settings or {}).get("writing") if isinstance((project.settings or {}).get("writing"), dict) else {}
        chapter_count = int(writing.get("chapter_count") or 10)
        chapter_words = int(writing.get("chapter_words") or 1200)

        # Agent: Outliner
        outline = None
        if kind in ("outline", "chapter", "continue"):
            try:
                yield emit("agent_started", "Outliner", {})
                system = (
                    "You are OutlinerAgent. Create a concise chapter outline for a novel. "
                    f"{lang_hint_json} "
                    "Output JSON only."
                )
                if output_lang == "zh":
                    lang_user = (
                        "语言要求：请用简体中文填写所有自然语言字段（title/summary/goal）。"
                        "不要输出英文或中英混排；如果输入里有英文，请先翻译为中文再写。\n\n"
                    )
                    example = '{ "chapters": [ {"index":1,"title":"第1章：……","summary":"……","goal":"……"} ] }'
                else:
                    lang_user = "Language requirement: Use English for all natural language fields.\n\n"
                    example = '{ "chapters": [ {"index":1,"title":"...","summary":"...","goal":"..."} ] }'
                user = (
                    f"{lang_user}"
                    f"Story info:\n{json_dumps(story)}\n\n"
                    f"StoryState (if any):\n{json_dumps(story_state or {})}\n\n"
                    f"Target chapter_count: {chapter_count}\n\n"
                    "Output JSON in the form:\n"
                    f"{example}\n"
                )
                cfg = llm_cfg()
                yield emit(
                    "tool_call",
                    "Outliner",
                    {"tool": "llm.generate_text", "provider": cfg.provider, "model": cfg.model},
                )
                outline_text = await generate_text(system_prompt=system, user_prompt=user, cfg=cfg)
                try:
                    outline = parse_json_loose(outline_text)
                except Exception:
                    # Retry once with stricter guidance (some gateways sometimes
                    # prepend chatter or truncate JSON).
                    cfg_retry = cfg
                    if cfg.provider == "gemini" and "packyapi.com" in (cfg.base_url or "").lower():
                        cfg_retry = replace(cfg_retry, model="gemini-3-flash-preview")
                    cfg_retry = replace(cfg_retry, temperature=0.2)
                    yield emit(
                        "tool_call",
                        "Outliner",
                        {
                            "tool": "llm.generate_text",
                            "provider": cfg_retry.provider,
                            "model": cfg_retry.model,
                            "note": "retry_parse_json",
                        },
                    )
                    outline_text2 = await generate_text(
                        system_prompt=system,
                        user_prompt=user
                        + "\n\nIMPORTANT: Output JSON only. No markdown, no commentary, no code fences.",
                        cfg=cfg_retry,
                    )
                    outline = parse_json_loose(outline_text2)
                # Some code-first models may still default to English. If we asked for zh,
                # do a single best-effort translation pass for the natural language fields.
                if (
                    output_lang == "zh"
                    and isinstance(outline, dict)
                    and isinstance(outline.get("chapters"), list)
                ):
                    sample_values: list[str] = []
                    for ch in (outline.get("chapters") or [])[:10]:
                        if not isinstance(ch, dict):
                            continue
                        for k in ("title", "summary", "goal"):
                            v = ch.get(k)
                            if isinstance(v, str) and v.strip():
                                sample_values.append(v.strip())

                    if sample_values and not any(_CJK_RE.search(v) for v in sample_values):
                        try:
                            system_t = (
                                "You are OutlineTranslatorAgent. "
                                "Convert an outline JSON to Simplified Chinese (zh-CN). "
                                "Translate ONLY natural language string values (title/summary/goal). "
                                "Do NOT change keys, indexes, or structure. Output JSON only."
                            )
                            user_t = f"OutlineJSON:\n{json_dumps(outline)}\n"
                            yield emit(
                                "tool_call",
                                "Outliner",
                                {
                                    "tool": "llm.generate_text",
                                    "provider": cfg.provider,
                                    "model": cfg.model,
                                    "note": "translate_outline_to_zh",
                                },
                            )
                            translated_text = await generate_text(
                                system_prompt=system_t, user_prompt=user_t, cfg=cfg
                            )
                            translated = parse_json_loose(translated_text)
                            if isinstance(translated, dict) and isinstance(translated.get("chapters"), list):
                                outline = translated
                        except Exception:
                            pass
                if isinstance(outline, dict) and isinstance(outline.get("chapters"), list):
                    with get_session() as s5:
                        p5 = s5.get(Project, project_id)
                        if p5:
                            next_settings = deep_merge(p5.settings or {}, {"story": {"outline": outline.get("chapters")}})
                            p5.settings = next_settings  # type: ignore[assignment]
                            p5.updated_at = _now_utc()
                            s5.add(p5)
                            s5.commit()
                            s5.refresh(p5)
                            project.settings = p5.settings
                    yield emit("agent_output", "Outliner", {"chapters": len(outline.get("chapters"))})
                    yield emit("artifact", "Outliner", {"artifact_type": "outline", "outline": outline})
                else:
                    yield emit("agent_output", "Outliner", {"text": "Outline not parsed as expected."})
                yield emit("agent_finished", "Outliner", {})
            except LLMError as e:
                msg = str(e)
                if kind == "outline":
                    yield emit("run_error", "Outliner", {"error": msg})
                    mark_run_failed(msg)
                    yield emit("run_completed", "Director", {})
                    return
                # For chapter/continue runs, Outliner is helpful but not strictly
                # required. Soft-fail to keep the app usable under flaky gateways.
                yield emit("agent_output", "Outliner", {"error": msg})
                yield emit("agent_finished", "Outliner", {})
                outline = None
            except Exception as e:
                msg = f"outline_failed:{type(e).__name__}"
                if kind == "outline":
                    yield emit("run_error", "Outliner", {"error": msg})
                    mark_run_failed(msg)
                    yield emit("run_completed", "Director", {})
                    return
                yield emit("agent_output", "Outliner", {"error": msg})
                yield emit("agent_finished", "Outliner", {})
                outline = None

        if kind == "outline":
            mark_run_completed()
            yield emit("run_completed", "Director", {})
            return

        # ---- Chapter writing ----
        chapter_index = int(payload.get("chapter_index") or 1)
        chapter_plan = None
        story_outline = ((project.settings or {}).get("story") or {}).get("outline") if isinstance(project.settings, dict) else None
        if isinstance(story_outline, list):
            for ch in story_outline:
                if isinstance(ch, dict) and int(ch.get("index") or 0) == chapter_index:
                    chapter_plan = ch
                    break

        # Tool: local KB retrieval
        kb_context: list[dict[str, Any]] = []
        try:
            q_terms = []
            if isinstance(story, dict):
                logline = story.get("logline")
                if isinstance(logline, str) and logline.strip():
                    q_terms.append(logline.strip())
                world = story.get("world")
                if isinstance(world, str) and world.strip():
                    q_terms.append(world.strip())
                chars = story.get("characters")
                if isinstance(chars, list):
                    for c in chars[:5]:
                        if isinstance(c, dict) and isinstance(c.get("name"), str):
                            q_terms.append(c["name"])
            query = " ".join(q_terms) or (project.title or "story")
            kb_context = kb_search(query, limit=5)
            yield emit("tool_result", "Retriever", {"tool": "kb_search", "hits": len(kb_context)})
        except Exception:
            kb_context = []

        if kb_mode == "strong" and not kb_context and not story:
            msg = "strong_kb_mode_requires_local_context"
            yield emit("run_error", "LoreKeeper", {"error": msg})
            mark_run_failed(msg)
            yield emit("run_completed", "Director", {})
            return

        # Tool: web search (optional)
        research_query = str(payload.get("research_query") or "").strip()
        web_results: list[dict[str, Any]] = []
        web_cfg = (((project.settings or {}).get("tools") or {}).get("web_search") or {})
        web_enabled = bool(web_cfg.get("enabled", True))
        web_provider = str(web_cfg.get("provider") or "auto")
        if research_query and web_enabled:
            try:
                from ..tools.web_search import web_search

                yield emit(
                    "tool_call",
                    "WebSearch",
                    {"tool": "web_search", "q": research_query, "provider": web_provider},
                )
                web_results, meta = web_search(research_query, limit=5, provider=web_provider)
                yield emit(
                    "tool_result",
                    "WebSearch",
                    {
                        "tool": "web_search",
                        "hits": len(web_results),
                        "provider_used": meta.get("provider_used"),
                        "errors": meta.get("errors", []),
                    },
                )
            except Exception as e:
                web_results = []
                yield emit(
                    "tool_result",
                    "WebSearch",
                    {"tool": "web_search", "hits": 0, "error": type(e).__name__},
                )

        # Agent: Writer
        writer_max_tokens = llm_cfg().max_tokens
        try:
            yield emit("agent_started", "Writer", {"chapter_index": chapter_index})
            system = (
                "You are WriterAgent. Write a novel chapter in Markdown. "
                f"{lang_hint_md} "
                "Write narrative prose (NOT an outline, NOT bullet notes). "
                "Respect the provided story settings and local KB excerpts. "
            )
            if kb_mode == "strong":
                system += (
                    "Strong KB mode (canon-locked): "
                    "When stating canon facts (world rules, history, geography, character backstory/status), "
                    "add inline evidence citations in the form [KB#ID]. "
                    "Only cite IDs that appear in the provided Local KB excerpts. "
                    "If a needed canon fact is not supported by Local KB, do NOT invent it; use [[TBD]] and add it "
                    "to a '## 待确认 / To Confirm' list at the end. "
                    "Do NOT treat web research results as canon unless the user explicitly confirms and it is in KB."
                )
            else:
                system += "If some details are missing, you may creatively fill gaps in a consistent way."
            min_len = max(200, int(chapter_words * 0.25))
            user_parts = [
                f"Story settings:\n{json_dumps(story)}",
                f"Writing targets: chapter_words≈{chapter_words}, chapter_index={chapter_index}",
                f"KB mode: {kb_mode}",
            ]
            if chapter_plan:
                user_parts.append(f"Chapter plan:\n{json_dumps(chapter_plan)}")
            if story_state:
                user_parts.append(f"StoryState:\n{json_dumps(story_state)}")
            if kb_context:
                kb_text = "\n\n".join(
                    f"[KB#{k['id']}] {k.get('title','')}\n{k.get('content','')}" for k in kb_context
                )
                user_parts.append(f"Local KB excerpts:\n{kb_text[:3000]}")
            if web_results:
                web_text = "\n\n".join(
                    f"- {w.get('title','')}\n  {w.get('snippet','')}\n  {w.get('url','')}" for w in web_results
                )
                user_parts.append(f"Web research results (do not treat as canon unless stated):\n{web_text[:2000]}")
            if output_lang == "zh":
                user_parts.append(f"最低长度：至少 {min_len} 个汉字（不含 Markdown 符号）。不要中途截断。")
            else:
                user_parts.append(
                    f"Minimum length: at least {max(120, int(chapter_words * 0.6))} words. Do not cut mid-sentence."
                )
            if output_lang == "zh":
                user_parts.append(
                    "只输出章节 Markdown（不要解释/不要前言）。用一级标题开头，例如："
                    f"{_writer_title_example(output_lang, chapter_index)}"
                )
            else:
                user_parts.append(
                    "Output ONLY the chapter Markdown. Start with a level-1 title like: "
                    f"{_writer_title_example(output_lang, chapter_index)}"
                )
            cfg0 = llm_cfg()
            desired_max_tokens = max(int(cfg0.max_tokens), min(4096, max(80, int(chapter_words * 1.4))))
            cfg = replace(cfg0, max_tokens=desired_max_tokens) if desired_max_tokens != cfg0.max_tokens else cfg0
            writer_max_tokens = cfg.max_tokens
            yield emit(
                "tool_call",
                "Writer",
                {
                    "tool": "llm.generate_text",
                    "provider": cfg.provider,
                    "model": cfg.model,
                    "max_tokens": cfg.max_tokens,
                },
            )
            writer_text = await generate_text(system_prompt=system, user_prompt="\n\n---\n\n".join(user_parts), cfg=cfg)
            writer_text = strip_think_blocks(writer_text)
            if not re.search(r"(?m)^#\\s+\\S", writer_text):
                title = _default_chapter_title(output_lang, chapter_index)
                if isinstance(chapter_plan, dict):
                    t = chapter_plan.get("title")
                    if isinstance(t, str) and t.strip():
                        title = t.strip()
                writer_text = f"# {title}\n\n{writer_text.lstrip()}"
            if output_lang == "zh":
                cjk_count = len(_CJK_RE.findall(writer_text))
                if cjk_count < min_len:
                    # Retry once when the gateway returns a suspiciously short
                    # completion (often truncated/partial). Prefer a more
                    # available fallback model on PackyAPI.
                    retry_cfg = cfg
                    if cfg.provider == "gemini" and "packyapi.com" in (cfg.base_url or "").lower():
                        retry_cfg = replace(retry_cfg, model="gemini-3-flash-preview")
                    yield emit(
                        "tool_call",
                        "Writer",
                        {
                            "tool": "llm.generate_text",
                            "provider": retry_cfg.provider,
                            "model": retry_cfg.model,
                            "max_tokens": retry_cfg.max_tokens,
                            "note": "retry_too_short",
                        },
                    )
                    retry_user = (
                        "\n\n---\n\n".join(user_parts)
                        + f"\n\nIMPORTANT: 上一轮输出过短且不完整。请重新输出【完整章节 Markdown】（不要承接上一轮），"
                        + f"至少 {min_len} 个汉字，结尾完整，不要只写标题或一句话。"
                    )
                    writer_text2 = await generate_text(
                        system_prompt=system, user_prompt=retry_user, cfg=retry_cfg
                    )
                    writer_text2 = strip_think_blocks(writer_text2)
                    if not re.search(r"(?m)^#\\s+\\S", writer_text2):
                        title = _default_chapter_title(output_lang, chapter_index)
                        if isinstance(chapter_plan, dict):
                            t = chapter_plan.get("title")
                            if isinstance(t, str) and t.strip():
                                title = t.strip()
                        writer_text2 = f"# {title}\n\n{writer_text2.lstrip()}"
                    cjk_count2 = len(_CJK_RE.findall(writer_text2))
                    if cjk_count2 >= min_len:
                        writer_text = writer_text2
                    else:
                        raise LLMError(f"writer_output_too_short:cjk={cjk_count2},min={min_len}")
            yield emit("agent_output", "Writer", {"text": writer_text[:400]})
            yield emit("agent_finished", "Writer", {})
        except LLMError as e:
            msg = str(e)
            yield emit("run_error", "Writer", {"error": msg})
            mark_run_failed(msg)
            yield emit("run_completed", "Director", {})
            return
        except Exception as e:
            msg = f"writer_failed:{type(e).__name__}"
            yield emit("run_error", "Writer", {"error": msg})
            mark_run_failed(msg)
            yield emit("run_completed", "Director", {})
            return

        # Agent: Editor (light polish)
        edited_text = writer_text
        try:
            yield emit("agent_started", "Editor", {})
            system = (
                "You are EditorAgent. Revise a novel chapter in Markdown. "
                f"{lang_hint_md} "
                "Preserve structure and length: do NOT summarize, do NOT delete content. "
                "Only improve wording/flow and fix inconsistencies/typos. "
                "If the input is not in the required language, translate it while preserving meaning and length. "
                "Do NOT remove evidence citations like [KB#123] or placeholders like [[TBD]]."
            )
            user = (
                "Revise the following Markdown chapter. Return the FULL chapter Markdown only.\n\n"
                f"{writer_text}\n"
            )
            cfg0 = llm_cfg()
            editor_max_tokens = max(int(cfg0.max_tokens), int(writer_max_tokens))
            cfg = replace(cfg0, max_tokens=editor_max_tokens) if editor_max_tokens != cfg0.max_tokens else cfg0
            yield emit(
                "tool_call",
                "Editor",
                {
                    "tool": "llm.generate_text",
                    "provider": cfg.provider,
                    "model": cfg.model,
                    "max_tokens": cfg.max_tokens,
                },
            )
            edited_text = await generate_text(system_prompt=system, user_prompt=user, cfg=cfg)
            edited_text = strip_think_blocks(edited_text)
            # Guardrail: some models may incorrectly summarize/shorten or output
            # partial content; fall back to the original writer output.
            w = writer_text.strip()
            e = edited_text.strip()
            suspicious = False
            if not e:
                suspicious = True
            elif not re.search(r"(?m)^#\\s+\\S", edited_text):
                suspicious = True
            elif len(w) >= 400 and len(e) < int(len(w) * 0.65):
                suspicious = True
            elif output_lang == "zh" and _CJK_RE.search(w) and not _CJK_RE.search(e):
                suspicious = True
            if suspicious:
                raise ValueError("editor_suspicious_output")
            yield emit("agent_output", "Editor", {"text": edited_text[:400]})
            yield emit("agent_finished", "Editor", {})
        except Exception as e:
            edited_text = writer_text
            yield emit(
                "agent_output",
                "Editor",
                {"error": f"editor_fallback_to_writer:{type(e).__name__}"},
            )
            yield emit("agent_finished", "Editor", {})

        # Agent: LoreKeeper (evidence audit + canon guard)
        yield emit("agent_started", "LoreKeeper", {"kb_mode": kb_mode})
        tbd_count = edited_text.count("[[TBD]]")
        cited_ids: list[int] = []
        warnings: list[str] = []
        evidence_report: dict[str, Any] | None = None
        to_confirm: list[str] = []
        unsafe_claims: list[str] = []
        rewritten = False

        if kb_mode == "strong":
            cited_ids = sorted({int(m.group(1)) for m in re.finditer(r"\[KB#(\d+)\]", edited_text)})
            kb_text = ""
            if kb_context:
                kb_text = "\n\n".join(
                    f"[KB#{k['id']}] {k.get('title','')}\n{k.get('content','')}" for k in kb_context
                )

            kb_ids_available = {
                int(k.get("id")) for k in kb_context if isinstance(k, dict) and isinstance(k.get("id"), int)
            }
            if kb_ids_available and not cited_ids:
                warnings.append("Strong KB mode: no [KB#...] citations found in chapter.")
            if kb_ids_available:
                invalid_cited = [i for i in cited_ids if i not in kb_ids_available]
                if invalid_cited:
                    warnings.append(
                        f"Strong KB mode: found citations not in provided KB context: {invalid_cited[:5]}"
                    )

            # Evidence audit (JSON output)
            try:
                system = (
                    "You are LoreKeeperAgent. Audit a chapter for Strong KB mode evidence. "
                    f"{lang_hint_json} "
                    "You will be given Local KB excerpts with IDs and a chapter markdown. "
                    "Identify canon claims not supported by the Local KB excerpts. "
                    "Return JSON only."
                )
                user = (
                    "Local KB excerpts:\n"
                    f"{kb_text[:6000]}\n\n"
                    "ChapterMarkdown:\n"
                    f"{edited_text[:12000]}\n\n"
                    "Return JSON with this schema:\n"
                    "{\n"
                    '  "supported_claims": [ {"claim":"...","kb_ids":[123]} ],\n'
                    '  "needs_confirmation": [ {"claim":"...","marked_tbd": true} ],\n'
                    '  "unsafe_claims": [ {"claim":"...","reason":"..."} ]\n'
                    "}\n"
                    "Rules:\n"
                    "- Prefer short, atomic claims.\n"
                    "- If a claim is not supported by KB, put it in needs_confirmation.\n"
                    "- If it is not supported AND the chapter does NOT visibly mark it as [[TBD]], "
                    "also put it in unsafe_claims.\n"
                )
                cfg = llm_cfg()
                yield emit(
                    "tool_call",
                    "LoreKeeper",
                    {"tool": "llm.generate_text", "provider": cfg.provider, "model": cfg.model},
                )
                evidence_text = await generate_text(system_prompt=system, user_prompt=user, cfg=cfg)
                parsed = parse_json_loose(evidence_text)
                if isinstance(parsed, dict):
                    evidence_report = parsed
            except Exception as e:
                warnings.append(f"evidence_audit_failed:{type(e).__name__}")

            if isinstance(evidence_report, dict):
                nc_raw = evidence_report.get("needs_confirmation")
                if isinstance(nc_raw, list):
                    for item in nc_raw:
                        if not isinstance(item, dict):
                            continue
                        c = item.get("claim")
                        if isinstance(c, str) and c.strip():
                            to_confirm.append(c.strip())

                unsafe_raw = evidence_report.get("unsafe_claims")
                if isinstance(unsafe_raw, list):
                    for item in unsafe_raw:
                        if not isinstance(item, dict):
                            continue
                        c = item.get("claim")
                        if isinstance(c, str) and c.strip():
                            unsafe_claims.append(c.strip())

                # Keep only KB ids that exist in the provided context (best-effort sanitization).
                supp_raw = evidence_report.get("supported_claims")
                if isinstance(supp_raw, list):
                    cleaned: list[dict[str, Any]] = []
                    for item in supp_raw:
                        if not isinstance(item, dict):
                            continue
                        claim = item.get("claim")
                        kb_ids = item.get("kb_ids")
                        if not isinstance(claim, str) or not claim.strip():
                            continue
                        ids: list[int] = []
                        if isinstance(kb_ids, list):
                            for x in kb_ids:
                                try:
                                    xi = int(x)
                                except Exception:
                                    continue
                                if kb_ids_available and xi not in kb_ids_available:
                                    continue
                                ids.append(xi)
                        cleaned.append({"claim": claim.strip(), "kb_ids": ids})
                    evidence_report["supported_claims"] = cleaned

            if tbd_count > 0:
                warnings.append("Strong KB mode: found [[TBD]] markers (missing canon facts).")
            if to_confirm:
                warnings.append(f"Strong KB mode: needs_confirmation={len(to_confirm)}")

            if unsafe_claims:
                warnings.append(
                    f"Strong KB mode: unsafe_claims={len(unsafe_claims)} (sanitizing to [[TBD]])."
                )
                # Sanitize via a minimal rewrite pass (does not invent facts; only redacts/asserts TBD).
                try:
                    system2 = (
                        "You are LoreKeeperAgent. Rewrite a chapter Markdown to comply with Strong KB mode. "
                        f"{lang_hint_md} "
                        "Replace each unsafe canon claim with [[TBD]] or neutral phrasing that does NOT assert canon. "
                        "Append/refresh a '## 待确认 / To Confirm' section listing all missing facts. "
                        "Do not add new plot points. Output Markdown only."
                    )
                    claims = "\n".join(
                        f"- {c}" for c in (unsafe_claims + to_confirm)[:20] if isinstance(c, str) and c.strip()
                    )
                    user2 = (
                        "Unsafe canon claims:\n"
                        f"{claims}\n\n"
                        "ChapterMarkdown:\n"
                        f"{edited_text}\n"
                    )
                    cfg = llm_cfg()
                    yield emit(
                        "tool_call",
                        "LoreKeeper",
                        {"tool": "llm.generate_text", "provider": cfg.provider, "model": cfg.model},
                    )
                    sanitized = await generate_text(system_prompt=system2, user_prompt=user2, cfg=cfg)
                    if isinstance(sanitized, str) and sanitized.strip():
                        edited_text = strip_think_blocks(sanitized)
                        rewritten = True
                        tbd_count = edited_text.count("[[TBD]]")
                except Exception as e:
                    warnings.append(f"sanitize_failed:{type(e).__name__}")

            # If we didn't rewrite, still append a to-confirm list when needed.
            if to_confirm and ("To Confirm" not in edited_text and "待确认" not in edited_text):
                unique: list[str] = []
                seen: set[str] = set()
                for c in to_confirm:
                    if c in seen:
                        continue
                    seen.add(c)
                    unique.append(c)
                if unique:
                    edited_text = (
                        edited_text.rstrip()
                        + "\n\n---\n\n## 待确认 / To Confirm\n"
                        + "\n".join(f"- {c}" for c in unique[:20])
                        + "\n"
                    )

        else:
            # Weak mode: keep a light warning only.
            if tbd_count > 0:
                warnings.append("Found [[TBD]] markers.")

        yield emit(
            "agent_output",
            "LoreKeeper",
            {
                "tbd_count": tbd_count,
                "warnings": warnings,
                "rewritten": rewritten,
                "citations": cited_ids,
                "to_confirm_count": len(to_confirm),
                "unsafe_count": len(unsafe_claims),
            },
        )
        if evidence_report is not None:
            yield emit(
                "artifact",
                "LoreKeeper",
                {"artifact_type": "evidence_report", "report": evidence_report},
            )
        yield emit("agent_finished", "LoreKeeper", {})

        # Persist Chapter + add to KB as manuscript chunk
        edited_text = strip_think_blocks(edited_text)
        chapter_title = _default_chapter_title(output_lang, chapter_index)
        for ln in edited_text.splitlines():
            if ln.strip().startswith("# "):
                chapter_title = ln.strip().lstrip("#").strip()
                break
        with get_session() as s6:
            ch_obj = Chapter(
                project_id=project_id,
                chapter_index=chapter_index,
                title=chapter_title,
                markdown=edited_text,
            )
            s6.add(
                ch_obj
            )
            s6.add(
                KBChunk(
                    project_id=project_id,
                    source_type="manuscript",
                    title=chapter_title,
                    content=edited_text,
                    tags=f"manuscript,chapter_id={ch_obj.id}",
                )
            )
            s6.commit()

        yield emit(
            "artifact",
            "Writer",
            {"artifact_type": "chapter_markdown", "chapter_index": chapter_index, "title": chapter_title, "markdown": edited_text},
        )

        mark_run_completed()
        yield emit("run_completed", "Director", {})

    return StreamingResponse(gen(), media_type="text/event-stream")
