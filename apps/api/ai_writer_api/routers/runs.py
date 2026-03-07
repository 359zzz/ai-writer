from __future__ import annotations

import asyncio
import json
import re
from collections import Counter, defaultdict
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any, AsyncGenerator

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlmodel import select
from starlette.background import BackgroundTask

from ..db import ENGINE, get_session
from ..llm import (
    LLMConfig,
    LLMError,
    generate_text,
    parse_json_loose,
    resolve_llm_config,
)
from ..models import Chapter, KBChunk, Project, Run, TraceEvent
from ..tools.book_index import iter_text_chunks
from ..tools.chapter_index import ChapterIndexError, build_chapter_index
from ..tools.continue_sources import (
    ContinueSourceError,
    load_continue_source,
    load_continue_source_excerpt,
)
from ..util import deep_merge, json_dumps, strip_think_blocks


router = APIRouter(tags=["runs"])


class RunRequestPayload(dict[str, Any]):
    # Keep request schema flexible for now.
    pass


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _coerce_lang(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    if not v or v == "auto":
        return None
    if v in {
        "zh",
        "zh-cn",
        "zh_cn",
        "zh-hans",
        "zh_hans",
        "cn",
        "chinese",
        "中文",
        "简体",
        "简体中文",
    }:
        return "zh"
    if v in {"en", "en-us", "en_us", "english", "英文"}:
        return "en"
    if v.startswith("zh"):
        return "zh"
    if v.startswith("en"):
        return "en"
    return None


def _resolve_output_lang(payload: dict[str, Any], project: Project) -> str:
    """
    Decide which language to ask the LLM to write in.

    Priority:
    1) payload override (ui_lang/output_lang/output_language/lang)
    2) project settings (writing/story/ui fields if present)
    3) heuristic: if project title/settings contain CJK -> zh else en
    """

    for key in ("output_lang", "output_language", "ui_lang", "lang"):
        resolved = _coerce_lang(payload.get(key))
        if resolved:
            return resolved

    settings = project.settings or {}
    if isinstance(settings, dict):
        writing = (
            settings.get("writing") if isinstance(settings.get("writing"), dict) else {}
        )
        story = settings.get("story") if isinstance(settings.get("story"), dict) else {}
        ui = settings.get("ui") if isinstance(settings.get("ui"), dict) else {}

        for candidate in (
            (writing or {}).get("output_lang"),
            (writing or {}).get("language"),
            (story or {}).get("output_lang"),
            (story or {}).get("language"),
            (ui or {}).get("lang"),
        ):
            resolved = _coerce_lang(candidate)
            if resolved:
                return resolved

        # Heuristic fallback.
        blob = f"{project.title or ''}\n{json.dumps(settings, ensure_ascii=False)}"
        if _CJK_RE.search(blob):
            return "zh"

    return "en"


def _lang_hint_json(lang: str) -> str:
    if lang == "zh":
        return (
            "Output language: Simplified Chinese (zh-CN). "
            "所有自然语言字段请用简体中文。"
            "Keep JSON keys in English as in the schema."
        )
    return "Output language: English (en). Keep JSON keys in English as in the schema."


def _lang_hint_markdown(lang: str) -> str:
    if lang == "zh":
        return (
            "Output language: Simplified Chinese (zh-CN). "
            "全文用简体中文书写（包括标题/小节标题）。"
        )
    return "Output language: English (en)."


def _writer_title_example(lang: str, chapter_index: int) -> str:
    if lang == "zh":
        return f"# 第{chapter_index}章：标题"
    return "# Chapter X: Title"


def _default_chapter_title(lang: str, chapter_index: int) -> str:
    if lang == "zh":
        return f"第{chapter_index}章"
    return f"Chapter {chapter_index}"


def _clip_text(value: object, max_len: int) -> str:
    if not isinstance(value, str):
        return ""
    s = value.strip()
    if len(s) <= max(0, int(max_len)):
        return s
    return s[: max(0, int(max_len))].rstrip() + "…"


def _clip_str_list(value: object, *, max_items: int, max_item_len: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for x in value:
        if not isinstance(x, str):
            continue
        t = x.strip()
        if not t:
            continue
        out.append(_clip_text(t, max_item_len))
        if len(out) >= max(0, int(max_items)):
            break
    return out


def _dedupe_keep_order(items: list[str], *, max_items: int) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        t = item.strip()
        if not t:
            continue
        low = t.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(t)
        if len(out) >= max(0, int(max_items)):
            break
    return out


def _split_summary_text_items(
    value: object, *, max_items: int, max_item_len: int
) -> list[str]:
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                clipped = _clip_text(item, max_item_len)
                if clipped:
                    parts.append(clipped)
                continue
            if isinstance(item, dict):
                for key in (
                    "event",
                    "details",
                    "summary",
                    "text",
                    "title",
                    "name",
                    "quote",
                    "analysis",
                    "theme",
                    "symbol",
                    "meaning",
                ):
                    clipped = _clip_text(item.get(key), max_item_len)
                    if clipped:
                        parts.append(clipped)
                        break
        return _dedupe_keep_order(parts, max_items=max_items)
    if not isinstance(value, str):
        return []

    raw = value.strip()
    if not raw:
        return []

    parts: list[str] = []
    for chunk in re.split("(?:\\r?\\n+|[;\uFF1B]+)", raw):
        piece = str(chunk or "").strip()
        if not piece:
            continue
        piece = re.sub("^\\s*(?:[-*\u2022\u00B7\u25CF\u25AA\u25E6]|\\d{1,3}[\\.\u3001:\uFF1A\\)])\\s*", "", piece)
        subparts = re.split("(?<=[\u3002\uFF01\uFF1F.!?])\\s+", piece)
        for sub in subparts:
            s = str(sub or "").strip().strip("-\u2014\u2013\u2022\u00B7,\uFF0C;\uFF1B:\uFF1A ")
            if s:
                parts.append(_clip_text(s, max_item_len))
    return _dedupe_keep_order(parts, max_items=max_items)


_GENERIC_CHARACTER_NAMES = {
    "\u4eba\u7269",
    "\u89d2\u8272",
    "\u4e3b\u89d2",
    "\u914d\u89d2",
    "\u4f17\u4eba",
    "\u5927\u5bb6",
    "\u4ed6\u4eec",
    "\u5979\u4eec",
    "\u6709\u4eba",
    "\u67d0\u4eba",
    "\u5c11\u5973",
    "\u5c11\u5e74",
    "\u7537\u5b50",
    "\u5973\u5b50",
    "\u8363\u56fd\u5e9c",
    "\u5b81\u56fd\u5e9c",
    "\u8363\u5e9c",
    "\u5b81\u5e9c",
    "\u8d3e\u5e9c",
    "\u859b\u5bb6",
    "\u738b\u5bb6",
    "\u5218\u5bb6",
    "\u91d1\u9675",
    "\u626c\u5dde",
    "\u4eac\u57ce",
    "\u4eac\u90fd",
    "\u592a\u865a\u5e7b\u5883",
    "\u51b7\u9999\u4e38",
    "\u5bab\u82b1",
    "\u4e49\u5b66",
    "others",
    "other",
    "someone",
    "unknown",
}


def _normalize_character_name(value: object) -> str:
    if not isinstance(value, str):
        return ""

    name = value.strip().strip("\"'\u201c\u201d\u2018\u2019()\uFF08\uFF09[]\u3010\u3011<>\u300a\u300b")
    if not name:
        return ""

    name = re.sub(r"\s+", " ", name)
    name = re.sub(r"^(?:\u4eba\u7269|\u89d2\u8272|\u59d3\u540d|\u89d2\u8272\u540d)\s*[:\uFF1A-]\s*", "", name)
    name = re.split(r"[:\uFF1A]", name, maxsplit=1)[0].strip()
    name = re.split(r"[\u2014\u2013]", name, maxsplit=1)[0].strip()
    name = re.split(r"\s+-\s+", name, maxsplit=1)[0].strip()
    name = re.split(r"[\uFF08(]", name, maxsplit=1)[0].strip()
    name = name.strip("-\u2014\u2013,\uFF0C;\uFF1B/\\ ")
    if not name or len(name) <= 1 or len(name) > 24:
        return ""
    if name.lower() in _GENERIC_CHARACTER_NAMES or name in _GENERIC_CHARACTER_NAMES:
        return ""
    return name


def _coerce_character_names(value: object, *, max_items: int) -> list[str]:
    items: list[str] = []
    if isinstance(value, list):
        for raw in value:
            if isinstance(raw, dict):
                norm = ""
                for key in ("name", "character", "person", "id", "source", "target"):
                    norm = _normalize_character_name(raw.get(key))
                    if norm:
                        break
            else:
                norm = _normalize_character_name(raw)
            if norm:
                items.append(norm)
        return _dedupe_keep_order(items, max_items=max_items)
    if isinstance(value, dict):
        for key in ("name", "character", "person", "id"):
            norm = _normalize_character_name(value.get(key))
            if norm:
                return [norm]
        return []
    if not isinstance(value, str):
        return []

    raw_items = _split_summary_text_items(
        value, max_items=max_items * 4, max_item_len=80
    )
    for raw in raw_items:
        head = re.split(r"[:?]", raw, maxsplit=1)[0]
        for part in re.split(
            r"(?:[?,?/?&]|\s+and\s+|\s+with\s+|\s+?\s+|\s+?\s+|\s+?\s+)",
            head,
        ):
            norm = _normalize_character_name(part)
            if norm:
                items.append(norm)
    return _dedupe_keep_order(items, max_items=max_items)


_COMMON_CJK_SURNAMES = (
    "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华"
    "金魏陶姜谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方"
    "俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅"
    "皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧"
    "计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾甄冷焦"
)

_TITLE_VERB_CHARS = "初再会见入送戏演说抛怀梦游饮识指乱判逢试进出赴遇哭笑醉骂访投设读探拜请商仙夤"


def _looks_like_character_name(name: str) -> bool:
    if not name:
        return False
    if name.lower() in _GENERIC_CHARACTER_NAMES or name in _GENERIC_CHARACTER_NAMES:
        return False
    if name.endswith(("府", "城", "院", "楼", "案", "境", "歌", "丸", "花", "学", "事", "情", "梦", "回", "章", "卷")):
        return False
    if len(name) > 5 and not name.endswith("家的"):
        return False
    return True


def _infer_character_names_from_title(title: object, *, max_items: int) -> list[str]:
    if not isinstance(title, str):
        return []
    raw = title.strip()
    if not raw:
        return []
    items: list[str] = []

    def _pick_strong_name(fragment: str, *, reverse: bool) -> str:
        text = fragment.strip()
        if not text:
            return ""
        sizes = (2, 3, 4)
        for size in sizes:
            if len(text) < size:
                continue
            candidate = text[-size:] if reverse else text[:size]
            name = _normalize_character_name(candidate)
            if not (
                _looks_like_character_name(name)
                and name
                and _CJK_RE.search(name)
                and name[0] in _COMMON_CJK_SURNAMES
            ):
                continue
            if name[-1] in _TITLE_VERB_CHARS:
                continue
            if not reverse and len(text) > size:
                next_char = text[size]
                if next_char not in (" ", "\u3000", "\uFF0C", "\u3002", "\uFF1B", "\u3001") and next_char not in _TITLE_VERB_CHARS:
                    continue
            return name
        return ""

    for idx, ch in enumerate(raw):
        if ch not in _TITLE_VERB_CHARS:
            continue
        before = _pick_strong_name(raw[max(0, idx - 4) : idx], reverse=True)
        after = _pick_strong_name(raw[idx + 1 : idx + 5], reverse=False)
        if before:
            items.append(before)
        if after:
            items.append(after)
    return _dedupe_keep_order(items, max_items=max_items)


def _infer_character_names_from_text(
    text: object, *, known_names: list[str], max_items: int
) -> list[str]:
    if not isinstance(text, str):
        return []
    raw = text.strip()
    if not raw:
        return []
    vocab = _dedupe_keep_order(
        [name for name in known_names if _looks_like_character_name(name)],
        max_items=128,
    )
    items: list[str] = []
    for name in sorted(vocab, key=len, reverse=True):
        variants = [name]
        if _CJK_RE.search(name) and len(name) >= 3:
            variants.append(name[-2:])
        if name.endswith("家的") and len(name) > 2:
            variants.append(name[:-2])
        if any(variant and variant in raw for variant in variants):
            items.append(name)
    return _dedupe_keep_order(items, max_items=max_items)


def _normalize_book_summary_data(data: dict[str, Any]) -> dict[str, Any]:
    out = dict(data)

    summary = _clip_text(
        out.get("summary") or out.get("overall_summary") or out.get("text"),
        1200,
    )
    if summary:
        out["summary"] = summary

    character_candidates: list[str] = []
    for raw in (
        out.get("characters"),
        out.get("main_characters"),
        out.get("characters_involved"),
    ):
        character_candidates.extend(
            _coerce_character_names(raw, max_items=32)
        )
    characters = _dedupe_keep_order(character_candidates, max_items=16)
    if characters:
        out["characters"] = characters

    event_candidates: list[str] = []
    for raw in (out.get("key_events"), out.get("events"), out.get("timeline")):
        event_candidates.extend(
            _split_summary_text_items(raw, max_items=12, max_item_len=220)
        )
    key_events = _dedupe_keep_order(event_candidates, max_items=10)
    if key_events:
        out["key_events"] = key_events

    locations = _split_summary_text_items(
        out.get("locations"), max_items=10, max_item_len=120
    )
    if locations:
        out["locations"] = locations

    timeline = _split_summary_text_items(
        out.get("timeline"), max_items=10, max_item_len=160
    )
    if timeline:
        out["timeline"] = timeline

    open_loops = _split_summary_text_items(
        out.get("open_loops"), max_items=10, max_item_len=220
    )
    if open_loops:
        out["open_loops"] = open_loops

    theme_candidates: list[str] = []
    for raw in (out.get("themes"), out.get("motifs")):
        theme_candidates.extend(
            _split_summary_text_items(raw, max_items=10, max_item_len=160)
        )
    themes = _dedupe_keep_order(theme_candidates, max_items=8)
    if themes:
        out["themes_list"] = themes

    return out


def _coerce_int_list(value: object, *, max_items: int) -> list[int]:
    if not isinstance(value, list):
        return []

    out: list[int] = []
    for item in value:
        try:
            n = int(item)
        except Exception:
            continue
        if n <= 0:
            continue
        out.append(int(n))
        if len(out) >= max(0, int(max_items)):
            break
    return out


def _normalize_characters_graph(obj: Any) -> tuple[dict[str, Any] | None, int, int]:
    if not isinstance(obj, dict):
        return None, 0, 0

    graph = obj.get("graph") if isinstance(obj.get("graph"), dict) else obj
    if not isinstance(graph, dict):
        return None, 0, 0

    raw_chars = graph.get("characters")
    raw_rels = graph.get("relations")
    provisional: dict[str, dict[str, Any]] = {}
    alias_to_id: dict[str, str] = {}

    def register_alias(raw: str, cid: str) -> None:
        t = raw.strip()
        if not t:
            return
        alias_to_id.setdefault(t.lower(), cid)

    if isinstance(raw_chars, list):
        for item in raw_chars:
            if not isinstance(item, dict):
                continue
            name = _normalize_character_name(item.get("name"))
            raw_id = _normalize_character_name(item.get("id"))
            cid = raw_id or name
            if not cid or not name:
                continue

            aliases = _coerce_character_names(item.get("aliases"), max_items=8)
            chapters = _coerce_int_list(item.get("chapters"), max_items=24)
            card: dict[str, Any] = {
                "id": cid,
                "name": name,
            }
            if aliases:
                card["aliases"] = aliases
            for key, max_len in (
                ("gender", 40),
                ("identity", 120),
                ("personality", 220),
                ("plot", 260),
            ):
                v = _clip_text(item.get(key), max_len)
                if v:
                    card[key] = v
            if chapters:
                card["chapters"] = chapters

            related_events = _split_summary_text_items(
                item.get("related_events"), max_items=8, max_item_len=180
            )
            if related_events:
                card["related_events"] = related_events

            provisional[cid] = card
            register_alias(cid, cid)
            register_alias(name, cid)
            for alias in aliases:
                register_alias(alias, cid)

    rels_out: list[dict[str, Any]] = []
    if isinstance(raw_rels, list):
        for item in raw_rels:
            if not isinstance(item, dict):
                continue
            src_raw = _normalize_character_name(
                item.get("source") if item.get("source") is not None else item.get("from")
            )
            dst_raw = _normalize_character_name(
                item.get("target") if item.get("target") is not None else item.get("to")
            )
            if not src_raw or not dst_raw or src_raw == dst_raw:
                continue

            src = alias_to_id.get(src_raw.lower(), src_raw)
            dst = alias_to_id.get(dst_raw.lower(), dst_raw)
            if src not in provisional:
                provisional[src] = {"id": src, "name": src}
                register_alias(src, src)
            if dst not in provisional:
                provisional[dst] = {"id": dst, "name": dst}
                register_alias(dst, dst)

            rel_type = _clip_text(item.get("type") or "other", 40) or "other"
            label = _clip_text(item.get("label"), 80)
            detail = _clip_text(item.get("detail"), 220)
            chapters = _coerce_int_list(item.get("chapters"), max_items=24)
            try:
                strength = float(item.get("strength"))
            except Exception:
                strength = 0.6

            rel: dict[str, Any] = {
                "source": src,
                "target": dst,
                "type": rel_type,
                "strength": max(0.0, min(1.0, strength)),
            }
            if label:
                rel["label"] = label
            if detail:
                rel["detail"] = detail
            if chapters:
                rel["chapters"] = chapters
            rels_out.append(rel)

    characters = sorted(
        provisional.values(),
        key=lambda c: (
            -len(c.get("chapters") or []),
            str(c.get("name") or c.get("id") or ""),
        ),
    )
    rels_dedup: list[dict[str, Any]] = []
    seen_rels: set[tuple[str, str, str]] = set()
    for rel in rels_out:
        key = (
            str(rel.get("source") or ""),
            str(rel.get("target") or ""),
            str(rel.get("type") or "other"),
        )
        if key in seen_rels:
            continue
        seen_rels.add(key)
        rels_dedup.append(rel)

    return {
        "characters": characters,
        "relations": rels_dedup,
    }, len(characters), len(rels_dedup)


def _same_character_surname(left: str, right: str) -> bool:
    if not left or not right:
        return False
    if _CJK_RE.search(left) and _CJK_RE.search(right):
        return len(left) >= 2 and len(right) >= 2 and left[0] == right[0]
    return left.split(" ", 1)[0].lower() == right.split(" ", 1)[0].lower()


def _heuristic_characters_graph_from_summaries(
    parts: list[dict[str, Any]], *, lang: str
) -> dict[str, Any]:
    chapter_map: dict[str, set[int]] = defaultdict(set)
    event_map: dict[str, list[str]] = defaultdict(list)
    pair_counter: Counter[tuple[str, str]] = Counter()
    pair_chapters: dict[tuple[str, str], set[int]] = defaultdict(set)

    for part in parts:
        idx = int(part.get("index") or 0)
        if idx <= 0:
            continue
        names = _dedupe_keep_order(
            _coerce_character_names(part.get("characters"), max_items=16), max_items=16
        )
        if not names:
            continue
        for name in names:
            chapter_map[name].add(idx)
            for ev in _split_summary_text_items(
                part.get("key_events"), max_items=4, max_item_len=180
            ):
                if ev not in event_map[name]:
                    event_map[name].append(ev)
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                pair = tuple(sorted((names[i], names[j])))
                pair_counter[pair] += 1
                pair_chapters[pair].add(idx)

    ordered_names = sorted(
        chapter_map,
        key=lambda name: (-len(chapter_map[name]), name),
    )[:40]
    characters: list[dict[str, Any]] = []
    for name in ordered_names:
        chapters = sorted(chapter_map[name])
        card: dict[str, Any] = {
            "id": name,
            "name": name,
            "chapters": chapters[:24],
        }
        related_events = event_map.get(name, [])[:4]
        if related_events:
            card["related_events"] = related_events
            joiner = "\uFF1B" if lang == "zh" else "; "
            card["plot"] = _clip_text(joiner.join(related_events), 220)
        if len(chapters) >= 4:
            card["identity"] = "\u5e38\u9a7b\u89d2\u8272" if lang == "zh" else "Recurring character"
        characters.append(card)

    valid_names = {str(c["id"]) for c in characters}
    relations: list[dict[str, Any]] = []
    for (left, right), count in pair_counter.most_common(120):
        if left not in valid_names or right not in valid_names:
            continue
        chapters = sorted(pair_chapters[(left, right)])
        rel_type = "family" if _same_character_surname(left, right) else (
            "ally" if count >= 2 else "friend"
        )
        detail = (
            f"\u5171\u540c\u51fa\u73b0\u5728\u7ae0\u8282 {', '.join(str(n) for n in chapters[:6])}"
            if lang == "zh"
            else f"Co-appear in chapters {', '.join(str(n) for n in chapters[:6])}"
        )
        relations.append(
            {
                "source": left,
                "target": right,
                "type": rel_type,
                "label": "\u5171\u73b0" if lang == "zh" else "Co-appearance",
                "detail": detail,
                "chapters": chapters[:24],
                "strength": max(0.45, min(0.9, 0.45 + 0.08 * count)),
            }
        )
        if len(relations) >= 80:
            break

    if not relations and len(characters) >= 2:
        first = str(characters[0]["id"])
        second = str(characters[1]["id"])
        shared = sorted(
            set(characters[0].get("chapters") or []).intersection(
                characters[1].get("chapters") or []
            )
        )
        relations.append(
            {
                "source": first,
                "target": second,
                "type": "other",
                "label": "\u5171\u4eab\u5f27\u5149" if lang == "zh" else "Shared arc",
                "chapters": shared[:24],
                "strength": 0.5,
            }
        )

    return {
        "characters": characters,
        "relations": relations,
    }


def _compact_compiled_book_state(state: dict[str, Any]) -> dict[str, Any]:
    """
    PackyAPI/proxy gateways can be sensitive to large prompts. Keep the compiled
    book state compact and stable so downstream Writer/Planner prompts stay
    within reasonable request sizes.

    This is a best-effort structural clamp (no extra LLM calls).
    """

    style_profile: dict[str, Any] = {}
    raw_style = state.get("style_profile")
    if isinstance(raw_style, dict):
        for k in ("pov", "tense", "tone", "genre", "voice", "pace"):
            if k in raw_style:
                v = raw_style.get(k)
                if isinstance(v, str) and v.strip():
                    style_profile[k] = _clip_text(v, 120)

    character_cards: list[dict[str, Any]] = []
    raw_cards = state.get("character_cards")
    if isinstance(raw_cards, list):
        for c in raw_cards:
            if not isinstance(c, dict):
                continue
            name = _clip_text(c.get("name"), 40)
            if not name:
                continue
            character_cards.append(
                {
                    "name": name,
                    "role": _clip_text(c.get("role"), 100),
                    "traits": _clip_text(c.get("traits"), 220),
                    "relationships": _clip_text(c.get("relationships"), 220),
                    "current_status": _clip_text(c.get("current_status"), 220),
                    "arc": _clip_text(c.get("arc"), 220),
                }
            )
            if len(character_cards) >= 16:
                break

    timeline: list[dict[str, Any]] = []
    raw_tl = state.get("timeline")
    if isinstance(raw_tl, list):
        for it in raw_tl:
            if not isinstance(it, dict):
                continue
            when = _clip_text(it.get("when"), 80)
            event = _clip_text(it.get("event"), 180)
            if not (when or event):
                continue
            timeline.append({"when": when, "event": event})
            if len(timeline) >= 24:
                break

    continuation_seed: dict[str, Any] = {}
    raw_seed = state.get("continuation_seed")
    if isinstance(raw_seed, dict):
        where = _clip_text(raw_seed.get("where_to_resume"), 220)
        scene = _clip_text(raw_seed.get("next_scene"), 280)
        constraints = _clip_str_list(
            raw_seed.get("constraints"), max_items=12, max_item_len=200
        )
        if where:
            continuation_seed["where_to_resume"] = where
        if scene:
            continuation_seed["next_scene"] = scene
        if constraints:
            continuation_seed["constraints"] = constraints

    return {
        "book_summary": _clip_text(state.get("book_summary"), 1800),
        "style_profile": style_profile,
        "world": _clip_text(state.get("world"), 900),
        "character_cards": character_cards,
        "timeline": timeline,
        "open_loops": _clip_str_list(
            state.get("open_loops"), max_items=20, max_item_len=200
        ),
        "continuation_seed": continuation_seed,
    }


@router.get("/api/projects/{project_id}/runs")
def list_runs(project_id: str) -> list[Run]:
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="Project not found")
        return list(
            session.exec(
                select(Run)
                .where(Run.project_id == project_id)
                .order_by(text("created_at DESC"))
            )
        )


@router.get("/api/runs/{run_id}/events")
def list_run_events(
    run_id: str,
    after_seq: int = Query(default=0, ge=0),
    limit: int = Query(default=5000, ge=1, le=50000),
) -> list[TraceEvent]:
    with get_session() as session:
        q = select(TraceEvent).where(TraceEvent.run_id == run_id)
        if after_seq > 0:
            q = q.where(TraceEvent.seq > after_seq)
        q = q.order_by(text("seq ASC")).limit(limit)
        return list(session.exec(q))


@router.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    with get_session() as session:
        run = session.get(Run, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")
        last = session.exec(
            select(TraceEvent)
            .where(TraceEvent.run_id == run_id)
            .order_by(text("seq DESC"))
            .limit(1)
        ).first()
        last_seq = int(last.seq) if last else 0
        return {
            "id": run.id,
            "project_id": run.project_id,
            "kind": run.kind,
            "status": run.status,
            "created_at": run.created_at,
            "finished_at": run.finished_at,
            "error": run.error,
            "last_seq": last_seq,
        }


@router.post("/api/projects/{project_id}/runs/stream")
async def stream_run(project_id: str, payload: dict[str, Any]) -> StreamingResponse:
    """
    MVP streaming endpoint.

    Supported kinds:
    - demo: placeholder pipeline
    - outline: generate outline (LLM)
    - chapter: write a chapter (LLM)
    - continue: extract story state + continue (LLM; minimal)
    - book_summarize: chunk a stored book source and summarize chunks into local KB (LLM)
    - book_compile: compile stored book summaries into a compact book state (LLM)
    - book_relations: derive chapter-to-chapter relations graph from stored summaries (LLM)
    - book_characters: derive character cards + relationship graph from stored summaries (LLM)
    - book_continue: continue writing a new chapter based on compiled book state (LLM)
    """
    with get_session() as session:
        project = session.get(Project, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        kind = str(payload.get("kind") or "demo")
        run = Run(project_id=project_id, kind=kind, status="running")
        session.add(run)
        session.commit()
        session.refresh(run)

    async def gen() -> AsyncGenerator[bytes, None]:
        seq = 0

        def emit(event_type: str, agent: str | None, data: dict[str, Any]) -> bytes:
            nonlocal seq
            seq += 1
            evt = {
                "run_id": run.id,
                "seq": seq,
                "ts": _now_utc().isoformat(),
                "type": event_type,
                "agent": agent,
                "data": data,
            }

            # Persist trace.
            with get_session() as s2:
                s2.add(
                    TraceEvent(
                        run_id=run.id,
                        seq=seq,
                        ts=_now_utc(),
                        event_type=event_type,
                        agent=agent,
                        payload=data,
                    )
                )
                s2.commit()

            return f"data: {json.dumps(evt, ensure_ascii=False)}\n\n".encode("utf-8")

        output_lang = _resolve_output_lang(payload, project)
        lang_hint_json = _lang_hint_json(output_lang)
        lang_hint_md = _lang_hint_markdown(output_lang)

        # Snapshot LLM config at run start to avoid mixing settings changes mid-run.
        run_llm_cfg = resolve_llm_config(project.settings or {})
        yield emit(
            "run_started",
            "Director",
            {
                "kind": kind,
                "project_id": project_id,
                "output_lang": output_lang,
                "llm": {
                    "provider": run_llm_cfg.provider,
                    "model": run_llm_cfg.model,
                    "base_url": run_llm_cfg.base_url,
                    "wire_api": run_llm_cfg.wire_api
                    if run_llm_cfg.provider == "openai"
                    else None,
                },
            },
        )

        def kb_search(query: str, limit: int = 5) -> list[dict[str, Any]]:
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
            q = query.replace('"', " ").strip()
            if not q:
                return []
            with ENGINE.connect() as conn:
                rows = (
                    conn.execute(
                        sql, {"project_id": project_id, "query": q, "limit": limit}
                    )
                    .mappings()
                    .all()
                )
            return [dict(r) for r in rows]

        def llm_cfg():
            return run_llm_cfg

        def _is_retryable_gateway_error(msg: str) -> bool:
            m = (msg or "").strip()
            if not m:
                return False
            if m.startswith("openai_network_error") or m.startswith("openai_timeout"):
                return True
            if m.startswith("gemini_network_error") or m.startswith("gemini_timeout"):
                return True
            if re.match(r"^(openai|gemini)_http_(408|409|425|429|500|502|503|504)", m):
                return True
            if m.startswith("empty_completion"):
                return True
            return False

        def _json_compact(obj: Any) -> str:
            return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))

        def _normalize_relations_graph(obj: Any) -> tuple[dict[str, Any] | None, int]:
            if not isinstance(obj, dict):
                return None, 0
            raw_edges = obj.get("edges")
            if not isinstance(raw_edges, list):
                return None, 0
            out_edges: list[dict[str, Any]] = []
            for e in raw_edges:
                if not isinstance(e, dict):
                    continue
                src_raw = e.get("from")
                dst_raw = e.get("to")
                try:
                    src = int(src_raw)
                    dst = int(dst_raw)
                except Exception:
                    continue
                if src <= 0 or dst <= 0 or src == dst:
                    continue
                typ = str(e.get("type") or "relation").strip() or "relation"
                label = str(e.get("label") or "").strip()
                s_raw = e.get("strength")
                try:
                    strength = float(s_raw)
                except Exception:
                    strength = 0.6
                strength = max(0.0, min(1.0, strength))
                out_edges.append(
                    {
                        "from": src,
                        "to": dst,
                        "type": typ,
                        "label": label,
                        "strength": strength,
                    }
                )
            return {"edges": out_edges}, len(out_edges)

        async def _repair_book_relations_json(
            *,
            source_text: str,
            base_cfg: Any,
            max_tokens: int,
        ) -> tuple[dict[str, Any] | None, str | None]:
            repair_cfg = replace(
                base_cfg, temperature=0.1, max_tokens=min(int(max_tokens), 900)
            )
            if (
                repair_cfg.provider == "gemini"
                and "packyapi.com" in (repair_cfg.base_url or "").lower()
            ):
                repair_cfg = resolve_llm_config(
                    {
                        "llm": {
                            "provider": "openai",
                            "temperature": 0.1,
                            "max_tokens": min(int(max_tokens), 900),
                        }
                    }
                )

            repair_system = (
                "You are BookRelationsJSONRepairAgent. Convert the input into strict JSON only. "
                'Do NOT add explanations. Output schema: {"edges":[{"from":int,"to":int,"type":string,"label":string,"strength":0..1}]}. '
                'If uncertain, return {"edges":[]} only.'
            )
            repair_user = f"RawModelOutput:\n{source_text[:12000]}"
            repaired_text = await _generate_text_with_timeout(
                system_prompt=repair_system,
                user_prompt=repair_user,
                cfg=repair_cfg,
                timeout_s=90.0,
                label="book_relations_repair",
                attempt=1,
            )
            repaired_clean = strip_think_blocks(repaired_text).strip()
            repaired_parsed = parse_json_loose(repaired_clean)
            normalized, n_edges = _normalize_relations_graph(repaired_parsed)
            if normalized is not None and n_edges > 0:
                return normalized, None
            return normalized, "repair_empty_or_invalid_edges"

        async def _repair_book_characters_json(
            *,
            source_text: str,
            base_cfg: Any,
            max_tokens: int,
        ) -> tuple[dict[str, Any] | None, str | None]:
            repair_cfg = replace(
                base_cfg, temperature=0.1, max_tokens=min(int(max_tokens), 1100)
            )
            if (
                repair_cfg.provider == "gemini"
                and "packyapi.com" in (repair_cfg.base_url or "").lower()
            ):
                repair_cfg = resolve_llm_config(
                    {
                        "llm": {
                            "provider": "openai",
                            "temperature": 0.1,
                            "max_tokens": min(int(max_tokens), 1100),
                        }
                    }
                )

            repair_system = (
                "You are BookCharactersJSONRepairAgent. Convert the input into strict JSON only. "
                'Do NOT add explanations. Output schema: {"characters":[{"id":string,"name":string,"aliases":[string],"gender":string,"identity":string,"personality":string,"plot":string,"chapters":[int],"related_events":[string]}],"relations":[{"source":string,"target":string,"type":string,"label":string,"detail":string,"chapters":[int],"strength":0..1}]}. '
                "Allowed relation types: family, love, friend, enemy, master_servant, mentor, rival, ally, colleague, other. "
                'If uncertain, return {"characters":[],"relations":[]} only.'
            )
            repair_user = f"RawModelOutput:\n{source_text[:12000]}"
            repaired_text = await _generate_text_with_timeout(
                system_prompt=repair_system,
                user_prompt=repair_user,
                cfg=repair_cfg,
                timeout_s=90.0,
                label="book_characters_repair",
                attempt=1,
            )
            repaired_clean = strip_think_blocks(repaired_text).strip()
            repaired_parsed = parse_json_loose(repaired_clean)
            normalized, n_chars, n_rels = _normalize_characters_graph(repaired_parsed)
            if normalized is not None and (n_chars > 0 or n_rels > 0):
                return normalized, None
            return normalized, "repair_empty_or_invalid_graph"

        def _is_model_unavailable_error(msg: str) -> bool:
            m = (msg or "").strip().lower()
            if not m:
                return False
            if "无可用渠道" in m:
                return True
            if "no distributor" in m or "distributor" in m:
                return True
            if "model_not_found" in m or "模型不存在" in m:
                return True
            return False

        async def _generate_text_with_timeout(
            *,
            system_prompt: str,
            user_prompt: str,
            cfg: Any,
            timeout_s: float,
            label: str,
            attempt: int,
        ) -> str:
            try:
                return await asyncio.wait_for(
                    generate_text(
                        system_prompt=system_prompt, user_prompt=user_prompt, cfg=cfg
                    ),
                    timeout=timeout_s,
                )
            except asyncio.TimeoutError:
                provider = str(getattr(cfg, "provider", "llm") or "llm")
                raise LLMError(
                    f"{provider}_timeout:attempt={int(attempt)},timeout_s={int(timeout_s)},label={label}"
                )

        def _choose_packy_gemini_rescue_model(current: str, err: str) -> str:
            candidates = [
                "gemini-3-pro-preview",
                "gemini-3-flash-preview",
                "gemini-2.5-flash",
                "gemini-2.5-pro",
                "gemini-2.0-flash",
                "gemini-1.5-flash",
            ]
            cur_low = str(current or "").strip().lower()
            blocked: set[str] = set()
            err_s = str(err or "")
            for m in re.findall(r"模型\s+([a-zA-Z0-9._-]+)\s+无可用渠道", err_s):
                blocked.add(str(m).strip().lower())
            for m in re.findall(
                r"model\s+([a-zA-Z0-9._-]+)\s+(?:no distributor|unavailable)",
                err_s,
                flags=re.I,
            ):
                blocked.add(str(m).strip().lower())
            for model in candidates:
                low = model.lower()
                if low == cur_low:
                    continue
                if low in blocked:
                    continue
                return model
            return current

        def _structured_cfg(
            base_cfg: LLMConfig, *, min_max_tokens: int, temperature: float = 0.2
        ) -> LLMConfig:
            try:
                target_max_tokens = max(int(base_cfg.max_tokens), int(min_max_tokens))
            except Exception:
                target_max_tokens = int(min_max_tokens)
            try:
                target_temperature = min(float(base_cfg.temperature), float(temperature))
            except Exception:
                target_temperature = float(temperature)
            return replace(
                base_cfg,
                temperature=max(0.0, target_temperature),
                max_tokens=target_max_tokens,
            )

        def _clean_json_text(text: str) -> str:
            return strip_think_blocks(text or "").strip()

        def _openai_structured_fallback_cfg(
            *, min_max_tokens: int, temperature: float = 0.2
        ) -> LLMConfig | None:
            fallback_settings = deep_merge(
                project.settings or {},
                {
                    "llm": {
                        "provider": "openai",
                        "temperature": temperature,
                        "max_tokens": min_max_tokens,
                    }
                },
            )
            fallback_cfg = resolve_llm_config(fallback_settings)
            if not fallback_cfg.api_key:
                return None
            if (
                fallback_cfg.provider == "openai"
                and "packyapi.com" in (fallback_cfg.base_url or "").lower()
            ):
                fallback_cfg = replace(
                    fallback_cfg,
                    model="gpt-5.1-codex",
                    wire_api="chat",
                )
            return _structured_cfg(
                fallback_cfg,
                min_max_tokens=min_max_tokens,
                temperature=temperature,
            )

        def _openai_writer_fallback_cfg(
            *, min_max_tokens: int, temperature: float = 0.6
        ) -> LLMConfig | None:
            fallback_settings = deep_merge(
                project.settings or {},
                {
                    "llm": {
                        "provider": "openai",
                        "temperature": temperature,
                        "max_tokens": min_max_tokens,
                    }
                },
            )
            fallback_cfg = resolve_llm_config(fallback_settings)
            if not fallback_cfg.api_key:
                return None
            if (
                fallback_cfg.provider == "openai"
                and "packyapi.com" in (fallback_cfg.base_url or "").lower()
            ):
                fallback_cfg = replace(fallback_cfg, wire_api="chat")
            return _structured_cfg(
                fallback_cfg,
                min_max_tokens=min_max_tokens,
                temperature=temperature,
            )

        def _structured_agent_cfg(
            base_cfg: LLMConfig, *, min_max_tokens: int, temperature: float = 0.2
        ) -> tuple[LLMConfig, str | None]:
            structured_cfg = _structured_cfg(
                base_cfg,
                min_max_tokens=min_max_tokens,
                temperature=temperature,
            )
            if "packyapi.com" in (base_cfg.base_url or "").lower():
                if base_cfg.provider == "gemini":
                    openai_cfg = _openai_structured_fallback_cfg(
                        min_max_tokens=min_max_tokens,
                        temperature=temperature,
                    )
                    if openai_cfg is not None:
                        return openai_cfg, "prefer_openai_structured_for_gemini_packy"
                if base_cfg.provider == "openai" and str(base_cfg.model or "").lower().startswith("gpt-5.4"):
                    openai_cfg = _openai_structured_fallback_cfg(
                        min_max_tokens=min_max_tokens,
                        temperature=temperature,
                    )
                    if openai_cfg is not None:
                        return openai_cfg, "prefer_packy_openai_structured_fallback"
            return structured_cfg, None

        def _should_openai_fallback_structured_generate(
            base_cfg: LLMConfig, err: str
        ) -> bool:
            return (
                base_cfg.provider == "gemini"
                and "packyapi.com" in (base_cfg.base_url or "").lower()
                and (
                    _is_retryable_gateway_error(err)
                    or _is_model_unavailable_error(err)
                )
            )

        async def _parse_or_repair_json(
            *,
            label: str,
            raw_text: str,
            schema_hint: str,
            base_cfg: LLMConfig,
            min_max_tokens: int,
        ) -> tuple[Any, bool, str | None]:
            cleaned = _clean_json_text(raw_text)
            try:
                return parse_json_loose(cleaned), False, None
            except Exception:
                pass

            repair_cfg = _structured_cfg(
                base_cfg, min_max_tokens=min_max_tokens, temperature=0.1
            )
            if (
                base_cfg.provider == "gemini"
                and "packyapi.com" in (base_cfg.base_url or "").lower()
            ):
                openai_cfg = _openai_structured_fallback_cfg(
                    min_max_tokens=min_max_tokens, temperature=0.1
                )
                if openai_cfg is not None:
                    repair_cfg = openai_cfg
            repair_model = str(repair_cfg.model or "")
            repair_system = (
                f"You are {label}JSONRepairAgent. Convert the input into strict JSON only. "
                "Do not add explanations, markdown fences, or commentary. "
                f"Return JSON matching this schema shape:\n{schema_hint}"
            )
            repair_user = f"RawModelOutput:\n{cleaned[:12000]}"

            try:
                repaired_text = await _generate_text_with_timeout(
                    system_prompt=repair_system,
                    user_prompt=repair_user,
                    cfg=repair_cfg,
                    timeout_s=90.0,
                    label=f"{label}_json_repair",
                    attempt=1,
                )
            except LLMError as e:
                if (
                    repair_cfg.provider == "gemini"
                    and "packyapi.com" in (repair_cfg.base_url or "").lower()
                    and _is_model_unavailable_error(str(e))
                ):
                    repair_cfg = replace(
                        repair_cfg,
                        model=_choose_packy_gemini_rescue_model(
                            str(repair_cfg.model or ""), str(e)
                        ),
                    )
                    repair_model = str(repair_cfg.model or "")
                    repaired_text = await _generate_text_with_timeout(
                        system_prompt=repair_system,
                        user_prompt=repair_user,
                        cfg=repair_cfg,
                        timeout_s=90.0,
                        label=f"{label}_json_repair",
                        attempt=2,
                    )
                else:
                    raise

            repaired_clean = _clean_json_text(repaired_text)
            return parse_json_loose(repaired_clean), True, repair_model

        def _is_suspicious_editor_output(original: str, candidate: str) -> bool:
            w = original.strip()
            e = candidate.strip()
            if not e:
                return True
            if not re.search(r"(?m)^#\s+\S", candidate):
                return True
            if len(w) >= 400 and len(e) < int(len(w) * 0.65):
                return True
            if output_lang == "zh" and _CJK_RE.search(w) and not _CJK_RE.search(e):
                return True
            return False

        def mark_run_failed(msg: str) -> None:
            with get_session() as s3:
                r3 = s3.get(Run, run.id)
                if r3:
                    r3.status = "failed"
                    r3.finished_at = _now_utc()
                    r3.error = msg[:500]
                    s3.add(r3)
                    s3.commit()

        def mark_run_completed() -> None:
            with get_session() as s3:
                r3 = s3.get(Run, run.id)
                if r3:
                    r3.status = "completed"
                    r3.finished_at = _now_utc()
                    s3.add(r3)
                    s3.commit()

        if kind == "demo":
            # Demo agents (placeholders).
            for agent_name, content in [
                ("ConfigAutofill", "Filled missing settings (demo)."),
                ("Outliner", "Generated outline (demo)."),
                ("Writer", "Wrote chapter markdown (demo)."),
                ("LoreKeeper", "Checked consistency (demo)."),
                ("Editor", "Polished text (demo)."),
            ]:
                yield emit("agent_started", agent_name, {})
                await asyncio.sleep(0.15)
                yield emit("agent_output", agent_name, {"text": content})
                yield emit("agent_finished", agent_name, {})

            yield emit(
                "artifact",
                "Writer",
                {
                    "artifact_type": "chapter_markdown",
                    "markdown": "# Chapter 1 (Demo)\n\nThis is a placeholder chapter.\n",
                },
            )
            mark_run_completed()
            yield emit("run_completed", "Director", {})
            return

        # ---- LLM-backed runs ----
        if kind == "book_summarize":
            source_id = str(
                payload.get("source_id") or payload.get("book_source_id") or ""
            ).strip()
            if not source_id:
                msg = "source_id_required"
                yield emit("run_error", "BookSummarizer", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            try:
                src = load_continue_source(source_id)
            except ContinueSourceError as e:
                msg = f"continue_source_load_failed:{str(e)}"
                yield emit("run_error", "BookSummarizer", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            def clamp_int(v: object, default: int, lo: int, hi: int) -> int:
                try:
                    n = int(v)  # type: ignore[arg-type]
                except Exception:
                    n = int(default)
                return max(int(lo), min(int(hi), int(n)))

            segment_mode_raw = (
                payload.get("segment_mode")
                or payload.get("segment")
                or ("chapter" if payload.get("use_chapter_index") else None)
                or "chunk"
            )
            segment_mode_in = str(segment_mode_raw or "chunk").strip().lower()
            segment_mode = "chunk"
            if segment_mode_in in {"chapter", "chapters"}:
                segment_mode = "chapter"
            elif segment_mode_in in {"auto"}:
                segment_mode = "auto"

            # Chapter index params (used when segment_mode=chapter/auto).
            max_chapters = clamp_int(payload.get("max_chapters"), 2000, 1, 20_000)
            segment_max_chars = clamp_int(
                payload.get("segment_max_chars") or payload.get("chapter_max_chars"),
                8000,
                1200,
                50_000,
            )
            chapter_index_obj: dict[str, Any] | None = None
            if segment_mode in {"chapter", "auto"}:
                try:
                    chapter_index_obj = build_chapter_index(
                        source_id=source_id,
                        preview_chars=160,
                        max_chapters=max_chapters,
                        overwrite=False,
                    )
                    segment_mode = "chapter"
                except ChapterIndexError as e:
                    chapter_index_obj = None
                    if segment_mode == "chapter":
                        yield emit(
                            "agent_output",
                            "BookSummarizer",
                            {
                                "error": f"chapter_index_failed:{str(e)}",
                                "soft_fail": True,
                            },
                        )
                    segment_mode = "chunk"

            chunk_chars = clamp_int(payload.get("chunk_chars"), 6000, 500, 30_000)
            overlap_chars = clamp_int(payload.get("overlap_chars"), 400, 0, 10_000)
            max_chunks = clamp_int(payload.get("max_chunks"), 200, 1, 2000)
            summary_max_chars = clamp_int(payload.get("summary_chars"), 500, 120, 2000)
            replace_existing = bool(payload.get("replace_existing", True))
            max_consecutive_failures = clamp_int(
                payload.get("max_consecutive_failures"), 4, 2, 20
            )
            requested_segment_indices = _coerce_int_list(
                payload.get("segment_indices")
                if payload.get("segment_indices") is not None
                else (
                    payload.get("chapter_indices")
                    if payload.get("chapter_indices") is not None
                    else payload.get("chunk_indices")
                ),
                max_items=20_000,
            )
            requested_segment_index_set = set(requested_segment_indices)

            # Keep max_tokens small; this is a batch process and should be cost-safe.
            summary_max_tokens = clamp_int(
                payload.get("summary_max_tokens"),
                min(600, int(llm_cfg().max_tokens or 800)),
                128,
                1200,
            )

            filename = str((src.meta or {}).get("filename") or "").strip() or "book"
            filename_tag = filename.replace(",", " ").strip()[:64]

            def book_title(
                lang: str, idx: int, *, chapter_label: str | None = None
            ) -> str:
                if segment_mode == "chapter":
                    hint = (chapter_label or "").replace(",", " ").strip()
                    if len(hint) > 24:
                        hint = hint[:24].rstrip() + "…"
                    if lang == "zh":
                        return f"书籍章节总结 #{idx:03d}（{hint or filename[:24]}）"
                    return f"Book chapter summary #{idx:03d} ({hint or filename[:24]})"
                if lang == "zh":
                    return f"书籍分片总结 #{idx:03d}（{filename[:40]}）"
                return f"Book chunk summary #{idx:03d} ({filename[:40]})"

            def book_tags(idx: int) -> str:
                parts = [f"book_source:{source_id}"]
                if segment_mode == "chapter":
                    parts.extend(["book_part:chapter", f"book_chapter:{idx}"])
                else:
                    parts.extend(["book_part:chunk", f"book_chunk:{idx}"])
                if filename_tag:
                    parts.append(f"book_file:{filename_tag}")
                return ",".join(parts)

            # NOTE: when replace_existing=True, avoid deleting everything upfront.
            # Gateway flakiness could otherwise wipe existing summaries and then fail.
            # We delete per-part (chapter/chunk index) right before inserting the
            # replacement chunk, which is safer for partial failures.

            yield emit(
                "agent_started",
                "BookSummarizer",
                {
                    "source_id": source_id,
                    "segment_mode": segment_mode,
                    "chunk_chars": chunk_chars,
                    "overlap_chars": overlap_chars,
                    "max_chunks": max_chunks,
                    "max_chapters": max_chapters if segment_mode == "chapter" else None,
                    "segment_max_chars": segment_max_chars
                    if segment_mode == "chapter"
                    else None,
                    "summary_chars": summary_max_chars,
                    "replace_existing": replace_existing,
                    "max_consecutive_failures": max_consecutive_failures,
                    "filename": filename,
                },
            )
            yield emit(
                "agent_output",
                "BookSummarizer",
                {"step": "prepare_index", "step_index": 1, "step_total": 3},
            )

            created = 0
            failed = 0
            processed = 0
            skipped = 0
            json_parse_failed = 0
            last_llm_error: str | None = None
            consecutive_failures = 0
            aborted_early = False
            abort_msg: str | None = None
            failed_index_set: set[int] = set()
            failed_indices: list[int] = []
            failed_items: list[dict[str, Any]] = []

            summarizer_cfg = replace(
                llm_cfg(),
                temperature=0.2,
                max_tokens=summary_max_tokens,
            )
            if (
                summarizer_cfg.provider == "gemini"
                and "packyapi.com" in (summarizer_cfg.base_url or "").lower()
            ):
                # Summaries are a throughput-heavy step; prefer a Flash model for
                # PackyAPI Gemini to reduce timeouts/ConnectError on long books.
                if "flash" not in str(summarizer_cfg.model or "").lower():
                    summarizer_cfg = replace(
                        summarizer_cfg, model="gemini-3-flash-preview"
                    )

            def load_existing_part_indices(mode: str) -> set[int]:
                if replace_existing:
                    return set()
                try:
                    with get_session() as s_exist:
                        existing_rows = list(
                            s_exist.exec(
                                select(KBChunk).where(
                                    KBChunk.project_id == project_id,
                                    KBChunk.source_type == "book_summary",
                                    KBChunk.tags.like(f"%book_source:{source_id}%"),
                                )
                            )
                        )
                    out: set[int] = set()
                    tag_key = "book_chapter" if mode == "chapter" else "book_chunk"
                    for row in existing_rows:
                        m = re.search(
                            rf"(?:^|,|\\s){tag_key}:(\\d+)(?:$|,|\\s)",
                            row.tags or "",
                        )
                        if m:
                            try:
                                out.add(int(m.group(1)))
                            except Exception:
                                continue
                    return out
                except Exception:
                    return set()

            existing_part_indices: set[int] = load_existing_part_indices(segment_mode)

            def record_failed_segment(
                *,
                idx: int,
                error: str,
                chapter_label: str | None = None,
                chapter_title: str | None = None,
            ) -> None:
                if idx <= 0 or idx in failed_index_set:
                    return
                failed_index_set.add(int(idx))
                failed_indices.append(int(idx))
                item: dict[str, Any] = {"index": int(idx)}
                if chapter_label:
                    item["chapter_label"] = _clip_text(chapter_label, 120)
                if chapter_title:
                    item["chapter_title"] = _clip_text(chapter_title, 160)
                item["error"] = _clip_text(error, 240) or "unknown_error"
                failed_items.append(item)

            async def summarize_segment(
                *,
                idx: int,
                start_char: int,
                end_char: int | None,
                snippet: str,
                chapter_label: str | None = None,
                chapter_title: str | None = None,
                truncated: bool = False,
                original_chars: int | None = None,
            ) -> AsyncGenerator[bytes, None]:
                nonlocal created, failed, processed, skipped, json_parse_failed

                if idx in existing_part_indices:
                    skipped += 1
                    yield emit(
                        "agent_output",
                        "BookSummarizer",
                        {
                            "chunk_index": idx,
                            "segment_mode": segment_mode,
                            "skipped": True,
                            "reason": "already_summarized",
                        },
                    )
                    return
                if not replace_existing:
                    # Extra safety: even if our upfront scan missed existing parts
                    # (e.g. transient DB errors), avoid unnecessary LLM calls by
                    # checking existence for this specific part index.
                    tag_key = (
                        "book_chapter" if segment_mode == "chapter" else "book_chunk"
                    )
                    with ENGINE.connect() as conn:
                        hit = conn.execute(
                            text(
                                """
                                SELECT id
                                FROM kb_chunk
                                WHERE project_id = :project_id
                                  AND source_type = 'book_summary'
                                  AND tags LIKE :tag_source
                                  AND (tags LIKE :tag_mid OR tags LIKE :tag_end)
                                LIMIT 1;
                                """
                            ),
                            {
                                "project_id": project_id,
                                "tag_source": f"%book_source:{source_id}%",
                                "tag_mid": f"%{tag_key}:{idx},%",
                                "tag_end": f"%,{tag_key}:{idx}",
                            },
                        ).first()
                    if hit is not None:
                        existing_part_indices.add(int(idx))
                        skipped += 1
                        yield emit(
                            "agent_output",
                            "BookSummarizer",
                            {
                                "chunk_index": idx,
                                "segment_mode": segment_mode,
                                "skipped": True,
                                "reason": "already_summarized",
                            },
                        )
                        return

                processed += 1
                snippet_s = (snippet or "").strip()
                if not snippet_s:
                    return

                # Tool call record for trace.
                yield emit(
                    "tool_call",
                    "BookSummarizer",
                    {
                        "tool": "llm.generate_text",
                        "provider": summarizer_cfg.provider,
                        "model": summarizer_cfg.model,
                        "segment_mode": segment_mode,
                        "chunk_index": idx,
                    },
                )

                system = (
                    "You are BookSummarizerAgent. Summarize a segment of a long manuscript for later continuation. "
                    f"{lang_hint_json} "
                    "Return JSON only. Keep strings concise; do NOT include any chain-of-thought. "
                    "Schema:\n"
                    "{\n"
                    '  "summary": "...",\n'
                    '  "key_events": ["..."],\n'
                    '  "characters": ["..."],\n'
                    '  "locations": ["..."],\n'
                    '  "timeline": ["..."],\n'
                    '  "open_loops": ["..."]\n'
                    "}\n"
                )

                kind_label = "chapter" if segment_mode == "chapter" else "chunk"
                user_lines = [
                    f"Book filename: {filename}",
                    f"Book source_id: {source_id}",
                    f"Segment mode: {segment_mode}",
                    f"Segment kind: {kind_label}",
                    f"Segment index: {idx}",
                    f"Start_char: {start_char}",
                ]
                if end_char is not None:
                    user_lines.append(f"End_char: {end_char}")
                if segment_mode == "chapter":
                    if chapter_label:
                        user_lines.append(f"Chapter label: {chapter_label}")
                    if chapter_title:
                        user_lines.append(f"Chapter title: {chapter_title}")
                if original_chars is not None:
                    user_lines.append(f"Original segment chars: {original_chars}")
                user_lines.append(f"Prompt segment chars: {len(snippet_s)}")
                if truncated:
                    user_lines.append(
                        "Note: this segment was truncated for prompt budget."
                    )
                if segment_mode == "chunk":
                    user_lines.append(
                        "Note: chunks may include overlap with previous chunks. Focus on NEW information and avoid repetition."
                    )
                user_lines.append(
                    f"Limit your JSON string fields to ~{summary_max_chars} chars each.\n\nSegmentText:\n{snippet_s}\n"
                )
                user = "\n".join(user_lines)

                try:
                    out = await generate_text(
                        system_prompt=system, user_prompt=user, cfg=summarizer_cfg
                    )
                except LLMError as e:
                    last_llm_error = str(e)
                    failed += 1
                    record_failed_segment(
                        idx=idx,
                        error=str(e),
                        chapter_label=chapter_label,
                        chapter_title=chapter_title,
                    )
                    yield emit(
                        "agent_output",
                        "BookSummarizer",
                        {
                            "chunk_index": idx,
                            "segment_mode": segment_mode,
                            "error": str(e),
                            "soft_fail": True,
                        },
                    )
                    return
                except Exception as e:
                    last_llm_error = f"llm_failed:{type(e).__name__}"
                    failed += 1
                    record_failed_segment(
                        idx=idx,
                        error=f"llm_failed:{type(e).__name__}",
                        chapter_label=chapter_label,
                        chapter_title=chapter_title,
                    )
                    yield emit(
                        "agent_output",
                        "BookSummarizer",
                        {
                            "chunk_index": idx,
                            "segment_mode": segment_mode,
                            "error": f"llm_failed:{type(e).__name__}",
                            "soft_fail": True,
                        },
                    )
                    return

                last_llm_error = None
                cleaned = strip_think_blocks(out).strip()
                parsed: Any | None = None
                parse_err: str | None = None
                try:
                    parsed = parse_json_loose(cleaned)
                except Exception as e:
                    json_parse_failed += 1
                    parse_err = type(e).__name__
                record: dict[str, Any]
                base_record: dict[str, Any] = {
                    "book_source_id": source_id,
                    "segment_mode": segment_mode,
                    "chunk_index": idx,
                    "start_char": start_char,
                }
                if end_char is not None:
                    base_record["end_char"] = int(end_char)
                if segment_mode == "chapter":
                    if chapter_label:
                        base_record["chapter_label"] = chapter_label
                    if chapter_title:
                        base_record["chapter_title"] = chapter_title
                if truncated:
                    base_record["truncated"] = True
                if original_chars is not None:
                    base_record["original_chars"] = int(original_chars)

                if isinstance(parsed, dict):
                    record = {
                        **base_record,
                        "data": _normalize_book_summary_data(parsed),
                    }
                else:
                    record = {
                        **base_record,
                        "text": cleaned[
                            : max(200, min(len(cleaned), summary_max_chars * 4))
                        ],
                    }
                    if parse_err:
                        record["parse_error"] = parse_err

                content = json_dumps(record)
                if replace_existing:
                    # Safer replacement: delete any existing summary for the SAME part index
                    # right before inserting the new one (avoid wiping everything upfront).
                    tag_key = (
                        "book_chapter" if segment_mode == "chapter" else "book_chunk"
                    )
                    with ENGINE.connect() as conn:
                        conn.execute(
                            text(
                                """
                                DELETE FROM kb_chunk
                                WHERE project_id = :project_id
                                  AND source_type = 'book_summary'
                                  AND tags LIKE :tag_source
                                  AND (tags LIKE :tag_mid OR tags LIKE :tag_end);
                                """
                            ),
                            {
                                "project_id": project_id,
                                "tag_source": f"%book_source:{source_id}%",
                                "tag_mid": f"%{tag_key}:{idx},%",
                                "tag_end": f"%,{tag_key}:{idx}",
                            },
                        )
                        conn.commit()
                with get_session() as s_kb:
                    kb = KBChunk(
                        project_id=project_id,
                        source_type="book_summary",
                        title=book_title(output_lang, idx, chapter_label=chapter_label),
                        content=content,
                        tags=book_tags(idx),
                    )
                    s_kb.add(kb)
                    s_kb.commit()
                    s_kb.refresh(kb)

                created += 1
                preview = cleaned.replace("\n", " ").strip()
                if len(preview) > 240:
                    preview = preview[:240].rstrip() + "…"
                yield emit(
                    "artifact",
                    "BookSummarizer",
                    {
                        "artifact_type": "book_chunk_summary",
                        "source_id": source_id,
                        "segment_mode": segment_mode,
                        "chunk_index": idx,
                        "start_char": start_char,
                        "end_char": end_char,
                        "kb_chunk_id": kb.id,
                        "preview": preview,
                    },
                )

            yield emit(
                "agent_output",
                "BookSummarizer",
                {"step": "summarize_segments", "step_index": 2, "step_total": 3},
            )
            if segment_mode == "chapter" and isinstance(chapter_index_obj, dict):
                try:
                    full_text = src.text_path.read_text(
                        encoding="utf-8", errors="ignore"
                    )
                except Exception as e:  # pragma: no cover
                    yield emit(
                        "agent_output",
                        "BookSummarizer",
                        {
                            "error": f"book_text_read_failed:{type(e).__name__}",
                            "soft_fail": True,
                        },
                    )
                    segment_mode = "chunk"
                    existing_part_indices = load_existing_part_indices("chunk")
                else:
                    chapters_raw = chapter_index_obj.get("chapters")
                    if not isinstance(chapters_raw, list) or not chapters_raw:
                        yield emit(
                            "agent_output",
                            "BookSummarizer",
                            {
                                "error": "chapter_index_invalid_or_empty",
                                "soft_fail": True,
                            },
                        )
                        segment_mode = "chunk"
                        existing_part_indices = load_existing_part_indices("chunk")
                    else:
                        total_parts_raw = chapter_index_obj.get("total_chapters")
                        try:
                            total_parts = (
                                int(total_parts_raw)
                                if total_parts_raw is not None
                                else len(chapters_raw)
                            )
                        except Exception:
                            total_parts = len(chapters_raw)

                        # Respect the API param max_chapters even when we are reading a cached chapter_index.json
                        # (overwrite=false). This allows safe smoke tests and cost-controlled runs.
                        chapters_use = chapters_raw
                        try:
                            max_chapters_i = int(max_chapters)
                        except Exception:
                            max_chapters_i = int(len(chapters_raw))
                        if max_chapters_i > 0 and len(chapters_use) > max_chapters_i:
                            chapters_use = chapters_use[:max_chapters_i]
                        if requested_segment_index_set:
                            filtered_chapters: list[dict[str, Any]] = []
                            for i, ch in enumerate(chapters_use, start=1):
                                if not isinstance(ch, dict):
                                    continue
                                try:
                                    chapter_idx = int(ch.get("index") or i) or i
                                except Exception:
                                    chapter_idx = i
                                if chapter_idx in requested_segment_index_set:
                                    filtered_chapters.append(ch)
                            chapters_use = filtered_chapters

                        total_parts = len(chapters_use)
                        yield emit(
                            "agent_output",
                            "BookSummarizer",
                            {
                                "segment_mode": "chapter",
                                "total_parts": total_parts,
                                "progress": {
                                    "done": int(created + skipped + failed),
                                    "total": int(total_parts),
                                },
                            },
                        )
                        for i, ch in enumerate(chapters_use, start=1):
                            if not isinstance(ch, dict):
                                continue
                            try:
                                idx = int(ch.get("index") or i) or i
                            except Exception:
                                idx = i
                            try:
                                start_char = int(ch.get("start_char") or 0)
                            except Exception:
                                start_char = 0
                            try:
                                end_char = int(ch.get("end_char") or 0)
                            except Exception:
                                end_char = 0
                            start_char = max(0, min(start_char, len(full_text)))
                            end_char = max(start_char, min(end_char, len(full_text)))
                            raw = full_text[start_char:end_char]
                            if not raw.strip():
                                continue
                            original_chars = len(raw)
                            snippet = raw
                            truncated = False
                            if (
                                segment_max_chars > 0
                                and original_chars > segment_max_chars
                            ):
                                # Keep both head and tail for better continuity.
                                head_n = max(300, int(segment_max_chars * 0.55))
                                tail_n = max(300, int(segment_max_chars * 0.45))
                                if head_n + tail_n > segment_max_chars:
                                    tail_n = max(0, segment_max_chars - head_n)
                                snippet = (
                                    raw[:head_n]
                                    + "\n\n...[TRUNCATED]...\n\n"
                                    + (raw[-tail_n:] if tail_n > 0 else "")
                                )
                                truncated = True

                            chapter_label = str(ch.get("label") or "").strip() or None
                            chapter_title = str(ch.get("title") or "").strip() or None

                            good_before = int(created + skipped)
                            failed_before = int(failed)
                            async for b in summarize_segment(
                                idx=idx,
                                start_char=start_char,
                                end_char=end_char,
                                snippet=snippet,
                                chapter_label=chapter_label,
                                chapter_title=chapter_title,
                                truncated=truncated,
                                original_chars=original_chars,
                            ):
                                yield b

                            good_after = int(created + skipped)
                            if (
                                int(failed) > failed_before
                                and good_after == good_before
                            ):
                                consecutive_failures += 1
                            else:
                                consecutive_failures = 0

                            if consecutive_failures >= max_consecutive_failures:
                                err_tail = (last_llm_error or "")[:220]
                                msg = f"book_summarize_aborted:consecutive_failures={consecutive_failures}"
                                if err_tail:
                                    msg += f":{err_tail}"
                                aborted_early = True
                                abort_msg = msg
                                if (created + skipped) <= 0:
                                    yield emit(
                                        "run_error", "BookSummarizer", {"error": msg}
                                    )
                                    mark_run_failed(msg)
                                    yield emit("run_completed", "Director", {})
                                    return
                                yield emit(
                                    "agent_output",
                                    "BookSummarizer",
                                    {"error": msg, "soft_fail": True},
                                )
                                break
                            yield emit(
                                "agent_output",
                                "BookSummarizer",
                                {
                                    "segment_mode": "chapter",
                                    "chunk_index": idx,
                                    "progress": {
                                        "done": int(created + skipped + failed),
                                        "total": int(total_parts),
                                    },
                                },
                            )

            if segment_mode == "chunk":
                # For progress UI, compute the actual number of chunks we will process
                # (bounded by max_chunks). This is intentionally best-effort: if the
                # count fails, fall back to max_chunks.
                try:
                    total_parts = sum(
                        1
                        for _idx, _start, _txt in iter_text_chunks(
                            path=src.text_path,
                            chunk_chars=chunk_chars,
                            overlap_chars=overlap_chars,
                            max_chunks=max_chunks,
                        )
                        if not requested_segment_index_set
                        or int(_idx) in requested_segment_index_set
                    )
                except Exception:
                    total_parts = (
                        len(requested_segment_indices)
                        if requested_segment_indices
                        else int(max_chunks)
                    )
                total_parts = max(0, min(int(total_parts), int(max_chunks)))

                yield emit(
                    "agent_output",
                    "BookSummarizer",
                    {
                        "segment_mode": "chunk",
                        "total_parts": int(total_parts),
                        "progress": {
                            "done": int(created + skipped + failed),
                            "total": int(total_parts),
                        },
                    },
                )
                for idx, start_char, chunk_text in iter_text_chunks(
                    path=src.text_path,
                    chunk_chars=chunk_chars,
                    overlap_chars=overlap_chars,
                    max_chunks=max_chunks,
                ):
                    if requested_segment_index_set and int(idx) not in requested_segment_index_set:
                        continue
                    end_char = int(start_char) + len(chunk_text or "")
                    good_before = int(created + skipped)
                    failed_before = int(failed)
                    async for b in summarize_segment(
                        idx=idx,
                        start_char=start_char,
                        end_char=end_char,
                        snippet=(chunk_text or ""),
                    ):
                        yield b

                    good_after = int(created + skipped)
                    if int(failed) > failed_before and good_after == good_before:
                        consecutive_failures += 1
                    else:
                        consecutive_failures = 0

                    if consecutive_failures >= max_consecutive_failures:
                        err_tail = (last_llm_error or "")[:220]
                        msg = f"book_summarize_aborted:consecutive_failures={consecutive_failures}"
                        if err_tail:
                            msg += f":{err_tail}"
                        aborted_early = True
                        abort_msg = msg
                        if (created + skipped) <= 0:
                            yield emit("run_error", "BookSummarizer", {"error": msg})
                            mark_run_failed(msg)
                            yield emit("run_completed", "Director", {})
                            return
                        yield emit(
                            "agent_output",
                            "BookSummarizer",
                            {"error": msg, "soft_fail": True},
                        )
                        break
                    yield emit(
                        "agent_output",
                        "BookSummarizer",
                        {
                            "segment_mode": "chunk",
                            "chunk_index": idx,
                            "progress": {
                                "done": int(created + skipped + failed),
                                "total": int(total_parts),
                            },
                        },
                    )

            yield emit(
                "agent_output",
                "BookSummarizer",
                {"step": "finalize", "step_index": 3, "step_total": 3},
            )
            yield emit(
                "artifact",
                "BookSummarizer",
                {
                    "artifact_type": "book_summarize_stats",
                    "source_id": source_id,
                    "filename": filename,
                    "segment_mode": segment_mode,
                    "processed": processed,
                    "created": created,
                    "failed": failed,
                    "failed_indices": failed_indices,
                    "failed_items": failed_items,
                    "skipped": skipped,
                    "json_parse_failed": json_parse_failed,
                    "aborted_early": aborted_early,
                    "abort_msg": abort_msg,
                    "params": {
                        "segment_mode": segment_mode,
                        "chunk_chars": chunk_chars,
                        "overlap_chars": overlap_chars,
                        "max_chunks": max_chunks,
                        "max_chapters": max_chapters,
                        "segment_max_chars": segment_max_chars,
                        "summary_chars": summary_max_chars,
                        "summary_max_tokens": summary_max_tokens,
                        "replace_existing": replace_existing,
                        "max_consecutive_failures": max_consecutive_failures,
                        "segment_indices": requested_segment_indices,
                    },
                },
            )
            yield emit(
                "agent_finished",
                "BookSummarizer",
                {"created": created, "failed": failed},
            )

            if (created + skipped) <= 0:
                msg = "book_summarize_no_results"
                yield emit("run_error", "BookSummarizer", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            mark_run_completed()
            yield emit("run_completed", "Director", {})
            return

        if kind == "book_compile":
            source_id = str(
                payload.get("source_id") or payload.get("book_source_id") or ""
            ).strip()
            if not source_id:
                msg = "source_id_required"
                yield emit("run_error", "BookCompiler", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            try:
                src = load_continue_source(source_id)
            except ContinueSourceError as e:
                msg = f"continue_source_load_failed:{str(e)}"
                yield emit("run_error", "BookCompiler", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            filename = str((src.meta or {}).get("filename") or "").strip() or "book"
            filename_tag = filename.replace(",", " ").strip()[:64]

            with get_session() as s_sum:
                rows = list(
                    s_sum.exec(
                        select(KBChunk).where(
                            KBChunk.project_id == project_id,
                            KBChunk.source_type == "book_summary",
                            KBChunk.tags.like(f"%book_source:{source_id}%"),
                        )
                    )
                )

            if not rows:
                msg = "book_compile_requires_book_summaries"
                yield emit("run_error", "BookCompiler", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            def _safe_list(v: object, max_items: int = 8) -> list[str]:
                if not isinstance(v, list):
                    return []
                out: list[str] = []
                for x in v[: max(0, int(max_items))]:
                    if isinstance(x, str) and x.strip():
                        out.append(x.strip())
                return out

            def _safe_str(v: object, max_len: int = 600) -> str:
                if not isinstance(v, str):
                    return ""
                s = v.strip()
                if len(s) > max_len:
                    s = s[:max_len].rstrip() + "…"
                return s

            summaries: list[dict[str, Any]] = []
            for r in rows:
                idx: int | None = None
                part_kind = "chunk"
                m = re.search(
                    r"(?:^|,|\\s)book_chapter:(\\d+)(?:$|,|\\s)", r.tags or ""
                )
                if m:
                    part_kind = "chapter"
                    try:
                        idx = int(m.group(1))
                    except Exception:
                        idx = None
                else:
                    m = re.search(
                        r"(?:^|,|\\s)book_chunk:(\\d+)(?:$|,|\\s)", r.tags or ""
                    )
                    if m:
                        try:
                            idx = int(m.group(1))
                        except Exception:
                            idx = None
                start_char: int | None = None
                data_summary: dict[str, Any] | None = None
                chapter_label: str | None = None
                chapter_title: str | None = None
                try:
                    obj = json.loads(r.content)
                    if isinstance(obj, dict):
                        seg_mode = str(obj.get("segment_mode") or "").strip().lower()
                        if seg_mode == "chapter":
                            part_kind = "chapter"
                        if idx is None and obj.get("chunk_index") is not None:
                            try:
                                idx = int(obj.get("chunk_index") or 0) or None
                            except Exception:
                                idx = None
                        if idx is None and obj.get("chapter_index") is not None:
                            try:
                                idx = int(obj.get("chapter_index") or 0) or None
                            except Exception:
                                idx = None
                        if obj.get("start_char") is not None:
                            try:
                                start_char = int(obj.get("start_char") or 0)
                            except Exception:
                                start_char = None
                        if obj.get("chapter_label") is not None:
                            chapter_label = (
                                _safe_str(obj.get("chapter_label"), 120) or None
                            )
                        if obj.get("chapter_title") is not None:
                            chapter_title = (
                                _safe_str(obj.get("chapter_title"), 160) or None
                            )
                        if isinstance(obj.get("data"), dict):
                            data_summary = obj.get("data")  # type: ignore[assignment]
                except Exception:
                    data_summary = None

                if idx is None:
                    continue

                if isinstance(data_summary, dict):
                    data_summary = _normalize_book_summary_data(data_summary)
                    summaries.append(
                        {
                            "segment_mode": part_kind,
                            "chunk_index": idx,
                            "start_char": start_char,
                            "chapter_label": chapter_label,
                            "chapter_title": chapter_title,
                            "summary": _safe_str(data_summary.get("summary"), 900),
                            "key_events": _safe_list(
                                data_summary.get("key_events"), 10
                            ),
                            "characters": _safe_list(
                                data_summary.get("characters"), 12
                            ),
                            "locations": _safe_list(data_summary.get("locations"), 10),
                            "timeline": _safe_list(data_summary.get("timeline"), 10),
                            "open_loops": _safe_list(
                                data_summary.get("open_loops"), 10
                            ),
                        }
                    )
                else:
                    summaries.append(
                        {
                            "segment_mode": part_kind,
                            "chunk_index": idx,
                            "start_char": start_char,
                            "chapter_label": chapter_label,
                            "chapter_title": chapter_title,
                            "summary": _safe_str(r.content, 900),
                            "key_events": [],
                            "characters": [],
                            "locations": [],
                            "timeline": [],
                            "open_loops": [],
                        }
                    )

            # Prefer chapter-based summaries when available (more aligned with user mental model).
            if any(str(s.get("segment_mode") or "") == "chapter" for s in summaries):
                summaries = [
                    s
                    for s in summaries
                    if str(s.get("segment_mode") or "") == "chapter"
                ]

            summaries.sort(key=lambda x: int(x.get("chunk_index") or 0))
            total = len(summaries)
            if total <= 0:
                msg = "book_compile_no_valid_summaries"
                yield emit("run_error", "BookCompiler", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            compiled_segment_mode = (
                "chapter"
                if any(str(s.get("segment_mode") or "") == "chapter" for s in summaries)
                else "chunk"
            )

            # Prompt size guard: include the beginning + ending to cover introductions and the latest state.
            selected: list[dict[str, Any]] = summaries
            selection_note = "all"
            if total > 80:
                selected = summaries[:20] + summaries[-60:]
                selection_note = "first_20_plus_last_60"

            yield emit(
                "agent_started",
                "BookCompiler",
                {
                    "source_id": source_id,
                    "filename": filename,
                    "segment_mode": compiled_segment_mode,
                    "total_summaries": total,
                    "used_summaries": len(selected),
                    "selection": selection_note,
                },
            )
            yield emit(
                "agent_output",
                "BookCompiler",
                {"step": "prepare_prompt", "step_index": 1, "step_total": 4},
            )

            compiler_cfg0 = llm_cfg()
            compiler_model = str(compiler_cfg0.model or "").strip()
            base_low = (compiler_cfg0.base_url or "").lower()
            if compiler_cfg0.provider == "gemini" and "packyapi.com" in base_low:
                # BookCompile is a "reasoning + aggregation" step; some PackyAPI
                # Gemini distributors can be slow/flaky on Pro models for large prompts.
                # Prefer a Flash model for responsiveness; provider fallback still applies.
                if "flash" not in compiler_model.lower():
                    compiler_model = "gemini-3-flash-preview"
            compiler_cfg = replace(
                compiler_cfg0,
                temperature=0.2,
                max_tokens=max(400, min(int(compiler_cfg0.max_tokens or 900), 1400)),
                model=compiler_model or compiler_cfg0.model,
            )
            yield emit(
                "tool_call",
                "BookCompiler",
                {
                    "tool": "llm.generate_text",
                    "provider": compiler_cfg.provider,
                    "model": compiler_cfg.model,
                    "max_tokens": compiler_cfg.max_tokens,
                },
            )
            yield emit(
                "agent_output",
                "BookCompiler",
                {"step": "llm.generate_text", "step_index": 2, "step_total": 4},
            )

            seg_word = "chapter" if compiled_segment_mode == "chapter" else "chunk"
            seg_word_cap = "Chapter" if compiled_segment_mode == "chapter" else "Chunk"

            def compact_for_compile(item: dict[str, Any]) -> dict[str, Any]:
                # Keep this prompt payload small and stable across gateways.
                # The compiler only needs coarse signals (summary + key events),
                # not the full per-segment JSON blobs.
                return {
                    "index": int(item.get("chunk_index") or 0),
                    "chapter_label": _safe_str(item.get("chapter_label"), 120) or None,
                    "chapter_title": _safe_str(item.get("chapter_title"), 160) or None,
                    "summary": _safe_str(item.get("summary"), 420),
                    "key_events": _safe_list(item.get("key_events"), 6),
                    "characters": _safe_list(item.get("characters"), 8),
                    "locations": _safe_list(item.get("locations"), 6),
                    "timeline": _safe_list(item.get("timeline"), 6),
                    "open_loops": _safe_list(item.get("open_loops"), 6),
                }

            selected_compact = [compact_for_compile(s) for s in selected]

            system = (
                f"You are BookCompilerAgent. Compile a long book's {seg_word} summaries into a compact state for continuation. "
                f"{lang_hint_json} "
                "Return JSON only. Do NOT include chain-of-thought. "
                "Constraints (keep it compact): "
                "book_summary<=1800 chars, world<=900 chars, character_cards<=16, timeline<=24, open_loops<=20. "
                "Schema:\n"
                "{\n"
                '  "book_summary": "...",\n'
                '  "style_profile": {"pov":"...","tense":"...","tone":"...","genre":"..."},\n'
                '  "world": "...",\n'
                '  "character_cards": [ {"name":"...","role":"...","traits":"...","relationships":"...","current_status":"...","arc":"..."} ],\n'
                '  "timeline": [ {"when":"...","event":"..."} ],\n'
                '  "open_loops": ["..."],\n'
                '  "continuation_seed": {"where_to_resume":"...","next_scene":"...","constraints":["..."]}\n'
                "}\n"
            )
            user = (
                f"Book filename: {filename}\n"
                f"Book source_id: {source_id}\n"
                f"{seg_word_cap} summaries available: {total}\n"
                f"Included in this compile: {len(selected)} (selection={selection_note})\n\n"
                f"{seg_word_cap}SummariesJSON:\n"
                f"{json_dumps(selected_compact)}\n"
            )

            try:
                # PackyAPI / Gemini proxies can occasionally "hang" (slow distributors / stalled connections).
                # While we keep httpx timeouts reasonably bounded, add an outer hard timeout and
                # emit SSE heartbeats so the UI doesn't look stuck.
                hard_timeout_s = 120.0
                heartbeat_s = 8.0
                t0 = asyncio.get_running_loop().time()
                task = asyncio.create_task(
                    generate_text(
                        system_prompt=system, user_prompt=user, cfg=compiler_cfg
                    )
                )
                while True:
                    done, _pending = await asyncio.wait({task}, timeout=heartbeat_s)
                    if task in done:
                        out = task.result()
                        break
                    elapsed = int(asyncio.get_running_loop().time() - t0)
                    yield emit(
                        "agent_output",
                        "BookCompiler",
                        {
                            "step": "llm.generate_text",
                            "step_index": 2,
                            "step_total": 4,
                            "waiting": True,
                            "elapsed_s": elapsed,
                            "attempt": 1,
                            "selection": selection_note,
                        },
                    )
                    if elapsed >= int(hard_timeout_s):
                        task.cancel()
                        try:
                            await task
                        except Exception:
                            pass
                        raise LLMError(
                            f"book_compile_timeout:attempt=1,elapsed_s={elapsed}"
                        )
            except LLMError as e:
                msg = str(e)

                def _looks_retryable(err: str) -> bool:
                    s = (err or "").strip()
                    if not s:
                        return False
                    if "html_error_page" in s:
                        return True
                    if s.startswith("openai_timeout") or s.startswith(
                        "openai_network_error"
                    ):
                        return True
                    if s.startswith("gemini_timeout") or s.startswith(
                        "gemini_network_error"
                    ):
                        return True
                    if re.match(r"^(openai|gemini)_http_(429|500|502|503|504)", s):
                        return True
                    # Packy-like model unavailability often benefits from retries/fallbacks.
                    if ("无可用渠道" in s) or ("distributor" in s.lower()):
                        return True
                    return False

                # Rescue retry: shrink prompt budget and try once more. This is
                # specifically to reduce ConnectError/502 failures on large books
                # without increasing request volume too much.
                if _looks_retryable(msg) and len(selected_compact) > 18:
                    yield emit(
                        "agent_output",
                        "BookCompiler",
                        {
                            "error": f"book_compile_retrying:{msg[:220]}",
                            "soft_fail": True,
                        },
                    )
                    # Prefer: a small head + larger tail for continuation.
                    head_n = min(10, len(selected_compact))
                    tail_n = min(26, max(0, len(selected_compact) - head_n))
                    selected_retry = selected_compact[:head_n] + (
                        selected_compact[-tail_n:] if tail_n > 0 else []
                    )
                    # Extra shrink for safety.
                    selected_retry = [
                        {
                            **it,
                            "summary": _safe_str(it.get("summary"), 260),
                            "key_events": _safe_list(it.get("key_events"), 4),
                            "characters": _safe_list(it.get("characters"), 6),
                            "locations": _safe_list(it.get("locations"), 4),
                            "timeline": _safe_list(it.get("timeline"), 4),
                            "open_loops": _safe_list(it.get("open_loops"), 4),
                        }
                        for it in selected_retry
                    ]
                    compiler_cfg_retry = replace(
                        compiler_cfg,
                        max_tokens=max(
                            320, min(int(compiler_cfg.max_tokens or 800), 900)
                        ),
                    )
                    system_retry = (
                        system
                        + "\nRetry note: prompt was shortened due to gateway instability. "
                        + "Return JSON only; keep fields compact."
                    )
                    user_retry = (
                        f"Book filename: {filename}\n"
                        f"Book source_id: {source_id}\n"
                        f"{seg_word_cap} summaries available: {total}\n"
                        f"Included in this compile: {len(selected_retry)} (selection=retry_head_tail)\n\n"
                        f"{seg_word_cap}SummariesJSON:\n"
                        f"{json_dumps(selected_retry)}\n"
                    )
                    yield emit(
                        "tool_call",
                        "BookCompiler",
                        {
                            "tool": "llm.generate_text",
                            "provider": compiler_cfg_retry.provider,
                            "model": compiler_cfg_retry.model,
                            "max_tokens": compiler_cfg_retry.max_tokens,
                            "attempt": 2,
                            "selection": "retry_head_tail",
                        },
                    )
                    try:
                        hard_timeout_s = 120.0
                        heartbeat_s = 8.0
                        t0 = asyncio.get_running_loop().time()
                        task = asyncio.create_task(
                            generate_text(
                                system_prompt=system_retry,
                                user_prompt=user_retry,
                                cfg=compiler_cfg_retry,
                            )
                        )
                        while True:
                            done, _pending = await asyncio.wait(
                                {task}, timeout=heartbeat_s
                            )
                            if task in done:
                                out = task.result()
                                break
                            elapsed = int(asyncio.get_running_loop().time() - t0)
                            yield emit(
                                "agent_output",
                                "BookCompiler",
                                {
                                    "step": "llm.generate_text",
                                    "step_index": 2,
                                    "step_total": 4,
                                    "waiting": True,
                                    "elapsed_s": elapsed,
                                    "attempt": 2,
                                    "selection": "retry_head_tail",
                                },
                            )
                            if elapsed >= int(hard_timeout_s):
                                task.cancel()
                                try:
                                    await task
                                except Exception:
                                    pass
                                raise LLMError(
                                    f"book_compile_timeout:attempt=2,elapsed_s={elapsed}"
                                )
                    except LLMError as e2:
                        msg2 = str(e2)
                        yield emit("run_error", "BookCompiler", {"error": msg2})
                        mark_run_failed(msg2)
                        yield emit("run_completed", "Director", {})
                        return
                    except Exception as e2:
                        msg2 = f"book_compile_failed:{type(e2).__name__}"
                        yield emit("run_error", "BookCompiler", {"error": msg2})
                        mark_run_failed(msg2)
                        yield emit("run_completed", "Director", {})
                        return
                else:
                    yield emit("run_error", "BookCompiler", {"error": msg})
                    mark_run_failed(msg)
                    yield emit("run_completed", "Director", {})
                    return
            except Exception as e:
                msg = f"book_compile_failed:{type(e).__name__}"
                yield emit("run_error", "BookCompiler", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            yield emit(
                "agent_output",
                "BookCompiler",
                {"step": "parse_json", "step_index": 3, "step_total": 4},
            )
            cleaned = strip_think_blocks(out).strip()
            parsed: Any | None = None
            parse_err: str | None = None
            relation_edges_count = 0
            try:
                parsed = parse_json_loose(cleaned)
                normalized, relation_edges_count = _normalize_relations_graph(parsed)
                if normalized is not None:
                    parsed = normalized
            except Exception as e:
                parse_err = type(e).__name__
                yield emit(
                    "agent_output",
                    "BookCompiler",
                    {
                        "error": f"book_compile_json_parse_failed:{parse_err}",
                        "soft_fail": True,
                    },
                )
            state: dict[str, Any]
            if isinstance(parsed, dict):
                state = parsed
                # Clamp sizes for downstream prompts (Writer/Planner). Some gateways
                # (PackyAPI/proxies) are sensitive to large JSON blobs.
                if any(
                    k in state
                    for k in (
                        "book_summary",
                        "style_profile",
                        "world",
                        "character_cards",
                        "timeline",
                        "open_loops",
                        "continuation_seed",
                    )
                ):
                    state = _compact_compiled_book_state(state)
            else:
                state = {"text": cleaned}
                if parse_err:
                    state["parse_error"] = parse_err

            record = {
                "book_source_id": source_id,
                "filename": filename,
                "compiled_at": _now_utc().isoformat(),
                "selection": {
                    "total": total,
                    "used": len(selected),
                    "strategy": selection_note,
                },
                "state": state,
            }
            if parse_err:
                record["parse_error"] = parse_err

            tags = [f"book_source:{source_id}", "book_state"]
            if filename_tag:
                tags.append(f"book_file:{filename_tag}")
            kb_tags = ",".join(tags)

            title = (
                f"书籍状态（{filename[:40]}）"
                if output_lang == "zh"
                else f"Book state ({filename[:40]})"
            )
            yield emit(
                "agent_output",
                "BookCompiler",
                {"step": "persist_book_state", "step_index": 4, "step_total": 4},
            )
            with get_session() as s_state:
                kb = KBChunk(
                    project_id=project_id,
                    source_type="book_state",
                    title=title,
                    content=json_dumps(record),
                    tags=kb_tags,
                )
                s_state.add(kb)
                s_state.commit()
                s_state.refresh(kb)

            preview = ""
            if isinstance(state, dict):
                bs = state.get("book_summary")
                if isinstance(bs, str):
                    preview = bs.strip()
            if not preview:
                preview = cleaned.replace("\n", " ").strip()
            if len(preview) > 240:
                preview = preview[:240].rstrip() + "…"

            yield emit(
                "artifact",
                "BookCompiler",
                {
                    "artifact_type": "book_state",
                    "source_id": source_id,
                    "kb_chunk_id": kb.id,
                    "state": state,
                    "preview": preview,
                },
            )
            yield emit("agent_finished", "BookCompiler", {"kb_chunk_id": kb.id})

            mark_run_completed()
            yield emit("run_completed", "Director", {})
            return

        if kind == "book_relations":
            source_id = str(
                payload.get("source_id") or payload.get("book_source_id") or ""
            ).strip()
            if not source_id:
                msg = "source_id_required"
                yield emit("run_error", "BookRelations", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            try:
                src = load_continue_source(source_id)
            except ContinueSourceError as e:
                msg = f"continue_source_load_failed:{str(e)}"
                yield emit("run_error", "BookRelations", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            filename = str((src.meta or {}).get("filename") or "").strip() or "book"
            filename_tag = filename.replace(",", " ").strip()[:64]

            with get_session() as s_sum:
                rows = list(
                    s_sum.exec(
                        select(KBChunk).where(
                            KBChunk.project_id == project_id,
                            KBChunk.source_type == "book_summary",
                            KBChunk.tags.like(f"%book_source:{source_id}%"),
                        )
                    )
                )

            if not rows:
                msg = "book_relations_requires_book_summaries"
                yield emit("run_error", "BookRelations", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            def _safe_list(v: object, max_items: int = 8) -> list[str]:
                if not isinstance(v, list):
                    return []
                out: list[str] = []
                for x in v[: max(0, int(max_items))]:
                    if isinstance(x, str) and x.strip():
                        out.append(x.strip())
                return out

            def _safe_str(v: object, max_len: int = 600) -> str:
                if not isinstance(v, str):
                    return ""
                s = v.strip()
                if len(s) > max_len:
                    s = s[:max_len].rstrip() + "…"
                return s

            rel_parts: list[dict[str, Any]] = []
            for r in rows:
                idx: int | None = None
                part_kind = "chunk"
                m = re.search(r"(?:^|,|\s)book_chapter:(\d+)(?:$|,|\s)", r.tags or "")
                if m:
                    part_kind = "chapter"
                    try:
                        idx = int(m.group(1))
                    except Exception:
                        idx = None
                else:
                    m = re.search(r"(?:^|,|\s)book_chunk:(\d+)(?:$|,|\s)", r.tags or "")
                    if m:
                        try:
                            idx = int(m.group(1))
                        except Exception:
                            idx = None
                chapter_label: str | None = None
                chapter_title: str | None = None
                data_summary: dict[str, Any] | None = None
                try:
                    obj = json.loads(r.content)
                    if isinstance(obj, dict):
                        seg_mode = str(obj.get("segment_mode") or "").strip().lower()
                        if seg_mode == "chapter":
                            part_kind = "chapter"
                        if idx is None and obj.get("chunk_index") is not None:
                            try:
                                idx = int(obj.get("chunk_index") or 0) or None
                            except Exception:
                                idx = None
                        if idx is None and obj.get("chapter_index") is not None:
                            try:
                                idx = int(obj.get("chapter_index") or 0) or None
                            except Exception:
                                idx = None
                        if obj.get("chapter_label") is not None:
                            chapter_label = (
                                _safe_str(obj.get("chapter_label"), 120) or None
                            )
                        if obj.get("chapter_title") is not None:
                            chapter_title = (
                                _safe_str(obj.get("chapter_title"), 160) or None
                            )
                        if isinstance(obj.get("data"), dict):
                            data_summary = obj.get("data")  # type: ignore[assignment]
                except Exception:
                    data_summary = None

                if idx is None:
                    continue

                if isinstance(data_summary, dict):
                    data_summary = _normalize_book_summary_data(data_summary)
                    rel_parts.append(
                        {
                            "segment_mode": part_kind,
                            "index": idx,
                            "chapter_label": chapter_label,
                            "chapter_title": chapter_title,
                            "summary": _safe_str(data_summary.get("summary"), 320),
                            "key_events": _safe_list(data_summary.get("key_events"), 6),
                            "characters": _safe_list(
                                data_summary.get("characters"), 10
                            ),
                            "locations": _safe_list(data_summary.get("locations"), 6),
                            "open_loops": _safe_list(data_summary.get("open_loops"), 8),
                            "themes": _safe_list(data_summary.get("themes_list"), 6),
                        }
                    )
                else:
                    rel_parts.append(
                        {
                            "segment_mode": part_kind,
                            "index": idx,
                            "chapter_label": chapter_label,
                            "chapter_title": chapter_title,
                            "summary": _safe_str(r.content, 320),
                            "key_events": [],
                            "characters": [],
                            "locations": [],
                            "open_loops": [],
                            "themes": [],
                        }
                    )

            # Prefer chapter-based summaries when available.
            if any(str(s.get("segment_mode") or "") == "chapter" for s in rel_parts):
                rel_parts = [
                    s
                    for s in rel_parts
                    if str(s.get("segment_mode") or "") == "chapter"
                ]

            known_character_names: list[str] = []
            for part in rel_parts:
                known_character_names.extend(_safe_list(part.get("characters"), 12))
                known_character_names.extend(
                    _infer_character_names_from_title(
                        part.get("chapter_title"), max_items=8
                    )
                )
            known_character_names = _dedupe_keep_order(
                known_character_names, max_items=96
            )
            for part in rel_parts:
                inferred_names = _infer_character_names_from_text(
                    " ".join(
                        x
                        for x in (
                            _safe_str(part.get("chapter_title"), 160),
                            _safe_str(part.get("summary"), 600),
                            "；".join(_safe_list(part.get("key_events"), 6)),
                        )
                        if x
                    ),
                    known_names=known_character_names,
                    max_items=12,
                )
                if inferred_names:
                    part["characters"] = _dedupe_keep_order(
                        _safe_list(part.get("characters"), 12) + inferred_names,
                        max_items=12,
                    )

            rel_parts.sort(key=lambda x: int(x.get("index") or 0))
            total = len(rel_parts)
            if total <= 0:
                msg = "book_relations_no_valid_summaries"
                yield emit("run_error", "BookRelations", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            selected: list[dict[str, Any]] = rel_parts
            selection_note = "all"

            def compact_for_relations(p: dict[str, Any]) -> dict[str, Any]:
                out: dict[str, Any] = {
                    "index": int(p.get("index") or 0),
                    "summary": _safe_str(p.get("summary"), 220),
                }
                if p.get("chapter_label"):
                    out["chapter_label"] = _safe_str(p.get("chapter_label"), 80)
                if p.get("chapter_title"):
                    out["chapter_title"] = _safe_str(p.get("chapter_title"), 120)
                ke = _safe_list(p.get("key_events"), 6)
                if ke:
                    out["key_events"] = ke
                chs = _safe_list(p.get("characters"), 10)
                if chs:
                    out["characters"] = chs
                ol = _safe_list(p.get("open_loops"), 8)
                if ol:
                    out["open_loops"] = ol
                themes = _safe_list(p.get("themes"), 6)
                if themes:
                    out["themes"] = themes
                return out

            parts_compact = [compact_for_relations(p) for p in rel_parts]

            def head_tail(head: int, tail: int) -> list[dict[str, Any]]:
                if head < 0:
                    head = 0
                if tail < 0:
                    tail = 0
                if len(parts_compact) <= head + tail:
                    return parts_compact
                return parts_compact[:head] + parts_compact[-tail:]

            def heuristic_relations_from_selected(
                sel: list[dict[str, Any]],
            ) -> list[dict[str, Any]]:
                edges: list[dict[str, Any]] = []
                if len(sel) < 2:
                    return edges

                def add_edge(
                    src: int, dst: int, rel_type: str, label: str, strength: float
                ) -> None:
                    if src <= 0 or dst <= 0 or src == dst:
                        return
                    edges.append(
                        {
                            "from": src,
                            "to": dst,
                            "type": rel_type,
                            "label": _clip_text(label, 36),
                            "strength": max(0.0, min(1.0, float(strength))),
                        }
                    )

                character_occurs: dict[str, list[int]] = defaultdict(list)
                loop_occurs: dict[str, list[int]] = defaultdict(list)
                theme_occurs: dict[str, list[int]] = defaultdict(list)

                for part in sel:
                    idx = int(part.get("index") or 0)
                    if idx <= 0:
                        continue
                    for name in _safe_list(part.get("characters"), 10):
                        character_occurs[name].append(idx)
                    for term in _safe_list(part.get("open_loops"), 8) + _safe_list(
                        part.get("key_events"), 6
                    ):
                        loop_occurs[_clip_text(term, 36)].append(idx)
                    for theme in _safe_list(part.get("themes"), 6):
                        theme_occurs[_clip_text(theme, 36)].append(idx)

                for name, occ in sorted(
                    character_occurs.items(), key=lambda kv: (-len(set(kv[1])), kv[0])
                ):
                    ordered = sorted(set(occ))
                    if len(ordered) < 2:
                        continue
                    pair_count = 0
                    for src, dst in zip(ordered, ordered[1:]):
                        if dst - src <= 0 or dst - src > 10:
                            continue
                        add_edge(
                            src,
                            dst,
                            "character_arc",
                            name,
                            0.68 if (dst - src) <= 4 else 0.62,
                        )
                        pair_count += 1
                        if pair_count >= 3:
                            break
                    if len(ordered) >= 3 and (ordered[-1] - ordered[0]) >= 6:
                        add_edge(ordered[0], ordered[-1], "payoff", name, 0.64)

                for term, occ in sorted(
                    loop_occurs.items(), key=lambda kv: (-len(set(kv[1])), kv[0])
                ):
                    ordered = sorted(set(occ))
                    if len(ordered) < 2:
                        continue
                    add_edge(
                        ordered[0],
                        ordered[1],
                        "foreshadow",
                        term,
                        0.72 if len(ordered) >= 3 else 0.66,
                    )
                    if len(ordered) >= 3:
                        add_edge(ordered[1], ordered[-1], "payoff", term, 0.70)

                for theme, occ in sorted(
                    theme_occurs.items(), key=lambda kv: (-len(set(kv[1])), kv[0])
                ):
                    ordered = sorted(set(occ))
                    if len(ordered) < 2:
                        continue
                    add_edge(ordered[0], ordered[-1], "theme", theme, 0.58)

                if not edges:
                    for i in range(len(sel)):
                        a = sel[i]
                        ai = int(a.get("index") or 0)
                        if ai <= 0:
                            continue
                        a_chars = set(_safe_list(a.get("characters"), 8))
                        if not a_chars:
                            continue
                        for j in range(i + 1, min(len(sel), i + 6)):
                            b = sel[j]
                            bi = int(b.get("index") or 0)
                            if bi <= 0 or bi == ai:
                                continue
                            shared_chars = sorted(
                                a_chars.intersection(_safe_list(b.get("characters"), 8))
                            )
                            if not shared_chars:
                                continue
                            add_edge(ai, bi, "parallel", shared_chars[0], 0.56)
                            if len(edges) >= 40:
                                break
                        if len(edges) >= 40:
                            break

                if not edges:
                    first = int(sel[0].get("index") or 0)
                    last = int(sel[-1].get("index") or 0)
                    if first > 0 and last > 0 and first != last:
                        add_edge(first, last, "structure", "book_progression", 0.5)

                if len(edges) <= 1:
                    return edges
                ranked = sorted(
                    edges,
                    key=lambda e: (
                        -float(e.get("strength") or 0),
                        int(e.get("from") or 0),
                        int(e.get("to") or 0),
                        str(e.get("label") or ""),
                    ),
                )
                deduped: list[dict[str, Any]] = []
                seen_pairs: set[tuple[int, int, str]] = set()
                for edge in ranked:
                    key = (
                        int(edge.get("from") or 0),
                        int(edge.get("to") or 0),
                        str(edge.get("type") or "relation"),
                    )
                    if key in seen_pairs:
                        continue
                    seen_pairs.add(key)
                    deduped.append(edge)
                    if len(deduped) >= 60:
                        break
                return deduped

            if total <= 60:
                selected = parts_compact
                selection_note = "all"
            elif total <= 140:
                selected = head_tail(12, 48)
                selection_note = "first_12_plus_last_48"
            else:
                selected = head_tail(12, 60)
                selection_note = "first_12_plus_last_60"

            yield emit(
                "agent_started",
                "BookRelations",
                {
                    "source_id": source_id,
                    "filename": filename,
                    "segment_mode": "chapter"
                    if any(p.get("segment_mode") == "chapter" for p in selected)
                    else "chunk",
                    "total_summaries": total,
                    "used_summaries": len(selected),
                    "selection": selection_note,
                },
            )
            yield emit(
                "agent_output",
                "BookRelations",
                {"step": "prepare_prompt", "step_index": 1, "step_total": 4},
            )

            rel_cfg0 = llm_cfg()
            rel_model = str(rel_cfg0.model or "").strip()
            if (
                rel_cfg0.provider == "gemini"
                and "packyapi.com" in (rel_cfg0.base_url or "").lower()
            ):
                if "flash" not in rel_model.lower():
                    rel_model = "gemini-3-flash-preview"
            rel_cfg = replace(
                rel_cfg0,
                temperature=0.2,
                max_tokens=max(500, min(int(rel_cfg0.max_tokens or 900), 1400)),
                model=rel_model or rel_cfg0.model,
            )

            # Keep prompt size bounded for flaky gateways (PackyAPI/proxies).
            base_low = (rel_cfg.base_url or "").lower()
            prompt_target_chars = 32_000 if "packyapi.com" in base_low else 70_000
            while (
                len(selected) > 32
                and len(_json_compact(selected)) > prompt_target_chars
            ):
                # Shrink selection gradually while keeping head/tail coverage.
                if selection_note.startswith("first_"):
                    pass
                # Reduce tail first (long books tend to put most continuity at the end).
                head = 10
                tail = max(18, min(40, len(selected) - head))
                selected = selected[:head] + selected[-tail:]
                selection_note = f"head_{head}_tail_{tail}"
            yield emit(
                "tool_call",
                "BookRelations",
                {
                    "tool": "llm.generate_text",
                    "provider": rel_cfg.provider,
                    "model": rel_cfg.model,
                    "max_tokens": rel_cfg.max_tokens,
                },
            )
            yield emit(
                "agent_output",
                "BookRelations",
                {"step": "llm.generate_text", "step_index": 2, "step_total": 4},
            )

            system = (
                "You are BookRelationsAgent. Build a chapter relationship graph for a long novel. "
                f"{lang_hint_json} "
                "Return JSON only. Do NOT include chain-of-thought. "
                "Output a concise set of NON-LINEAR edges across chapters. "
                "Edge types allowed: causal, foreshadow, payoff, character_arc, theme, structure, suspense, parallel, contrast. "
                "Constraints: output <= 120 edges total; avoid duplicates; prefer meaningful long-range links; "
                "each edge must have: from, to, type, label (short), strength (0..1). "
                "Schema:\n"
                "{\n"
                '  "edges": [\n'
                '    {"from": 1, "to": 8, "type": "foreshadow", "label": "...", "strength": 0.7}\n'
                "  ]\n"
                "}\n"
            )
            user = (
                f"Book filename: {filename}\n"
                f"Book source_id: {source_id}\n"
                f"Summaries available: {total}\n"
                f"Included in this analysis: {len(selected)} (selection={selection_note})\n\n"
                "ChapterSummariesJSON:\n"
                f"{_json_compact(selected)}\n"
            )

            try:
                out = await _generate_text_with_timeout(
                    system_prompt=system,
                    user_prompt=user,
                    cfg=rel_cfg,
                    timeout_s=120.0,
                    label="book_relations",
                    attempt=1,
                )
            except LLMError as e:
                msg = str(e)
                if _is_retryable_gateway_error(msg):
                    rescue_selected = selected
                    if len(rescue_selected) > 36:
                        rescue_selected = rescue_selected[:8] + rescue_selected[-28:]
                    rescue_note = (
                        "rescue_head_8_tail_28"
                        if rescue_selected is not selected
                        else "rescue_same"
                    )

                    rescue_cfg = rel_cfg
                    if (
                        rescue_cfg.provider == "gemini"
                        and "packyapi.com" in (rescue_cfg.base_url or "").lower()
                    ):
                        rescue_cfg = replace(
                            rescue_cfg,
                            model=_choose_packy_gemini_rescue_model(
                                str(rescue_cfg.model or ""), msg
                            ),
                        )
                    rescue_cfg = replace(
                        rescue_cfg, max_tokens=min(int(rescue_cfg.max_tokens), 900)
                    )

                    yield emit(
                        "tool_call",
                        "BookRelations",
                        {
                            "tool": "llm.generate_text",
                            "provider": rescue_cfg.provider,
                            "model": rescue_cfg.model,
                            "max_tokens": rescue_cfg.max_tokens,
                            "note": f"rescue_retry:{msg[:70]}",
                        },
                    )
                    rescue_user = (
                        f"Book filename: {filename}\n"
                        f"Book source_id: {source_id}\n"
                        f"Summaries available: {total}\n"
                        f"Included in this analysis: {len(rescue_selected)} (selection={rescue_note})\n\n"
                        "ChapterSummariesJSON:\n"
                        f"{_json_compact(rescue_selected)}\n"
                    )
                    try:
                        out = await _generate_text_with_timeout(
                            system_prompt=system,
                            user_prompt=rescue_user,
                            cfg=rescue_cfg,
                            timeout_s=120.0,
                            label="book_relations",
                            attempt=2,
                        )
                    except LLMError as e2:
                        msg2 = str(e2)
                        if (
                            rescue_cfg.provider == "gemini"
                            and _is_model_unavailable_error(msg2)
                        ):
                            openai_cfg = resolve_llm_config(
                                {
                                    "llm": {
                                        "provider": "openai",
                                        "temperature": rescue_cfg.temperature,
                                        "max_tokens": int(rescue_cfg.max_tokens),
                                    }
                                }
                            )
                            openai_cfg = replace(
                                openai_cfg,
                                max_tokens=min(int(rescue_cfg.max_tokens), 900),
                            )
                            yield emit(
                                "tool_call",
                                "BookRelations",
                                {
                                    "tool": "llm.generate_text",
                                    "provider": openai_cfg.provider,
                                    "model": openai_cfg.model,
                                    "max_tokens": openai_cfg.max_tokens,
                                    "note": f"fallback_openai:{msg2[:70]}",
                                },
                            )
                            out = await _generate_text_with_timeout(
                                system_prompt=system,
                                user_prompt=rescue_user,
                                cfg=openai_cfg,
                                timeout_s=120.0,
                                label="book_relations",
                                attempt=3,
                            )
                        else:
                            raise
                else:
                    yield emit("run_error", "BookRelations", {"error": msg})
                    mark_run_failed(msg)
                    yield emit("run_completed", "Director", {})
                    return
            except Exception as e:
                msg = f"book_relations_failed:{type(e).__name__}"
                yield emit("run_error", "BookRelations", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            yield emit(
                "agent_output",
                "BookRelations",
                {"step": "parse_json", "step_index": 3, "step_total": 4},
            )
            cleaned = strip_think_blocks(out).strip()
            parsed: Any | None = None
            parse_err: str | None = None
            relation_edges_count = 0
            try:
                parsed = parse_json_loose(cleaned)
                normalized, relation_edges_count = _normalize_relations_graph(parsed)
                if normalized is not None:
                    parsed = normalized
            except Exception as e:
                parse_err = type(e).__name__
                yield emit(
                    "agent_output",
                    "BookRelations",
                    {
                        "error": f"book_relations_json_parse_failed:{parse_err}",
                        "soft_fail": True,
                    },
                )

            if parse_err or relation_edges_count <= 0:
                try:
                    yield emit(
                        "tool_call",
                        "BookRelations",
                        {
                            "tool": "llm.generate_text",
                            "provider": rel_cfg.provider,
                            "model": rel_cfg.model,
                            "max_tokens": min(int(rel_cfg.max_tokens), 900),
                            "note": "repair_json_after_parse_fail_or_empty_edges",
                        },
                    )
                    repaired, repaired_err = await _repair_book_relations_json(
                        source_text=cleaned,
                        base_cfg=rel_cfg,
                        max_tokens=min(int(rel_cfg.max_tokens), 900),
                    )
                    repaired_norm, repaired_n = _normalize_relations_graph(repaired)
                    if repaired_norm is not None and repaired_n > 0:
                        parsed = repaired_norm
                        relation_edges_count = repaired_n
                        parse_err = None
                    elif parse_err is None:
                        parse_err = repaired_err or "repair_failed"
                except Exception as e:
                    if parse_err is None:
                        parse_err = f"repair_failed:{type(e).__name__}"

            def _relation_edges_list(obj: Any) -> list[dict[str, Any]]:
                if not isinstance(obj, dict) or not isinstance(obj.get("edges"), list):
                    return []
                return [e for e in obj.get("edges") or [] if isinstance(e, dict)]

            def _has_meaningful_relation_edges(edges: list[dict[str, Any]]) -> bool:
                for edge in edges:
                    edge_type = str(edge.get("type") or "").strip().lower()
                    label = str(edge.get("label") or "").strip().lower()
                    if edge_type and edge_type != "structure":
                        return True
                    if label and label != "book_progression":
                        return True
                return False

            def _merge_relation_edges(
                primary: list[dict[str, Any]], secondary: list[dict[str, Any]]
            ) -> list[dict[str, Any]]:
                best: dict[tuple[int, int, str, str], dict[str, Any]] = {}
                for group in (primary, secondary):
                    for raw_edge in group:
                        normalized_group, _ = _normalize_relations_graph(
                            {"edges": [raw_edge]}
                        )
                        if normalized_group is None:
                            continue
                        for edge in normalized_group.get("edges") or []:
                            key = (
                                int(edge.get("from") or 0),
                                int(edge.get("to") or 0),
                                str(edge.get("type") or "relation"),
                                str(edge.get("label") or ""),
                            )
                            prev = best.get(key)
                            if prev is None or float(edge.get("strength") or 0) > float(
                                prev.get("strength") or 0
                            ):
                                best[key] = edge
                return sorted(
                    best.values(),
                    key=lambda edge: (
                        -float(edge.get("strength") or 0),
                        int(edge.get("from") or 0),
                        int(edge.get("to") or 0),
                        str(edge.get("type") or ""),
                        str(edge.get("label") or ""),
                    ),
                )[:60]

            heuristic_edges = heuristic_relations_from_selected(selected)
            parsed_edges = _relation_edges_list(parsed)
            parsed_has_signal = _has_meaningful_relation_edges(parsed_edges)
            heuristic_has_signal = _has_meaningful_relation_edges(heuristic_edges)

            if (relation_edges_count <= 0 or not parsed_has_signal) and heuristic_edges:
                if heuristic_has_signal or relation_edges_count <= 0:
                    replace_reason = (
                        "heuristic_fallback"
                        if relation_edges_count <= 0
                        else "heuristic_replace_generic"
                    )
                    parsed = {"edges": heuristic_edges}
                    relation_edges_count = len(heuristic_edges)
                    parse_err = None
                    yield emit(
                        "agent_output",
                        "BookRelations",
                        {
                            "step": replace_reason,
                            "soft_fail": True,
                            "edges": relation_edges_count,
                        },
                    )
            elif parsed_has_signal and heuristic_has_signal and relation_edges_count < 6:
                merged_edges = _merge_relation_edges(parsed_edges, heuristic_edges)
                if len(merged_edges) > relation_edges_count:
                    parsed = {"edges": merged_edges}
                    relation_edges_count = len(merged_edges)
                    yield emit(
                        "agent_output",
                        "BookRelations",
                        {
                            "step": "heuristic_enhance",
                            "soft_fail": True,
                            "edges": relation_edges_count,
                        },
                    )

            record: dict[str, Any] = {
                "book_source_id": source_id,
                "filename": filename,
                "generated_at": _now_utc().isoformat(),
                "selection": {
                    "total": total,
                    "used": len(selected),
                    "strategy": selection_note,
                },
                "graph": parsed
                if isinstance(parsed, dict)
                else {"text": cleaned[:8000]},
            }
            if parse_err:
                record["parse_error"] = parse_err

            tags = [f"book_source:{source_id}", "book_relations"]
            if filename_tag:
                tags.append(f"book_file:{filename_tag}")
            kb_tags = ",".join(tags)
            title = (
                f"章节关系图谱（{filename[:40]}）"
                if output_lang == "zh"
                else f"Chapter relations ({filename[:40]})"
            )
            yield emit(
                "agent_output",
                "BookRelations",
                {"step": "persist_graph", "step_index": 4, "step_total": 4},
            )
            with get_session() as s_rel:
                kb = KBChunk(
                    project_id=project_id,
                    source_type="book_relations",
                    title=title,
                    content=json_dumps(record),
                    tags=kb_tags,
                )
                s_rel.add(kb)
                s_rel.commit()
                s_rel.refresh(kb)

            edges_count = relation_edges_count
            if (
                edges_count <= 0
                and isinstance(parsed, dict)
                and isinstance(parsed.get("edges"), list)
            ):
                edges_count = len(parsed.get("edges") or [])

            yield emit(
                "artifact",
                "BookRelations",
                {
                    "artifact_type": "book_relations",
                    "source_id": source_id,
                    "kb_chunk_id": kb.id,
                    "edges": edges_count,
                    "parse_error": parse_err,
                },
            )
            yield emit(
                "agent_finished",
                "BookRelations",
                {"kb_chunk_id": kb.id, "edges": edges_count},
            )

            mark_run_completed()
            yield emit("run_completed", "Director", {})
            return

        if kind == "book_characters":
            source_id = str(
                payload.get("source_id") or payload.get("book_source_id") or ""
            ).strip()
            if not source_id:
                msg = "source_id_required"
                yield emit("run_error", "BookCharacters", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            try:
                src = load_continue_source(source_id)
            except ContinueSourceError as e:
                msg = f"continue_source_load_failed:{str(e)}"
                yield emit("run_error", "BookCharacters", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            filename = str((src.meta or {}).get("filename") or "").strip() or "book"
            filename_tag = filename.replace(",", " ").strip()[:64]

            with get_session() as s_sum:
                rows = list(
                    s_sum.exec(
                        select(KBChunk).where(
                            KBChunk.project_id == project_id,
                            KBChunk.source_type == "book_summary",
                            KBChunk.tags.like(f"%book_source:{source_id}%"),
                        )
                    )
                )

            if not rows:
                msg = "book_characters_requires_book_summaries"
                yield emit("run_error", "BookCharacters", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            def _safe_list(v: object, max_items: int = 8) -> list[str]:
                if not isinstance(v, list):
                    return []
                out: list[str] = []
                for x in v[: max(0, int(max_items))]:
                    if isinstance(x, str) and x.strip():
                        out.append(x.strip())
                return out

            def _safe_str(v: object, max_len: int = 600) -> str:
                if not isinstance(v, str):
                    return ""
                s = v.strip()
                if len(s) > max_len:
                    s = s[:max_len].rstrip() + "…"
                return s

            char_parts: list[dict[str, Any]] = []
            for r in rows:
                idx: int | None = None
                part_kind = "chunk"
                m = re.search(r"(?:^|,|\s)book_chapter:(\d+)(?:$|,|\s)", r.tags or "")
                if m:
                    part_kind = "chapter"
                    try:
                        idx = int(m.group(1))
                    except Exception:
                        idx = None
                else:
                    m = re.search(r"(?:^|,|\s)book_chunk:(\d+)(?:$|,|\s)", r.tags or "")
                    if m:
                        try:
                            idx = int(m.group(1))
                        except Exception:
                            idx = None

                chapter_label: str | None = None
                chapter_title: str | None = None
                data_summary: dict[str, Any] | None = None
                try:
                    obj = json.loads(r.content)
                    if isinstance(obj, dict):
                        seg_mode = str(obj.get("segment_mode") or "").strip().lower()
                        if seg_mode == "chapter":
                            part_kind = "chapter"
                        if idx is None and obj.get("chunk_index") is not None:
                            try:
                                idx = int(obj.get("chunk_index") or 0) or None
                            except Exception:
                                idx = None
                        if idx is None and obj.get("chapter_index") is not None:
                            try:
                                idx = int(obj.get("chapter_index") or 0) or None
                            except Exception:
                                idx = None
                        if obj.get("chapter_label") is not None:
                            chapter_label = (
                                _safe_str(obj.get("chapter_label"), 120) or None
                            )
                        if obj.get("chapter_title") is not None:
                            chapter_title = (
                                _safe_str(obj.get("chapter_title"), 160) or None
                            )
                        if isinstance(obj.get("data"), dict):
                            data_summary = obj.get("data")  # type: ignore[assignment]
                except Exception:
                    data_summary = None

                if idx is None:
                    continue

                if isinstance(data_summary, dict):
                    data_summary = _normalize_book_summary_data(data_summary)
                    char_parts.append(
                        {
                            "segment_mode": part_kind,
                            "index": idx,
                            "chapter_label": chapter_label,
                            "chapter_title": chapter_title,
                            "summary": _safe_str(data_summary.get("summary"), 280),
                            "key_events": _safe_list(data_summary.get("key_events"), 8),
                            "characters": _safe_list(
                                data_summary.get("characters"), 16
                            ),
                            "open_loops": _safe_list(
                                data_summary.get("open_loops"), 10
                            ),
                        }
                    )
                else:
                    char_parts.append(
                        {
                            "segment_mode": part_kind,
                            "index": idx,
                            "chapter_label": chapter_label,
                            "chapter_title": chapter_title,
                            "summary": _safe_str(r.content, 280),
                            "key_events": [],
                            "characters": [],
                            "open_loops": [],
                        }
                    )

            # Prefer chapter-based summaries when available.
            if any(str(s.get("segment_mode") or "") == "chapter" for s in char_parts):
                char_parts = [
                    s
                    for s in char_parts
                    if str(s.get("segment_mode") or "") == "chapter"
                ]

            known_character_names: list[str] = []
            for part in char_parts:
                known_character_names.extend(_safe_list(part.get("characters"), 16))
                known_character_names.extend(
                    _infer_character_names_from_title(
                        part.get("chapter_title"), max_items=8
                    )
                )
            known_character_names = _dedupe_keep_order(
                known_character_names, max_items=128
            )
            for part in char_parts:
                inferred_names = _infer_character_names_from_text(
                    " ".join(
                        x
                        for x in (
                            _safe_str(part.get("chapter_title"), 160),
                            _safe_str(part.get("summary"), 600),
                            "；".join(_safe_list(part.get("key_events"), 8)),
                        )
                        if x
                    ),
                    known_names=known_character_names,
                    max_items=16,
                )
                if inferred_names:
                    part["characters"] = _dedupe_keep_order(
                        _safe_list(part.get("characters"), 16) + inferred_names,
                        max_items=16,
                    )

            char_parts.sort(key=lambda x: int(x.get("index") or 0))
            total = len(char_parts)
            if total <= 0:
                msg = "book_characters_no_valid_summaries"
                yield emit("run_error", "BookCharacters", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            selected: list[dict[str, Any]] = char_parts
            selection_note = "all"

            def compact_for_characters(p: dict[str, Any]) -> dict[str, Any]:
                out: dict[str, Any] = {
                    "index": int(p.get("index") or 0),
                    "summary": _safe_str(p.get("summary"), 220),
                }
                if p.get("chapter_label"):
                    out["chapter_label"] = _safe_str(p.get("chapter_label"), 80)
                if p.get("chapter_title"):
                    out["chapter_title"] = _safe_str(p.get("chapter_title"), 120)
                ke = _safe_list(p.get("key_events"), 8)
                if ke:
                    out["key_events"] = ke
                chs = _safe_list(p.get("characters"), 16)
                if chs:
                    out["characters"] = chs
                ol = _safe_list(p.get("open_loops"), 10)
                if ol:
                    out["open_loops"] = ol
                return out

            parts_compact = [compact_for_characters(p) for p in char_parts]

            def head_tail(head: int, tail: int) -> list[dict[str, Any]]:
                if head < 0:
                    head = 0
                if tail < 0:
                    tail = 0
                if len(parts_compact) <= head + tail:
                    return parts_compact
                return parts_compact[:head] + parts_compact[-tail:]

            if total <= 60:
                selected = parts_compact
                selection_note = "all"
            elif total <= 140:
                selected = head_tail(12, 48)
                selection_note = "first_12_plus_last_48"
            else:
                selected = head_tail(12, 60)
                selection_note = "first_12_plus_last_60"

            yield emit(
                "agent_started",
                "BookCharacters",
                {
                    "source_id": source_id,
                    "filename": filename,
                    "segment_mode": "chapter"
                    if any(p.get("segment_mode") == "chapter" for p in selected)
                    else "chunk",
                    "total_summaries": total,
                    "used_summaries": len(selected),
                    "selection": selection_note,
                },
            )
            yield emit(
                "agent_output",
                "BookCharacters",
                {"step": "prepare_prompt", "step_index": 1, "step_total": 4},
            )

            char_cfg0 = llm_cfg()
            char_model = str(char_cfg0.model or "").strip()
            if (
                char_cfg0.provider == "gemini"
                and "packyapi.com" in (char_cfg0.base_url or "").lower()
            ):
                if "flash" not in char_model.lower():
                    char_model = "gemini-3-flash-preview"
            char_cfg = replace(
                char_cfg0,
                temperature=0.2,
                max_tokens=max(600, min(int(char_cfg0.max_tokens or 900), 1600)),
                model=char_model or char_cfg0.model,
            )

            base_low = (char_cfg.base_url or "").lower()
            prompt_target_chars = 32_000 if "packyapi.com" in base_low else 70_000
            while (
                len(selected) > 32
                and len(_json_compact(selected)) > prompt_target_chars
            ):
                head = 10
                tail = max(18, min(40, len(selected) - head))
                selected = selected[:head] + selected[-tail:]
                selection_note = f"head_{head}_tail_{tail}"
            yield emit(
                "tool_call",
                "BookCharacters",
                {
                    "tool": "llm.generate_text",
                    "provider": char_cfg.provider,
                    "model": char_cfg.model,
                    "max_tokens": char_cfg.max_tokens,
                },
            )
            yield emit(
                "agent_output",
                "BookCharacters",
                {"step": "llm.generate_text", "step_index": 2, "step_total": 4},
            )

            system = (
                "You are BookCharacterGraphAgent. Extract character cards and relationships from chapter summaries of a novel. "
                f"{lang_hint_json} "
                "Return JSON only. Do NOT include chain-of-thought. "
                "Prefer the main cast; avoid tiny one-off characters. "
                "IDs must be stable: set character.id equal to character.name, and relation.source/target must match character.id. "
                "Relation types allowed: family, love, friend, enemy, master_servant, mentor, rival, ally, colleague, other. "
                "Constraints: characters<=40, relations<=120; keep all string fields concise. "
                "Schema:\n"
                "{\n"
                '  "characters": [\n'
                '    {"id":"林黛玉","name":"林黛玉","gender":"女","identity":"...","personality":"...","plot":"...","chapters":[1,2]}\n'
                "  ],\n"
                '  "relations": [\n'
                '    {"source":"贾宝玉","target":"林黛玉","type":"love","label":"知己/倾慕","detail":"...","chapters":[1,2],"strength":0.8}\n'
                "  ]\n"
                "}\n"
            )
            user = (
                f"Book filename: {filename}\n"
                f"Book source_id: {source_id}\n"
                f"Summaries available: {total}\n"
                f"Included in this analysis: {len(selected)} (selection={selection_note})\n\n"
                "ChapterSummariesJSON:\n"
                f"{_json_compact(selected)}\n"
            )

            try:
                out = await _generate_text_with_timeout(
                    system_prompt=system,
                    user_prompt=user,
                    cfg=char_cfg,
                    timeout_s=120.0,
                    label="book_characters",
                    attempt=1,
                )
            except LLMError as e:
                msg = str(e)
                if _is_retryable_gateway_error(msg):
                    rescue_selected = selected
                    if len(rescue_selected) > 36:
                        rescue_selected = rescue_selected[:8] + rescue_selected[-28:]
                    rescue_note = (
                        "rescue_head_8_tail_28"
                        if rescue_selected is not selected
                        else "rescue_same"
                    )

                    rescue_cfg = char_cfg
                    if (
                        rescue_cfg.provider == "gemini"
                        and "packyapi.com" in (rescue_cfg.base_url or "").lower()
                    ):
                        rescue_cfg = replace(
                            rescue_cfg,
                            model=_choose_packy_gemini_rescue_model(
                                str(rescue_cfg.model or ""), msg
                            ),
                        )
                    rescue_cfg = replace(
                        rescue_cfg, max_tokens=min(int(rescue_cfg.max_tokens), 1000)
                    )

                    yield emit(
                        "tool_call",
                        "BookCharacters",
                        {
                            "tool": "llm.generate_text",
                            "provider": rescue_cfg.provider,
                            "model": rescue_cfg.model,
                            "max_tokens": rescue_cfg.max_tokens,
                            "note": f"rescue_retry:{msg[:70]}",
                        },
                    )
                    rescue_user = (
                        f"Book filename: {filename}\n"
                        f"Book source_id: {source_id}\n"
                        f"Summaries available: {total}\n"
                        f"Included in this analysis: {len(rescue_selected)} (selection={rescue_note})\n\n"
                        "ChapterSummariesJSON:\n"
                        f"{_json_compact(rescue_selected)}\n"
                    )
                    try:
                        out = await _generate_text_with_timeout(
                            system_prompt=system,
                            user_prompt=rescue_user,
                            cfg=rescue_cfg,
                            timeout_s=120.0,
                            label="book_characters",
                            attempt=2,
                        )
                    except LLMError as e2:
                        msg2 = str(e2)
                        if (
                            rescue_cfg.provider == "gemini"
                            and _is_model_unavailable_error(msg2)
                        ):
                            openai_cfg = resolve_llm_config(
                                {
                                    "llm": {
                                        "provider": "openai",
                                        "temperature": rescue_cfg.temperature,
                                        "max_tokens": int(rescue_cfg.max_tokens),
                                    }
                                }
                            )
                            openai_cfg = replace(
                                openai_cfg,
                                max_tokens=min(int(rescue_cfg.max_tokens), 1000),
                            )
                            yield emit(
                                "tool_call",
                                "BookCharacters",
                                {
                                    "tool": "llm.generate_text",
                                    "provider": openai_cfg.provider,
                                    "model": openai_cfg.model,
                                    "max_tokens": openai_cfg.max_tokens,
                                    "note": f"fallback_openai:{msg2[:70]}",
                                },
                            )
                            out = await _generate_text_with_timeout(
                                system_prompt=system,
                                user_prompt=rescue_user,
                                cfg=openai_cfg,
                                timeout_s=120.0,
                                label="book_characters",
                                attempt=3,
                            )
                        else:
                            raise
                else:
                    yield emit("run_error", "BookCharacters", {"error": msg})
                    mark_run_failed(msg)
                    yield emit("run_completed", "Director", {})
                    return
            except Exception as e:
                msg = f"book_characters_failed:{type(e).__name__}"
                yield emit("run_error", "BookCharacters", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            yield emit(
                "agent_output",
                "BookCharacters",
                {"step": "parse_json", "step_index": 3, "step_total": 4},
            )
            cleaned = strip_think_blocks(out).strip()
            parsed: Any | None = None
            parse_err: str | None = None
            char_count = 0
            rel_count = 0
            try:
                parsed = parse_json_loose(cleaned)
                normalized_graph, char_count, rel_count = _normalize_characters_graph(
                    parsed
                )
                if normalized_graph is not None:
                    parsed = normalized_graph
            except Exception as e:
                parse_err = type(e).__name__
                yield emit(
                    "agent_output",
                    "BookCharacters",
                    {
                        "error": f"book_characters_json_parse_failed:{parse_err}",
                        "soft_fail": True,
                    },
                )

            if parse_err or char_count <= 0 or rel_count <= 0:
                try:
                    yield emit(
                        "tool_call",
                        "BookCharacters",
                        {
                            "tool": "llm.generate_text",
                            "provider": char_cfg.provider,
                            "model": char_cfg.model,
                            "max_tokens": min(int(char_cfg.max_tokens), 1100),
                            "note": "repair_json_after_parse_fail_or_incomplete_graph",
                        },
                    )
                    repaired, repaired_err = await _repair_book_characters_json(
                        source_text=cleaned,
                        base_cfg=char_cfg,
                        max_tokens=min(int(char_cfg.max_tokens), 1100),
                    )
                    repaired_graph, repaired_chars, repaired_rels = _normalize_characters_graph(
                        repaired
                    )
                    if repaired_graph is not None and (
                        repaired_chars > 0 or repaired_rels > 0
                    ):
                        parsed = repaired_graph
                        char_count = repaired_chars
                        rel_count = repaired_rels
                        parse_err = None
                    elif parse_err is None:
                        parse_err = repaired_err or "repair_failed"
                except Exception as e:
                    if parse_err is None:
                        parse_err = f"repair_failed:{type(e).__name__}"

            if char_count <= 0 or rel_count <= 0:
                heuristic_graph = _heuristic_characters_graph_from_summaries(
                    selected, lang=output_lang
                )
                heuristic_norm, heuristic_chars, heuristic_rels = _normalize_characters_graph(
                    heuristic_graph
                )
                if heuristic_norm is not None and heuristic_chars > 0:
                    if isinstance(parsed, dict) and char_count > 0 and rel_count <= 0:
                        parsed = {
                            "characters": parsed.get("characters")
                            if isinstance(parsed.get("characters"), list)
                            else (heuristic_norm.get("characters") or []),
                            "relations": heuristic_norm.get("relations") or [],
                        }
                        char_count = len(parsed.get("characters") or [])
                        rel_count = len(parsed.get("relations") or [])
                    else:
                        parsed = heuristic_norm
                        char_count = heuristic_chars
                        rel_count = heuristic_rels
                    parse_err = None
                    yield emit(
                        "agent_output",
                        "BookCharacters",
                        {
                            "step": "heuristic_fallback",
                            "soft_fail": True,
                            "characters": char_count,
                            "relations": rel_count,
                        },
                    )

            record: dict[str, Any] = {
                "book_source_id": source_id,
                "filename": filename,
                "generated_at": _now_utc().isoformat(),
                "selection": {
                    "total": total,
                    "used": len(selected),
                    "strategy": selection_note,
                },
                "graph": parsed
                if isinstance(parsed, dict)
                else {"text": cleaned[:8000]},
            }
            if parse_err:
                record["parse_error"] = parse_err

            tags = [f"book_source:{source_id}", "book_characters"]
            if filename_tag:
                tags.append(f"book_file:{filename_tag}")
            kb_tags = ",".join(tags)
            title = (
                f"\u4eba\u7269\u5173\u7cfb\u56fe\u8c31\uff08{filename[:40]}\uff09"
                if output_lang == "zh"
                else f"Character graph ({filename[:40]})"
            )
            yield emit(
                "agent_output",
                "BookCharacters",
                {"step": "persist_graph", "step_index": 4, "step_total": 4},
            )
            with get_session() as s_char:
                kb = KBChunk(
                    project_id=project_id,
                    source_type="book_characters",
                    title=title,
                    content=json_dumps(record),
                    tags=kb_tags,
                )
                s_char.add(kb)
                s_char.commit()
                s_char.refresh(kb)


            yield emit(
                "artifact",
                "BookCharacters",
                {
                    "artifact_type": "book_characters",
                    "source_id": source_id,
                    "kb_chunk_id": kb.id,
                    "characters": char_count,
                    "relations": rel_count,
                    "parse_error": parse_err,
                },
            )
            yield emit(
                "agent_finished",
                "BookCharacters",
                {
                    "kb_chunk_id": kb.id,
                    "characters": char_count,
                    "relations": rel_count,
                },
            )

            mark_run_completed()
            yield emit("run_completed", "Director", {})
            return

        kb_mode = "weak"
        try:
            kb_mode = str(
                ((project.settings or {}).get("kb") or {}).get("mode") or "weak"
            )
        except Exception:
            kb_mode = "weak"

        # Agent: ConfigAutofill
        # - Weak mode: LLM can creatively fill missing fields.
        # - Strong mode: avoid inventing canon/settings. (User should provide KB or explicit settings.)
        yield emit("agent_started", "ConfigAutofill", {"kb_mode": kb_mode})
        if kind.startswith("book_"):
            # Book continuation flows are derived from the uploaded manuscript + summaries.
            # Avoid random autofill that could conflict with existing canon.
            yield emit(
                "agent_output",
                "ConfigAutofill",
                {
                    "skipped": True,
                    "reason": "book_mode_skip_autofill",
                    "step": "skipped",
                    "step_index": 1,
                    "step_total": 1,
                },
            )
            yield emit("agent_finished", "ConfigAutofill", {})
        elif kb_mode == "strong":
            yield emit(
                "agent_output",
                "ConfigAutofill",
                {
                    "skipped": True,
                    "reason": "strong_kb_mode_no_random_autofill",
                    "step": "skipped",
                    "step_index": 1,
                    "step_total": 1,
                },
            )
            yield emit("agent_finished", "ConfigAutofill", {})
        else:
            # ConfigAutofill is best-effort. If the gateway is flaky (e.g. 502 HTML),
            # we should still allow the main pipeline (Extractor/Outliner/Writer) to run.
            patch: dict[str, Any] | None = None
            try:
                yield emit(
                    "agent_output",
                    "ConfigAutofill",
                    {"step": "prepare_prompt", "step_index": 1, "step_total": 4},
                )
                system = (
                    "You are ConfigAutofillAgent for a novel writing platform. "
                    f"{lang_hint_json} "
                    "Given a partial project settings JSON, produce a JSON patch that fills missing fields only. "
                    "Do not overwrite user-provided fields. Output JSON only."
                )
                user = (
                    "CurrentSettingsJSON:\n"
                    f"{json_dumps(project.settings or {})}\n\n"
                    "Return a JSON object with keys you want to add. Keep it small and practical. "
                    "Do not use markdown fences. Keep strings short and only fill fields that are clearly missing.\n"
                    "Suggested schema (only include what is missing):\n"
                    "{\n"
                    '  "story": {\n'
                    '    "genre": "...",\n'
                    '    "logline": "...",\n'
                    '    "style_guide": "...",\n'
                    '    "world": "...",\n'
                    '    "characters": [ {"name":"...","role":"...","personality":"...","goal":"..."} ]\n'
                    "  },\n"
                    '  "writing": { "chapter_count": 10, "chapter_words": 1200 }\n'
                    "}\n"
                )
                cfg, cfg_note = _structured_agent_cfg(
                    llm_cfg(), min_max_tokens=640, temperature=0.2
                )
                tool_call_data = {
                    "tool": "llm.generate_text",
                    "provider": cfg.provider,
                    "model": cfg.model,
                }
                if cfg_note:
                    tool_call_data["note"] = cfg_note
                yield emit(
                    "tool_call",
                    "ConfigAutofill",
                    tool_call_data,
                )
                yield emit(
                    "agent_output",
                    "ConfigAutofill",
                    {"step": "llm.generate_text", "step_index": 2, "step_total": 4},
                )
                try:
                    autofill_text = await generate_text(
                        system_prompt=system, user_prompt=user, cfg=cfg
                    )
                except LLMError as e:
                    msg = str(e)
                    fallback_cfg = (
                        _openai_structured_fallback_cfg(
                            min_max_tokens=640, temperature=0.2
                        )
                        if _should_openai_fallback_structured_generate(cfg, msg)
                        else None
                    )
                    if fallback_cfg is None:
                        raise
                    yield emit(
                        "tool_call",
                        "ConfigAutofill",
                        {
                            "tool": "llm.generate_text",
                            "provider": fallback_cfg.provider,
                            "model": fallback_cfg.model,
                            "max_tokens": fallback_cfg.max_tokens,
                            "note": "fallback_openai_structured",
                        },
                    )
                    autofill_text = await generate_text(
                        system_prompt=system,
                        user_prompt=user,
                        cfg=fallback_cfg,
                    )
                    cfg = fallback_cfg
                yield emit(
                    "agent_output",
                    "ConfigAutofill",
                    {"step": "parse_json", "step_index": 3, "step_total": 4},
                )
                parsed, repaired_json, repair_model = await _parse_or_repair_json(
                    label="config_autofill",
                    raw_text=autofill_text,
                    schema_hint='{"story":{"genre":"...","logline":"..."},"writing":{"chapter_count":10,"chapter_words":1200}}',
                    base_cfg=cfg,
                    min_max_tokens=640,
                )
                if repaired_json:
                    yield emit(
                        "agent_output",
                        "ConfigAutofill",
                        {
                            "step": "repair_json",
                            "step_index": 3,
                            "step_total": 4,
                            "model": repair_model,
                        },
                    )
                if isinstance(parsed, dict):
                    patch = parsed
                    with get_session() as s4:
                        p4 = s4.get(Project, project_id)
                        if p4:
                            yield emit(
                                "agent_output",
                                "ConfigAutofill",
                                {
                                    "step": "persist_settings",
                                    "step_index": 4,
                                    "step_total": 4,
                                },
                            )
                            p4.settings = deep_merge(p4.settings or {}, patch)  # type: ignore[assignment]
                            p4.updated_at = _now_utc()
                            s4.add(p4)
                            s4.commit()
                            s4.refresh(p4)
                            project.settings = p4.settings
                yield emit(
                    "agent_output",
                    "ConfigAutofill",
                    {
                        "patch_keys": list(patch.keys())
                        if isinstance(patch, dict)
                        else []
                    },
                )
            except LLMError as e:
                msg = str(e)
                yield emit(
                    "agent_output",
                    "ConfigAutofill",
                    {"error": msg, "soft_fail": True},
                )
            except Exception as e:
                msg = f"config_autofill_failed:{type(e).__name__}"
                yield emit(
                    "agent_output",
                    "ConfigAutofill",
                    {"error": msg, "soft_fail": True},
                )
            yield emit("agent_finished", "ConfigAutofill", {})

        # Agent: Extractor (continue mode)
        story_state: dict[str, Any] | None = None
        source_text = ""
        source_id = payload.get("source_id")
        excerpt_mode = str(payload.get("source_slice_mode") or "tail")
        try:
            excerpt_chars = int(payload.get("source_slice_chars") or 8000)
        except Exception:
            excerpt_chars = 8000
        excerpt_chars = max(200, min(excerpt_chars, 50_000))

        if kind == "continue":
            if isinstance(source_id, str) and source_id.strip():
                try:
                    yield emit(
                        "tool_call",
                        "Extractor",
                        {
                            "tool": "continue_sources.load_excerpt",
                            "source_id": source_id.strip(),
                            "mode": excerpt_mode,
                            "limit_chars": excerpt_chars,
                        },
                    )
                    source_text = load_continue_source_excerpt(
                        source_id=source_id.strip(),
                        mode=excerpt_mode,
                        limit_chars=excerpt_chars,
                    ).strip()
                    yield emit(
                        "tool_result",
                        "Extractor",
                        {
                            "tool": "continue_sources.load_excerpt",
                            "chars": len(source_text),
                        },
                    )
                except ContinueSourceError as e:
                    yield emit(
                        "agent_output",
                        "Extractor",
                        {"error": f"continue_source_load_failed:{str(e)}"},
                    )
                    source_text = ""
                except Exception as e:
                    yield emit(
                        "agent_output",
                        "Extractor",
                        {"error": f"continue_source_load_failed:{type(e).__name__}"},
                    )
                    source_text = ""
            else:
                source_text = str(payload.get("source_text") or "").strip()

        if kind == "continue" and source_text:
            try:
                yield emit("agent_started", "Extractor", {})
                yield emit(
                    "agent_output",
                    "Extractor",
                    {"step": "prepare_prompt", "step_index": 1, "step_total": 4},
                )
                system = (
                    "You are ExtractorAgent. Extract a structured StoryState from an existing manuscript excerpt. "
                    f"{lang_hint_json} "
                    "Output JSON only."
                )
                extractor_excerpt = _clip_text(source_text, 6000)
                user = (
                    "Extract the following fields:\n"
                    "{\n"
                    '  "summary_so_far": "<=220 chars",\n'
                    '  "characters": [ {"name":"...","current_status":"<=80 chars","relationships":"<=100 chars"} ],\n'
                    '  "world": "<=160 chars",\n'
                    '  "timeline": [ {"event":"<=80 chars","when":"<=40 chars"} ],\n'
                    '  "open_loops": ["<=60 chars"],\n'
                    '  "style_profile": {"pov":"...","tense":"...","tone":"..."}\n'
                    "}\n\n"
                    "Keep it compact: max 8 characters, max 6 timeline items, max 6 open loops. "
                    "No markdown fences, no commentary.\n\n"
                    "Manuscript (excerpt):\n"
                    f"{extractor_excerpt}\n"
                )
                cfg, cfg_note = _structured_agent_cfg(
                    llm_cfg(), min_max_tokens=900, temperature=0.2
                )
                tool_call_data = {
                    "tool": "llm.generate_text",
                    "provider": cfg.provider,
                    "model": cfg.model,
                }
                if cfg_note:
                    tool_call_data["note"] = cfg_note
                yield emit(
                    "tool_call",
                    "Extractor",
                    tool_call_data,
                )
                yield emit(
                    "agent_output",
                    "Extractor",
                    {"step": "llm.generate_text", "step_index": 2, "step_total": 4},
                )
                try:
                    extracted_text = await generate_text(
                        system_prompt=system, user_prompt=user, cfg=cfg
                    )
                except LLMError as e:
                    msg = str(e)
                    fallback_cfg = (
                        _openai_structured_fallback_cfg(
                            min_max_tokens=900, temperature=0.2
                        )
                        if _should_openai_fallback_structured_generate(cfg, msg)
                        else None
                    )
                    if fallback_cfg is None:
                        raise
                    yield emit(
                        "tool_call",
                        "Extractor",
                        {
                            "tool": "llm.generate_text",
                            "provider": fallback_cfg.provider,
                            "model": fallback_cfg.model,
                            "max_tokens": fallback_cfg.max_tokens,
                            "note": "fallback_openai_structured",
                        },
                    )
                    extracted_text = await generate_text(
                        system_prompt=system,
                        user_prompt=user,
                        cfg=fallback_cfg,
                    )
                    cfg = fallback_cfg
                yield emit(
                    "agent_output",
                    "Extractor",
                    {"step": "parse_json", "step_index": 3, "step_total": 4},
                )
                parsed, repaired_json, repair_model = await _parse_or_repair_json(
                    label="extractor",
                    raw_text=extracted_text,
                    schema_hint='{"summary_so_far":"...","characters":[{"name":"...","current_status":"...","relationships":"..."}],"world":"...","timeline":[{"event":"...","when":"..."}],"open_loops":["..."],"style_profile":{"pov":"...","tense":"...","tone":"..."}}',
                    base_cfg=cfg,
                    min_max_tokens=900,
                )
                if repaired_json:
                    yield emit(
                        "agent_output",
                        "Extractor",
                        {
                            "step": "repair_json",
                            "step_index": 3,
                            "step_total": 4,
                            "model": repair_model,
                        },
                    )
                if isinstance(parsed, dict):
                    story_state = parsed
                    with get_session() as s4b:
                        p4b = s4b.get(Project, project_id)
                        if p4b:
                            yield emit(
                                "agent_output",
                                "Extractor",
                                {
                                    "step": "persist_story_state",
                                    "step_index": 4,
                                    "step_total": 4,
                                },
                            )
                            p4b.settings = deep_merge(
                                p4b.settings or {}, {"story_state": story_state}
                            )  # type: ignore[assignment]
                            p4b.updated_at = _now_utc()
                            s4b.add(p4b)
                            s4b.commit()
                            s4b.refresh(p4b)
                            project.settings = p4b.settings
                yield emit(
                    "agent_output",
                    "Extractor",
                    {"keys": list(story_state.keys()) if story_state else []},
                )
                yield emit(
                    "artifact",
                    "Extractor",
                    {"artifact_type": "story_state", "story_state": story_state},
                )
                yield emit("agent_finished", "Extractor", {})
            except Exception as e:
                # Continue mode should degrade gracefully: keep going without story_state.
                yield emit(
                    "agent_output",
                    "Extractor",
                    {"error": f"extractor_failed:{type(e).__name__}"},
                )
                yield emit("agent_finished", "Extractor", {})

        story = (
            (project.settings or {}).get("story")
            if isinstance((project.settings or {}).get("story"), dict)
            else {}
        )
        writing = (
            (project.settings or {}).get("writing")
            if isinstance((project.settings or {}).get("writing"), dict)
            else {}
        )
        chapter_count = int(writing.get("chapter_count") or 10)
        chapter_words = int(writing.get("chapter_words") or 1200)
        # Per-run overrides (optional; UI may pass these for ad-hoc testing).
        try:
            if payload.get("chapter_words") is not None:
                chapter_words = int(payload.get("chapter_words") or chapter_words)
        except Exception:
            pass
        chapter_words = max(200, min(10_000, int(chapter_words)))
        try:
            chapter_index = int(payload.get("chapter_index") or 1)
        except Exception:
            chapter_index = 1
        chapter_index = max(1, chapter_index)

        # For batch generation, UI may call Outliner once and then run many chapters
        # with skip_outliner=true to avoid repeated outline calls.
        skip_outliner = bool(payload.get("skip_outliner") or False)

        # Agent: Outliner
        outline = None
        if kind in ("outline", "chapter", "continue") and not (
            skip_outliner and kind in ("chapter", "continue")
        ):
            try:
                yield emit("agent_started", "Outliner", {})
                yield emit(
                    "agent_output",
                    "Outliner",
                    {"step": "prepare_prompt", "step_index": 1, "step_total": 5},
                )
                system = (
                    "You are OutlinerAgent. Create a concise chapter outline for a novel. "
                    f"{lang_hint_json} "
                    "Output JSON only."
                )
                if output_lang == "zh":
                    lang_user = (
                        "语言要求：请用简体中文填写所有自然语言字段（title/summary/goal）。"
                        "不要输出英文或中英混排；如果输入里有英文，请先翻译为中文再写。\n\n"
                    )
                    example = '{ "chapters": [ {"index":1,"title":"第1章：……","summary":"……","goal":"……"} ] }'
                else:
                    lang_user = "Language requirement: Use English for all natural language fields.\n\n"
                    example = '{ "chapters": [ {"index":1,"title":"...","summary":"...","goal":"..."} ] }'
                target_desc = (
                    f"Target chapter index: {chapter_index}\n"
                    "Return exactly ONE concise chapter plan for the target chapter only.\n\n"
                    if kind in {"chapter", "continue"}
                    else f"Target chapter_count: {chapter_count}\n\n"
                )
                user = (
                    f"{lang_user}"
                    f"Story info:\n{json_dumps(story)}\n\n"
                    f"StoryState (if any):\n{json_dumps(story_state or {})}\n\n"
                    f"{target_desc}"
                    "Output JSON in the form:\n"
                    f"{example}\n"
                )
                cfg, cfg_note = _structured_agent_cfg(
                    llm_cfg(),
                    min_max_tokens=480 if kind in {"chapter", "continue"} else 900,
                    temperature=0.2,
                )
                tool_call_data = {
                    "tool": "llm.generate_text",
                    "provider": cfg.provider,
                    "model": cfg.model,
                }
                if cfg_note:
                    tool_call_data["note"] = cfg_note
                yield emit(
                    "tool_call",
                    "Outliner",
                    tool_call_data,
                )
                yield emit(
                    "agent_output",
                    "Outliner",
                    {"step": "llm.generate_text", "step_index": 2, "step_total": 5},
                )
                try:
                    outline_text = await generate_text(
                        system_prompt=system, user_prompt=user, cfg=cfg
                    )
                except LLMError as e:
                    msg = str(e)
                    fallback_cfg = (
                        _openai_structured_fallback_cfg(
                            min_max_tokens=(
                                480 if kind in {"chapter", "continue"} else 900
                            ),
                            temperature=0.2,
                        )
                        if _should_openai_fallback_structured_generate(cfg, msg)
                        else None
                    )
                    if fallback_cfg is None:
                        raise
                    yield emit(
                        "tool_call",
                        "Outliner",
                        {
                            "tool": "llm.generate_text",
                            "provider": fallback_cfg.provider,
                            "model": fallback_cfg.model,
                            "max_tokens": fallback_cfg.max_tokens,
                            "note": "fallback_openai_structured",
                        },
                    )
                    outline_text = await generate_text(
                        system_prompt=system,
                        user_prompt=user,
                        cfg=fallback_cfg,
                    )
                    cfg = fallback_cfg
                yield emit(
                    "agent_output",
                    "Outliner",
                    {"step": "parse_json", "step_index": 3, "step_total": 5},
                )
                outline, repaired_json, repair_model = await _parse_or_repair_json(
                    label="outliner",
                    raw_text=outline_text,
                    schema_hint='{"chapters":[{"index":1,"title":"...","summary":"...","goal":"..."}]}',
                    base_cfg=cfg,
                    min_max_tokens=480 if kind in {"chapter", "continue"} else 900,
                )
                if repaired_json:
                    yield emit(
                        "agent_output",
                        "Outliner",
                        {
                            "step": "repair_json",
                            "step_index": 3,
                            "step_total": 5,
                            "model": repair_model,
                        },
                    )
                # Some code-first models may still default to English. If we asked for zh,
                # do a single best-effort translation pass for the natural language fields.
                if (
                    output_lang == "zh"
                    and isinstance(outline, dict)
                    and isinstance(outline.get("chapters"), list)
                ):
                    sample_values: list[str] = []
                    for ch in (outline.get("chapters") or [])[:10]:
                        if not isinstance(ch, dict):
                            continue
                        for k in ("title", "summary", "goal"):
                            v = ch.get(k)
                            if isinstance(v, str) and v.strip():
                                sample_values.append(v.strip())

                    if sample_values and not any(
                        _CJK_RE.search(v) for v in sample_values
                    ):
                        try:
                            yield emit(
                                "agent_output",
                                "Outliner",
                                {
                                    "step": "translate_to_zh",
                                    "step_index": 4,
                                    "step_total": 5,
                                },
                            )
                            system_t = (
                                "You are OutlineTranslatorAgent. "
                                "Convert an outline JSON to Simplified Chinese (zh-CN). "
                                "Translate ONLY natural language string values (title/summary/goal). "
                                "Do NOT change keys, indexes, or structure. Output JSON only."
                            )
                            user_t = f"OutlineJSON:\n{json_dumps(outline)}\n"
                            yield emit(
                                "tool_call",
                                "Outliner",
                                {
                                    "tool": "llm.generate_text",
                                    "provider": cfg.provider,
                                    "model": cfg.model,
                                    "note": "translate_outline_to_zh",
                                },
                            )
                            translated_text = await generate_text(
                                system_prompt=system_t, user_prompt=user_t, cfg=cfg
                            )
                            translated = parse_json_loose(translated_text)
                            if isinstance(translated, dict) and isinstance(
                                translated.get("chapters"), list
                            ):
                                outline = translated
                        except Exception:
                            pass
                    else:
                        yield emit(
                            "agent_output",
                            "Outliner",
                            {
                                "step": "translate_to_zh",
                                "step_index": 4,
                                "step_total": 5,
                                "skipped": True,
                            },
                        )
                if isinstance(outline, dict) and isinstance(
                    outline.get("chapters"), list
                ):
                    yield emit(
                        "agent_output",
                        "Outliner",
                        {"step": "persist_outline", "step_index": 5, "step_total": 5},
                    )
                    with get_session() as s5:
                        p5 = s5.get(Project, project_id)
                        if p5:
                            next_settings = deep_merge(
                                p5.settings or {},
                                {"story": {"outline": outline.get("chapters")}},
                            )
                            p5.settings = next_settings  # type: ignore[assignment]
                            p5.updated_at = _now_utc()
                            s5.add(p5)
                            s5.commit()
                            s5.refresh(p5)
                            project.settings = p5.settings
                    yield emit(
                        "agent_output",
                        "Outliner",
                        {"chapters": len(outline.get("chapters"))},
                    )
                    yield emit(
                        "artifact",
                        "Outliner",
                        {"artifact_type": "outline", "outline": outline},
                    )
                else:
                    yield emit(
                        "agent_output",
                        "Outliner",
                        {"text": "Outline not parsed as expected."},
                    )
                yield emit("agent_finished", "Outliner", {})
            except LLMError as e:
                msg = str(e)
                if kind == "outline":
                    yield emit("run_error", "Outliner", {"error": msg})
                    mark_run_failed(msg)
                    yield emit("run_completed", "Director", {})
                    return
                # For chapter/continue runs, Outliner is helpful but not strictly
                # required. Soft-fail to keep the app usable under flaky gateways.
                yield emit("agent_output", "Outliner", {"error": msg})
                yield emit("agent_finished", "Outliner", {})
                outline = None
            except Exception as e:
                msg = f"outline_failed:{type(e).__name__}"
                if kind == "outline":
                    yield emit("run_error", "Outliner", {"error": msg})
                    mark_run_failed(msg)
                    yield emit("run_completed", "Director", {})
                    return
                yield emit("agent_output", "Outliner", {"error": msg})
                yield emit("agent_finished", "Outliner", {})
                outline = None

        if kind == "outline":
            mark_run_completed()
            yield emit("run_completed", "Director", {})
            return

        # ---- Chapter writing ----

        story_outline = (
            ((project.settings or {}).get("story") or {}).get("outline")
            if isinstance(project.settings, dict)
            else None
        )
        outline_by_index: dict[int, dict[str, Any]] = {}
        if isinstance(story_outline, list):
            for ch in story_outline:
                if not isinstance(ch, dict):
                    continue
                try:
                    idx = int(ch.get("index") or 0)
                except Exception:
                    continue
                if idx > 0:
                    outline_by_index[idx] = ch
        chapter_plan = outline_by_index.get(chapter_index)

        # ---- Book Continue (single chapter) ----
        book_kb_context: list[dict[str, Any]] = []
        book_excerpt_for_writer = ""
        book_recent_chapters_for_writer = ""
        book_recent_chapters_loaded = 0
        book_source_id_for_chapter: str | None = None
        if kind == "book_continue":
            book_source_id = str(
                payload.get("source_id") or payload.get("book_source_id") or ""
            ).strip()
            if not book_source_id:
                msg = "source_id_required"
                yield emit("run_error", "BookContinue", {"error": msg})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return
            book_source_id_for_chapter = book_source_id

            excerpt_mode = str(payload.get("source_slice_mode") or "tail")
            try:
                excerpt_chars = int(payload.get("source_slice_chars") or 8000)
            except Exception:
                excerpt_chars = 8000
            excerpt_chars = max(200, min(excerpt_chars, 50_000))

            yield emit(
                "agent_started",
                "BookContinue",
                {"source_id": book_source_id, "chapter_index": chapter_index},
            )
            yield emit(
                "agent_output",
                "BookContinue",
                {"step": "prepare_context", "step_index": 1, "step_total": 4},
            )

            try:
                yield emit(
                    "tool_call",
                    "BookContinue",
                    {
                        "tool": "continue_sources.load_excerpt",
                        "source_id": book_source_id,
                        "mode": excerpt_mode,
                        "limit_chars": excerpt_chars,
                    },
                )
                book_excerpt = load_continue_source_excerpt(
                    source_id=book_source_id,
                    mode=excerpt_mode,
                    limit_chars=excerpt_chars,
                ).strip()
                book_excerpt_for_writer = book_excerpt
                yield emit(
                    "tool_result",
                    "BookContinue",
                    {
                        "tool": "continue_sources.load_excerpt",
                        "chars": len(book_excerpt),
                    },
                )
                yield emit(
                    "agent_output",
                    "BookContinue",
                    {"step": "load_excerpt", "step_index": 2, "step_total": 4},
                )
            except Exception as e:
                book_excerpt = ""
                yield emit(
                    "tool_result",
                    "BookContinue",
                    {
                        "tool": "continue_sources.load_excerpt",
                        "error": type(e).__name__,
                    },
                )

            # Include the most recently written chapters (if any) as context for multi-chapter continuation,
            # since the uploaded book source itself does not include newly generated chapters.
            try:
                with get_session() as s_prev:
                    prev_rows = list(
                        s_prev.exec(
                            select(Chapter)
                            .where(
                                Chapter.project_id == project_id,
                                Chapter.chapter_index < chapter_index,
                            )
                            .order_by(text("chapter_index DESC"))
                            .limit(2)
                        )
                    )
                if prev_rows:
                    recent_parts: list[str] = []
                    for ch in reversed(prev_rows):
                        md = (ch.markdown or "").strip()
                        if len(md) > 3200:
                            md = md[-3200:]
                        recent_parts.append(
                            f"# Prev Chapter {ch.chapter_index}: {ch.title}\n\n{md}"
                        )
                    book_recent_chapters_for_writer = "\n\n".join(recent_parts).strip()
                    book_recent_chapters_loaded = len(prev_rows)
            except Exception:
                book_recent_chapters_for_writer = ""
                book_recent_chapters_loaded = 0

            with get_session() as s_book:
                state_row = s_book.exec(
                    select(KBChunk)
                    .where(
                        KBChunk.project_id == project_id,
                        KBChunk.source_type == "book_state",
                        KBChunk.tags.like(f"%book_source:{book_source_id}%"),
                    )
                    .order_by(text("created_at DESC"))
                ).first()
                summary_rows = list(
                    s_book.exec(
                        select(KBChunk)
                        .where(
                            KBChunk.project_id == project_id,
                            KBChunk.source_type == "book_summary",
                            KBChunk.tags.like(f"%book_source:{book_source_id}%"),
                        )
                        .order_by(text("created_at DESC"))
                        .limit(6)
                    )
                )

            if not state_row:
                msg = "book_state_missing"
                yield emit("run_error", "BookContinue", {"error": msg})
                yield emit("agent_finished", "BookContinue", {})
                mark_run_failed(msg)
                yield emit("run_completed", "Director", {})
                return

            yield emit(
                "agent_output",
                "BookContinue",
                {"step": "load_book_state", "step_index": 3, "step_total": 4},
            )
            book_kb_context = [
                {
                    "id": int(state_row.id),
                    "title": state_row.title,
                    "content": state_row.content,
                },
                *[
                    {"id": int(r.id), "title": r.title, "content": r.content}
                    for r in summary_rows
                    if r and r.id is not None
                ],
            ]
            yield emit(
                "agent_output",
                "BookContinue",
                {
                    "step": "finalize",
                    "step_index": 4,
                    "step_total": 4,
                    "book_state_kb_id": int(state_row.id),
                    "summary_chunks_loaded": len(summary_rows),
                    "excerpt_chars": len(book_excerpt),
                    "recent_chapters_loaded": book_recent_chapters_loaded,
                },
            )
            yield emit("agent_finished", "BookContinue", {})

            compiled_state: dict[str, Any] | None = None
            try:
                rec = json.loads(state_row.content)
                if isinstance(rec, dict) and isinstance(rec.get("state"), dict):
                    compiled_state = rec.get("state")  # type: ignore[assignment]
            except Exception:
                compiled_state = None

            if isinstance(compiled_state, dict):
                compiled_state = _compact_compiled_book_state(compiled_state)
                # Convert to the same StoryState schema that WriterAgent expects.
                cards = compiled_state.get("character_cards")
                characters: list[dict[str, Any]] = []
                if isinstance(cards, list):
                    for c in cards[:16]:
                        if not isinstance(c, dict):
                            continue
                        name = c.get("name")
                        if not isinstance(name, str) or not name.strip():
                            continue
                        characters.append(
                            {
                                "name": name.strip(),
                                "current_status": _clip_text(
                                    c.get("current_status"), 220
                                ),
                                "relationships": _clip_text(
                                    c.get("relationships"), 220
                                ),
                            }
                        )
                story_state = {
                    "summary_so_far": _clip_text(
                        compiled_state.get("book_summary"), 1800
                    ),
                    "characters": characters,
                    "world": _clip_text(compiled_state.get("world"), 900),
                    "timeline": compiled_state.get("timeline")
                    if isinstance(compiled_state.get("timeline"), list)
                    else [],
                    "open_loops": compiled_state.get("open_loops")
                    if isinstance(compiled_state.get("open_loops"), list)
                    else [],
                    "style_profile": compiled_state.get("style_profile")
                    if isinstance(compiled_state.get("style_profile"), dict)
                    else {},
                }

            # BookPlanner: generate a small chapter plan for this continuation chapter.
            try:
                yield emit(
                    "agent_started", "BookPlanner", {"chapter_index": chapter_index}
                )
                yield emit(
                    "agent_output",
                    "BookPlanner",
                    {"step": "prepare_prompt", "step_index": 1, "step_total": 4},
                )
                system = (
                    "You are BookPlannerAgent. Plan the next continuation chapter for a long book. "
                    f"{lang_hint_json} "
                    "Return JSON only.\n"
                    "Schema:\n"
                    "{\n"
                    '  "index": 1,\n'
                    '  "title": "...",\n'
                    '  "summary": "...",\n'
                    '  "goal": "..." \n'
                    "}\n"
                )
                user = (
                    f"Book source_id: {book_source_id}\n"
                    f"Chapter index to write: {chapter_index}\n"
                    "Use the compiled book state + latest excerpt to decide what happens next.\n\n"
                    f"CompiledBookStateJSON:\n{json_dumps(compiled_state or {})}\n\n"
                    + (
                        f"RecentWrittenChaptersMarkdown:\n{book_recent_chapters_for_writer[:4000]}\n\n"
                        if book_recent_chapters_for_writer
                        else ""
                    )
                    + f"LatestExcerpt:\n{book_excerpt[:4000]}\n"
                )
                cfg0 = llm_cfg()
                planner_cfg = replace(
                    cfg0,
                    temperature=0.3,
                    max_tokens=max(220, min(int(cfg0.max_tokens or 500), 700)),
                )
                yield emit(
                    "tool_call",
                    "BookPlanner",
                    {
                        "tool": "llm.generate_text",
                        "provider": planner_cfg.provider,
                        "model": planner_cfg.model,
                        "max_tokens": planner_cfg.max_tokens,
                    },
                )
                yield emit(
                    "agent_output",
                    "BookPlanner",
                    {"step": "llm.generate_text", "step_index": 2, "step_total": 4},
                )
                plan_text = await generate_text(
                    system_prompt=system, user_prompt=user, cfg=planner_cfg
                )
                plan_text = strip_think_blocks(plan_text)
                yield emit(
                    "agent_output",
                    "BookPlanner",
                    {"step": "parse_json", "step_index": 3, "step_total": 4},
                )
                plan_parsed = parse_json_loose(plan_text)
                if isinstance(plan_parsed, dict):
                    chapter_plan = plan_parsed
                    chapter_plan["index"] = chapter_index
                else:
                    chapter_plan = {"index": chapter_index}
                yield emit(
                    "agent_output",
                    "BookPlanner",
                    {"step": "plan_ready", "step_index": 4, "step_total": 4},
                )
                yield emit(
                    "artifact",
                    "BookPlanner",
                    {"artifact_type": "chapter_plan", "plan": chapter_plan},
                )
                yield emit("agent_finished", "BookPlanner", {})
            except Exception as e:
                # Soft-fail: Writer can proceed without an explicit plan.
                yield emit(
                    "agent_output",
                    "BookPlanner",
                    {
                        "error": f"book_planner_failed:{type(e).__name__}",
                        "soft_fail": True,
                    },
                )
                yield emit("agent_finished", "BookPlanner", {})

            if not isinstance(chapter_plan, dict):
                title = _default_chapter_title(output_lang, chapter_index)
                chapter_plan = {
                    "index": chapter_index,
                    "title": title,
                    "summary": "",
                    "goal": "Continue the story"
                    if output_lang != "zh"
                    else "继续推进剧情",
                }
            else:
                if (
                    not isinstance(chapter_plan.get("title"), str)
                    or not str(chapter_plan.get("title") or "").strip()
                ):
                    chapter_plan["title"] = _default_chapter_title(
                        output_lang, chapter_index
                    )

        # Tool: local KB retrieval
        kb_context: list[dict[str, Any]] = []
        try:
            q_terms: list[str] = []
            if isinstance(story, dict):
                logline = story.get("logline")
                if isinstance(logline, str) and logline.strip():
                    q_terms.append(logline.strip())
                world = story.get("world")
                if isinstance(world, str) and world.strip():
                    q_terms.append(world.strip())
                chars = story.get("characters")
                if isinstance(chars, list):
                    for c in chars[:5]:
                        if isinstance(c, dict) and isinstance(c.get("name"), str):
                            q_terms.append(c["name"])
            # Continue/Book flows often rely on StoryState more than Story settings.
            if isinstance(story_state, dict):
                ss_world = story_state.get("world")
                if isinstance(ss_world, str) and ss_world.strip():
                    q_terms.append(ss_world.strip()[:120])
                ss_chars = story_state.get("characters")
                if isinstance(ss_chars, list):
                    for c in ss_chars[:8]:
                        if isinstance(c, dict) and isinstance(c.get("name"), str):
                            q_terms.append(c["name"])

            uniq: list[str] = []
            seen_terms: set[str] = set()
            for t in q_terms:
                tt = str(t).strip()
                if not tt or tt in seen_terms:
                    continue
                seen_terms.add(tt)
                uniq.append(tt)

            query = " ".join(uniq) or (project.title or "story")
            kb_context = kb_search(query, limit=5)
            yield emit(
                "tool_result",
                "Retriever",
                {"tool": "kb_search", "hits": len(kb_context)},
            )
        except Exception:
            kb_context = []

        if kind == "book_continue" and book_kb_context:
            # Ensure book state/summaries are present in Writer prompt, and keep IDs stable for Strong mode citations.
            seen_kb_ids: set[int] = set()
            merged: list[dict[str, Any]] = []
            for it in book_kb_context + kb_context:
                try:
                    kid = int(it.get("id") or 0)  # type: ignore[arg-type]
                except Exception:
                    kid = 0
                if kid and kid in seen_kb_ids:
                    continue
                if kid:
                    seen_kb_ids.add(kid)
                merged.append(it)
            kb_context = merged

        if kb_mode == "strong" and not kb_context and not story:
            msg = "strong_kb_mode_requires_local_context"
            yield emit("run_error", "LoreKeeper", {"error": msg})
            mark_run_failed(msg)
            yield emit("run_completed", "Director", {})
            return

        # Tool: web search (optional)
        research_query = str(payload.get("research_query") or "").strip()
        web_results: list[dict[str, Any]] = []
        web_cfg = ((project.settings or {}).get("tools") or {}).get("web_search") or {}
        web_enabled = bool(web_cfg.get("enabled", True))
        web_provider = str(web_cfg.get("provider") or "auto")
        if research_query and web_enabled:
            try:
                from ..tools.web_search import web_search

                yield emit(
                    "tool_call",
                    "WebSearch",
                    {
                        "tool": "web_search",
                        "q": research_query,
                        "provider": web_provider,
                    },
                )
                web_results, meta = web_search(
                    research_query, limit=5, provider=web_provider
                )
                yield emit(
                    "tool_result",
                    "WebSearch",
                    {
                        "tool": "web_search",
                        "hits": len(web_results),
                        "provider_used": meta.get("provider_used"),
                        "errors": meta.get("errors", []),
                    },
                )
            except Exception as e:
                web_results = []
                yield emit(
                    "tool_result",
                    "WebSearch",
                    {"tool": "web_search", "hits": 0, "error": type(e).__name__},
                )

        # Agent: Writer
        writer_max_tokens = llm_cfg().max_tokens
        try:
            yield emit("agent_started", "Writer", {"chapter_index": chapter_index})
            yield emit(
                "agent_output",
                "Writer",
                {"step": "prepare_prompt", "step_index": 1, "step_total": 4},
            )
            system = (
                "You are WriterAgent. Write a novel chapter in Markdown. "
                f"{lang_hint_md} "
                "Write narrative prose (NOT an outline, NOT bullet notes). "
                "Respect the provided story settings and local KB excerpts. "
            )
            if kb_mode == "strong":
                system += (
                    "Strong KB mode (canon-locked): "
                    "When stating canon facts (world rules, history, geography, character backstory/status), "
                    "add inline evidence citations in the form [KB#ID]. "
                    "Only cite IDs that appear in the provided Local KB excerpts. "
                    "If a needed canon fact is not supported by Local KB, do NOT invent it; use [[TBD]] and add it "
                    "to a '## 待确认 / To Confirm' list at the end. "
                    "Do NOT treat web research results as canon unless the user explicitly confirms and it is in KB."
                )
            else:
                system += "If some details are missing, you may creatively fill gaps in a consistent way."
            min_len = max(200, int(chapter_words * 0.25))

            cfg0 = llm_cfg()
            base_low = (cfg0.base_url or "").lower()
            # When using PackyAPI Gemini, prefer a slightly more conservative max_tokens
            # budget for the Writer stage to reduce long-running connections.
            max_tokens_cap = (
                2048
                if (cfg0.provider == "gemini" and "packyapi.com" in base_low)
                else 4096
            )

            if cfg0.provider == "gemini" and "packyapi.com" in base_low:
                system += (
                    " Safety writing mode: avoid explicit pornographic or extreme violent depictions; "
                    "avoid real-world political agitation; if a scene would be disallowed, rephrase with euphemism."
                )

            def _json_for_prompt(obj: object, max_chars: int) -> str:
                s = json_dumps(obj)
                if len(s) <= max_chars:
                    return s
                return s[: max(0, int(max_chars))].rstrip() + "\n…(truncated)"

            def _build_user_parts(
                *, recent_max: int, excerpt_max: int, kb_max: int
            ) -> list[str]:
                parts = [
                    f"Story settings:\n{_json_for_prompt(story, 2600)}",
                    f"Writing targets: chapter_words≈{chapter_words}, chapter_index={chapter_index}",
                    f"KB mode: {kb_mode}",
                ]
                if chapter_plan:
                    parts.append(
                        f"Chapter plan:\n{_json_for_prompt(chapter_plan, 1400)}"
                    )
                if story_state:
                    parts.append(f"StoryState:\n{_json_for_prompt(story_state, 2800)}")
                if kind == "book_continue" and book_recent_chapters_for_writer.strip():
                    parts.append(
                        "Recent chapters already written in this project (keep continuity with these):\n"
                        f"{book_recent_chapters_for_writer[: max(0, int(recent_max))]}"
                    )
                if kind == "book_continue" and book_excerpt_for_writer.strip():
                    parts.append(
                        "Latest manuscript excerpt (continue from this context, keep continuity):\n"
                        f"{book_excerpt_for_writer[: max(0, int(excerpt_max))]}"
                    )
                if kb_context:
                    kb_text = "\n\n".join(
                        f"[KB#{k['id']}] {k.get('title', '')}\n{k.get('content', '')}"
                        for k in kb_context
                    )
                    parts.append(
                        f"Local KB excerpts:\n{kb_text[: max(0, int(kb_max))]}"
                    )
                if web_results:
                    web_text = "\n\n".join(
                        f"- {w.get('title', '')}\n  {w.get('snippet', '')}\n  {w.get('url', '')}"
                        for w in web_results
                    )
                    parts.append(
                        f"Web research results (do not treat as canon unless stated):\n{web_text[:2000]}"
                    )
                return parts

            user_parts = _build_user_parts(
                recent_max=3500, excerpt_max=3500, kb_max=3000
            )
            if output_lang == "zh":
                user_parts.append(
                    f"最低长度：至少 {min_len} 个汉字（不含 Markdown 符号）。不要中途截断。"
                )
            else:
                user_parts.append(
                    f"Minimum length: at least {max(120, int(chapter_words * 0.6))} words. Do not cut mid-sentence."
                )
            if output_lang == "zh":
                user_parts.append(
                    "只输出章节 Markdown（不要解释/不要前言）。用一级标题开头，例如："
                    f"{_writer_title_example(output_lang, chapter_index)}"
                )
            else:
                user_parts.append(
                    "Output ONLY the chapter Markdown. Start with a level-1 title like: "
                    f"{_writer_title_example(output_lang, chapter_index)}"
                )

            desired_max_tokens = max(
                int(cfg0.max_tokens),
                min(max_tokens_cap, max(80, int(chapter_words * 1.4))),
            )
            cfg = (
                replace(cfg0, max_tokens=desired_max_tokens)
                if desired_max_tokens != cfg0.max_tokens
                else cfg0
            )
            writer_max_tokens = cfg.max_tokens
            yield emit(
                "agent_output",
                "Writer",
                {"step": "llm.generate_text", "step_index": 2, "step_total": 4},
            )
            yield emit(
                "tool_call",
                "Writer",
                {
                    "tool": "llm.generate_text",
                    "provider": cfg.provider,
                    "model": cfg.model,
                    "max_tokens": cfg.max_tokens,
                },
            )
            user_prompt = "\n\n---\n\n".join(user_parts)
            try:
                writer_text = await generate_text(
                    system_prompt=system, user_prompt=user_prompt, cfg=cfg
                )
            except LLMError as e:
                # Rescue path for flaky gateways: retry with a smaller prompt first
                # on the SAME selected model; only switch models when the gateway
                # reports model-unavailable style errors.
                msg = str(e)
                retryable = bool(
                    kind in {"chapter", "continue", "book_continue"}
                    and _is_retryable_gateway_error(msg)
                )
                if not retryable:
                    raise

                retry_cfg = replace(cfg, max_tokens=min(int(cfg.max_tokens), 1536))

                retry_parts = _build_user_parts(
                    recent_max=2000, excerpt_max=2000, kb_max=1800
                )
                if output_lang == "zh":
                    retry_parts.append(
                        "IMPORTANT: 上一轮请求可能因网关不稳定/内容敏感/上下文过长而断连。"
                        "请保持行文含蓄，避免露骨描写，优先推进剧情与人物互动。"
                    )
                else:
                    retry_parts.append(
                        "IMPORTANT: The previous request likely failed due to gateway instability / sensitive content / long context. "
                        "Keep the writing PG-13 and focus on plot + character interaction."
                    )
                retry_prompt = "\n\n---\n\n".join(retry_parts)
                yield emit(
                    "tool_call",
                    "Writer",
                    {
                        "tool": "llm.generate_text",
                        "provider": retry_cfg.provider,
                        "model": retry_cfg.model,
                        "max_tokens": retry_cfg.max_tokens,
                        "note": f"retry_gateway_error_same_model:{msg[:60]}",
                    },
                )
                try:
                    writer_text = await generate_text(
                        system_prompt=system, user_prompt=retry_prompt, cfg=retry_cfg
                    )
                except LLMError as retry_err:
                    retry_msg = str(retry_err)
                    if not (
                        retry_cfg.provider == "gemini"
                        and "packyapi.com" in (retry_cfg.base_url or "").lower()
                        and (
                            _is_model_unavailable_error(retry_msg)
                            or _is_retryable_gateway_error(retry_msg)
                            or retry_msg.startswith("empty_completion")
                        )
                    ):
                        raise
                    openai_retry_cfg = _openai_writer_fallback_cfg(
                        min_max_tokens=int(retry_cfg.max_tokens),
                        temperature=min(float(cfg.temperature), 0.6),
                    )
                    if openai_retry_cfg is not None:
                        retry_cfg = openai_retry_cfg
                        yield emit(
                            "tool_call",
                            "Writer",
                            {
                                "tool": "llm.generate_text",
                                "provider": retry_cfg.provider,
                                "model": retry_cfg.model,
                                "max_tokens": retry_cfg.max_tokens,
                                "note": f"retry_gateway_error_openai_fallback:{retry_msg[:60]}",
                            },
                        )
                        writer_text = await generate_text(
                            system_prompt=system,
                            user_prompt=retry_prompt,
                            cfg=retry_cfg,
                        )
                        cfg = retry_cfg
                    else:
                        retry_cfg = replace(
                            retry_cfg,
                            model=_choose_packy_gemini_rescue_model(
                                str(retry_cfg.model or ""), retry_msg
                            ),
                        )
                        yield emit(
                            "tool_call",
                            "Writer",
                            {
                                "tool": "llm.generate_text",
                                "provider": retry_cfg.provider,
                                "model": retry_cfg.model,
                                "max_tokens": retry_cfg.max_tokens,
                                "note": f"retry_gateway_error_fallback_model:{retry_msg[:60]}",
                            },
                        )
                        writer_text = await generate_text(
                            system_prompt=system, user_prompt=retry_prompt, cfg=retry_cfg
                        )
                        cfg = retry_cfg
            writer_text = strip_think_blocks(writer_text)
            if not re.search(r"(?m)^#\\s+\\S", writer_text):
                title = _default_chapter_title(output_lang, chapter_index)
                if isinstance(chapter_plan, dict):
                    t = chapter_plan.get("title")
                    if isinstance(t, str) and t.strip():
                        title = t.strip()
                writer_text = f"# {title}\n\n{writer_text.lstrip()}"
            if output_lang == "zh":
                cjk_count = len(_CJK_RE.findall(writer_text))
                if cjk_count < min_len:
                    # Retry once on the same selected model before falling back.
                    retry_cfg = cfg
                    yield emit(
                        "tool_call",
                        "Writer",
                        {
                            "tool": "llm.generate_text",
                            "provider": retry_cfg.provider,
                            "model": retry_cfg.model,
                            "max_tokens": retry_cfg.max_tokens,
                            "note": "retry_too_short",
                        },
                    )
                    retry_user = (
                        "\n\n---\n\n".join(user_parts)
                        + f"\n\nIMPORTANT: 上一轮输出过短且不完整。请重新输出【完整章节 Markdown】（不要承接上一轮），"
                        + f"至少 {min_len} 个汉字，结尾完整，不要只写标题或一句话。"
                    )
                    writer_text2 = await generate_text(
                        system_prompt=system, user_prompt=retry_user, cfg=retry_cfg
                    )
                    writer_text2 = strip_think_blocks(writer_text2)
                    if not re.search(r"(?m)^#\\s+\\S", writer_text2):
                        title = _default_chapter_title(output_lang, chapter_index)
                        if isinstance(chapter_plan, dict):
                            t = chapter_plan.get("title")
                            if isinstance(t, str) and t.strip():
                                title = t.strip()
                        writer_text2 = f"# {title}\n\n{writer_text2.lstrip()}"
                    cjk_count2 = len(_CJK_RE.findall(writer_text2))
                    if cjk_count2 >= min_len:
                        writer_text = writer_text2
                    elif (
                        cfg.provider == "gemini"
                        and "packyapi.com" in (cfg.base_url or "").lower()
                    ):
                        openai_retry_cfg = _openai_structured_fallback_cfg(
                            min_max_tokens=int(retry_cfg.max_tokens),
                            temperature=min(float(cfg.temperature), 0.6),
                        )
                        if openai_retry_cfg is not None:
                            retry_cfg = openai_retry_cfg
                            note = "retry_too_short_openai_fallback"
                        else:
                            retry_cfg = replace(
                                retry_cfg,
                                model=_choose_packy_gemini_rescue_model(
                                    str(retry_cfg.model or ""), "too_short_retry"
                                ),
                            )
                            note = "retry_too_short_fallback_model"
                        yield emit(
                            "tool_call",
                            "Writer",
                            {
                                "tool": "llm.generate_text",
                                "provider": retry_cfg.provider,
                                "model": retry_cfg.model,
                                "max_tokens": retry_cfg.max_tokens,
                                "note": note,
                            },
                        )
                        writer_text3 = await generate_text(
                            system_prompt=system, user_prompt=retry_user, cfg=retry_cfg
                        )
                        writer_text3 = strip_think_blocks(writer_text3)
                        if not re.search(r"(?m)^#\s+\S", writer_text3):
                            title = _default_chapter_title(output_lang, chapter_index)
                            if isinstance(chapter_plan, dict):
                                t = chapter_plan.get("title")
                                if isinstance(t, str) and t.strip():
                                    title = t.strip()
                            writer_text3 = f"# {title}\n\n{writer_text3.lstrip()}"
                        cjk_count3 = len(_CJK_RE.findall(writer_text3))
                        if cjk_count3 >= min_len:
                            writer_text = writer_text3
                        else:
                            raise LLMError(
                                f"writer_output_too_short:cjk={cjk_count3},min={min_len}"
                            )
                    else:
                        raise LLMError(
                            f"writer_output_too_short:cjk={cjk_count2},min={min_len}"
                        )
            yield emit(
                "agent_output",
                "Writer",
                {
                    "step": "validate_output",
                    "step_index": 3,
                    "step_total": 4,
                    "max_tokens": writer_max_tokens,
                    "min_cjk": min_len if output_lang == "zh" else None,
                },
            )
            yield emit(
                "agent_output",
                "Writer",
                {
                    "step": "finalize",
                    "step_index": 4,
                    "step_total": 4,
                    "text": writer_text[:400],
                },
            )
            yield emit("agent_finished", "Writer", {})
        except LLMError as e:
            msg = str(e)
            yield emit("run_error", "Writer", {"error": msg})
            mark_run_failed(msg)
            yield emit("run_completed", "Director", {})
            return
        except Exception as e:
            msg = f"writer_failed:{type(e).__name__}"
            yield emit("run_error", "Writer", {"error": msg})
            mark_run_failed(msg)
            yield emit("run_completed", "Director", {})
            return

        # Agent: Editor (light polish)
        edited_text = writer_text
        try:
            yield emit("agent_started", "Editor", {})
            yield emit(
                "agent_output",
                "Editor",
                {"step": "prepare_prompt", "step_index": 1, "step_total": 4},
            )
            system = (
                "You are EditorAgent. Revise a novel chapter in Markdown. "
                f"{lang_hint_md} "
                "Preserve structure and length: do NOT summarize, do NOT delete content. "
                "Only improve wording/flow and fix inconsistencies/typos. "
                "If the input is not in the required language, translate it while preserving meaning and length. "
                "Do NOT remove evidence citations like [KB#123] or placeholders like [[TBD]]."
            )
            user = (
                "Revise the following Markdown chapter. Return the FULL chapter Markdown only.\n\n"
                f"{writer_text}\n"
            )
            cfg0 = llm_cfg()
            editor_max_tokens = max(int(cfg0.max_tokens), int(writer_max_tokens))
            cfg = replace(
                cfg0,
                max_tokens=editor_max_tokens,
                temperature=min(float(cfg0.temperature), 0.2),
            )
            editor_note: str | None = None
            if cfg.provider == "gemini" and "packyapi.com" in (cfg.base_url or "").lower():
                openai_cfg = _openai_writer_fallback_cfg(
                    min_max_tokens=editor_max_tokens,
                    temperature=0.2,
                )
                if openai_cfg is not None:
                    cfg = openai_cfg
                    editor_note = "prefer_openai_editor_for_gemini_packy"
            yield emit(
                "agent_output",
                "Editor",
                {"step": "llm.generate_text", "step_index": 2, "step_total": 4},
            )
            tool_call_data = {
                "tool": "llm.generate_text",
                "provider": cfg.provider,
                "model": cfg.model,
                "max_tokens": cfg.max_tokens,
            }
            if editor_note:
                tool_call_data["note"] = editor_note
            yield emit(
                "tool_call",
                "Editor",
                tool_call_data,
            )
            edited_text = await generate_text(
                system_prompt=system, user_prompt=user, cfg=cfg
            )
            edited_text = strip_think_blocks(edited_text)
            yield emit(
                "agent_output",
                "Editor",
                {"step": "validate_output", "step_index": 3, "step_total": 4},
            )
            if _is_suspicious_editor_output(writer_text, edited_text):
                repair_cfg = replace(cfg, temperature=0.1)
                repair_user = (
                    user
                    + "\n\nIMPORTANT: Keep the exact chapter structure, keep the length close to the input, "
                    + "return full Markdown only, no commentary, no fences."
                )
                yield emit(
                    "tool_call",
                    "Editor",
                    {
                        "tool": "llm.generate_text",
                        "provider": repair_cfg.provider,
                        "model": repair_cfg.model,
                        "max_tokens": repair_cfg.max_tokens,
                        "note": "retry_suspicious_output",
                    },
                )
                edited_retry = await generate_text(
                    system_prompt=system, user_prompt=repair_user, cfg=repair_cfg
                )
                edited_retry = strip_think_blocks(edited_retry)
                if _is_suspicious_editor_output(writer_text, edited_retry):
                    raise ValueError("editor_suspicious_output")
                edited_text = edited_retry
            yield emit(
                "agent_output",
                "Editor",
                {
                    "step": "finalize",
                    "step_index": 4,
                    "step_total": 4,
                    "text": edited_text[:400],
                },
            )
            yield emit("agent_finished", "Editor", {})
        except Exception as e:
            edited_text = writer_text
            yield emit(
                "agent_output",
                "Editor",
                {
                    "step": "finalize",
                    "step_index": 4,
                    "step_total": 4,
                    "error": f"editor_fallback_to_writer:{type(e).__name__}",
                    "soft_fail": True,
                    "text": writer_text[:240],
                },
            )
            yield emit("agent_finished", "Editor", {})

        # Agent: LoreKeeper (evidence audit + canon guard)
        yield emit("agent_started", "LoreKeeper", {"kb_mode": kb_mode})
        yield emit(
            "agent_output",
            "LoreKeeper",
            {"step": "prepare_context", "step_index": 1, "step_total": 5},
        )
        tbd_count = edited_text.count("[[TBD]]")
        cited_ids: list[int] = []
        warnings: list[str] = []
        evidence_report: dict[str, Any] | None = None
        to_confirm: list[str] = []
        unsafe_claims: list[str] = []
        rewritten = False

        if kb_mode == "strong":
            cited_ids = sorted(
                {int(m.group(1)) for m in re.finditer(r"\[KB#(\d+)\]", edited_text)}
            )
            kb_text = ""
            if kb_context:
                kb_text = "\n\n".join(
                    f"[KB#{k['id']}] {k.get('title', '')}\n{k.get('content', '')}"
                    for k in kb_context
                )

            kb_ids_available = {
                int(k.get("id"))
                for k in kb_context
                if isinstance(k, dict) and isinstance(k.get("id"), int)
            }
            if kb_ids_available and not cited_ids:
                warnings.append(
                    "Strong KB mode: no [KB#...] citations found in chapter."
                )
            if kb_ids_available:
                invalid_cited = [i for i in cited_ids if i not in kb_ids_available]
                if invalid_cited:
                    warnings.append(
                        f"Strong KB mode: found citations not in provided KB context: {invalid_cited[:5]}"
                    )

            # Evidence audit (JSON output)
            try:
                yield emit(
                    "agent_output",
                    "LoreKeeper",
                    {"step": "evidence_audit", "step_index": 2, "step_total": 5},
                )
                system = (
                    "You are LoreKeeperAgent. Audit a chapter for Strong KB mode evidence. "
                    f"{lang_hint_json} "
                    "You will be given Local KB excerpts with IDs and a chapter markdown. "
                    "Identify canon claims not supported by the Local KB excerpts. "
                    "Return JSON only."
                )
                user = (
                    "Local KB excerpts:\n"
                    f"{kb_text[:6000]}\n\n"
                    "ChapterMarkdown:\n"
                    f"{edited_text[:12000]}\n\n"
                    "Return JSON with this schema:\n"
                    "{\n"
                    '  "supported_claims": [ {"claim":"...","kb_ids":[123]} ],\n'
                    '  "needs_confirmation": [ {"claim":"...","marked_tbd": true} ],\n'
                    '  "unsafe_claims": [ {"claim":"...","reason":"..."} ]\n'
                    "}\n"
                    "Rules:\n"
                    "- Prefer short, atomic claims.\n"
                    "- If a claim is not supported by KB, put it in needs_confirmation.\n"
                    "- If it is not supported AND the chapter does NOT visibly mark it as [[TBD]], "
                    "also put it in unsafe_claims.\n"
                )
                cfg = llm_cfg()
                yield emit(
                    "tool_call",
                    "LoreKeeper",
                    {
                        "tool": "llm.generate_text",
                        "provider": cfg.provider,
                        "model": cfg.model,
                    },
                )
                evidence_text = await generate_text(
                    system_prompt=system, user_prompt=user, cfg=cfg
                )
                yield emit(
                    "agent_output",
                    "LoreKeeper",
                    {"step": "parse_json", "step_index": 3, "step_total": 5},
                )
                parsed = parse_json_loose(evidence_text)
                if isinstance(parsed, dict):
                    evidence_report = parsed
            except Exception as e:
                warnings.append(f"evidence_audit_failed:{type(e).__name__}")

            if isinstance(evidence_report, dict):
                nc_raw = evidence_report.get("needs_confirmation")
                if isinstance(nc_raw, list):
                    for item in nc_raw:
                        if not isinstance(item, dict):
                            continue
                        c = item.get("claim")
                        if isinstance(c, str) and c.strip():
                            to_confirm.append(c.strip())

                unsafe_raw = evidence_report.get("unsafe_claims")
                if isinstance(unsafe_raw, list):
                    for item in unsafe_raw:
                        if not isinstance(item, dict):
                            continue
                        c = item.get("claim")
                        if isinstance(c, str) and c.strip():
                            unsafe_claims.append(c.strip())

                # Keep only KB ids that exist in the provided context (best-effort sanitization).
                supp_raw = evidence_report.get("supported_claims")
                if isinstance(supp_raw, list):
                    cleaned: list[dict[str, Any]] = []
                    for item in supp_raw:
                        if not isinstance(item, dict):
                            continue
                        claim = item.get("claim")
                        kb_ids = item.get("kb_ids")
                        if not isinstance(claim, str) or not claim.strip():
                            continue
                        ids: list[int] = []
                        if isinstance(kb_ids, list):
                            for x in kb_ids:
                                try:
                                    xi = int(x)
                                except Exception:
                                    continue
                                if kb_ids_available and xi not in kb_ids_available:
                                    continue
                                ids.append(xi)
                        cleaned.append({"claim": claim.strip(), "kb_ids": ids})
                    evidence_report["supported_claims"] = cleaned

            if tbd_count > 0:
                warnings.append(
                    "Strong KB mode: found [[TBD]] markers (missing canon facts)."
                )
            if to_confirm:
                warnings.append(f"Strong KB mode: needs_confirmation={len(to_confirm)}")

            if unsafe_claims:
                warnings.append(
                    f"Strong KB mode: unsafe_claims={len(unsafe_claims)} (sanitizing to [[TBD]])."
                )
                # Sanitize via a minimal rewrite pass (does not invent facts; only redacts/asserts TBD).
                try:
                    yield emit(
                        "agent_output",
                        "LoreKeeper",
                        {"step": "sanitize_rewrite", "step_index": 4, "step_total": 5},
                    )
                    system2 = (
                        "You are LoreKeeperAgent. Rewrite a chapter Markdown to comply with Strong KB mode. "
                        f"{lang_hint_md} "
                        "Replace each unsafe canon claim with [[TBD]] or neutral phrasing that does NOT assert canon. "
                        "Append/refresh a '## 待确认 / To Confirm' section listing all missing facts. "
                        "Do not add new plot points. Output Markdown only."
                    )
                    claims = "\n".join(
                        f"- {c}"
                        for c in (unsafe_claims + to_confirm)[:20]
                        if isinstance(c, str) and c.strip()
                    )
                    user2 = (
                        "Unsafe canon claims:\n"
                        f"{claims}\n\n"
                        "ChapterMarkdown:\n"
                        f"{edited_text}\n"
                    )
                    cfg = llm_cfg()
                    yield emit(
                        "tool_call",
                        "LoreKeeper",
                        {
                            "tool": "llm.generate_text",
                            "provider": cfg.provider,
                            "model": cfg.model,
                        },
                    )
                    sanitized = await generate_text(
                        system_prompt=system2, user_prompt=user2, cfg=cfg
                    )
                    if isinstance(sanitized, str) and sanitized.strip():
                        edited_text = strip_think_blocks(sanitized)
                        rewritten = True
                        tbd_count = edited_text.count("[[TBD]]")
                except Exception as e:
                    warnings.append(f"sanitize_failed:{type(e).__name__}")
            else:
                yield emit(
                    "agent_output",
                    "LoreKeeper",
                    {
                        "step": "sanitize_rewrite",
                        "step_index": 4,
                        "step_total": 5,
                        "skipped": True,
                    },
                )

            # If we didn't rewrite, still append a to-confirm list when needed.
            if to_confirm and (
                "To Confirm" not in edited_text and "待确认" not in edited_text
            ):
                unique: list[str] = []
                seen_confirm: set[str] = set()
                for c in to_confirm:
                    if c in seen_confirm:
                        continue
                    seen_confirm.add(c)
                    unique.append(c)
                if unique:
                    edited_text = (
                        edited_text.rstrip()
                        + "\n\n---\n\n## 待确认 / To Confirm\n"
                        + "\n".join(f"- {c}" for c in unique[:20])
                        + "\n"
                    )

        else:
            # Weak mode: keep a light warning only.
            if tbd_count > 0:
                warnings.append("Found [[TBD]] markers.")
            yield emit(
                "agent_output",
                "LoreKeeper",
                {
                    "step": "evidence_audit",
                    "step_index": 2,
                    "step_total": 5,
                    "skipped": True,
                },
            )
            yield emit(
                "agent_output",
                "LoreKeeper",
                {
                    "step": "parse_json",
                    "step_index": 3,
                    "step_total": 5,
                    "skipped": True,
                },
            )
            yield emit(
                "agent_output",
                "LoreKeeper",
                {
                    "step": "sanitize_rewrite",
                    "step_index": 4,
                    "step_total": 5,
                    "skipped": True,
                },
            )

        yield emit(
            "agent_output",
            "LoreKeeper",
            {
                "step": "finalize",
                "step_index": 5,
                "step_total": 5,
                "tbd_count": tbd_count,
                "warnings": warnings,
                "rewritten": rewritten,
                "citations": cited_ids,
                "to_confirm_count": len(to_confirm),
                "unsafe_count": len(unsafe_claims),
            },
        )
        if evidence_report is not None:
            yield emit(
                "artifact",
                "LoreKeeper",
                {"artifact_type": "evidence_report", "report": evidence_report},
            )
        yield emit("agent_finished", "LoreKeeper", {})

        # Persist Chapter + add to KB as manuscript chunk
        edited_text = strip_think_blocks(edited_text)
        chapter_title = _default_chapter_title(output_lang, chapter_index)
        for ln in edited_text.splitlines():
            if ln.strip().startswith("# "):
                chapter_title = ln.strip().lstrip("#").strip()
                break
        with get_session() as s6:
            ch_obj = Chapter(
                project_id=project_id,
                chapter_index=chapter_index,
                title=chapter_title,
                markdown=edited_text,
            )
            tags_parts = ["manuscript", f"chapter_id={ch_obj.id}"]
            if book_source_id_for_chapter:
                tags_parts.extend(
                    [f"book_source:{book_source_id_for_chapter}", "book_continue"]
                )
            s6.add(ch_obj)
            s6.add(
                KBChunk(
                    project_id=project_id,
                    source_type="manuscript",
                    title=chapter_title,
                    content=edited_text,
                    tags=",".join(tags_parts),
                )
            )
            s6.commit()

        yield emit(
            "artifact",
            "Writer",
            {
                "artifact_type": "chapter_markdown",
                "chapter_index": chapter_index,
                "title": chapter_title,
                "markdown": edited_text,
            },
        )

        mark_run_completed()
        yield emit("run_completed", "Director", {})

    def _finalize_run_if_still_running() -> None:
        """
        If the client disconnects or the streaming response ends unexpectedly,
        the in-request pipeline is cancelled and would otherwise leave the run
        in a perpetual "running" state. Mark it failed so the UI can recover.
        """

        with get_session() as s:
            r = s.get(Run, run.id)
            if not r or r.status != "running":
                return

            msg = "run_aborted:stream_closed"

            last = s.exec(
                select(TraceEvent)
                .where(TraceEvent.run_id == run.id)
                .order_by(text("seq DESC"))
                .limit(1)
            ).first()
            next_seq = int(last.seq) + 1 if last else 1
            s.add(
                TraceEvent(
                    run_id=run.id,
                    seq=next_seq,
                    ts=_now_utc(),
                    event_type="run_error",
                    agent="Director",
                    payload={"error": msg},
                )
            )
            s.add(
                TraceEvent(
                    run_id=run.id,
                    seq=next_seq + 1,
                    ts=_now_utc(),
                    event_type="run_completed",
                    agent="Director",
                    payload={},
                )
            )
            r.status = "failed"
            r.finished_at = _now_utc()
            r.error = msg[:500]
            s.add(r)
            s.commit()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        background=BackgroundTask(_finalize_run_if_still_running),
    )
