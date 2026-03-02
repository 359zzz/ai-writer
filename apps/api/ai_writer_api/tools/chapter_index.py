from __future__ import annotations

import json
import bisect
import math
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

# A more permissive detector for headings that may appear "inside" the body text
# due to imperfect extraction/formatting (e.g. PDF/EPUB text merge) OR due to
# "navigation noise" getting inlined before the heading (common on scraped sites):
#   ... 回目录回首页第二回 标题
#
# We keep the regex permissive and rely on context-based filtering + a DP that
# prefers plausible chapter lengths when multiple duplicates exist.
_CHAPTER_HEADING_ANY_RE = re.compile(
    rf"第[ \t　]*([{_CN_NUM}]+)[ \t　]*(章|回|卷|节)"
    rf"(?:[ \t　]*[（(]?[ \t　]*[上中下序终完][ \t　]*[）)]?)?"
    rf"(?P<delim>[ \t　:：\-\—\.]*)"
    rf"(?P<title>[^\r\n]{{0,60}})"
)

_PUNCT_BEFORE_HEADING = set(
    "，。！？：；、,.!?;:\"'“”‘’（）()【】[]《》<>—-…·．"
)

# Common page/navigation tails seen in scraped Chinese novels.
_NAV_SUFFIXES: tuple[str, ...] = (
    "回目录回首页",
    "返回目录",
    "返回首页",
    "回目录",
    "回首页",
    "上一页",
    "下一页",
    "前一页",
    "后一页",
    "上一章",
    "下一章",
)


_CN_DIGIT_MAP: dict[str, int] = {
    "零": 0,
    "〇": 0,
    "0": 0,
    "一": 1,
    "1": 1,
    "二": 2,
    "两": 2,
    "2": 2,
    "三": 3,
    "3": 3,
    "四": 4,
    "4": 4,
    "五": 5,
    "5": 5,
    "六": 6,
    "6": 6,
    "七": 7,
    "7": 7,
    "八": 8,
    "8": 8,
    "九": 9,
    "9": 9,
}

_CN_UNIT_MAP: dict[str, int] = {
    "十": 10,
    "百": 100,
    "千": 1000,
    "万": 10_000,
}


def _parse_cn_int(text: str) -> int | None:
    s = (text or "").strip()
    if not s:
        return None
    if re.fullmatch(r"\d{1,6}", s):
        try:
            return int(s)
        except Exception:
            return None

    total = 0
    section = 0
    number = 0
    any_hit = False
    for ch in s:
        if ch in _CN_DIGIT_MAP:
            number = _CN_DIGIT_MAP[ch]
            any_hit = True
            continue
        if ch in _CN_UNIT_MAP:
            unit = _CN_UNIT_MAP[ch]
            any_hit = True
            if unit >= 10_000:
                section = (section + number) * unit
                total += section
                section = 0
            else:
                if number == 0:
                    # e.g. "十二" / "十"
                    number = 1
                section += number * unit
            number = 0
            continue
        # Unknown char: give up if no useful tokens so far, otherwise ignore.
        if not any_hit:
            return None

    out = total + section + number
    if out <= 0:
        return None
    return out


@dataclass(frozen=True)
class HeadingCandidate:
    start_char: int
    end_char: int
    num_raw: str
    num: int | None
    unit: str
    delim: str
    title: str
    header: str
    score: float
    ref_like: bool


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

    try:
        full_text = src.text_path.read_text(encoding="utf-8", errors="ignore")
    except Exception as e:  # pragma: no cover
        raise ChapterIndexError(f"chapter_index_read_text_failed:{type(e).__name__}") from e

    total_len = len(full_text)
    if total_len <= 0:
        raise ChapterIndexError("chapter_index_empty_text")

    def nav_bonus(start: int) -> float:
        if start <= 0:
            return 0.0
        left = full_text[max(0, start - 90) : start]
        left = left.replace("\r", "").replace("\n", "")
        left_norm = re.sub(r"[\s　\t]+", "", left)
        left_norm = re.sub(
            r"[\-—_|\u00b7…。，、：;；.!！?？“”‘’（）()\[\]<>《》]",
            "",
            left_norm,
        )
        tail = left_norm[-40:]
        for tok in _NAV_SUFFIXES:
            if tail.endswith(tok):
                return 1.8
        if "回目录" in tail and "回首页" in tail:
            return 1.2
        if "回首页" in tail and ("上一页" in tail or "下一页" in tail or "前一页" in tail or "后一页" in tail):
            return 1.0
        return 0.0

    def allow_by_left_context(*, start: int, nav_b: float) -> bool:
        if start <= 0:
            return True
        prev = full_text[start - 1]
        if prev in "\r\n":
            return True
        if prev.isspace():
            return True
        if prev in _PUNCT_BEFORE_HEADING:
            return True
        return nav_b > 0.0

    def score_candidate(
        *, start: int, end: int, core_end: int, delim: str, title: str, nav_b: float
    ) -> tuple[float, bool]:
        score = 0.0
        if start <= 0:
            score += 1.0
        else:
            prev = full_text[start - 1]
            if prev in "\r\n":
                score += 2.0
            elif prev.isspace():
                score += 0.3
            elif prev in _PUNCT_BEFORE_HEADING:
                score += 0.4

        score += float(nav_b)

        title_s = (title or "").strip()
        delim_s = delim or ""

        if title_s:
            score += 0.5

        # Reward visible "heading delimiter" (spaces/colon/dash/dot) between the unit and title.
        if delim_s:
            score += 0.7

        # Penalize reference-like patterns:
        #   "第四回中既将..." (no delimiter, title begins immediately with '中/内/里' etc.)
        ref_like = False
        if not delim_s and title_s:
            ch0 = title_s[:1]
            if ch0 in {"中", "内", "里"}:
                score -= 2.2
                ref_like = True
            else:
                score -= 0.9

        # If a newline appears soon after the matched heading, it's likely a real header line.
        tail = full_text[end : min(total_len, end + 80)]
        if "\n" in tail or "\r" in tail:
            score += 0.6

        # Blank line before heading is a weak positive signal.
        prev2 = full_text[max(0, start - 6) : start]
        if "\n\n" in prev2 or "\r\n\r\n" in prev2:
            score += 0.4

        # If the delimiter/title captured nav noise, it's probably an artifact.
        if ("回目录" in title_s) or ("回首页" in title_s) or ("返回目录" in title_s) or ("返回首页" in title_s):
            score -= 1.3

        # If there's no delimiter and the title is non-empty, ensure we didn't cross a newline boundary.
        # (Our regex excludes newlines in delim/title, but core_end may still be at EOL.)
        if not delim_s and title_s and core_end < total_len and full_text[core_end] in "\r\n":
            score += 0.2

        return score, ref_like

    candidates_raw: list[HeadingCandidate] = []
    for m in _CHAPTER_HEADING_ANY_RE.finditer(full_text):
        num_raw = (m.group(1) or "").strip()
        unit = (m.group(2) or "").strip()
        delim = (m.group("delim") or "")
        title = (m.group("title") or "")
        start = int(m.start())
        end = int(m.end())
        if start < 0 or start >= total_len:
            continue
        if end <= start:
            continue
        nav_b = nav_bonus(start)
        if not allow_by_left_context(start=start, nav_b=nav_b):
            continue
        header = full_text[start:end].strip()
        num = _parse_cn_int(num_raw)
        core_end = int(m.start("delim"))
        score, ref_like = score_candidate(
            start=start,
            end=end,
            core_end=core_end,
            delim=delim,
            title=title,
            nav_b=nav_b,
        )
        candidates_raw.append(
            HeadingCandidate(
                start_char=start,
                end_char=end,
                num_raw=num_raw,
                num=num,
                unit=unit,
                delim=delim,
                title=title,
                header=header,
                score=score,
                ref_like=ref_like,
            )
        )

    if not candidates_raw:
        raise ChapterIndexError("chapter_index_no_headings_found")

    # Dedupe candidates by boundary position (keep the best-scored one).
    by_start: dict[int, HeadingCandidate] = {}
    for c in candidates_raw:
        prev = by_start.get(c.start_char)
        if not prev or c.score > prev.score:
            by_start[c.start_char] = c
    candidates = sorted(by_start.values(), key=lambda c: c.start_char)

    # Pick the most likely unit (章/回/卷/节) to reduce noise.
    unit_counts: dict[str, int] = {}
    for c in candidates:
        if c.num is None:
            continue
        unit_counts[c.unit] = unit_counts.get(c.unit, 0) + 1
    if not unit_counts:
        for c in candidates:
            unit_counts[c.unit] = unit_counts.get(c.unit, 0) + 1
    best_unit = sorted(unit_counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    candidates = [c for c in candidates if c.unit == best_unit]
    if not candidates:
        raise ChapterIndexError("chapter_index_no_headings_found")

    numeric = [c for c in candidates if c.num is not None]
    # If we don't have usable numbers, fall back to simple position-based split.
    if len(numeric) < 2:
        picked = candidates[:max_chapters_i]
    else:
        # Find the longest consecutive run of chapter numbers (most likely real book structure).
        nums = sorted({int(c.num) for c in numeric if c.num is not None})
        best_start = nums[0]
        best_len = 1
        cur_start = nums[0]
        cur_len = 1
        for i in range(1, len(nums)):
            if nums[i] == nums[i - 1] + 1:
                cur_len += 1
            else:
                if cur_len > best_len:
                    best_start, best_len = cur_start, cur_len
                cur_start = nums[i]
                cur_len = 1
        if cur_len > best_len:
            best_start, best_len = cur_start, cur_len

        run_nums = list(range(best_start, best_start + best_len))
        if len(run_nums) > max_chapters_i:
            run_nums = run_nums[:max_chapters_i]
        num_set = set(run_nums)

        groups: list[list[HeadingCandidate]] = []
        for n in run_nums:
            g = [c for c in numeric if int(c.num or -1) == n]
            g.sort(key=lambda c: c.start_char)
            groups.append(g)

        # Safety: prune per-number candidates to keep DP fast even on page-header duplicates.
        def prune_group(g: list[HeadingCandidate], limit: int = 18) -> list[HeadingCandidate]:
            if len(g) <= limit:
                return g
            by_pos = sorted(g, key=lambda c: c.start_char)
            by_score = sorted(g, key=lambda c: (-c.score, c.start_char))
            keep: dict[int, HeadingCandidate] = {}
            for c in by_score[: max(6, limit // 2)]:
                keep[c.start_char] = c
            for c in by_pos[:4] + by_pos[-4:]:
                keep[c.start_char] = c
            pruned = sorted(keep.values(), key=lambda c: (-c.score, c.start_char))[:limit]
            return sorted(pruned, key=lambda c: c.start_char)

        groups = [prune_group(g) for g in groups]

        # For TOC/page-header noise: if a candidate range contains *other* strong
        # chapter headings (different numbers), it's probably a false boundary.
        def is_strong_heading(c: HeadingCandidate) -> bool:
            if bool(getattr(c, "ref_like", False)):
                return False
            if c.start_char <= 0:
                return True
            prev_ch = full_text[c.start_char - 1]
            if prev_ch in "\r\n":
                return True
            return nav_bonus(int(c.start_char)) > 0.0

        strong_headings = sorted(
            [
                (c.start_char, int(c.num or 0))
                for c in numeric
                if c.num is not None and is_strong_heading(c)
            ],
            key=lambda t: t[0],
        )
        strong_starts = [p for p, _n in strong_headings]
        strong_nums = [_n for _p, _n in strong_headings]

        avg_len = max(1.0, float(total_len) / max(1, len(groups)))
        min_seg_candidates = [
            max(60, min(2500, int(avg_len * 0.08))),
            max(40, min(1800, int(avg_len * 0.04))),
            max(20, min(1200, int(avg_len * 0.02))),
            0,
        ]

        def dp_pick(*, typical_len: float | None, min_seg_len: int) -> list[HeadingCandidate] | None:
            if not groups or any(not g for g in groups):
                return None
            dp: list[list[float]] = [[-1e30 for _ in g] for g in groups]
            prev_ix: list[list[int]] = [[-1 for _ in g] for g in groups]

            for j, c in enumerate(groups[0]):
                dp[0][j] = float(c.score)

            def trans_bonus(seg_len: int) -> float:
                if typical_len is None or typical_len <= 0:
                    return 0.0
                r = max(1e-6, float(seg_len) / float(typical_len))
                pen = abs(math.log(r))
                # Strong penalty when too off (helps reject TOC/page-header duplicates).
                return -2.4 * pen

            def intrusion_penalty(prev_start: int, cur_start: int, prev_num: int) -> float:
                if not strong_headings:
                    return 0.0
                lo = bisect.bisect_right(strong_starts, int(prev_start))
                hi = bisect.bisect_left(strong_starts, int(cur_start))
                if hi <= lo:
                    return 0.0
                cnt = 0
                # Cap scan/penalty to keep worst-case bounded.
                for n in strong_nums[lo:hi]:
                    if int(n) != int(prev_num):
                        cnt += 1
                        if cnt >= 10:
                            break
                return -0.9 * float(cnt)

            for i in range(1, len(groups)):
                for j, cur in enumerate(groups[i]):
                    best = -1e30
                    best_k = -1
                    for k, prev in enumerate(groups[i - 1]):
                        if prev.start_char >= cur.start_char:
                            continue
                        seg_len = int(cur.start_char - prev.start_char)
                        if seg_len < int(min_seg_len):
                            continue
                        if dp[i - 1][k] <= -1e20:
                            continue
                        prev_num = int(prev.num or 0)
                        cand = (
                            dp[i - 1][k]
                            + float(cur.score)
                            + trans_bonus(seg_len)
                            + intrusion_penalty(prev.start_char, cur.start_char, prev_num)
                        )
                        if cand > best:
                            best = cand
                            best_k = k
                    dp[i][j] = best
                    prev_ix[i][j] = best_k

            last = dp[-1]
            best_last = max(range(len(last)), key=lambda j: last[j], default=-1)
            if best_last < 0 or last[best_last] <= -1e20:
                return None
            out: list[HeadingCandidate] = []
            j = best_last
            for i in reversed(range(len(groups))):
                out.append(groups[i][j])
                j = prev_ix[i][j]
                if i > 0 and j < 0:
                    return None
            out.reverse()
            return out

        picked: list[HeadingCandidate] | None = None
        used_min_seg_len = 0
        for ms in min_seg_candidates:
            picked = dp_pick(typical_len=None, min_seg_len=int(ms))
            if picked:
                used_min_seg_len = int(ms)
                break
        if not picked:
            # Final fallback: greedily pick the first monotonic sequence.
            picked = []
            last_pos = -1
            for g in groups:
                nxt = next((c for c in g if c.start_char > last_pos), None)
                if not nxt:
                    break
                picked.append(nxt)
                last_pos = nxt.start_char

        seg_lens = [
            int(picked[i + 1].start_char - picked[i].start_char)
            for i in range(len(picked) - 1)
            if picked[i + 1].start_char > picked[i].start_char
        ]
        typical = None
        if seg_lens:
            seg_sorted = sorted(seg_lens)
            trim = max(0, int(len(seg_sorted) * 0.1))
            core = seg_sorted[trim : len(seg_sorted) - trim] if len(seg_sorted) >= 8 else seg_sorted
            typical = float(core[len(core) // 2])
            if typical <= 0:
                typical = None

        picked2 = dp_pick(typical_len=typical, min_seg_len=max(0, used_min_seg_len // 2))
        if picked2:
            picked = picked2

    # Build final ChapterMeta list with previews.
    chapters: list[ChapterMeta] = []
    truncated = False
    picked = sorted(picked, key=lambda c: c.start_char)
    if len(picked) > max_chapters_i:
        picked = picked[:max_chapters_i]
        truncated = True

    for i, c in enumerate(picked):
        start = int(c.start_char)
        end = int(picked[i + 1].start_char) if i + 1 < len(picked) else int(total_len)
        end = max(start, min(end, int(total_len)))
        label = f"第{c.num_raw}{c.unit}".strip()
        title_raw = (c.title or "").strip()

        def _clean_title(t: str) -> str:
            s = (t or "").strip()
            if not s:
                return ""
            s = re.sub(r"[ \t　]+", " ", s).strip()
            # Drop obvious navigation noise if it got captured.
            for tok in _NAV_SUFFIXES:
                if tok and tok in s:
                    s = s.replace(tok, " ").strip()
            s = re.sub(r"[ \t　]+", " ", s).strip()
            return s[:60].strip()

        title = _clean_title(title_raw)
        if (not title) or title == label:
            # Fallback: try to read a "next line" title after the heading span.
            # Common format:
            #   第二回
            #   贾夫人仙逝扬州城  冷子兴演说荣国府
            look_start = int(min(end, max(0, int(c.end_char))))
            look_end = int(min(end, look_start + 420))
            tail = full_text[look_start:look_end]
            for ln in tail.splitlines():
                s = (ln or "").strip()
                if not s:
                    continue
                # Skip common nav-only lines.
                if any(tok in s for tok in _NAV_SUFFIXES) and len(s) <= 16:
                    continue
                # Avoid capturing the next chapter heading as a title.
                if _CHAPTER_HEADING_RE.match(s):
                    break
                title2 = _clean_title(s)
                if title2:
                    title = title2
                    break

        if not title:
            title = label
        # previews: prefer content after the detected header span
        head_src = full_text[min(end, int(c.end_char)) : end]
        tail_src = full_text[start:end]
        head = head_src.strip()
        tail = tail_src.strip()

        chapters.append(
            ChapterMeta(
                index=i + 1,
                label=label,
                title=title,
                start_char=start,
                end_char=end,
                chars=max(0, end - start),
                header=c.header,
                preview_head=(head[:preview_chars_i] if preview_chars_i > 0 else ""),
                preview_tail=(tail[-preview_chars_i:] if preview_chars_i > 0 else ""),
            )
        )

    if not chapters:
        raise ChapterIndexError("chapter_index_no_headings_found")

    result: dict[str, Any] = {
        "source_id": src.source_id,
        "meta": src.meta,
        "params": {
            "preview_chars": preview_chars_i,
            "max_chapters": max_chapters_i,
            "pattern": "cn_default_v2",
            "overwrite": bool(overwrite),
            "unit": best_unit,
        },
        "chapters": [c.to_dict() for c in chapters],
        "total_chapters": len(chapters),
        "truncated": truncated,
        "updated_at": _now_utc_iso(),
    }

    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result
