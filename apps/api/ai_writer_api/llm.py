from __future__ import annotations

import asyncio
import json
import random
import re
from dataclasses import dataclass
from typing import Any, Callable, Literal

import httpx

from .secrets import Secrets, load_secrets


Provider = Literal["openai", "gemini"]
WireAPI = Literal["chat", "responses"]


class LLMError(RuntimeError):
    pass


def _is_google_genai_base(base_url: str | None) -> bool:
    if not base_url:
        return False
    u = base_url.lower()
    return ("generativelanguage.googleapis.com" in u) or ("genai.googleapis.com" in u)


def _looks_like_model_unavailable(msg: str) -> bool:
    m = (msg or "").strip().lower()
    if not m:
        return False
    # Common proxy / gateway patterns (PackyAPI etc.)
    if "无可用渠道" in m:
        return True
    if "model_not_found" in m or "模型不存在" in m:
        return True
    if "no distributor" in m or "distributor" in m:
        return True
    return False


@dataclass(frozen=True)
class LLMConfig:
    provider: Provider
    model: str
    base_url: str | None = None  # used by openai-compatible and (optionally) gemini
    api_key: str | None = None
    temperature: float = 0.7
    max_tokens: int = 800
    wire_api: WireAPI = "chat"  # only used for openai-compatible providers

    def __repr__(self) -> str:  # pragma: no cover
        # Avoid leaking secrets if someone prints the config.
        redacted_key = "***" if self.api_key else None
        return (
            "LLMConfig("
            f"provider={self.provider!r}, "
            f"model={self.model!r}, "
            f"base_url={self.base_url!r}, "
            f"api_key={redacted_key!r}, "
            f"temperature={self.temperature!r}, "
            f"max_tokens={self.max_tokens!r}, "
            f"wire_api={self.wire_api!r}"
            ")"
        )


def _normalize_base_url(url: str) -> str:
    u = url.strip().rstrip("/")
    if len(u) >= 2 and ((u[0] == u[-1] == '"') or (u[0] == u[-1] == "'")):
        u = u[1:-1].strip().rstrip("/")
    if u and not (u.startswith("http://") or u.startswith("https://")):
        u = "https://" + u.lstrip("/")
    return u


_OPENAI_ENDPOINT_SUFFIXES = (
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/responses",
    "/responses",
)


def _strip_openai_endpoint_suffix(base_url: str) -> str:
    """
    Some providers (including PackyAPI docs for certain clients) present the full
    endpoint URL like:
      https://www.packyapi.com/v1/chat/completions
    while our app expects a base URL like:
      https://www.packyapi.com (or /v1)

    This helper makes the app more copy/paste friendly.
    """

    u = (base_url or "").strip().rstrip("/")
    for suf in _OPENAI_ENDPOINT_SUFFIXES:
        if u.endswith(suf):
            return u[: -len(suf)].rstrip("/")
    return u


def _normalize_openai_model_name(model: str) -> str:
    """
    Normalize common user inputs:
    - gpt4o -> gpt-4o
    - gpt4o-mini -> gpt-4o-mini
    - gpt5.2 -> gpt-5.2

    This is intentionally conservative: only apply when the user omitted the dash
    after 'gpt'.
    """

    m = (model or "").strip()
    low = m.lower()

    # Common aliases without dash.
    if low == "gpt4o":
        return "gpt-4o"
    if low == "gpt4o-mini":
        return "gpt-4o-mini"

    # Generic: gpt5..., gpt4..., etc -> gpt-5..., gpt-4...
    if re.match(r"^gpt\d", low) and not low.startswith("gpt-"):
        return "gpt-" + m[3:]

    return m


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
        wire_api_raw = openai_cfg.get("wire_api") or openai_cfg.get("api") or "chat"
        wire_api_s = str(wire_api_raw).strip().lower()
        wire_api: WireAPI = "responses" if wire_api_s in ("responses", "response") else "chat"
        model = str(model).strip()
        if len(model) >= 2 and ((model[0] == model[-1] == '"') or (model[0] == model[-1] == "'")):
            model = model[1:-1].strip()
        model = _normalize_openai_model_name(model)
        api_key = s.openai_api_key
        return LLMConfig(
            provider="openai",
            base_url=_strip_openai_endpoint_suffix(_normalize_base_url(str(base_url))),
            model=str(model),
            api_key=api_key,
            temperature=temperature_f,
            max_tokens=max_tokens_i,
            wire_api=wire_api,
        )

    gemini_cfg = llm.get("gemini") if isinstance(llm.get("gemini"), dict) else {}
    base_url = gemini_cfg.get("base_url") or s.gemini_base_url or "https://generativelanguage.googleapis.com"
    model = gemini_cfg.get("model") or s.gemini_model or "gemini-1.5-flash"
    model = str(model).strip()
    if len(model) >= 2 and ((model[0] == model[-1] == '"') or (model[0] == model[-1] == "'")):
        model = model[1:-1].strip()
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

    def clip(s: str, max_len: int = 220) -> str:
        ss = (s or "").strip()
        if len(ss) <= max_len:
            return ss
        return ss[: max_len - 3].rstrip() + "..."

    def extract_err_detail(resp: httpx.Response) -> str:
        ctype = (resp.headers.get("content-type") or "").lower()
        try:
            if "application/json" in ctype:
                data = resp.json()
                # OpenAI style: {"error": {"message": "...", ...}}
                if isinstance(data, dict) and isinstance(data.get("error"), dict):
                    msg = data["error"].get("message")
                    if isinstance(msg, str) and msg.strip():
                        return clip(msg)
                # Some gateways use {"detail": "..."}.
                detail = data.get("detail") if isinstance(data, dict) else None
                if isinstance(detail, str) and detail.strip():
                    return clip(detail)
        except Exception:
            pass
        # Avoid dumping raw HTML error pages into traces/UI.
        if "text/html" in ctype:
            return "html_error_page"
        try:
            return clip(resp.text)
        except Exception:
            return ""

    def err_score(msg: str) -> int:
        # Prefer the most actionable error for end users.
        # Do NOT let a trailing 404 override a prior 502.
        m = (msg or "").strip()
        if not m:
            return -1
        if m.startswith("openai_http_404") or m.startswith("gemini_http_404"):
            return 0
        if m.startswith("openai_non_json_response"):
            return 10
        if m.startswith("openai_bad_json"):
            return 20
        if m.startswith("openai_bad_response"):
            return 25
        if m.startswith("empty_completion"):
            return 30
        if m.startswith("openai_timeout") or m.startswith("openai_network_error"):
            return 80
        if m.startswith("openai_http_"):
            return 90
        if m.startswith("gemini_timeout") or m.startswith("gemini_network_error"):
            return 80
        if m.startswith("gemini_http_"):
            return 90
        return 40

    def build_candidates(base_in: str, path: str) -> list[str]:
        # Supports BOTH styles without producing /v1/v1:
        # - base=https://host              then POST /v1/<path>
        # - base=https://host/v1           then POST /<path>
        b = _normalize_base_url(base_in)
        bases: list[str] = [b]
        if b.endswith("/v1"):
            bases.append(b[: -len("/v1")])

        candidates_out: list[str] = []
        for bb in bases:
            if not bb:
                continue
            if bb.endswith("/v1"):
                urls = (f"{bb}/{path}",)
            else:
                urls = (f"{bb}/v1/{path}", f"{bb}/{path}")
            for u in urls:
                if u not in candidates_out:
                    candidates_out.append(u)
        return candidates_out

    def extract_chat_text(data: Any) -> str:
        # Some gateways return a Responses-like shortcut even on chat endpoints.
        if isinstance(data, dict):
            out_text = data.get("output_text")
            if isinstance(out_text, str) and out_text.strip():
                return out_text

        if not isinstance(data, dict):
            return ""
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            return ""

        choice0 = choices[0]
        if not isinstance(choice0, dict):
            return ""

        msg = choice0.get("message")
        if isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                return content
            if isinstance(content, list):
                parts: list[str] = []
                for part in content:
                    if isinstance(part, str) and part.strip():
                        parts.append(part)
                        continue
                    if not isinstance(part, dict):
                        continue
                    t = part.get("text") or part.get("content") or part.get("value")
                    if isinstance(t, str) and t.strip():
                        parts.append(t)
                joined = "".join(parts)
                if joined.strip():
                    return joined

        txt = choice0.get("text")
        if isinstance(txt, str) and txt.strip():
            return txt
        return ""

    def extract_responses_text(data: Any) -> str:
        if isinstance(data, dict):
            out_text = data.get("output_text")
            if isinstance(out_text, str) and out_text.strip():
                return out_text

            output = data.get("output")
            if isinstance(output, list):
                parts: list[str] = []
                for item in output:
                    if not isinstance(item, dict):
                        continue
                    content = item.get("content")
                    if not isinstance(content, list):
                        continue
                    for c in content:
                        if not isinstance(c, dict):
                            continue
                        t = c.get("text")
                        if isinstance(t, str) and t.strip():
                            parts.append(t)
                joined = "".join(parts)
                if joined.strip():
                    return joined

        # Some gateways return a chat-completions structure even on /responses.
        return extract_chat_text(data)

    transient_status = {408, 409, 425, 429, 500, 502, 503, 504}
    max_attempts = 3
    timeout_s = 75

    async def openai_compatible_request(
        base_url: str,
        api_key: str,
        path: str,
        payload: dict[str, Any],
        parser: Callable[[Any], str],
    ) -> str:
        candidates = build_candidates(base_url, path)
        headers = {"Authorization": f"Bearer {api_key}"}

        async with httpx.AsyncClient(timeout=timeout_s, trust_env=False) as client:
            last_err: str | None = None
            best_err: str | None = None

            def record_err(msg: str) -> None:
                nonlocal last_err, best_err
                last_err = msg
                if best_err is None or err_score(msg) >= err_score(best_err):
                    best_err = msg

            for attempt in range(1, max_attempts + 1):
                attempt_had_transient = False
                for url in candidates:
                    try:
                        r = await client.post(url, json=payload, headers=headers)
                    except httpx.TimeoutException:
                        record_err("openai_timeout")
                        attempt_had_transient = True
                        continue
                    except httpx.RequestError as e:
                        record_err(f"openai_network_error:{type(e).__name__}")
                        attempt_had_transient = True
                        continue

                    if r.status_code == 404:
                        record_err("openai_http_404")
                        continue

                    if r.status_code >= 400:
                        detail = extract_err_detail(r)
                        msg = f"openai_http_{r.status_code}"
                        if detail:
                            msg += f":{detail}"

                        if r.status_code in transient_status:
                            record_err(msg)
                            attempt_had_transient = True
                            continue

                        raise LLMError(msg)

                    ctype = (r.headers.get("content-type") or "").lower()
                    if "application/json" not in ctype:
                        record_err("openai_non_json_response")
                        continue

                    try:
                        data = r.json()
                    except Exception:
                        record_err("openai_bad_json")
                        continue

                    try:
                        content = parser(data)
                    except Exception as e:
                        record_err(f"openai_bad_response:{type(e).__name__}")
                        continue

                    content_s = content if isinstance(content, str) else str(content)
                    if not content_s.strip():
                        record_err("empty_completion")
                        continue

                    return content_s

                if attempt < max_attempts and attempt_had_transient:
                    backoff = (0.8 * (2 ** (attempt - 1))) + (random.random() * 0.2)
                    await asyncio.sleep(backoff)
                    continue
                break

        raise LLMError(best_err or last_err or "openai_failed")

    async def openai_compatible_generate(
        base_url: str,
        api_key: str,
        model: str,
        prefer: WireAPI = "chat",
    ) -> str:
        payload_chat = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": cfg.temperature,
            "max_tokens": cfg.max_tokens,
        }
        payload_responses = {
            "model": model,
            "instructions": system_prompt,
            "input": user_prompt,
            "temperature": cfg.temperature,
            "max_output_tokens": cfg.max_tokens,
        }

        first: WireAPI = prefer
        second: WireAPI = "responses" if first == "chat" else "chat"
        errs: list[str] = []

        for kind in (first, second):
            try:
                if kind == "responses":
                    return await openai_compatible_request(
                        base_url=base_url,
                        api_key=api_key,
                        path="responses",
                        payload=payload_responses,
                        parser=extract_responses_text,
                    )
                return await openai_compatible_request(
                    base_url=base_url,
                    api_key=api_key,
                    path="chat/completions",
                    payload=payload_chat,
                    parser=extract_chat_text,
                )
            except LLMError as e:
                errs.append(str(e))
                continue

        if errs:
            best = max(errs, key=err_score)

            # If we tried both wire APIs, keep some context: PackyAPI (and other
            # gateways) can fail differently across endpoints. Showing only the
            # "best" error sometimes hides the more actionable one.
            alt = next((e for e in errs if e != best), None)
            if alt and alt not in best:
                best = f"{best} | alt={alt}"

            # PackyAPI-specific hint: their docs recommend /v1/chat/completions
            # for most integrations, and Codex-group users often use
            # gpt-5.1-codex. In some regions, /v1/responses may be unstable and
            # return Cloudflare 502 HTML.
            b_low = (base_url or "").lower()
            if "packyapi.com" in b_low:
                # Only add a hint when it looks like the common failure pattern.
                if ("openai_http_502:html_error_page" in best) and (
                    ("openai_http_404" in best) or ("openai_http_404" in (alt or ""))
                ):
                    best += " | packyapi_hint=try wire_api=chat and model=gpt-5.1-codex"
                elif ("openai_http_502:html_error_page" in best) and (
                    model.strip().lower() in {"gpt-5.2", "gpt-5", "gpt-5-codex", "gpt-5.2-codex"}
                ):
                    best += " | packyapi_hint=try model=gpt-5.1-codex"

            raise LLMError(best)
        raise LLMError("openai_failed")

    async def gemini_generate_v1beta(base_url: str, api_key: str, model: str) -> str:
        # Support both:
        # - Official Google Generative Language API
        # - Proxies that keep the same path shape (e.g. PackyAPI)
        base = _normalize_base_url(base_url)
        bases: list[str] = [base]
        if base.endswith("/v1beta"):
            bases.append(base[: -len("/v1beta")])
        if base.endswith("/v1"):
            bases.append(base[: -len("/v1")])

        urls: list[str] = []
        for bb in bases:
            if not bb:
                continue
            if bb.endswith("/v1beta"):
                url = f"{bb}/models/{model}:generateContent"
            else:
                url = f"{bb}/v1beta/models/{model}:generateContent"
            if url not in urls:
                urls.append(url)

        payload = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {
                "temperature": cfg.temperature,
                "maxOutputTokens": cfg.max_tokens,
            },
        }
        params = {"key": api_key}

        async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
            last_err: str | None = None

            for attempt in range(1, 4):
                attempt_had_transient = False
                for url in urls:
                    try:
                        r = await client.post(url, params=params, json=payload)
                    except httpx.TimeoutException:
                        last_err = "gemini_timeout"
                        attempt_had_transient = True
                        continue
                    except httpx.RequestError as e:
                        last_err = f"gemini_network_error:{type(e).__name__}"
                        attempt_had_transient = True
                        continue

                    if r.status_code == 404:
                        last_err = "gemini_http_404"
                        continue

                    if r.status_code >= 400:
                        detail = extract_err_detail(r)
                        msg = f"gemini_http_{r.status_code}"
                        if detail:
                            msg += f":{detail}"

                        # A 503 can be either a transient gateway hiccup OR a
                        # "model unavailable" situation (no distributor/channel).
                        # Only treat it as retryable when it looks transient.
                        if r.status_code in transient_status and not _looks_like_model_unavailable(msg):
                            last_err = msg
                            attempt_had_transient = True
                            continue

                        raise LLMError(msg)

                    try:
                        data = r.json()
                    except Exception:
                        last_err = "gemini_bad_json"
                        continue

                    try:
                        text_s = ""
                        candidates = data.get("candidates") if isinstance(data, dict) else None
                        if isinstance(candidates, list) and candidates:
                            cand0 = candidates[0] if isinstance(candidates[0], dict) else {}
                            content = cand0.get("content") if isinstance(cand0, dict) else None
                            if isinstance(content, dict):
                                parts = content.get("parts")
                                if isinstance(parts, list) and parts:
                                    text_out = "".join(
                                        (p.get("text", "") if isinstance(p, dict) else "")
                                        for p in parts
                                    )
                                    text_s = str(text_out)
                    except Exception as e:
                        raise LLMError(f"gemini_bad_response:{type(e).__name__}")

                    if not text_s.strip():
                        # Some gateways/proxies occasionally return a structurally
                        # valid response but without any text parts. Treat as
                        # retryable to reduce flaky empty outputs.
                        last_err = "empty_completion"
                        attempt_had_transient = True
                        continue

                    return text_s

                if attempt < 3 and attempt_had_transient:
                    backoff = (0.8 * (2 ** (attempt - 1))) + (random.random() * 0.2)
                    await asyncio.sleep(backoff)
                    continue
                break

        raise LLMError(last_err or "gemini_failed")

    if cfg.provider == "openai":
        base = cfg.base_url or "https://api.openai.com/v1"
        return await openai_compatible_generate(
            base_url=base,
            api_key=cfg.api_key,
            model=cfg.model,
            prefer=cfg.wire_api,
        )

    # Gemini: we always try the Gemini v1beta shape first (works for Google and
    # some proxies). If the base_url isn't Google-like and that fails, we fall
    # back to OpenAI-compatible chat/responses (some gateways expose Gemini via
    # /chat/completions).
    base = cfg.base_url or "https://generativelanguage.googleapis.com"
    if _is_google_genai_base(base):
        return await gemini_generate_v1beta(base, cfg.api_key, cfg.model)

    try:
        return await gemini_generate_v1beta(base, cfg.api_key, cfg.model)
    except LLMError as e1:
        gemini_err = str(e1)

        # PackyAPI (and similar gateways) may intermittently report that a model
        # has "no distributor"/"no channel" in the selected group. In this case,
        # try a small set of fallback Gemini models so the app remains usable.
        if _looks_like_model_unavailable(gemini_err):
            fallbacks = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"]
            for fb in fallbacks:
                if fb.strip().lower() == (cfg.model or "").strip().lower():
                    continue
                try:
                    return await gemini_generate_v1beta(base, cfg.api_key, fb)
                except LLMError as efb:
                    # Keep the most actionable failure.
                    gemini_err = max([gemini_err, str(efb)], key=err_score)
        try:
            return await openai_compatible_generate(
                base_url=base,
                api_key=cfg.api_key,
                model=cfg.model,
                prefer="chat",
            )
        except LLMError as e2:
            # If Gemini endpoint returns a syntactically valid response but
            # with no text parts, surface that as the primary failure (it's
            # usually more actionable than "not implemented" fallbacks).
            if gemini_err.startswith("empty_completion"):
                raise LLMError(gemini_err)
            best = max([gemini_err, str(e2)], key=err_score)
            if "packyapi.com" in (base or "").lower() and _looks_like_model_unavailable(best):
                best += " | packyapi_hint=try gemini-2.5-flash or gemini-2.0-flash or gemini-1.5-flash"
            raise LLMError(best)


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
