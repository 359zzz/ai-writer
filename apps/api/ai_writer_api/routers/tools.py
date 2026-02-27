from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..tools.web_search import WebSearchError, web_search as perform_web_search


router = APIRouter(prefix="/api/tools", tags=["tools"])


@router.get("/web_search")
def web_search(
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=5, ge=1, le=10),
    provider: str = Query(default="auto", max_length=24),
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
        results, _meta = perform_web_search(query, limit=limit, provider=provider)
        # Keep response shape stable (list of {title,url,snippet}).
        return results
    except WebSearchError as e:
        detail = "web_search_failed"
        if getattr(e, "errors", None):
            detail += f": {', '.join(e.errors[:6])}"
        raise HTTPException(status_code=502, detail=detail) from e
    except Exception as e:  # pragma: no cover
        raise HTTPException(status_code=502, detail=f"web_search_failed: {type(e).__name__}") from e
