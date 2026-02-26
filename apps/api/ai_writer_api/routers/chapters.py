from __future__ import annotations

from fastapi import APIRouter, HTTPException
from sqlmodel import select

from ..db import get_session
from ..models import Chapter, Project


router = APIRouter(prefix="/api/projects/{project_id}/chapters", tags=["chapters"])


@router.get("")
def list_chapters(project_id: str) -> list[Chapter]:
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        return list(
            session.exec(
                select(Chapter)
                .where(Chapter.project_id == project_id)
                .order_by(Chapter.chapter_index.asc(), Chapter.created_at.asc())
            )
        )


@router.get("/{chapter_id}")
def get_chapter(project_id: str, chapter_id: str) -> Chapter:
    with get_session() as session:
        ch = session.get(Chapter, chapter_id)
        if not ch or ch.project_id != project_id:
            raise HTTPException(status_code=404, detail="Chapter not found")
        return ch

