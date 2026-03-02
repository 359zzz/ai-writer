from __future__ import annotations

from datetime import datetime
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


@router.get("/chunks/{chunk_id}")
def get_chunk(project_id: str, chunk_id: int) -> KBChunk:
    """
    Fetch a single KB chunk (including full content).

    For large books, prefer /chunks_meta when listing; this endpoint is meant for
    on-demand detail loading (graphs, inspectors, etc.).
    """
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        chunk = session.get(KBChunk, chunk_id)
        if not chunk or chunk.project_id != project_id:
            raise HTTPException(status_code=404, detail="Chunk not found")
        return chunk


@router.get("/chunks_meta")
def list_chunks_meta(
    project_id: str,
    source_type: str | None = Query(default=None, min_length=1, max_length=40),
    tag_contains: str | None = Query(default=None, min_length=1, max_length=120),
    limit: int = Query(default=200, ge=1, le=5000),
) -> list[dict[str, Any]]:
    """
    List KB chunks metadata without returning full content (useful for large books).

    Optional filters:
    - source_type: exact match
    - tag_contains: LIKE match on tags
    """
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")

        q = select(KBChunk.id, KBChunk.source_type, KBChunk.title, KBChunk.tags, KBChunk.created_at).where(
            KBChunk.project_id == project_id
        )
        if source_type:
            q = q.where(KBChunk.source_type == source_type)
        if tag_contains:
            needle = tag_contains.strip()
            if needle:
                q = q.where(KBChunk.tags.like(f"%{needle}%"))
        q = q.order_by(KBChunk.created_at.desc()).limit(limit)

        rows = list(session.exec(q))
        out: list[dict[str, Any]] = []
        for rid, st, title, tags, created_at in rows:
            out.append(
                {
                    "id": int(rid),
                    "source_type": st,
                    "title": title,
                    "tags": tags,
                    "created_at": created_at if isinstance(created_at, datetime) else created_at,
                }
            )
        return out


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


@router.patch("/chunks/{chunk_id}")
def update_chunk(project_id: str, chunk_id: int, payload: dict[str, Any]) -> KBChunk:
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")

        chunk = session.get(KBChunk, chunk_id)
        if not chunk or chunk.project_id != project_id:
            raise HTTPException(status_code=404, detail="Chunk not found")

        if "title" in payload:
            chunk.title = str(payload.get("title") or "").strip()

        if "tags" in payload:
            tags = payload.get("tags") or ""
            if isinstance(tags, list):
                tags = ",".join(str(t).strip() for t in tags if str(t).strip())
            chunk.tags = str(tags).strip()

        if "content" in payload:
            content = str(payload.get("content") or "").strip()
            if not content:
                raise HTTPException(status_code=400, detail="content is required")
            chunk.content = content

        session.add(chunk)
        session.commit()
        session.refresh(chunk)
        return chunk


@router.delete("/chunks/{chunk_id}")
def delete_chunk(project_id: str, chunk_id: int) -> dict[str, bool]:
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")

        chunk = session.get(KBChunk, chunk_id)
        if not chunk or chunk.project_id != project_id:
            raise HTTPException(status_code=404, detail="Chunk not found")

        session.delete(chunk)
        session.commit()

    return {"ok": True}


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
