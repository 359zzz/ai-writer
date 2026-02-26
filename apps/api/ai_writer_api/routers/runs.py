from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from sqlmodel import select

from ..db import get_session
from ..models import Project, Run, TraceEvent


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
    Runs a small multi-agent demo pipeline and emits SSE events.
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

        # Demo agents (placeholders until real LLM integration in later versions).
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

        with get_session() as s3:
            r3 = s3.get(Run, run.id)
            if r3:
                r3.status = "completed"
                r3.finished_at = _now_utc()
                s3.add(r3)
                s3.commit()

        yield emit("run_completed", "Director", {})

    return StreamingResponse(gen(), media_type="text/event-stream")

