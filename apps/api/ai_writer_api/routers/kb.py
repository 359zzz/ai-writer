from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text
from sqlmodel import select

from ..db import ENGINE, get_session
from ..models import KBChunk, Project


router = APIRouter(prefix="/api/projects/{project_id}/kb", tags=["kb"])


@router.get("/chunks")
def list_chunks(project_id: str) -> list[KBChunk]:
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        return list(
            session.exec(
                select(KBChunk).where(KBChunk.project_id == project_id).order_by(KBChunk.created_at.desc())
            )
        )


@router.post("/chunks")
def create_chunk(project_id: str, payload: dict[str, Any]) -> KBChunk:
    content = str(payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    title = str(payload.get("title") or "").strip()
    tags = payload.get("tags") or ""
    if isinstance(tags, list):
        tags = ",".join(str(t).strip() for t in tags if str(t).strip())
    tags = str(tags).strip()

    source_type = str(payload.get("source_type") or "note").strip()

    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")

        chunk = KBChunk(
            project_id=project_id,
            source_type=source_type,
            title=title,
            content=content,
            tags=tags,
        )
        session.add(chunk)
        session.commit()
        session.refresh(chunk)
        return chunk


@router.get("/search")
def search_kb(
    project_id: str,
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=5, ge=1, le=20),
) -> list[dict[str, Any]]:
    # Use SQLite FTS5 bm25 ranking; smaller is better.
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")

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

    # Wrap query for basic safety; FTS5 supports advanced syntax, but keep simple.
    query = q.replace('"', " ").strip()
    params = {"project_id": project_id, "query": query, "limit": limit}
    with ENGINE.connect() as conn:
        rows = conn.execute(sql, params).mappings().all()
    return [dict(r) for r in rows]

