from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Secrets:
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    openai_model: str | None = None
    gemini_api_key: str | None = None
    gemini_model: str | None = None
    gemini_base_url: str | None = None


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
                return k, v
    return None


def _looks_like_api_key(s: str) -> bool:
    t = s.strip()
    # Heuristic only; do NOT validate format or print it.
    return len(t) >= 20


def load_secrets() -> Secrets:
    """
    Load secrets with priority:
    1) Environment variables
    2) api.txt at repo root (gitignored)

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

