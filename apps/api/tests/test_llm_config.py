from __future__ import annotations

from ai_writer_api.llm import (
    _gemini_proxy_fallback_models,
    _packy_openai_fallback_models,
    resolve_llm_config,
)
from ai_writer_api.secrets import Secrets


def test_openai_base_url_strips_full_endpoint_suffix() -> None:
    cfg = resolve_llm_config(
        {
            "llm": {
                "provider": "openai",
                "openai": {
                    "base_url": "https://www.packyapi.com/v1/chat/completions",
                    "model": "gpt-5.1-codex",
                    "wire_api": "chat",
                },
            }
        },
        secrets=Secrets(openai_api_key="sk-test"),
    )
    # We accept base urls with or without /v1; but we must not keep
    # the full endpoint path.
    assert cfg.base_url in {"https://www.packyapi.com", "https://www.packyapi.com/v1"}


def test_openai_model_name_normalization() -> None:
    cfg = resolve_llm_config(
        {
            "llm": {
                "provider": "openai",
                "openai": {
                    "base_url": "api.openai.com/v1",
                    "model": "gpt4o-mini",
                    "wire_api": "chat",
                },
            }
        },
        secrets=Secrets(openai_api_key="sk-test"),
    )
    assert cfg.model == "gpt-4o-mini"


def test_openai_model_gpt5_dash_insertion() -> None:
    cfg = resolve_llm_config(
        {
            "llm": {
                "provider": "openai",
                "openai": {
                    "base_url": "www.packyapi.com/v1",
                    "model": "gpt5.1-codex",
                    "wire_api": "chat",
                },
            }
        },
        secrets=Secrets(openai_api_key="sk-test"),
    )
    assert cfg.model == "gpt-5.1-codex"


def test_packy_openai_fallbacks_cover_gpt54() -> None:
    models = _packy_openai_fallback_models("gpt-5.4", "openai_http_404")
    assert models[:2] == ["gpt-5.2", "gpt-5.1-codex"]


def test_packy_gemini_disables_hidden_cross_model_fallbacks() -> None:
    assert _gemini_proxy_fallback_models(
        "gemini-2.5-pro", "https://www.packyapi.com/v1"
    ) == []
