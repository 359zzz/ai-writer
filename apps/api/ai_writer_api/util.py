from __future__ import annotations

import json
import re
from typing import Any


def deep_merge(base: object, patch: object) -> object:
    """
    Recursively merge dictionaries.
    Non-dict values are replaced by patch.
    """
    if isinstance(base, dict) and isinstance(patch, dict):
        out = dict(base)
        for k, v in patch.items():
            out[k] = deep_merge(out.get(k), v)
        return out
    return patch


def json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", flags=re.IGNORECASE | re.DOTALL)


def strip_think_blocks(text: str) -> str:
    """
    Some LLMs (especially code-first models / proxy gateways) may emit reasoning
    blocks like:
      <think>...</think>
    We never want to persist those into chapters/KB or show them in the UI.
    """

    if not isinstance(text, str):
        return ""
    out = _THINK_BLOCK_RE.sub("", text)
    return out.lstrip()
