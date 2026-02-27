from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .text_extract import ExtractedText, TextExtractError, extract_text_from_bytes


class ContinueSourceError(RuntimeError):
    pass


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _continue_sources_root() -> Path:
    # This file lives at .../apps/api/ai_writer_api/tools/continue_sources.py
    # parents[2] -> .../apps/api
    api_root = Path(__file__).resolve().parents[2]
    root = api_root / "data" / "continue_sources"
    root.mkdir(parents=True, exist_ok=True)
    return root


_SAFE_ID_RE = re.compile(r"^[a-f0-9\\-]{8,64}$")


def _validate_source_id(source_id: str) -> str:
    sid = (source_id or "").strip()
    if not sid or not _SAFE_ID_RE.fullmatch(sid):
        raise ContinueSourceError("invalid_source_id")
    return sid


def _safe_ext(ext: str) -> str:
    e = (ext or "").strip().lower()
    if re.fullmatch(r"\\.[a-z0-9]{1,8}", e):
        return e
    return ".bin"


@dataclass(frozen=True)
class ContinueSource:
    source_id: str
    meta: dict[str, Any]
    text_path: Path
    meta_path: Path
    original_path: Path


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def save_continue_source_from_bytes(
    *,
    filename: str,
    content_type: str | None,
    data: bytes,
) -> ContinueSource:
    """
    Store a "Continue Mode" source into local disk (gitignored).

    - Keeps original upload bytes.
    - Extracts plain text (no LLM) and stores as UTF-8 text.

    This exists to avoid shuttling huge manuscripts back and forth to the browser.
    """
    try:
        extracted: ExtractedText = extract_text_from_bytes(
            filename=filename,
            content_type=content_type,
            data=data,
        )
    except TextExtractError as e:
        raise ContinueSourceError(str(e)) from e

    source_id = str(uuid4())
    root = _continue_sources_root() / source_id
    root.mkdir(parents=True, exist_ok=True)

    ext = _safe_ext(str(extracted.meta.get("ext") or Path(filename).suffix))
    original_path = root / f"original{ext}"
    original_path.write_bytes(data)

    text_path = root / "text.txt"
    text_path.write_text(extracted.text, encoding="utf-8")

    meta_path = root / "meta.json"
    meta: dict[str, Any] = {
        **(extracted.meta or {}),
        "source_id": source_id,
        "created_at": _now_utc_iso(),
    }
    _write_json(meta_path, meta)

    return ContinueSource(
        source_id=source_id,
        meta=meta,
        text_path=text_path,
        meta_path=meta_path,
        original_path=original_path,
    )


def save_continue_source_from_text(*, text: str, filename: str = "pasted.txt") -> ContinueSource:
    # Reuse the same extraction/normalization pipeline as uploads (.txt).
    data = (text or "").encode("utf-8", errors="ignore")
    return save_continue_source_from_bytes(filename=filename, content_type="text/plain", data=data)


def load_continue_source(source_id: str) -> ContinueSource:
    sid = _validate_source_id(source_id)
    root = _continue_sources_root() / sid
    meta_path = root / "meta.json"
    text_path = root / "text.txt"
    if not meta_path.exists() or not text_path.exists():
        raise ContinueSourceError("source_not_found")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        meta = {}
    ext = _safe_ext(str((meta or {}).get("ext") or ".bin"))
    original_path = root / f"original{ext}"
    return ContinueSource(
        source_id=sid,
        meta=meta if isinstance(meta, dict) else {},
        text_path=text_path,
        meta_path=meta_path,
        original_path=original_path,
    )


def _read_text_head(path: Path, *, limit_chars: int) -> str:
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        return f.read(max(0, int(limit_chars)))


def _read_text_tail(path: Path, *, limit_chars: int) -> str:
    limit = max(0, int(limit_chars))
    if limit <= 0:
        return ""
    # UTF-8 can be up to 4 bytes/char; over-read a bit and slice after decode.
    approx_bytes = max(4096, limit * 4)
    size = path.stat().st_size
    start = max(0, size - approx_bytes)
    with path.open("rb") as f:
        f.seek(start)
        buf = f.read()
    txt = buf.decode("utf-8", errors="ignore")
    return txt[-limit:]


def get_continue_source_preview(
    *,
    source_id: str,
    mode: str = "tail",
    limit_chars: int = 8000,
) -> dict[str, Any]:
    src = load_continue_source(source_id)
    m = (mode or "tail").strip().lower()
    if m not in {"head", "tail"}:
        m = "tail"
    limit = max(200, min(int(limit_chars), 200_000))

    if m == "head":
        preview = _read_text_head(src.text_path, limit_chars=limit)
    else:
        preview = _read_text_tail(src.text_path, limit_chars=limit)

    return {
        "source_id": src.source_id,
        "mode": m,
        "limit_chars": limit,
        "text": preview,
        "meta": src.meta,
    }


def load_continue_source_excerpt(
    *,
    source_id: str,
    mode: str = "tail",
    limit_chars: int = 8000,
) -> str:
    """
    Load only a limited excerpt of a stored Continue source for LLM prompting.
    """
    src = load_continue_source(source_id)
    m = (mode or "tail").strip().lower()
    if m not in {"head", "tail"}:
        m = "tail"
    limit = max(200, min(int(limit_chars), 200_000))
    if m == "head":
        return _read_text_head(src.text_path, limit_chars=limit)
    return _read_text_tail(src.text_path, limit_chars=limit)

