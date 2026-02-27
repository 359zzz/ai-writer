from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Secrets:
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    openai_model: str | None = None
    gemini_api_key: str | None = None
    gemini_model: str | None = None
    gemini_base_url: str | None = None


def _default_secrets_store_path() -> Path:
    """
    Local-only secrets store path (gitignored via data/).

    We store API keys here when they are configured via the web Settings UI,
    so users don't have to rely on api.txt.
    """

    api_root = Path(__file__).resolve().parents[1]  # .../apps/api
    data_dir = api_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "secrets.local.json"


def _load_secrets_store() -> dict[str, str]:
    path = _default_secrets_store_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in data.items():
        if isinstance(k, str) and isinstance(v, str):
            if v.strip():
                out[k] = v.strip()
    return out


def _write_secrets_store(data: dict[str, str]) -> None:
    path = _default_secrets_store_path()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def update_secrets_store(update: dict[str, Any]) -> None:
    """
    Update the local secrets store.

    - Missing keys are ignored.
    - Empty string clears the value.
    - Values are stored as plain strings (local single-user app).

    IMPORTANT: Must never print/log secrets.
    """

    store = _load_secrets_store()
    for k, v in update.items():
        if not isinstance(k, str):
            continue
        if v is None:
            continue
        if not isinstance(v, str):
            continue
        vv = v.strip()
        if not vv:
            store.pop(k, None)
            continue
        store[k] = vv
    _write_secrets_store(store)


def _find_api_txt() -> Path | None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "api.txt"
        if cand.exists():
            return cand
    return None


def _next_value(lines: list[str], start_idx: int) -> str | None:
    for j in range(start_idx + 1, len(lines)):
        t = lines[j].strip()
        if not t or t.startswith("#"):
            continue
        return t
    return None


def _parse_key_value(line: str) -> tuple[str, str] | None:
    t = line.strip()
    if not t or t.startswith("#"):
        return None
    for sep in ("=", ":"):
        if sep in t:
            k, v = t.split(sep, 1)
            k = k.strip()
            v = v.strip()
            if k and v:
                v = _strip_wrapping_quotes(v)
                return k, v
    return None


def _strip_wrapping_quotes(v: str) -> str:
    t = v.strip()
    if len(t) >= 2 and ((t[0] == t[-1] == '"') or (t[0] == t[-1] == "'")):
        return t[1:-1].strip()
    return t


def _looks_like_api_key(s: str) -> bool:
    t = s.strip()
    # Heuristic only; do NOT validate format or print it.
    return len(t) >= 20


def load_secrets() -> Secrets:
    """
    Load secrets with priority:
    1) Environment variables
    2) Local backend secrets store (configured via Settings UI; gitignored)
    3) api.txt at repo root (legacy fallback; gitignored)

    This function must never log/print keys.
    """
    env_openai_key = os.getenv("OPENAI_API_KEY")
    env_openai_base = os.getenv("OPENAI_BASE_URL")
    env_openai_model = os.getenv("OPENAI_MODEL")
    env_gemini_key = os.getenv("GEMINI_API_KEY")
    env_gemini_model = os.getenv("GEMINI_MODEL")
    env_gemini_base = os.getenv("GEMINI_BASE_URL") or os.getenv("GOOGLE_GEMINI_BASE_URL")

    openai_api_key = env_openai_key
    openai_base_url = env_openai_base
    openai_model = env_openai_model
    gemini_api_key = env_gemini_key
    gemini_model = env_gemini_model
    gemini_base_url = env_gemini_base

    # Load from local backend secrets store (if present). Environment variables
    # still take priority for CI / temporary overrides.
    store = _load_secrets_store()
    if not openai_api_key:
        openai_api_key = store.get("OPENAI_API_KEY") or store.get("openai_api_key")
    if not openai_base_url:
        openai_base_url = store.get("OPENAI_BASE_URL") or store.get("openai_base_url")
    if not openai_model:
        openai_model = store.get("OPENAI_MODEL") or store.get("openai_model")
    if not gemini_api_key:
        gemini_api_key = store.get("GEMINI_API_KEY") or store.get("gemini_api_key")
    if not gemini_model:
        gemini_model = store.get("GEMINI_MODEL") or store.get("gemini_model")
    if not gemini_base_url:
        gemini_base_url = (
            store.get("GEMINI_BASE_URL")
            or store.get("GOOGLE_GEMINI_BASE_URL")
            or store.get("gemini_base_url")
        )

    api_txt = _find_api_txt()
    if api_txt:
        raw_lines = api_txt.read_text(encoding="utf-8", errors="ignore").splitlines()
        lines = [ln.rstrip("\r\n") for ln in raw_lines]

        # Headings style:
        # Gemini:
        # <key>
        # GPT:
        # <key>
        for i, ln in enumerate(lines):
            t = ln.strip()
            if not t:
                continue
            low = t.lower()
            if low.startswith("gemini"):
                candidate = _next_value(lines, i)
                if candidate and _looks_like_api_key(candidate) and not gemini_api_key:
                    gemini_api_key = candidate.strip()
            if low.startswith("gpt"):
                candidate = _next_value(lines, i)
                if candidate and _looks_like_api_key(candidate) and not openai_api_key:
                    openai_api_key = candidate.strip()

        # Key-value style lines
        for ln in lines:
            kv = _parse_key_value(ln)
            if not kv:
                continue
            k, v = kv
            if k == "base_url" and not openai_base_url:
                openai_base_url = v
            if k == "model" and not openai_model:
                openai_model = v
            if k in ("GEMINI_MODEL",) and not gemini_model:
                gemini_model = v
            if k in ("GOOGLE_GEMINI_BASE_URL",) and not gemini_base_url:
                gemini_base_url = v
            if k in ("GEMINI_API_KEY",) and (not gemini_api_key) and _looks_like_api_key(v):
                gemini_api_key = v
            if k in ("OPENAI_API_KEY",) and (not openai_api_key) and _looks_like_api_key(v):
                openai_api_key = v
            if k in ("OPENAI_BASE_URL",) and not openai_base_url:
                openai_base_url = v
            if k in ("OPENAI_MODEL",) and not openai_model:
                openai_model = v

    return Secrets(
        openai_api_key=openai_api_key,
        openai_base_url=openai_base_url,
        openai_model=openai_model,
        gemini_api_key=gemini_api_key,
        gemini_model=gemini_model,
        gemini_base_url=gemini_base_url,
    )


def secrets_status() -> dict[str, object]:
    s = load_secrets()
    return {
        "openai_api_key_present": bool(s.openai_api_key),
        "openai_base_url_present": bool(s.openai_base_url),
        "openai_model_present": bool(s.openai_model),
        "gemini_api_key_present": bool(s.gemini_api_key),
        "gemini_model_present": bool(s.gemini_model),
        "gemini_base_url_present": bool(s.gemini_base_url),
    }
