from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlmodel import select

from ..db import ENGINE, get_session
from ..llm import LLMError, parse_json_loose, resolve_llm_config, generate_text
from ..models import Chapter, KBChunk, Project, Run, TraceEvent
from ..util import deep_merge, json_dumps


router = APIRouter(tags=["runs"])


class RunRequestPayload(dict):
    # Keep request schema flexible for now.
    pass


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


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

        yield emit("run_started", "Director", {"kind": kind, "project_id": project_id})

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
            return resolve_llm_config(project.settings or {})

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
        try:
            yield emit("agent_started", "ConfigAutofill", {})
            system = (
                "You are ConfigAutofillAgent for a novel writing platform. "
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
            patch = parse_json_loose(autofill_text)
            if isinstance(patch, dict):
                with get_session() as s4:
                    p4 = s4.get(Project, project_id)
                    if p4:
                        p4.settings = deep_merge(p4.settings or {}, patch)  # type: ignore[assignment]
                        p4.updated_at = _now_utc()
                        s4.add(p4)
                        s4.commit()
                        s4.refresh(p4)
                        project.settings = p4.settings
            yield emit("agent_output", "ConfigAutofill", {"patch_keys": list(patch.keys()) if isinstance(patch, dict) else []})
            yield emit("agent_finished", "ConfigAutofill", {})
        except LLMError as e:
            msg = str(e)
            yield emit("run_error", "ConfigAutofill", {"error": msg})
            mark_run_failed(msg)
            yield emit("run_completed", "Director", {})
            return
        except Exception as e:
            msg = f"config_autofill_failed:{type(e).__name__}"
            yield emit("run_error", "ConfigAutofill", {"error": msg})
            mark_run_failed(msg)
            yield emit("run_completed", "Director", {})
            return

        # Agent: Extractor (continue mode)
        story_state: dict[str, Any] | None = None
        source_text = str(payload.get("source_text") or "").strip()
        if kind == "continue" and source_text:
            try:
                yield emit("agent_started", "Extractor", {})
                system = (
                    "You are ExtractorAgent. Extract a structured StoryState from an existing manuscript excerpt. "
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
                    "Manuscript:\n"
                    f"{source_text[:8000]}\n"
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
                    "Output JSON only."
                )
                user = (
                    f"Story info:\n{json_dumps(story)}\n\n"
                    f"StoryState (if any):\n{json_dumps(story_state or {})}\n\n"
                    f"Target chapter_count: {chapter_count}\n\n"
                    "Output JSON in the form:\n"
                    "{ \"chapters\": [ {\"index\":1,\"title\":\"...\",\"summary\":\"...\",\"goal\":\"...\"} ] }\n"
                )
                cfg = llm_cfg()
                yield emit(
                    "tool_call",
                    "Outliner",
                    {"tool": "llm.generate_text", "provider": cfg.provider, "model": cfg.model},
                )
                outline_text = await generate_text(system_prompt=system, user_prompt=user, cfg=cfg)
                outline = parse_json_loose(outline_text)
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
                yield emit("run_error", "Outliner", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return
            except Exception as e:
                msg = f"outline_failed:{type(e).__name__}"
                yield emit("run_error", "Outliner", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

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
        web_enabled = bool((((project.settings or {}).get("tools") or {}).get("web_search") or {}).get("enabled", True))
        if research_query and web_enabled:
            try:
                from duckduckgo_search import DDGS

                yield emit("tool_call", "WebSearch", {"tool": "web_search", "q": research_query})
                with DDGS() as ddgs:
                    for r in ddgs.text(research_query, max_results=5):
                        web_results.append(
                            {
                                "title": r.get("title") or "",
                                "url": r.get("href") or r.get("url") or "",
                                "snippet": r.get("body") or r.get("snippet") or "",
                            }
                        )
                yield emit("tool_result", "WebSearch", {"tool": "web_search", "hits": len(web_results)})
            except Exception:
                web_results = []

        # Agent: Writer
        try:
            yield emit("agent_started", "Writer", {"chapter_index": chapter_index})
            system = (
                "You are WriterAgent. Write a novel chapter in Markdown. "
                "Respect the provided story settings and local KB excerpts. "
                "If in strong canon-locked mode and you must introduce unknown canon facts, mark them as [[TBD]]."
            )
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
            user_parts.append(
                "Output ONLY the chapter Markdown. Start with a level-1 title like: # Chapter X: Title"
            )
            cfg = llm_cfg()
            yield emit(
                "tool_call",
                "Writer",
                {"tool": "llm.generate_text", "provider": cfg.provider, "model": cfg.model},
            )
            writer_text = await generate_text(system_prompt=system, user_prompt="\n\n---\n\n".join(user_parts), cfg=cfg)
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
            system = "You are EditorAgent. Polish the chapter while keeping meaning. Output Markdown only."
            user = (
                "Polish this Markdown chapter. Keep it concise; do not add new plot points.\n\n"
                f"{writer_text}\n"
            )
            cfg = llm_cfg()
            yield emit(
                "tool_call",
                "Editor",
                {"tool": "llm.generate_text", "provider": cfg.provider, "model": cfg.model},
            )
            edited_text = await generate_text(system_prompt=system, user_prompt=user, cfg=cfg)
            yield emit("agent_output", "Editor", {"text": edited_text[:400]})
            yield emit("agent_finished", "Editor", {})
        except Exception:
            edited_text = writer_text

        # Persist Chapter + add to KB as manuscript chunk
        chapter_title = f"Chapter {chapter_index}"
        for ln in edited_text.splitlines():
            if ln.strip().startswith("# "):
                chapter_title = ln.strip().lstrip("#").strip()
                break
        with get_session() as s6:
            s6.add(
                Chapter(
                    project_id=project_id,
                    chapter_index=chapter_index,
                    title=chapter_title,
                    markdown=edited_text,
                )
            )
            s6.add(
                KBChunk(
                    project_id=project_id,
                    source_type="manuscript",
                    title=chapter_title,
                    content=edited_text,
                    tags="manuscript",
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
