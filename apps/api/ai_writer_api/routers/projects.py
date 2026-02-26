from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from sqlmodel import select

from ..db import get_session
from ..models import Project, ProjectCreate, ProjectUpdate


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
            # Shallow merge by default; callers can send full object if desired.
            p.settings = {**(p.settings or {}), **payload.settings}

        p.updated_at = datetime.now(timezone.utc)
        session.add(p)
        session.commit()
        session.refresh(p)
        return p

