from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from sqlmodel import select

from ..db import get_session
from ..models import Chapter, KBChunk, Project, ProjectCreate, ProjectUpdate, Run, TraceEvent
from ..util import deep_merge


router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
def list_projects() -> list[Project]:
    with get_session() as session:
        return list(session.exec(select(Project).order_by(Project.updated_at.desc())))


@router.post("")
def create_project(payload: ProjectCreate) -> Project:
    with get_session() as session:
        p = Project(title=payload.title)
        session.add(p)
        session.commit()
        session.refresh(p)
        return p


@router.get("/{project_id}")
def get_project(project_id: str) -> Project:
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="Project not found")
        return p


@router.patch("/{project_id}")
def update_project(project_id: str, payload: ProjectUpdate) -> Project:
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="Project not found")

        if payload.title is not None:
            p.title = payload.title

        if payload.settings is not None:
            p.settings = deep_merge(p.settings or {}, payload.settings)  # type: ignore[assignment]

        p.updated_at = datetime.now(timezone.utc)
        session.add(p)
        session.commit()
        session.refresh(p)
        return p


@router.delete("/{project_id}")
def delete_project(project_id: str) -> dict[str, bool]:
    """
    Delete a project and its local artifacts (chapters/KB/runs/trace).
    This is a local-only single-user app; keep it simple and explicit.
    """
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="Project not found")

        # Delete trace events first (depends on run_id).
        run_ids = [r.id for r in session.exec(select(Run).where(Run.project_id == project_id))]
        if run_ids:
            for evt in session.exec(select(TraceEvent).where(TraceEvent.run_id.in_(run_ids))):
                session.delete(evt)
            for r in session.exec(select(Run).where(Run.project_id == project_id)):
                session.delete(r)

        for ch in session.exec(select(Chapter).where(Chapter.project_id == project_id)):
            session.delete(ch)
        for kb in session.exec(select(KBChunk).where(KBChunk.project_id == project_id)):
            session.delete(kb)

        session.delete(p)
        session.commit()

    return {"ok": True}
