from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from .secrets import Secrets, load_secrets


Provider = Literal["openai", "gemini"]


class LLMError(RuntimeError):
    pass


@dataclass(frozen=True)
class LLMConfig:
    provider: Provider
    model: str
    base_url: str | None = None  # used by openai-compatible and (optionally) gemini
    api_key: str | None = None
    temperature: float = 0.7
    max_tokens: int = 800


def _normalize_base_url(url: str) -> str:
    u = url.strip().rstrip("/")
    return u


def resolve_llm_config(project_settings: dict[str, Any], secrets: Secrets | None = None) -> LLMConfig:
    s = secrets or load_secrets()
    llm = project_settings.get("llm") if isinstance(project_settings, dict) else {}
    if not isinstance(llm, dict):
        llm = {}

    provider = llm.get("provider") or "openai"
    if provider not in ("openai", "gemini"):
        provider = "openai"

    temperature = llm.get("temperature")
    try:
        temperature_f = float(temperature) if temperature is not None else 0.7
    except Exception:
        temperature_f = 0.7

    max_tokens = llm.get("max_tokens")
    try:
        max_tokens_i = int(max_tokens) if max_tokens is not None else 800
    except Exception:
        max_tokens_i = 800

    if provider == "openai":
        openai_cfg = llm.get("openai") if isinstance(llm.get("openai"), dict) else {}
        base_url = openai_cfg.get("base_url") or s.openai_base_url or "https://api.openai.com/v1"
        model = openai_cfg.get("model") or s.openai_model or "gpt-4o-mini"
        api_key = s.openai_api_key
        return LLMConfig(
            provider="openai",
            base_url=_normalize_base_url(str(base_url)),
            model=str(model),
            api_key=api_key,
            temperature=temperature_f,
            max_tokens=max_tokens_i,
        )

    gemini_cfg = llm.get("gemini") if isinstance(llm.get("gemini"), dict) else {}
    base_url = gemini_cfg.get("base_url") or s.gemini_base_url or "https://generativelanguage.googleapis.com"
    model = gemini_cfg.get("model") or s.gemini_model or "gemini-1.5-flash"
    api_key = s.gemini_api_key
    return LLMConfig(
        provider="gemini",
        base_url=_normalize_base_url(str(base_url)),
        model=str(model),
        api_key=api_key,
        temperature=temperature_f,
        max_tokens=max_tokens_i,
    )


async def generate_text(system_prompt: str, user_prompt: str, cfg: LLMConfig) -> str:
    if not cfg.api_key:
        raise LLMError(f"missing_api_key_for_provider:{cfg.provider}")

    if cfg.provider == "openai":
        base = cfg.base_url or "https://api.openai.com/v1"
        url = f"{base}/chat/completions"
        payload = {
            "model": cfg.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": cfg.temperature,
            "max_tokens": cfg.max_tokens,
        }
        headers = {"Authorization": f"Bearer {cfg.api_key}"}
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(url, json=payload, headers=headers)
            if r.status_code >= 400:
                raise LLMError(f"openai_http_{r.status_code}")
            data = r.json()
        try:
            return str(data["choices"][0]["message"]["content"])
        except Exception as e:
            raise LLMError(f"openai_bad_response:{type(e).__name__}")

    # Gemini: Generative Language API (v1beta)
    base = cfg.base_url or "https://generativelanguage.googleapis.com"
    url = f"{base}/v1beta/models/{cfg.model}:generateContent"
    params = {"key": cfg.api_key}
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": cfg.temperature,
            # Gemini uses maxOutputTokens naming
            "maxOutputTokens": cfg.max_tokens,
        },
    }
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(url, params=params, json=payload)
        if r.status_code >= 400:
            raise LLMError(f"gemini_http_{r.status_code}")
        data = r.json()

    try:
        parts = data["candidates"][0]["content"]["parts"]
        text_out = "".join(p.get("text", "") for p in parts)
        return str(text_out)
    except Exception as e:
        raise LLMError(f"gemini_bad_response:{type(e).__name__}")


def parse_json_loose(text: str) -> Any:
    """
    Best-effort JSON parser:
    - strips code fences
    - finds the first {...} or [...]
    """
    t = text.strip()
    if t.startswith("```"):
        # Remove ```json ... ```
        t = t.split("\n", 1)[1] if "\n" in t else t
        if t.endswith("```"):
            t = t[: -3]
        t = t.strip()
    # Try direct parse
    try:
        return json.loads(t)
    except Exception:
        pass
    # Find first JSON object/array
    start = None
    for i, ch in enumerate(t):
        if ch in "{[":
            start = i
            break
    if start is None:
        raise ValueError("no_json_start")
    for end in range(len(t), start, -1):
        if t[end - 1] in "}]":
            snippet = t[start:end]
            try:
                return json.loads(snippet)
            except Exception:
                continue
    raise ValueError("json_parse_failed")

