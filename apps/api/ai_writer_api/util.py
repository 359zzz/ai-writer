from __future__ import annotations

import json
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

