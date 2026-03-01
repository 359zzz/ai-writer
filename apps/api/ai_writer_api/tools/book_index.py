from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .continue_sources import ContinueSourceError, load_continue_source


class BookIndexError(RuntimeError):
    pass


@dataclass(frozen=True)
class BookChunkMeta:
    index: int
    start_char: int
    end_char: int
    chars: int
    preview_head: str
    preview_tail: str


def _clamp_int(value: object, *, default: int, min_v: int, max_v: int) -> int:
    try:
        n = int(value)  # type: ignore[arg-type]
    except Exception:
        n = int(default)
    return max(int(min_v), min(int(max_v), int(n)))


def iter_text_chunks(
    *,
    path: Path,
    chunk_chars: int,
    overlap_chars: int,
    max_chunks: int,
) -> Iterator[tuple[int, int, str]]:
    """
    Yield (chunk_index, start_char, chunk_text) from a UTF-8 text file.

    Notes:
    - Chunking is character-based (not tokens).
    - overlap_chars applies to subsequent chunks (sliding window).
    - Reads incrementally to avoid loading the entire file into memory.
    """

    chunk_chars = _clamp_int(chunk_chars, default=6000, min_v=500, max_v=30_000)
    overlap_chars = _clamp_int(overlap_chars, default=400, min_v=0, max_v=10_000)
    max_chunks = _clamp_int(max_chunks, default=200, min_v=1, max_v=2000)

    if overlap_chars >= chunk_chars:
        # Keep a sane step size; don't allow a non-advancing window.
        overlap_chars = max(0, chunk_chars // 4)

    step = max(1, chunk_chars - overlap_chars)

    buf = ""
    start_char = 0
    idx = 1
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        while True:
            while len(buf) < chunk_chars:
                piece = f.read(8192)
                if not piece:
                    break
                buf += piece

            if not buf:
                break

            if len(buf) <= chunk_chars:
                yield idx, start_char, buf
                break

            yield idx, start_char, buf[:chunk_chars]
            idx += 1
            if idx > max_chunks:
                break
            start_char += step
            buf = buf[step:]


def build_book_index(
    *,
    source_id: str,
    chunk_chars: int = 6000,
    overlap_chars: int = 400,
    max_chunks: int = 200,
    preview_chars: int = 160,
) -> dict[str, Any]:
    """
    Build a lightweight chunk index for a stored Continue/Book source.

    Returns a JSON-serializable dict with chunk metadata + small previews.
    """

    src = load_continue_source(source_id)
    chunk_chars_i = _clamp_int(chunk_chars, default=6000, min_v=500, max_v=30_000)
    overlap_chars_i = _clamp_int(overlap_chars, default=400, min_v=0, max_v=10_000)
    max_chunks_i = _clamp_int(max_chunks, default=200, min_v=1, max_v=2000)
    preview_chars_i = _clamp_int(preview_chars, default=160, min_v=0, max_v=1000)

    chunks: list[BookChunkMeta] = []
    truncated = False

    try:
        for idx, start, text in iter_text_chunks(
            path=src.text_path,
            chunk_chars=chunk_chars_i,
            overlap_chars=overlap_chars_i,
            max_chunks=max_chunks_i,
        ):
            cleaned = (text or "").strip("\n")
            if not cleaned:
                continue
            head = cleaned[:preview_chars_i].strip() if preview_chars_i > 0 else ""
            tail = cleaned[-preview_chars_i:].strip() if preview_chars_i > 0 else ""
            chunks.append(
                BookChunkMeta(
                    index=int(idx),
                    start_char=int(start),
                    end_char=int(start) + len(cleaned),
                    chars=len(cleaned),
                    preview_head=head,
                    preview_tail=tail,
                )
            )
            if idx >= max_chunks_i:
                # If there is more content, it will be truncated. We can't know
                # without scanning the rest; this is a conservative marker.
                truncated = True
                break
    except ContinueSourceError:
        raise
    except Exception as e:  # pragma: no cover
        raise BookIndexError(f"book_index_failed:{type(e).__name__}") from e

    return {
        "source_id": src.source_id,
        "meta": src.meta,
        "params": {
            "chunk_chars": chunk_chars_i,
            "overlap_chars": overlap_chars_i,
            "max_chunks": max_chunks_i,
            "preview_chars": preview_chars_i,
        },
        "chunks": [
            {
                "index": c.index,
                "start_char": c.start_char,
                "end_char": c.end_char,
                "chars": c.chars,
                "preview_head": c.preview_head,
                "preview_tail": c.preview_tail,
            }
            for c in chunks
        ],
        "total_chunks": len(chunks),
        "truncated": truncated,
    }

