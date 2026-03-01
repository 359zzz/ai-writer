from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from ..tools.continue_sources import (
    ContinueSourceError,
    get_continue_source_preview,
    save_continue_source_from_bytes,
    save_continue_source_from_text,
)
from ..tools.book_index import BookIndexError, build_book_index
from ..tools.text_extract import TextExtractError, extract_text_from_bytes
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


@router.post("/extract_text")
async def extract_text(
    file: UploadFile = File(...),
    max_bytes: int = Query(default=20_000_000, ge=1_000_000, le=80_000_000),
) -> dict[str, Any]:
    """
    Extract text content from an uploaded file for Continue Mode.

    This endpoint does NOT call any LLM. It only converts supported formats to plain text.

    Supported:
    - .txt / .md
    - .docx
    - .pdf
    - .epub
    """
    raw = await file.read()
    if len(raw) > int(max_bytes):
        raise HTTPException(status_code=413, detail="file_too_large")

    try:
        extracted = extract_text_from_bytes(
            filename=file.filename or "upload",
            content_type=file.content_type,
            data=raw,
        )
        return {"text": extracted.text, "meta": extracted.meta}
    except TextExtractError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # pragma: no cover
        raise HTTPException(
            status_code=500, detail=f"extract_text_failed: {type(e).__name__}"
        ) from e


@router.post("/continue_sources/upload")
async def upload_continue_source(
    file: UploadFile = File(...),
    max_bytes: int = Query(default=80_000_000, ge=1_000_000, le=200_000_000),
    preview_mode: str = Query(default="tail", max_length=8),
    preview_chars: int = Query(default=8000, ge=200, le=200_000),
) -> dict[str, Any]:
    """
    Upload a manuscript (txt/docx/pdf/epub) for Continue Mode.

    Unlike /extract_text, this endpoint stores the extracted text locally on disk and
    returns a short preview + a source_id, so the frontend does NOT need to keep or
    re-POST the entire manuscript again when starting a run.

    This endpoint does NOT call any LLM.
    """
    raw = await file.read()
    if len(raw) > int(max_bytes):
        raise HTTPException(status_code=413, detail="file_too_large")

    try:
        src = save_continue_source_from_bytes(
            filename=file.filename or "upload",
            content_type=file.content_type,
            data=raw,
        )
        preview = get_continue_source_preview(
            source_id=src.source_id,
            mode=preview_mode,
            limit_chars=preview_chars,
        )
        return {
            "source_id": src.source_id,
            "meta": src.meta,
            "preview": preview.get("text", ""),
            "preview_mode": preview.get("mode", "tail"),
            "preview_chars": preview.get("limit_chars", preview_chars),
        }
    except ContinueSourceError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # pragma: no cover
        raise HTTPException(
            status_code=500, detail=f"continue_source_upload_failed: {type(e).__name__}"
        ) from e


@router.post("/continue_sources/text")
async def create_continue_source_from_text_payload(
    payload: dict[str, Any],
    max_chars: int = Query(default=6_000_000, ge=10_000, le=50_000_000),
    preview_mode: str = Query(default="tail", max_length=8),
    preview_chars: int = Query(default=8000, ge=200, le=200_000),
) -> dict[str, Any]:
    """
    Store pasted/typed text into a local Continue Mode source.

    This endpoint does NOT call any LLM.
    """
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="text_required")
    if len(text) > int(max_chars):
        raise HTTPException(status_code=413, detail="text_too_large")

    filename = payload.get("filename")
    if not isinstance(filename, str) or not filename.strip():
        filename = "pasted.txt"

    try:
        src = save_continue_source_from_text(text=text, filename=filename)
        preview = get_continue_source_preview(
            source_id=src.source_id,
            mode=preview_mode,
            limit_chars=preview_chars,
        )
        return {
            "source_id": src.source_id,
            "meta": src.meta,
            "preview": preview.get("text", ""),
            "preview_mode": preview.get("mode", "tail"),
            "preview_chars": preview.get("limit_chars", preview_chars),
        }
    except ContinueSourceError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # pragma: no cover
        raise HTTPException(
            status_code=500, detail=f"continue_source_text_failed: {type(e).__name__}"
        ) from e


@router.get("/continue_sources/{source_id}/preview")
def preview_continue_source(
    source_id: str,
    mode: str = Query(default="tail", max_length=8),
    limit_chars: int = Query(default=8000, ge=200, le=200_000),
) -> dict[str, Any]:
    """
    Fetch a preview/excerpt of a stored Continue Mode source.

    This is safe for large files: it reads only a limited excerpt from disk.
    """
    try:
        return get_continue_source_preview(
            source_id=source_id,
            mode=mode,
            limit_chars=limit_chars,
        )
    except ContinueSourceError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/continue_sources/{source_id}/book_index")
def build_continue_source_book_index(
    source_id: str,
    chunk_chars: int = Query(default=6000, ge=500, le=30_000),
    overlap_chars: int = Query(default=400, ge=0, le=10_000),
    max_chunks: int = Query(default=200, ge=1, le=2000),
    preview_chars: int = Query(default=160, ge=0, le=1000),
) -> dict[str, Any]:
    """
    Build a lightweight "book chunk index" for a stored Continue/Book source.

    This endpoint does NOT call any LLM.
    """

    try:
        return build_book_index(
            source_id=source_id,
            chunk_chars=chunk_chars,
            overlap_chars=overlap_chars,
            max_chunks=max_chunks,
            preview_chars=preview_chars,
        )
    except ContinueSourceError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except BookIndexError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
