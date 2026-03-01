from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .continue_sources import ContinueSourceError, load_continue_source


class ChapterIndexError(RuntimeError):
    pass


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clamp_int(value: object, *, default: int, min_v: int, max_v: int) -> int:
    try:
        n = int(value)  # type: ignore[arg-type]
    except Exception:
        n = int(default)
    return max(int(min_v), min(int(max_v), int(n)))


_CN_NUM = "0-9一二三四五六七八九十百千万零〇两"

# Typical Chinese web novels / classical novels:
#   第十二章：标题
#   第十回  标题
# Also tolerate extra spaces / fullwidth spaces.
_CHAPTER_HEADING_RE = re.compile(
    rf"^\s*第\s*([{_CN_NUM}]+)\s*(章|回|卷|节)\s*[:：\-\—\.\s　\t]*([^\r\n]*)\s*$"
)


@dataclass
class ChapterMeta:
    index: int
    label: str
    title: str
    start_char: int
    end_char: int
    chars: int
    header: str
    preview_head: str
    preview_tail: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": int(self.index),
            "label": self.label,
            "title": self.title,
            "start_char": int(self.start_char),
            "end_char": int(self.end_char),
            "chars": int(self.chars),
            "header": self.header,
            "preview_head": self.preview_head,
            "preview_tail": self.preview_tail,
        }


def _chapter_index_path(text_path: Path) -> Path:
    # Continue source layout:
    #   data/continue_sources/<source_id>/text.txt
    # Store chapter index alongside the text.
    return text_path.parent / "chapter_index.json"


def load_chapter_index(*, source_id: str) -> dict[str, Any]:
    src = load_continue_source(source_id)
    path = _chapter_index_path(src.text_path)
    if not path.exists():
        raise ChapterIndexError("chapter_index_not_found")
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # pragma: no cover
        raise ChapterIndexError(f"chapter_index_bad_json:{type(e).__name__}") from e
    if not isinstance(obj, dict):
        raise ChapterIndexError("chapter_index_invalid")
    return obj


def update_chapter_index(
    *,
    source_id: str,
    chapters: list[dict[str, Any]],
    preview_chars: int = 160,
    max_chapters: int = 2000,
) -> dict[str, Any]:
    """
    Update (overwrite) chapter index with a user-edited chapter list.

    Intended for "manual micro-tuning" after auto chapter detection:
    - delete chapters (merge boundaries)
    - edit labels/titles
    - (optionally) reorder by start_char

    Notes:
    - This does NOT call any LLM.
    - It recomputes end_char/chars and previews based on the current text file.
    """

    src = load_continue_source(source_id)
    preview_chars_i = _clamp_int(preview_chars, default=160, min_v=0, max_v=2000)
    max_chapters_i = _clamp_int(max_chapters, default=2000, min_v=1, max_v=20_000)

    if not isinstance(chapters, list) or not chapters:
        raise ChapterIndexError("chapter_index_invalid:missing_chapters")

    try:
        full_text = src.text_path.read_text(encoding="utf-8", errors="ignore")
    except Exception as e:  # pragma: no cover
        raise ChapterIndexError(f"chapter_index_read_text_failed:{type(e).__name__}") from e

    total_len = len(full_text)

    items: list[dict[str, Any]] = []
    for it in chapters:
        if not isinstance(it, dict):
            continue
        start_raw = it.get("start_char")
        try:
            start = int(start_raw)  # type: ignore[arg-type]
        except Exception:
            continue
        start = max(0, min(int(start), int(total_len)))

        header = str(it.get("header") or "").strip()
        label = str(it.get("label") or "").strip()
        title = str(it.get("title") or "").strip()

        if not label and header:
            m = _CHAPTER_HEADING_RE.match(header)
            if m:
                num_s = (m.group(1) or "").strip()
                unit = (m.group(2) or "").strip()
                label = f"第{num_s}{unit}".strip()
        if not label:
            label = "Chapter"
        if not title:
            title = label

        items.append(
            {
                "start_char": start,
                "header": header,
                "label": label,
                "title": title,
            }
        )

    if not items:
        raise ChapterIndexError("chapter_index_invalid:no_valid_chapters")

    # Sort by boundary, dedupe by start_char to keep a stable, monotonic index.
    items.sort(key=lambda x: int(x.get("start_char") or 0))
    deduped: list[dict[str, Any]] = []
    seen: set[int] = set()
    for it in items:
        start = int(it.get("start_char") or 0)
        if start in seen:
            continue
        seen.add(start)
        deduped.append(it)
        if len(deduped) >= max_chapters_i:
            break

    chapters_out: list[ChapterMeta] = []
    for i, it in enumerate(deduped):
        start = int(it.get("start_char") or 0)
        end = int(deduped[i + 1].get("start_char") or total_len) if i + 1 < len(deduped) else int(total_len)
        end = max(start, min(end, int(total_len)))
        chapter_text = full_text[start:end]

        header = str(it.get("header") or "").strip()
        label = str(it.get("label") or "").strip()
        title = str(it.get("title") or "").strip()

        # Prefer preview_head AFTER the header line if possible.
        content_for_head = chapter_text
        if header and chapter_text.startswith(header):
            content_for_head = chapter_text[len(header) :]
            if content_for_head.startswith("\n"):
                content_for_head = content_for_head[1:]
        else:
            # Fall back: drop the first line as "header-like".
            parts = chapter_text.splitlines()
            if len(parts) >= 2:
                content_for_head = "\n".join(parts[1:])

        head = content_for_head.strip()
        tail = chapter_text.strip()

        chapters_out.append(
            ChapterMeta(
                index=i + 1,
                label=label,
                title=title,
                start_char=start,
                end_char=end,
                chars=max(0, end - start),
                header=header,
                preview_head=(head[:preview_chars_i] if preview_chars_i > 0 else ""),
                preview_tail=(tail[-preview_chars_i:] if preview_chars_i > 0 else ""),
            )
        )

    if not chapters_out:
        raise ChapterIndexError("chapter_index_invalid:no_chapters_after_normalize")

    result: dict[str, Any] = {
        "source_id": src.source_id,
        "meta": src.meta,
        "params": {
            "preview_chars": preview_chars_i,
            "max_chapters": max_chapters_i,
            "pattern": "cn_default",
            "overwrite": True,
            "user_edited": True,
        },
        "chapters": [c.to_dict() for c in chapters_out],
        "total_chapters": len(chapters_out),
        "truncated": len(items) > len(chapters_out),
        "updated_at": _now_utc_iso(),
    }

    out_path = _chapter_index_path(src.text_path)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def build_chapter_index(
    *,
    source_id: str,
    preview_chars: int = 160,
    max_chapters: int = 2000,
    overwrite: bool = True,
) -> dict[str, Any]:
    """
    Build a chapter-aware index for a stored book source (rule-based).

    This endpoint/tool does NOT call any LLM.
    """

    src = load_continue_source(source_id)
    preview_chars_i = _clamp_int(preview_chars, default=160, min_v=0, max_v=2000)
    max_chapters_i = _clamp_int(max_chapters, default=2000, min_v=1, max_v=20_000)

    out_path = _chapter_index_path(src.text_path)
    if out_path.exists() and not overwrite:
        return load_chapter_index(source_id=source_id)

    chapters: list[ChapterMeta] = []
    truncated = False

    # Streaming scan: keep offsets in character units (not bytes).
    pos = 0
    cur_start = -1
    cur_header = ""
    cur_label = ""
    cur_title = ""
    head_buf = ""
    tail_buf = ""
    capturing_head = True

    def _finalize(end_pos: int) -> None:
        nonlocal cur_start, cur_header, cur_label, cur_title, head_buf, tail_buf, capturing_head
        if cur_start < 0:
            return
        idx = len(chapters) + 1
        end = max(cur_start, int(end_pos))
        chars = max(0, end - cur_start)
        chapters.append(
            ChapterMeta(
                index=idx,
                label=cur_label,
                title=cur_title,
                start_char=cur_start,
                end_char=end,
                chars=chars,
                header=cur_header,
                preview_head=(head_buf.strip()[:preview_chars_i] if preview_chars_i > 0 else ""),
                preview_tail=(tail_buf.strip()[-preview_chars_i:] if preview_chars_i > 0 else ""),
            )
        )
        cur_start = -1
        cur_header = ""
        cur_label = ""
        cur_title = ""
        head_buf = ""
        tail_buf = ""
        capturing_head = True

    try:
        with src.text_path.open("r", encoding="utf-8", errors="ignore") as f:
            for raw_line in f:
                line = raw_line.rstrip("\r\n")
                m = _CHAPTER_HEADING_RE.match(line)
                if m:
                    # Start of a new chapter.
                    _finalize(pos)
                    if len(chapters) >= max_chapters_i:
                        truncated = True
                        break
                    num_s = (m.group(1) or "").strip()
                    unit = (m.group(2) or "").strip()
                    tail = (m.group(3) or "").strip()
                    label = f"第{num_s}{unit}"
                    title = tail if tail else label
                    cur_start = int(pos)
                    cur_header = line.strip()
                    cur_label = label
                    cur_title = title
                    head_buf = ""
                    tail_buf = ""
                    capturing_head = True
                else:
                    if cur_start >= 0 and preview_chars_i > 0:
                        # head: capture early content (after the heading).
                        if capturing_head and len(head_buf) < preview_chars_i:
                            need = preview_chars_i - len(head_buf)
                            if need > 0 and line.strip():
                                head_buf += (line.strip() + "\n")[:need]
                            if len(head_buf) >= preview_chars_i:
                                capturing_head = False

                        # tail: rolling buffer
                        if line.strip():
                            tail_buf = (tail_buf + line.strip() + "\n")[-max(200, preview_chars_i * 2) :]

                pos += len(raw_line)
    except ContinueSourceError:
        raise
    except Exception as e:  # pragma: no cover
        raise ChapterIndexError(f"chapter_index_failed:{type(e).__name__}") from e

    if not truncated:
        _finalize(pos)

    if not chapters:
        raise ChapterIndexError("chapter_index_no_headings_found")

    result: dict[str, Any] = {
        "source_id": src.source_id,
        "meta": src.meta,
        "params": {
            "preview_chars": preview_chars_i,
            "max_chapters": max_chapters_i,
            "pattern": "cn_default",
            "overwrite": bool(overwrite),
        },
        "chapters": [c.to_dict() for c in chapters],
        "total_chapters": len(chapters),
        "truncated": truncated,
        "updated_at": _now_utc_iso(),
    }

    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result
