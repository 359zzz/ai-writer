from __future__ import annotations

from typing import Any

from duckduckgo_search import DDGS
from fastapi import APIRouter, HTTPException, Query


router = APIRouter(prefix="/api/tools", tags=["tools"])


@router.get("/web_search")
def web_search(
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=5, ge=1, le=10),
) -> list[dict[str, Any]]:
    """
    Lightweight web search tool.

    Notes:
    - Results are transient; not stored into local KB unless the user imports them.
    - Do not return full page contents here; just search results.
    """
    query = q.strip()
    if not query:
        raise HTTPException(status_code=400, detail="q is required")

    try:
        out: list[dict[str, Any]] = []
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=limit):
                out.append(
                    {
                        "title": r.get("title") or "",
                        "url": r.get("href") or r.get("url") or "",
                        "snippet": r.get("body") or r.get("snippet") or "",
                    }
                )
        return out
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"web_search_failed: {type(e).__name__}")

