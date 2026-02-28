from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import select

from ..db import get_session
from ..models import Chapter, KBChunk, Project


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


@router.delete("/{chapter_id}")
def delete_chapter(project_id: str, chapter_id: str) -> dict[str, bool]:
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        ch = session.get(Chapter, chapter_id)
        if not ch or ch.project_id != project_id:
            raise HTTPException(status_code=404, detail="Chapter not found")
        session.delete(ch)

        # Best-effort cleanup for the auto-added manuscript KB chunk.
        tag = f"chapter_id={chapter_id}"
        for kb in session.exec(
            select(KBChunk).where(
                KBChunk.project_id == project_id,
                KBChunk.source_type == "manuscript",
                KBChunk.tags.like(f"%{tag}%"),
            )
        ):
            session.delete(kb)

        session.commit()
    return {"ok": True}


@router.post("/reorder")
def reorder_chapters(project_id: str, payload: dict[str, Any]) -> list[Chapter]:
    """
    Reorder chapters by renumbering chapter_index sequentially.
    Payload:
      { "chapter_ids": ["..."], "start_index": 1 }
    """
    raw_ids = payload.get("chapter_ids")
    if not isinstance(raw_ids, list) or not raw_ids or not all(isinstance(x, str) for x in raw_ids):
        raise HTTPException(status_code=400, detail="invalid_chapter_ids")
    chapter_ids = [x.strip() for x in raw_ids if isinstance(x, str) and x.strip()]
    if not chapter_ids:
        raise HTTPException(status_code=400, detail="invalid_chapter_ids")
    if len(chapter_ids) != len(set(chapter_ids)):
        raise HTTPException(status_code=400, detail="duplicate_chapter_ids")

    try:
        start_index = int(payload.get("start_index") or 1)
    except Exception:
        start_index = 1
    start_index = max(1, start_index)

    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")

        items = list(
            session.exec(
                select(Chapter).where(Chapter.project_id == project_id, Chapter.id.in_(chapter_ids))
            )
        )
        by_id = {c.id: c for c in items}
        if len(by_id) != len(set(chapter_ids)):
            raise HTTPException(status_code=400, detail="chapter_ids_not_found")

        now = datetime.now(timezone.utc)
        for i, cid in enumerate(chapter_ids):
            ch = by_id.get(cid)
            if not ch:
                raise HTTPException(status_code=400, detail="chapter_ids_not_found")
            ch.chapter_index = start_index + i
            ch.updated_at = now
            session.add(ch)

        session.commit()

        return list_chapters(project_id)
