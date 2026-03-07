from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from ai_writer_api.llm import LLMError
from ai_writer_api.main import app
from ai_writer_api.secrets import Secrets


def test_continue_run_softfails_config_autofill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Regression test:
    - ConfigAutofill is best-effort in weak mode.
    - A transient OpenAI-compatible 502 (often HTML) should not abort a continue run.
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "ConfigAutofillAgent" in system_prompt:
            raise LLMError("openai_http_502:html_error_page")
        if "ExtractorAgent" in system_prompt:
            return json.dumps(
                {
                    "summary_so_far": "demo",
                    "characters": [],
                    "world": "demo",
                    "timeline": [],
                    "open_loops": [],
                    "style_profile": {
                        "pov": "third",
                        "tense": "past",
                        "tone": "neutral",
                    },
                },
                ensure_ascii=True,
            )
        if "OutlinerAgent" in system_prompt:
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "Test Chapter",
                            "summary": "demo",
                            "goal": "demo",
                        }
                    ]
                },
                ensure_ascii=True,
            )
        if "WriterAgent" in system_prompt:
            return (
                "<think>planning</think>\n# Chapter 1: Test Chapter\n\nHello world.\n"
            )
        if "EditorAgent" in system_prompt:
            return "<think>edit</think>\n# Chapter 1: Test Chapter\n\nHello world (edited).\n"

        raise AssertionError("Unexpected agent system prompt")

    # runs.py imports generate_text into module scope; patch that symbol.
    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Run Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={"text": "hello\nworld\n", "filename": "pasted.txt"},
        ).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "continue",
                "source_id": src["source_id"],
                "source_slice_mode": "tail",
                "source_slice_chars": 200,
            },
        ) as res:
            assert res.status_code == 200

            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert events, "Expected at least one SSE event"

    # ConfigAutofill should NOT mark the run failed; we record as agent_output.
    assert not any(e.get("type") == "run_error" for e in events)

    assert any(
        e.get("type") == "agent_output"
        and e.get("agent") == "ConfigAutofill"
        and isinstance((e.get("data") or {}).get("error"), str)
        for e in events
    )

    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
        for e in events
    )

    chapter_evts = [
        e
        for e in events
        if e.get("type") == "artifact"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
    ]
    assert chapter_evts
    md = (chapter_evts[-1].get("data") or {}).get("markdown")
    assert isinstance(md, str)
    assert "<think>" not in md


def test_run_prompts_follow_ui_lang(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Regression test:
    - Frontend passes ui_lang.
    - Backend should inject an explicit language hint into prompts so models
      like Codex do not default to English.
    """

    import ai_writer_api.routers.runs as runs_mod

    captured: dict[str, str] = {}

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "ConfigAutofillAgent" in system_prompt:
            return "{}"
        if "OutlinerAgent" in system_prompt:
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "Test Chapter",
                            "summary": "demo",
                            "goal": "demo",
                        }
                    ]
                },
                ensure_ascii=True,
            )
        if "OutlineTranslatorAgent" in system_prompt:
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "第1章：测试章节",
                            "summary": "示例",
                            "goal": "示例",
                        }
                    ]
                },
                ensure_ascii=False,
            )
        if "WriterAgent" in system_prompt:
            captured["writer_system"] = system_prompt
            captured["writer_user"] = user_prompt
            return "# Chapter 1: Test Chapter\n\nHello world.\n"
        if "EditorAgent" in system_prompt:
            return "# Chapter 1: Test Chapter\n\nHello world (edited).\n"

        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Run Test"}).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "chapter", "chapter_index": 1, "ui_lang": "zh"},
        ) as res:
            assert res.status_code == 200

            for raw in res.iter_lines():
                if not raw:
                    continue
                if raw.startswith("data:"):
                    evt = json.loads(raw.replace("data:", "", 1).strip())
                    if evt.get("type") == "run_completed":
                        break

    assert "Simplified Chinese (zh-CN)" in captured.get("writer_system", "")
    # When ui_lang=zh, the example title should NOT be the English placeholder.
    assert "Chapter X: Title" not in captured.get("writer_user", "")


def test_chapter_run_respects_skip_outliner(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Regression test:
    - The frontend may send skip_outliner=true to avoid re-running Outliner when
      users explicitly edited/persisted an outline.
    - When skip_outliner=true, we should not call OutlinerAgent (and the run
      should still complete and persist a chapter).
    """

    import ai_writer_api.routers.runs as runs_mod

    system_prompts: list[str] = []

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        system_prompts.append(system_prompt)
        if "ConfigAutofillAgent" in system_prompt:
            return "{}"
        if "WriterAgent" in system_prompt:
            return "# Chapter 1: Test Chapter\n\nHello world.\n"
        if "EditorAgent" in system_prompt:
            return "# Chapter 1: Test Chapter\n\nHello world (edited).\n"
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Run Test"}).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "chapter", "chapter_index": 1, "skip_outliner": True},
        ) as res:
            assert res.status_code == 200

            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert any("WriterAgent" in s for s in system_prompts)
    assert not any("OutlinerAgent" in s for s in system_prompts)
    assert not any(e.get("agent") == "Outliner" for e in events)
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
        for e in events
    )


def test_continue_run_softfails_outliner(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Regression test:
    - Outliner is helpful but should not be able to brick continue runs when
      the LLM gateway is flaky (e.g. PackyAPI "no distributor" 503s).
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "ConfigAutofillAgent" in system_prompt:
            return "{}"
        if "ExtractorAgent" in system_prompt:
            return json.dumps(
                {
                    "summary_so_far": "demo",
                    "characters": [],
                    "world": "demo",
                    "timeline": [],
                    "open_loops": [],
                    "style_profile": {
                        "pov": "third",
                        "tense": "past",
                        "tone": "neutral",
                    },
                },
                ensure_ascii=True,
            )
        if "OutlinerAgent" in system_prompt:
            raise LLMError("openai_http_503:no_distributor")
        if "WriterAgent" in system_prompt:
            return "# 第1章：测试\n\n" + ("正文。" * 200) + "\n"
        if "EditorAgent" in system_prompt:
            return "# 第1章：测试\n\n" + ("正文（润色）。" * 200) + "\n"

        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Run Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={"text": "hello\nworld\n", "filename": "pasted.txt"},
        ).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "continue",
                "source_id": src["source_id"],
                "source_slice_mode": "tail",
                "source_slice_chars": 200,
                "ui_lang": "zh",
            },
        ) as res:
            assert res.status_code == 200

            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert events, "Expected at least one SSE event"

    # Outliner fails, but run should still complete without run_error.
    assert not any(e.get("type") == "run_error" for e in events)
    assert any(
        e.get("type") == "agent_output"
        and e.get("agent") == "Outliner"
        and isinstance((e.get("data") or {}).get("error"), str)
        for e in events
    )
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
        for e in events
    )


def test_editor_suspicious_output_fallbacks_to_writer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Regression test:
    - Some models may summarize/shorten during the Editor pass, resulting in a
      "completed" run with an incomplete chapter. We should fall back to the
      Writer output when the Editor output looks suspiciously short.
    """

    import ai_writer_api.routers.runs as runs_mod

    writer_md = "# Chapter 1: Test\n\n" + ("Hello world. " * 120) + "\n"
    editor_md = "# Chapter 1: Test\n\nshort\n"

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "ConfigAutofillAgent" in system_prompt:
            return "{}"
        if "OutlinerAgent" in system_prompt:
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "Test Chapter",
                            "summary": "demo",
                            "goal": "demo",
                        }
                    ]
                },
                ensure_ascii=True,
            )
        if "WriterAgent" in system_prompt:
            return writer_md
        if "EditorAgent" in system_prompt:
            return editor_md

        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Run Test"}).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "chapter", "chapter_index": 1, "ui_lang": "en"},
        ) as res:
            assert res.status_code == 200

            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    chapter_evts = [
        e
        for e in events
        if e.get("type") == "artifact"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
    ]
    assert chapter_evts
    md = (chapter_evts[-1].get("data") or {}).get("markdown")
    assert isinstance(md, str)
    # Should fall back to Writer output (long), not keep the short Editor output.
    assert len(md) >= len(writer_md) * 0.8


def test_continue_json_agents_repair_invalid_outputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "ConfigAutofillAgent" in system_prompt:
            return "{}"
        if "ExtractorAgent" in system_prompt:
            return "```json\n{\"summary_so_far\": \"demo\""
        if "extractorJSONRepairAgent" in system_prompt:
            return json.dumps(
                {
                    "summary_so_far": "demo",
                    "characters": [],
                    "world": "demo",
                    "timeline": [],
                    "open_loops": [],
                    "style_profile": {
                        "pov": "third",
                        "tense": "past",
                        "tone": "neutral",
                    },
                },
                ensure_ascii=True,
            )
        if "OutlinerAgent" in system_prompt:
            return '{"chapters":[{"index":1,"title":"Repair Me"'
        if "outlinerJSONRepairAgent" in system_prompt:
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "Repair Me",
                            "summary": "demo",
                            "goal": "demo",
                        }
                    ]
                },
                ensure_ascii=True,
            )
        if "WriterAgent" in system_prompt:
            return "# Chapter 1: Repair Me\n\nHello world.\n"
        if "EditorAgent" in system_prompt:
            return "# Chapter 1: Repair Me\n\nHello world (edited).\n"

        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Repair Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={"text": "hello\nworld\n", "filename": "pasted.txt"},
        ).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "continue",
                "source_id": src["source_id"],
                "source_slice_mode": "tail",
                "source_slice_chars": 200,
                "chapter_index": 1,
                "ui_lang": "en",
            },
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw or not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Extractor"
        and (e.get("data") or {}).get("artifact_type") == "story_state"
        for e in events
    )
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Outliner"
        and (e.get("data") or {}).get("artifact_type") == "outline"
        for e in events
    )
    assert any(
        e.get("type") == "agent_output"
        and e.get("agent") == "Extractor"
        and (e.get("data") or {}).get("step") == "repair_json"
        for e in events
    )
    assert any(
        e.get("type") == "agent_output"
        and e.get("agent") == "Outliner"
        and (e.get("data") or {}).get("step") == "repair_json"
        for e in events
    )


def test_continue_structured_agents_fallback_to_openai_on_gemini_packy_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.llm as llm_mod
    import ai_writer_api.routers.runs as runs_mod

    structured_calls: list[tuple[str, str]] = []

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        provider = str(getattr(cfg, "provider", ""))
        model = str(getattr(cfg, "model", ""))
        if "ConfigAutofillAgent" in system_prompt:
            structured_calls.append(("ConfigAutofill", provider))
            if provider == "gemini":
                raise LLMError("gemini_http_503:temporary_gateway")
            return "{}"
        if "ExtractorAgent" in system_prompt:
            structured_calls.append(("Extractor", provider))
            if provider == "gemini":
                raise LLMError("gemini_http_503:temporary_gateway")
            return json.dumps(
                {
                    "summary_so_far": "demo",
                    "characters": [],
                    "world": "demo",
                    "timeline": [],
                    "open_loops": [],
                    "style_profile": {
                        "pov": "third",
                        "tense": "past",
                        "tone": "neutral",
                    },
                },
                ensure_ascii=True,
            )
        if "OutlinerAgent" in system_prompt:
            structured_calls.append(("Outliner", provider))
            if provider == "gemini":
                raise LLMError("gemini_http_503:temporary_gateway")
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "Fallback Chapter",
                            "summary": "demo",
                            "goal": "demo",
                        }
                    ]
                },
                ensure_ascii=True,
            )
        if "WriterAgent" in system_prompt:
            return "# Chapter 1: Fallback Chapter\n\nHello world.\n"
        if "EditorAgent" in system_prompt:
            return "# Chapter 1: Fallback Chapter\n\nHello world (edited).\n"

        raise AssertionError(f"Unexpected agent system prompt: {model}")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)
    monkeypatch.setattr(
        llm_mod,
        "load_secrets",
        lambda: Secrets(openai_api_key="sk-openai", gemini_api_key="sk-gemini"),
    )

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Structured Fallback Test"}).json()
        client.patch(
            f"/api/projects/{p['id']}",
            json={
                "settings": {
                    "llm": {
                        "provider": "gemini",
                        "temperature": 0.7,
                        "max_tokens": 900,
                        "gemini": {
                            "model": "gemini-2.5-pro",
                            "base_url": "https://www.packyapi.com/v1",
                        },
                        "openai": {
                            "model": "gpt-5.2",
                            "base_url": "https://www.packyapi.com/v1",
                        },
                    }
                }
            },
        ).raise_for_status()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={"text": "hello\nworld\n", "filename": "pasted.txt"},
        ).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "continue",
                "source_id": src["source_id"],
                "source_slice_mode": "tail",
                "source_slice_chars": 200,
                "chapter_index": 1,
                "ui_lang": "en",
            },
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw or not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert structured_calls[:3] == [
        ("ConfigAutofill", "openai"),
        ("Extractor", "openai"),
        ("Outliner", "openai"),
    ]
    assert any(
        e.get("type") == "tool_call"
        and e.get("agent") == "ConfigAutofill"
        and (e.get("data") or {}).get("note")
        == "prefer_openai_structured_for_gemini_packy"
        for e in events
    )
    assert any(
        e.get("type") == "tool_call"
        and e.get("agent") == "Extractor"
        and (e.get("data") or {}).get("note")
        == "prefer_openai_structured_for_gemini_packy"
        for e in events
    )
    assert any(
        e.get("type") == "tool_call"
        and e.get("agent") == "Outliner"
        and (e.get("data") or {}).get("note")
        == "prefer_openai_structured_for_gemini_packy"
        for e in events
    )
    assert any(
        e.get("type") == "tool_call"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("provider") == "gemini"
        for e in events
    )
    assert any(
        e.get("type") == "tool_call"
        and e.get("agent") == "Editor"
        and (e.get("data") or {}).get("note")
        == "prefer_openai_editor_for_gemini_packy"
        for e in events
    )
    assert not any(e.get("type") == "run_error" for e in events)
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Extractor"
        and (e.get("data") or {}).get("artifact_type") == "story_state"
        for e in events
    )
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Outliner"
        and (e.get("data") or {}).get("artifact_type") == "outline"
        for e in events
    )
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
        for e in events
    )



def test_writer_retry_prefers_same_gemini_model_before_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    writer_calls: list[str] = []

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        model = str(getattr(cfg, "model", ""))
        if "ConfigAutofillAgent" in system_prompt:
            return "{}"
        if "OutlinerAgent" in system_prompt:
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "Retry Chapter",
                            "summary": "demo",
                            "goal": "demo",
                        }
                    ]
                },
                ensure_ascii=True,
            )
        if "WriterAgent" in system_prompt:
            writer_calls.append(model)
            if len(writer_calls) == 1:
                raise LLMError("gemini_http_503:temporary_gateway")
            return "# 第1章：重试成功\n\n" + ("正文。" * 220) + "\n"
        if "EditorAgent" in system_prompt:
            return "# 第1章：重试成功\n\n" + ("正文（润色）。" * 220) + "\n"

        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Gemini Retry Test"}).json()
        client.patch(
            f"/api/projects/{p['id']}",
            json={
                "settings": {
                    "llm": {
                        "provider": "gemini",
                        "gemini": {
                            "model": "gemini-2.5-pro",
                            "base_url": "https://www.packyapi.com/v1",
                        },
                    }
                }
            },
        ).raise_for_status()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "chapter", "chapter_index": 1, "ui_lang": "zh"},
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw or not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert writer_calls[:2] == ["gemini-2.5-pro", "gemini-2.5-pro"]
    assert not any(e.get("type") == "run_error" for e in events)
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
        for e in events
    )



def test_writer_uses_openai_fallback_after_gemini_packy_model_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.llm as llm_mod
    import ai_writer_api.routers.runs as runs_mod

    writer_calls: list[tuple[str, str]] = []

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        provider = str(getattr(cfg, "provider", ""))
        model = str(getattr(cfg, "model", ""))
        if "ConfigAutofillAgent" in system_prompt:
            return "{}"
        if "OutlinerAgent" in system_prompt:
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "Fallback Chapter",
                            "summary": "demo",
                            "goal": "demo",
                        }
                    ]
                },
                ensure_ascii=True,
            )
        if "WriterAgent" in system_prompt:
            writer_calls.append((provider, model))
            if provider == "gemini":
                raise LLMError(
                    "openai_http_503:gemini_model_unavailable_distributor"
                )
            return "# \u7b2c1\u7ae0\uff1a\u56de\u9000\u6210\u529f\n\n" + ("\u6b63\u6587\u3002" * 220) + "\n"
        if "EditorAgent" in system_prompt:
            return "# \u7b2c1\u7ae0\uff1a\u56de\u9000\u6210\u529f\n\n" + ("\u6b63\u6587\uff08\u6da6\u8272\uff09\u3002" * 220) + "\n"

        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)
    monkeypatch.setattr(
        llm_mod,
        "load_secrets",
        lambda: Secrets(openai_api_key="sk-openai", gemini_api_key="sk-gemini"),
    )

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Gemini OpenAI Rescue"}).json()
        client.patch(
            f"/api/projects/{p['id']}",
            json={
                "settings": {
                    "llm": {
                        "provider": "gemini",
                        "gemini": {
                            "model": "gemini-2.5-pro",
                            "base_url": "https://www.packyapi.com/v1",
                        },
                        "openai": {
                            "model": "gpt-5.2",
                            "base_url": "https://www.packyapi.com/v1",
                        },
                    }
                }
            },
        ).raise_for_status()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "chapter", "chapter_index": 1, "ui_lang": "zh"},
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw or not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert writer_calls[:3] == [
        ("gemini", "gemini-2.5-pro"),
        ("gemini", "gemini-2.5-pro"),
        ("openai", "gpt-5.2"),
    ]
    assert any(
        e.get("type") == "tool_call"
        and e.get("agent") == "Writer"
        and str((e.get("data") or {}).get("note") or "").startswith(
            "retry_gateway_error_openai_fallback:"
        )
        for e in events
    )
    assert not any(e.get("type") == "run_error" for e in events)
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
        for e in events
    )



def test_writer_too_short_can_use_openai_fallback_for_gemini_packy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.llm as llm_mod
    import ai_writer_api.routers.runs as runs_mod

    writer_calls: list[tuple[str, str]] = []

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        provider = str(getattr(cfg, "provider", ""))
        model = str(getattr(cfg, "model", ""))
        if "ConfigAutofillAgent" in system_prompt:
            return "{}"
        if "OutlinerAgent" in system_prompt:
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "Short Retry",
                            "summary": "demo",
                            "goal": "demo",
                        }
                    ]
                },
                ensure_ascii=True,
            )
        if "WriterAgent" in system_prompt:
            writer_calls.append((provider, model))
            if provider == "gemini":
                return "# \u7b2c1\u7ae0\uff1aShort Retry\n\n\u592a\u77ed\u4e86\u3002\n"
            return "# \u7b2c1\u7ae0\uff1aShort Retry\n\n" + ("\u6b63\u6587\u3002" * 220) + "\n"
        if "EditorAgent" in system_prompt:
            return "# \u7b2c1\u7ae0\uff1aShort Retry\n\n" + ("\u6b63\u6587\uff08\u6da6\u8272\uff09\u3002" * 220) + "\n"

        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)
    monkeypatch.setattr(
        llm_mod,
        "load_secrets",
        lambda: Secrets(openai_api_key="sk-openai", gemini_api_key="sk-gemini"),
    )

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Gemini Too Short Rescue"}).json()
        client.patch(
            f"/api/projects/{p['id']}",
            json={
                "settings": {
                    "llm": {
                        "provider": "gemini",
                        "gemini": {
                            "model": "gemini-3-flash-preview",
                            "base_url": "https://www.packyapi.com/v1",
                        },
                        "openai": {
                            "model": "gpt-5.2",
                            "base_url": "https://www.packyapi.com/v1",
                        },
                    }
                }
            },
        ).raise_for_status()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "chapter", "chapter_index": 1, "ui_lang": "zh"},
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw or not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert writer_calls[:3] == [
        ("gemini", "gemini-3-flash-preview"),
        ("gemini", "gemini-3-flash-preview"),
        ("openai", "gpt-5.1-codex"),
    ]
    assert any(
        e.get("type") == "tool_call"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("note") == "retry_too_short_openai_fallback"
        for e in events
    )
    assert not any(e.get("type") == "run_error" for e in events)
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "Writer"
        and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
        for e in events
    )


def test_editor_retries_suspicious_output_before_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    writer_md = "# Chapter 1: Test\n\n" + ("Hello world. " * 120) + "\n"
    editor_calls = 0

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        nonlocal editor_calls
        if "ConfigAutofillAgent" in system_prompt:
            return "{}"
        if "OutlinerAgent" in system_prompt:
            return json.dumps(
                {
                    "chapters": [
                        {
                            "index": 1,
                            "title": "Test Chapter",
                            "summary": "demo",
                            "goal": "demo",
                        }
                    ]
                },
                ensure_ascii=True,
            )
        if "WriterAgent" in system_prompt:
            return writer_md
        if "EditorAgent" in system_prompt:
            editor_calls += 1
            if editor_calls == 1:
                return "# Chapter 1: Test\n\nshort\n"
            return "# Chapter 1: Test\n\n" + ("Hello world (edited). " * 120) + "\n"

        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Editor Retry Test"}).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "chapter", "chapter_index": 1, "ui_lang": "en"},
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw or not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert editor_calls == 2
    assert not any(
        e.get("type") == "agent_output"
        and e.get("agent") == "Editor"
        and isinstance((e.get("data") or {}).get("error"), str)
        and "editor_fallback_to_writer" in str((e.get("data") or {}).get("error"))
        for e in events
    )


def test_book_summarize_persists_kb_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    v1.10 regression test:
    - book_summarize should chunk a stored book source and persist summaries into KB.
    - It should emit a final stats artifact and complete the run when at least
      one chunk is summarized successfully.
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookSummarizerAgent" in system_prompt:
            return json.dumps(
                {
                    "summary": "demo",
                    "key_events": ["event"],
                    "characters": ["Alice"],
                    "locations": ["Town"],
                    "timeline": ["Day 1"],
                    "open_loops": ["mystery"],
                },
                ensure_ascii=True,
            )
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Book Sum Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={
                "text": ("hello world. " * 600) + "\n" + ("more text. " * 600),
                "filename": "book.txt",
            },
        ).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "book_summarize",
                "source_id": src["source_id"],
                "chunk_chars": 800,
                "overlap_chars": 0,
                "max_chunks": 5,
                "replace_existing": True,
            },
        ) as res:
            assert res.status_code == 200

            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

        assert any(
            e.get("type") == "artifact"
            and e.get("agent") == "BookSummarizer"
            and (e.get("data") or {}).get("artifact_type") == "book_summarize_stats"
            and int(((e.get("data") or {}).get("created") or 0)) >= 1
            for e in events
        )

        chunks = client.get(f"/api/projects/{p['id']}/kb/chunks")
        assert chunks.status_code == 200
        listed = chunks.json()
        assert any(it.get("source_type") == "book_summary" for it in listed)


def test_book_summarize_chapter_mode_uses_chapter_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    v2.x regression test:
    - book_summarize with segment_mode=chapter should summarize by detected chapters.
    - It should emit stats with segment_mode=chapter and persist KB chunks tagged as book_chapter:*.
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookSummarizerAgent" in system_prompt:
            return json.dumps(
                {
                    "summary": "demo",
                    "key_events": ["event"],
                    "characters": ["Alice"],
                    "locations": ["Town"],
                    "timeline": ["Day 1"],
                    "open_loops": ["mystery"],
                },
                ensure_ascii=True,
            )
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Book Sum Chapter Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={
                "text": "第1章：开端\n"
                + ("A" * 1200)
                + "\n\n第2章：继续\n"
                + ("B" * 1200),
                "filename": "book.txt",
            },
        ).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "book_summarize",
                "source_id": src["source_id"],
                "segment_mode": "chapter",
                "replace_existing": True,
            },
        ) as res:
            assert res.status_code == 200

            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

        assert any(
            e.get("type") == "artifact"
            and e.get("agent") == "BookSummarizer"
            and (e.get("data") or {}).get("artifact_type") == "book_summarize_stats"
            and (e.get("data") or {}).get("segment_mode") == "chapter"
            and int(((e.get("data") or {}).get("created") or 0)) >= 1
            for e in events
        )

        chunks = client.get(f"/api/projects/{p['id']}/kb/chunks")
        assert chunks.status_code == 200
        listed = chunks.json()
        assert any(
            (it.get("source_type") == "book_summary")
            and ("book_chapter:" in (it.get("tags") or ""))
            for it in listed
        )


def test_book_summarize_tolerates_non_json_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Real gateways occasionally return non-JSON text even when instructed.

    book_summarize should NOT crash the SSE stream in that case; it should
    store a best-effort text summary record and complete when at least one
    segment is stored successfully.
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookSummarizerAgent" in system_prompt:
            return "这不是JSON，但应该被容错保存。"
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post(
            "/api/projects", json={"title": "Book Sum Non-JSON Test"}
        ).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={
                "text": "第1章：开端\n"
                + ("A" * 1200)
                + "\n\n第2章：继续\n"
                + ("B" * 1200),
                "filename": "book.txt",
            },
        ).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "book_summarize",
                "source_id": src["source_id"],
                "segment_mode": "chapter",
                "replace_existing": True,
            },
        ) as res:
            assert res.status_code == 200

            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

        assert any(
            e.get("type") == "artifact"
            and e.get("agent") == "BookSummarizer"
            and (e.get("data") or {}).get("artifact_type") == "book_summarize_stats"
            and int(((e.get("data") or {}).get("created") or 0)) >= 1
            and int(((e.get("data") or {}).get("json_parse_failed") or 0)) >= 1
            for e in events
        )

        chunks = client.get(f"/api/projects/{p['id']}/kb/chunks")
        assert chunks.status_code == 200
        listed = chunks.json()
        assert any(it.get("source_type") == "book_summary" for it in listed)
        # Should persist a JSON record with a text fallback + parse_error.
        assert any(
            ("parse_error" in (it.get("content") or ""))
            and ("text" in (it.get("content") or ""))
            for it in listed
        )


def test_book_summarize_all_skipped_is_not_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    v2.x regression test:
    - When replace_existing=false and all parts were already summarized, the run should
      complete successfully (created=0, skipped>0) instead of failing with
      book_summarize_no_results.
    - It should also avoid making any LLM calls when everything is skipped.
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text_ok(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookSummarizerAgent" in system_prompt:
            return json.dumps(
                {
                    "summary": "demo",
                    "key_events": ["event"],
                    "characters": ["Alice"],
                    "locations": ["Town"],
                    "timeline": ["Day 1"],
                    "open_loops": ["mystery"],
                },
                ensure_ascii=True,
            )
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text_ok)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Book Sum Skip Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={
                "text": "第1章：开端\n"
                + ("A" * 1200)
                + "\n\n第2章：继续\n"
                + ("B" * 1200),
                "filename": "book.txt",
            },
        ).json()

        # First pass: summarize normally (creates KB chunks).
        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "book_summarize",
                "source_id": src["source_id"],
                "segment_mode": "chapter",
                "replace_existing": True,
            },
        ) as res:
            assert res.status_code == 200
            for raw in res.iter_lines():
                if not raw or not raw.startswith("data:"):
                    continue
                if (
                    json.loads(raw.replace("data:", "", 1).strip()).get("type")
                    == "run_completed"
                ):
                    break

        # Second pass: replace_existing=false should skip all parts and NOT call LLM.
        async def fake_generate_text_must_not_run(
            *, system_prompt: str, user_prompt: str, cfg: object
        ) -> str:  # type: ignore[override]
            raise AssertionError("LLM should not be called when all parts are skipped")

        monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text_must_not_run)

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "book_summarize",
                "source_id": src["source_id"],
                "segment_mode": "chapter",
                "replace_existing": False,
            },
        ) as res2:
            assert res2.status_code == 200
            events2: list[dict[str, object]] = []
            for raw in res2.iter_lines():
                if not raw or not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events2.append(evt)
                if evt.get("type") == "run_completed":
                    break

        stats = [
            (e.get("data") or {})
            for e in events2
            if e.get("type") == "artifact"
            and e.get("agent") == "BookSummarizer"
            and (e.get("data") or {}).get("artifact_type") == "book_summarize_stats"
        ]
        assert stats
        created = int((stats[-1].get("created") or 0))
        skipped = int((stats[-1].get("skipped") or 0))
        assert created == 0
        assert skipped >= 1


def test_book_compile_persists_book_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    v1.11 regression test:
    - book_compile should compile existing book_summary KB chunks into a book_state chunk.
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookCompilerAgent" in system_prompt:
            return json.dumps(
                {
                    "book_summary": "demo",
                    "style_profile": {
                        "pov": "third",
                        "tense": "past",
                        "tone": "neutral",
                        "genre": "fiction",
                    },
                    "world": "demo",
                    "character_cards": [
                        {
                            "name": "Alice",
                            "role": "protagonist",
                            "traits": "brave",
                            "relationships": "none",
                            "current_status": "ok",
                            "arc": "demo",
                        }
                    ],
                    "timeline": [{"when": "Day 1", "event": "demo"}],
                    "open_loops": ["mystery"],
                    "continuation_seed": {
                        "where_to_resume": "end",
                        "next_scene": "demo",
                        "constraints": [],
                    },
                },
                ensure_ascii=True,
            )
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Book Compile Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={
                "text": ("hello world. " * 200) + "\n" + ("more text. " * 200),
                "filename": "book.txt",
            },
        ).json()
        sid = src["source_id"]

        # Seed some book_summary KB chunks (as if book_summarize already ran).
        for i in (1, 2, 3):
            created = client.post(
                f"/api/projects/{p['id']}/kb/chunks",
                json={
                    "title": f"sum {i}",
                    "content": json.dumps(
                        {
                            "book_source_id": sid,
                            "chunk_index": i,
                            "start_char": (i - 1) * 1000,
                            "data": {
                                "summary": f"demo {i}",
                                "key_events": [],
                                "characters": [],
                            },
                        },
                        ensure_ascii=True,
                    ),
                    "source_type": "book_summary",
                    "tags": [f"book_source:{sid}", f"book_chunk:{i}"],
                },
            )
            assert created.status_code == 200

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_compile", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

        assert any(
            e.get("type") == "artifact"
            and e.get("agent") == "BookCompiler"
            and (e.get("data") or {}).get("artifact_type") == "book_state"
            for e in events
        )

        chunks = client.get(f"/api/projects/{p['id']}/kb/chunks")
        assert chunks.status_code == 200
        listed = chunks.json()
        assert any(it.get("source_type") == "book_state" for it in listed)


def test_book_compile_prefers_chapter_summaries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    v2.x regression test:
    - book_compile should prefer chapter-based summaries when both chunk and chapter summaries exist.
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookCompilerAgent" in system_prompt:
            return json.dumps(
                {
                    "book_summary": "demo",
                    "style_profile": {
                        "pov": "third",
                        "tense": "past",
                        "tone": "neutral",
                        "genre": "fiction",
                    },
                    "world": "demo",
                    "character_cards": [],
                    "timeline": [],
                    "open_loops": [],
                    "continuation_seed": {
                        "where_to_resume": "end",
                        "next_scene": "demo",
                        "constraints": [],
                    },
                },
                ensure_ascii=True,
            )
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post(
            "/api/projects", json={"title": "Book Compile Prefer Chapter"}
        ).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={"text": "第1章\nhello\n", "filename": "book.txt"},
        ).json()
        sid = src["source_id"]

        # Seed both kinds.
        created_chunk = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={
                "title": "chunk sum 1",
                "content": json.dumps(
                    {
                        "book_source_id": sid,
                        "chunk_index": 1,
                        "segment_mode": "chunk",
                        "data": {"summary": "c"},
                    },
                    ensure_ascii=True,
                ),
                "source_type": "book_summary",
                "tags": [f"book_source:{sid}", "book_chunk:1"],
            },
        )
        assert created_chunk.status_code == 200

        created_chapter = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={
                "title": "chapter sum 1",
                "content": json.dumps(
                    {
                        "book_source_id": sid,
                        "chunk_index": 1,
                        "segment_mode": "chapter",
                        "chapter_label": "第1章",
                        "data": {"summary": "ch"},
                    },
                    ensure_ascii=True,
                ),
                "source_type": "book_summary",
                "tags": [f"book_source:{sid}", "book_part:chapter", "book_chapter:1"],
            },
        )
        assert created_chapter.status_code == 200

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_compile", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

        assert any(
            e.get("type") == "agent_started"
            and e.get("agent") == "BookCompiler"
            and (e.get("data") or {}).get("segment_mode") == "chapter"
            for e in events
        )


def test_book_continue_writes_chapter_from_compiled_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    v1.12 regression test:
    - book_continue should use compiled book_state + local excerpt and persist a chapter.
    - Think blocks must be stripped before persisting/emitting chapter markdown.
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookPlannerAgent" in system_prompt:
            return "<think>plan</think>\n" + json.dumps(
                {
                    "index": 1,
                    "title": "第1章：续写测试",
                    "summary": "示例",
                    "goal": "继续推进",
                },
                ensure_ascii=False,
            )
        if "WriterAgent" in system_prompt:
            body = "这是续写正文。\n" + ("继续推进剧情。" * 80) + "\n"
            return "<think>write</think>\n# 第1章：续写测试\n\n" + body
        if "EditorAgent" in system_prompt:
            body = "这是续写正文（润色）。\n" + ("继续推进剧情。" * 80) + "\n"
            return "<think>edit</think>\n# 第1章：续写测试\n\n" + body
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Book Continue Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={
                "text": "第一章内容……\n第二章内容……\n（结尾）\n",
                "filename": "book.txt",
            },
        ).json()
        sid = src["source_id"]

        # Seed a compiled book_state KB chunk (as if book_compile already ran).
        compiled_state = {
            "book_summary": "demo",
            "style_profile": {"pov": "third", "tense": "past", "tone": "neutral"},
            "world": "demo",
            "character_cards": [
                {
                    "name": "Alice",
                    "role": "protagonist",
                    "traits": "brave",
                    "relationships": "none",
                    "current_status": "ok",
                    "arc": "demo",
                }
            ],
            "timeline": [],
            "open_loops": [],
            "continuation_seed": {
                "where_to_resume": "end",
                "next_scene": "demo",
                "constraints": [],
            },
        }
        created_state = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={
                "title": "book state",
                "content": json.dumps(
                    {"book_source_id": sid, "state": compiled_state}, ensure_ascii=False
                ),
                "source_type": "book_state",
                "tags": [f"book_source:{sid}", "book_state"],
            },
        )
        assert created_state.status_code == 200

        # Seed at least one book_summary chunk (optional context; book_continue should not require it).
        created_sum = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={
                "title": "sum 1",
                "content": json.dumps(
                    {
                        "book_source_id": sid,
                        "chunk_index": 1,
                        "data": {"summary": "demo"},
                    },
                    ensure_ascii=False,
                ),
                "source_type": "book_summary",
                "tags": [f"book_source:{sid}", "book_chunk:1"],
            },
        )
        assert created_sum.status_code == 200

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "book_continue",
                "source_id": sid,
                "chapter_index": 1,
                "source_slice_mode": "tail",
                "source_slice_chars": 200,
                "ui_lang": "zh",
            },
        ) as res:
            assert res.status_code == 200

            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

        chapter_evts = [
            e
            for e in events
            if e.get("type") == "artifact"
            and e.get("agent") == "Writer"
            and (e.get("data") or {}).get("artifact_type") == "chapter_markdown"
        ]
        assert chapter_evts
        md = (chapter_evts[-1].get("data") or {}).get("markdown")
        assert isinstance(md, str)
        assert "<think>" not in md
        assert "续写正文" in md

        chapters = client.get(f"/api/projects/{p['id']}/chapters")
        assert chapters.status_code == 200
        listed = chapters.json()
        assert any(int(c.get("chapter_index") or 0) == 1 for c in listed)

        # The persisted manuscript KB chunk should be tagged with book_source
        # so Book Structure graph can link continuation chapters back to this book.
        meta = client.get(
            f"/api/projects/{p['id']}/kb/chunks_meta",
            params={
                "source_type": "manuscript",
                "tag_contains": f"book_source:{sid}",
                "limit": 50,
            },
        )
        assert meta.status_code == 200
        meta_items = meta.json()
        assert any("book_source" in (it.get("tags") or "") for it in meta_items)


def test_run_meta_and_event_polling() -> None:
    """
    Job/Progress (runs + trace) should be pollable:
    - /api/runs/{run_id} returns status + last_seq
    - /api/runs/{run_id}/events supports after_seq + limit
    """

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Run Meta Test"}).json()

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "demo"},
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

        assert events
        run_id = str(events[0].get("run_id") or "").strip()
        assert run_id
        last_seq = int(events[-1].get("seq") or 0)
        assert last_seq > 0

        meta = client.get(f"/api/runs/{run_id}").json()
        assert meta["id"] == run_id
        assert meta["project_id"] == p["id"]
        assert meta["status"] in {"completed", "failed", "running"}
        assert int(meta["last_seq"]) == last_seq

        # Limit should cap returned events.
        evts_limited = client.get(f"/api/runs/{run_id}/events?limit=3").json()
        assert 1 <= len(evts_limited) <= 3

        # after_seq should return strictly newer events.
        after_seq = max(0, last_seq - 2)
        evts_after = client.get(
            f"/api/runs/{run_id}/events?after_seq={after_seq}&limit=10"
        ).json()
        assert evts_after
        assert all(int(e["seq"]) > after_seq for e in evts_after)


def test_book_continue_budgets_compiled_state_for_writer_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Regression test (v1.12.2):
    - Some proxies/gateways are sensitive to large prompts.
    - When compiled book_state contains very long strings, book_continue should
      clamp it before feeding it into Writer prompts (to reduce ConnectError risk).
    """

    import ai_writer_api.routers.runs as runs_mod

    captured: dict[str, str] = {}

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookPlannerAgent" in system_prompt:
            return json.dumps(
                {
                    "index": 1,
                    "title": "第1章：续写测试",
                    "summary": "示例",
                    "goal": "继续推进",
                },
                ensure_ascii=False,
            )
        if "WriterAgent" in system_prompt:
            captured["writer_user"] = user_prompt
            return "# 第1章：续写测试\n\n正文。\n"
        if "EditorAgent" in system_prompt:
            return "# 第1章：续写测试\n\n正文（润色）。\n"
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post(
            "/api/projects", json={"title": "Book Continue Budget Test"}
        ).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={
                "text": "第一章内容……\n第二章内容……\n（结尾）\n",
                "filename": "book.txt",
            },
        ).json()
        sid = src["source_id"]

        very_long = ("A" * 9000) + "TAIL_MARKER_SHOULD_NOT_APPEAR"
        compiled_state = {
            "book_summary": very_long,
            "style_profile": {"pov": "third", "tense": "past", "tone": "neutral"},
            "world": "demo",
            "character_cards": [
                {"name": "Alice", "current_status": "ok", "relationships": "none"}
            ],
            "timeline": [],
            "open_loops": [],
            "continuation_seed": {
                "where_to_resume": "end",
                "next_scene": "demo",
                "constraints": [],
            },
        }
        created_state = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={
                "title": "book state",
                "content": json.dumps(
                    {"book_source_id": sid, "state": compiled_state}, ensure_ascii=False
                ),
                "source_type": "book_state",
                "tags": [f"book_source:{sid}", "book_state"],
            },
        )
        assert created_state.status_code == 200

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "book_continue",
                "source_id": sid,
                "chapter_index": 1,
                "source_slice_mode": "tail",
                "source_slice_chars": 200,
                "ui_lang": "zh",
            },
        ) as res:
            assert res.status_code == 200
            for raw in res.iter_lines():
                if not raw:
                    continue
                if raw.startswith("data:"):
                    evt = json.loads(raw.replace("data:", "", 1).strip())
                    if evt.get("type") == "run_completed":
                        break

    # The raw tail marker must not be present; it should have been clipped out.
    assert "TAIL_MARKER_SHOULD_NOT_APPEAR" not in captured.get("writer_user", "")


def test_book_relations_rescue_can_fallback_to_openai(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    rel_calls: list[dict[str, object]] = []

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookRelationsAgent" not in system_prompt:
            raise AssertionError("Unexpected agent system prompt")
        rel_calls.append({"cfg": cfg, "user": user_prompt})
        if len(rel_calls) == 1:
            raise LLMError(
                "openai_http_503:分组 gemini 下模型 gemini-3-flash-preview 无可用渠道（distributor）"
            )
        if len(rel_calls) == 2:
            raise LLMError(
                "openai_http_503:分组 gemini 下模型 gemini-3-pro-preview 无可用渠道（distributor）"
            )
        return json.dumps(
            {
                "edges": [
                    {
                        "from": 1,
                        "to": 2,
                        "type": "foreshadow",
                        "label": "test",
                        "strength": 0.8,
                    }
                ]
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post(
            "/api/projects",
            json={"title": "Book Relations Fallback Test"},
        ).json()

        client.patch(
            f"/api/projects/{p['id']}",
            json={
                "settings": {
                    "llm": {
                        "provider": "gemini",
                        "temperature": 0.2,
                        "max_tokens": 900,
                        "gemini": {
                            "model": "gemini-3-flash-preview",
                            "base_url": "https://www.packyapi.com",
                        },
                    }
                }
            },
        )

        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={"text": "第一章\n第二章\n", "filename": "book.txt"},
        ).json()
        sid = src["source_id"]

        s1 = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={
                "title": "sum1",
                "source_type": "book_summary",
                "tags": [f"book_source:{sid}", "book_chapter:1"],
                "content": json.dumps(
                    {
                        "book_source_id": sid,
                        "data": {
                            "summary": "A",
                            "key_events": ["A1"],
                            "characters": ["甲"],
                            "locations": [],
                            "open_loops": [],
                        },
                    },
                    ensure_ascii=False,
                ),
            },
        )
        assert s1.status_code == 200

        s2 = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={
                "title": "sum2",
                "source_type": "book_summary",
                "tags": [f"book_source:{sid}", "book_chapter:2"],
                "content": json.dumps(
                    {
                        "book_source_id": sid,
                        "data": {
                            "summary": "B",
                            "key_events": ["B1"],
                            "characters": ["乙"],
                            "locations": [],
                            "open_loops": [],
                        },
                    },
                    ensure_ascii=False,
                ),
            },
        )
        assert s2.status_code == 200

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_relations", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert not any(e.get("type") == "run_error" for e in events)
    tool_calls = [
        e
        for e in events
        if e.get("type") == "tool_call" and e.get("agent") == "BookRelations"
    ]
    assert any(
        (e.get("data") or {}).get("note", "").startswith("rescue_retry:")
        for e in tool_calls
    )
    assert any(
        (e.get("data") or {}).get("note", "").startswith("fallback_openai:")
        for e in tool_calls
    )
    assert any(
        e.get("type") == "artifact"
        and e.get("agent") == "BookRelations"
        and (e.get("data") or {}).get("artifact_type") == "book_relations"
        for e in events
    )


def test_book_relations_parse_fail_can_repair_to_edges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    calls: list[str] = []

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookRelationsJSONRepairAgent" in system_prompt:
            calls.append("repair")
            return json.dumps(
                {
                    "edges": [
                        {
                            "from": 1,
                            "to": 2,
                            "type": "foreshadow",
                            "label": "修复",
                            "strength": 0.7,
                        }
                    ]
                },
                ensure_ascii=False,
            )
        if "BookRelationsAgent" in system_prompt:
            calls.append("main")
            return "下面是分析结果：第一回与第二回存在伏笔关系。"
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post(
            "/api/projects",
            json={"title": "Book Relations Parse Repair Test"},
        ).json()

        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={"text": "第一章\n第二章\n", "filename": "book.txt"},
        ).json()
        sid = src["source_id"]

        s1 = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={
                "title": "sum1",
                "source_type": "book_summary",
                "tags": [f"book_source:{sid}", "book_chapter:1"],
                "content": json.dumps(
                    {
                        "book_source_id": sid,
                        "data": {
                            "summary": "A",
                            "key_events": ["A1"],
                            "characters": ["甲"],
                            "locations": [],
                            "open_loops": [],
                        },
                    },
                    ensure_ascii=False,
                ),
            },
        )
        assert s1.status_code == 200

        s2 = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={
                "title": "sum2",
                "source_type": "book_summary",
                "tags": [f"book_source:{sid}", "book_chapter:2"],
                "content": json.dumps(
                    {
                        "book_source_id": sid,
                        "data": {
                            "summary": "B",
                            "key_events": ["B1"],
                            "characters": ["乙"],
                            "locations": [],
                            "open_loops": [],
                        },
                    },
                    ensure_ascii=False,
                ),
            },
        )
        assert s2.status_code == 200

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_relations", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            events: list[dict[str, object]] = []
            for raw in res.iter_lines():
                if not raw:
                    continue
                if not raw.startswith("data:"):
                    continue
                evt = json.loads(raw.replace("data:", "", 1).strip())
                events.append(evt)
                if evt.get("type") == "run_completed":
                    break

    assert "main" in calls
    assert "repair" in calls
    artifacts = [
        e
        for e in events
        if e.get("type") == "artifact"
        and e.get("agent") == "BookRelations"
        and (e.get("data") or {}).get("artifact_type") == "book_relations"
    ]
    assert artifacts
    data = artifacts[-1].get("data") or {}
    assert (data.get("edges") or 0) >= 1
    assert not data.get("parse_error")


def _collect_sse_events(res: TestClient) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for raw in res.iter_lines():
        if not raw:
            continue
        if not raw.startswith("data:"):
            continue
        evt = json.loads(raw.replace("data:", "", 1).strip())
        events.append(evt)
        if evt.get("type") == "run_completed":
            break
    return events


def test_book_summarize_can_retry_failed_segments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import re

    import ai_writer_api.routers.runs as runs_mod

    attempts_by_index: dict[int, int] = {}

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookSummarizerAgent" not in system_prompt:
            raise AssertionError("Unexpected agent system prompt")
        m = re.search(r"Segment index: (\d+)", user_prompt)
        assert m is not None
        idx = int(m.group(1))
        attempts_by_index[idx] = attempts_by_index.get(idx, 0) + 1
        if idx == 2 and attempts_by_index[idx] == 1:
            raise LLMError("retry_this_segment")
        return json.dumps(
            {
                "summary": f"summary-{idx}",
                "key_events": [f"event-{idx}"],
                "characters": [f"char-{idx}"],
                "locations": [f"place-{idx}"],
                "timeline": [f"time-{idx}"],
                "open_loops": [f"loop-{idx}"],
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Book Retry Test"}).json()
        book_text = (
            "第一回 起\n" + ("A" * 800) + "\n"
            + "第二回 承\n" + ("B" * 800) + "\n"
            + "第三回 转\n" + ("C" * 800)
        )
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={"text": book_text, "filename": "retry-book.txt"},
        ).json()
        sid = src["source_id"]

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "book_summarize",
                "source_id": sid,
                "segment_mode": "chapter",
                "max_chapters": 10,
                "replace_existing": True,
            },
        ) as res:
            assert res.status_code == 200
            events = _collect_sse_events(res)

        stats_evt = [
            e
            for e in events
            if e.get("type") == "artifact"
            and e.get("agent") == "BookSummarizer"
            and (e.get("data") or {}).get("artifact_type") == "book_summarize_stats"
        ]
        assert stats_evt
        stats = stats_evt[-1].get("data") or {}
        assert int(stats.get("failed") or 0) == 1
        assert stats.get("failed_indices") == [2]
        failed_items = stats.get("failed_items") or []
        assert isinstance(failed_items, list) and failed_items
        assert (failed_items[0] or {}).get("index") == 2

        chunks = client.get(f"/api/projects/{p['id']}/kb/chunks").json()
        summary_chunks = [
            c for c in chunks if c.get("source_type") == "book_summary"
        ]
        assert len(summary_chunks) == 2
        assert not any(
            "book_chapter:2" in str(c.get("tags") or "")
            for c in summary_chunks
        )

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={
                "kind": "book_summarize",
                "source_id": sid,
                "segment_mode": "chapter",
                "max_chapters": 10,
                "replace_existing": True,
                "segment_indices": [2],
            },
        ) as res:
            assert res.status_code == 200
            retry_events = _collect_sse_events(res)

        retry_stats_evt = [
            e
            for e in retry_events
            if e.get("type") == "artifact"
            and e.get("agent") == "BookSummarizer"
            and (e.get("data") or {}).get("artifact_type") == "book_summarize_stats"
        ]
        assert retry_stats_evt
        retry_stats = retry_stats_evt[-1].get("data") or {}
        assert int(retry_stats.get("failed") or 0) == 0
        assert int(retry_stats.get("created") or 0) == 1
        assert (retry_stats.get("params") or {}).get("segment_indices") == [2]

        chunks_after = client.get(f"/api/projects/{p['id']}/kb/chunks").json()
        summary_chunks_after = [
            c for c in chunks_after if c.get("source_type") == "book_summary"
        ]
        assert len(summary_chunks_after) == 3
        assert any(
            "book_chapter:2" in str(c.get("tags") or "")
            for c in summary_chunks_after
        )


def test_book_relations_heuristic_uses_string_schema_summaries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    calls: list[str] = []

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookRelationsJSONRepairAgent" in system_prompt:
            calls.append("repair")
            return json.dumps({"edges": []}, ensure_ascii=False)
        if "BookRelationsAgent" in system_prompt:
            calls.append("main")
            return "relation prose only"
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post(
            "/api/projects",
            json={"title": "Book Relations String Schema Test"},
        ).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={
                "text": "chapter 1\nchapter 2\nchapter 3\n",
                "filename": "graph-book.txt",
            },
        ).json()
        sid = src["source_id"]

        def seed_summary(index: int, payload: dict[str, object]) -> None:
            res = client.post(
                f"/api/projects/{p['id']}/kb/chunks",
                json={
                    "title": f"summary-{index}",
                    "source_type": "book_summary",
                    "tags": [f"book_source:{sid}", f"book_chapter:{index}"],
                    "content": json.dumps(
                        {
                            "book_source_id": sid,
                            "segment_mode": "chapter",
                            "chunk_index": index,
                            "data": payload,
                        },
                        ensure_ascii=False,
                    ),
                },
            )
            assert res.status_code == 200

        seed_summary(
            1,
            {
                "summary": "s1",
                "main_characters": "贾宝玉；林黛玉",
                "key_events": "1. 宝玉初见黛玉；2. 贾母见黛玉",
                "themes": "命运；亲情",
                "open_loops": "黛玉入府后的处境",
            },
        )
        seed_summary(
            2,
            {
                "summary": "s2",
                "main_characters": "贾宝玉；薛宝钗",
                "key_events": "宝玉得金锁；宝钗亮相",
                "themes": "婚配；家族",
                "open_loops": "金玉良缘",
            },
        )
        seed_summary(
            3,
            {
                "summary": "s3",
                "main_characters": "贾宝玉；林黛玉",
                "key_events": "宝玉再见黛玉；情绪生变",
                "themes": "命运；儿女情长",
                "open_loops": "黛玉与贾府的关系",
            },
        )

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_relations", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            events = _collect_sse_events(res)

        assert "main" in calls
        assert "repair" in calls
        artifacts = [
            e
            for e in events
            if e.get("type") == "artifact"
            and e.get("agent") == "BookRelations"
            and (e.get("data") or {}).get("artifact_type") == "book_relations"
        ]
        assert artifacts
        artifact = artifacts[-1].get("data") or {}
        assert int(artifact.get("edges") or 0) >= 1
        assert not artifact.get("parse_error")

        kb_chunk_id = int(artifact.get("kb_chunk_id") or 0)
        stored = client.get(f"/api/projects/{p['id']}/kb/chunks/{kb_chunk_id}")
        assert stored.status_code == 200
        record = json.loads(stored.json()["content"])
        graph = record.get("graph") or {}
        edges = graph.get("edges") or []
        assert isinstance(edges, list) and edges
        assert any(
            str(edge.get("type") or "")
            in {"character_arc", "foreshadow", "payoff", "theme", "parallel"}
            for edge in edges
            if isinstance(edge, dict)
        )
        assert any(
            str(edge.get("label") or "").strip()
            and str(edge.get("label") or "") != "book_progression"
            for edge in edges
            if isinstance(edge, dict)
        )


def test_book_characters_heuristic_uses_string_schema_summaries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    calls: list[str] = []

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookCharactersJSONRepairAgent" in system_prompt:
            calls.append("repair")
            return json.dumps(
                {"characters": [], "relations": []}, ensure_ascii=False
            )
        if "BookCharacterGraphAgent" in system_prompt:
            calls.append("main")
            return "character prose only"
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post(
            "/api/projects",
            json={"title": "Book Characters String Schema Test"},
        ).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={
                "text": "chapter 1\nchapter 2\nchapter 3\n",
                "filename": "character-book.txt",
            },
        ).json()
        sid = src["source_id"]

        def seed_summary(index: int, payload: dict[str, object]) -> None:
            res = client.post(
                f"/api/projects/{p['id']}/kb/chunks",
                json={
                    "title": f"summary-{index}",
                    "source_type": "book_summary",
                    "tags": [f"book_source:{sid}", f"book_chapter:{index}"],
                    "content": json.dumps(
                        {
                            "book_source_id": sid,
                            "segment_mode": "chapter",
                            "chunk_index": index,
                            "data": payload,
                        },
                        ensure_ascii=False,
                    ),
                },
            )
            assert res.status_code == 200

        seed_summary(
            1,
            {
                "summary": "s1",
                "main_characters": "贾宝玉；林黛玉；贾母",
                "key_events": "宝玉初见黛玉；贾母安排住处",
            },
        )
        seed_summary(
            2,
            {
                "summary": "s2",
                "main_characters": "贾宝玉；薛宝钗",
                "key_events": "宝玉与宝钗相会",
            },
        )
        seed_summary(
            3,
            {
                "summary": "s3",
                "main_characters": "贾宝玉；林黛玉",
                "key_events": "宝玉与黛玉再会",
            },
        )

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_characters", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            events = _collect_sse_events(res)

        assert "main" in calls
        assert "repair" in calls
        artifacts = [
            e
            for e in events
            if e.get("type") == "artifact"
            and e.get("agent") == "BookCharacters"
            and (e.get("data") or {}).get("artifact_type") == "book_characters"
        ]
        assert artifacts
        artifact = artifacts[-1].get("data") or {}
        assert int(artifact.get("characters") or 0) >= 2
        assert int(artifact.get("relations") or 0) >= 1
        assert not artifact.get("parse_error")

        kb_chunk_id = int(artifact.get("kb_chunk_id") or 0)
        stored = client.get(f"/api/projects/{p['id']}/kb/chunks/{kb_chunk_id}")
        assert stored.status_code == 200
        record = json.loads(stored.json()["content"])
        graph = record.get("graph") or {}
        characters = graph.get("characters") or []
        relations = graph.get("relations") or []
        assert isinstance(characters, list) and len(characters) >= 2
        assert isinstance(relations, list) and len(relations) >= 1
        assert any(
            str(item.get("name") or "")
            in {"贾宝玉", "林黛玉", "薛宝钗"}
            for item in characters
            if isinstance(item, dict)
        )
        assert any(
            str(rel.get("label") or "").strip()
            for rel in relations
            if isinstance(rel, dict)
        )


def test_book_relations_heuristic_handles_mixed_character_schemas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookRelationsJSONRepairAgent" in system_prompt:
            return json.dumps({"edges": []}, ensure_ascii=False)
        if "BookRelationsAgent" in system_prompt:
            return json.dumps(
                {"edges": [{"from": 1, "to": 3, "type": "structure", "label": "book_progression", "strength": 0.4}]},
                ensure_ascii=False,
            )
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Book Relations Mixed Schema Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={"text": "chapter 1\nchapter 2\nchapter 3\n", "filename": "mixed-relations-book.txt"},
        ).json()
        sid = src["source_id"]

        for index, payload in enumerate(
            [
                {
                    "overall_summary": "s1",
                    "characters": [{"name": "贾宝玉"}, {"name": "林黛玉"}],
                    "timeline": [{"event": "宝玉初见黛玉", "approximate_time": "白日"}],
                    "themes": ["宿缘", "家族"],
                },
                {
                    "summary": "s2",
                    "characters_involved": ["贾宝玉", "王熙凤", "贾母"],
                    "events": ["凤姐张罗家务", "贾母照看众人"],
                    "themes": "家族；礼制",
                },
                {
                    "summary": "s3",
                    "characters": ["王熙凤—荣府当家少奶奶", "贾宝玉—贾府公子", "林黛玉—敏感多思"],
                    "events": "凤姐与宝玉同往宁府；宝玉再见黛玉",
                    "themes": ["家族", "情感"],
                },
            ],
            start=1,
        ):
            res = client.post(
                f"/api/projects/{p['id']}/kb/chunks",
                json={
                    "title": f"summary-{index}",
                    "source_type": "book_summary",
                    "tags": [f"book_source:{sid}", f"book_chapter:{index}"],
                    "content": json.dumps(
                        {"book_source_id": sid, "segment_mode": "chapter", "chunk_index": index, "data": payload},
                        ensure_ascii=False,
                    ),
                },
            )
            assert res.status_code == 200

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_relations", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            events = _collect_sse_events(res)

        artifact = next(
            e for e in reversed(events)
            if e.get("type") == "artifact"
            and e.get("agent") == "BookRelations"
            and (e.get("data") or {}).get("artifact_type") == "book_relations"
        )
        kb_chunk_id = int((artifact.get("data") or {}).get("kb_chunk_id") or 0)
        stored = client.get(f"/api/projects/{p['id']}/kb/chunks/{kb_chunk_id}")
        record = json.loads(stored.json()["content"])
        edges = ((record.get("graph") or {}).get("edges") or [])
        assert isinstance(edges, list) and edges
        assert any(
            str(edge.get("type") or "") in {"character_arc", "theme", "parallel", "foreshadow", "payoff"}
            for edge in edges
            if isinstance(edge, dict)
        )
        assert any(
            str(edge.get("label") or "").strip() and str(edge.get("label") or "") != "book_progression"
            for edge in edges
            if isinstance(edge, dict)
        )


def test_book_characters_heuristic_handles_mixed_character_schemas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookCharactersJSONRepairAgent" in system_prompt:
            return json.dumps({"characters": [], "relations": []}, ensure_ascii=False)
        if "BookCharacterGraphAgent" in system_prompt:
            return "character prose only"
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Book Characters Mixed Schema Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={"text": "chapter 1\nchapter 2\nchapter 3\n", "filename": "mixed-characters-book.txt"},
        ).json()
        sid = src["source_id"]

        for index, payload in enumerate(
            [
                {
                    "overall_summary": "s1",
                    "characters": [{"name": "贾宝玉"}, {"name": "林黛玉"}],
                    "timeline": [{"event": "宝玉初见黛玉"}],
                },
                {
                    "summary": "s2",
                    "characters_involved": ["贾宝玉", "王熙凤", "贾母"],
                    "events": ["凤姐张罗家务"],
                },
                {
                    "summary": "s3",
                    "characters": ["王熙凤—荣府当家少奶奶", "贾宝玉—贾府公子", "林黛玉—敏感多思"],
                    "events": "凤姐与宝玉同往宁府；宝玉再见黛玉",
                },
            ],
            start=1,
        ):
            res = client.post(
                f"/api/projects/{p['id']}/kb/chunks",
                json={
                    "title": f"summary-{index}",
                    "source_type": "book_summary",
                    "tags": [f"book_source:{sid}", f"book_chapter:{index}"],
                    "content": json.dumps(
                        {"book_source_id": sid, "segment_mode": "chapter", "chunk_index": index, "data": payload},
                        ensure_ascii=False,
                    ),
                },
            )
            assert res.status_code == 200

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_characters", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            events = _collect_sse_events(res)

        artifact = next(
            e for e in reversed(events)
            if e.get("type") == "artifact"
            and e.get("agent") == "BookCharacters"
            and (e.get("data") or {}).get("artifact_type") == "book_characters"
        )
        kb_chunk_id = int((artifact.get("data") or {}).get("kb_chunk_id") or 0)
        stored = client.get(f"/api/projects/{p['id']}/kb/chunks/{kb_chunk_id}")
        record = json.loads(stored.json()["content"])
        graph = record.get("graph") or {}
        characters = graph.get("characters") or []
        relations = graph.get("relations") or []
        assert isinstance(characters, list) and len(characters) >= 3
        assert isinstance(relations, list) and len(relations) >= 1
        assert any(
            str(item.get("name") or "") == "王熙凤"
            for item in characters
            if isinstance(item, dict)
        )


def test_book_graph_heuristics_infer_names_from_chapter_titles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(
        *, system_prompt: str, user_prompt: str, cfg: object
    ) -> str:  # type: ignore[override]
        if "BookRelationsJSONRepairAgent" in system_prompt:
            return json.dumps({"edges": []}, ensure_ascii=False)
        if "BookRelationsAgent" in system_prompt:
            return "relation prose only"
        if "BookCharactersJSONRepairAgent" in system_prompt:
            return json.dumps({"characters": [], "relations": []}, ensure_ascii=False)
        if "BookCharacterGraphAgent" in system_prompt:
            return "character prose only"
        raise AssertionError("Unexpected agent system prompt")

    monkeypatch.setattr(runs_mod, "generate_text", fake_generate_text)

    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "Book Graph Title Inference Test"}).json()
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={"text": "chapter 1\nchapter 2\nchapter 3\n", "filename": "title-inference-book.txt"},
        ).json()
        sid = src["source_id"]

        seeds = [
            (
                1,
                "第一回",
                "甄士隐梦幻识通灵 贾雨村风尘怀闺秀",
                "士隐资助雨村进京，二人因命运与家道兴衰相连。",
            ),
            (
                2,
                "第六回",
                "贾宝玉初试云雨情 刘姥姥一进荣国府",
                "宝玉与刘姥姥分别牵出贾府内外两条线索，凤姐在其中居中调度。",
            ),
            (
                3,
                "第七回",
                "送宫花贾琏戏熙凤 宴宁府宝玉会秦钟",
                "宝玉在宁府会见秦钟，熙凤与贾琏继续处理贾府事务。",
            ),
        ]
        for index, chapter_label, chapter_title, summary in seeds:
            res = client.post(
                f"/api/projects/{p['id']}/kb/chunks",
                json={
                    "title": f"summary-{index}",
                    "source_type": "book_summary",
                    "tags": [f"book_source:{sid}", f"book_chapter:{index}"],
                    "content": json.dumps(
                        {
                            "book_source_id": sid,
                            "segment_mode": "chapter",
                            "chunk_index": index,
                            "chapter_label": chapter_label,
                            "chapter_title": chapter_title,
                            "data": {"summary": summary},
                        },
                        ensure_ascii=False,
                    ),
                },
            )
            assert res.status_code == 200

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_relations", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            relation_events = _collect_sse_events(res)

        relation_artifact = next(
            e for e in reversed(relation_events)
            if e.get("type") == "artifact"
            and e.get("agent") == "BookRelations"
            and (e.get("data") or {}).get("artifact_type") == "book_relations"
        )
        relation_chunk = client.get(
            f"/api/projects/{p['id']}/kb/chunks/{int((relation_artifact.get('data') or {}).get('kb_chunk_id') or 0)}"
        )
        relation_record = json.loads(relation_chunk.json()["content"])
        relation_edges = ((relation_record.get("graph") or {}).get("edges") or [])
        assert any(
            str(edge.get("type") or "") in {"character_arc", "theme", "parallel", "foreshadow", "payoff"}
            for edge in relation_edges
            if isinstance(edge, dict)
        )

        with client.stream(
            "POST",
            f"/api/projects/{p['id']}/runs/stream",
            json={"kind": "book_characters", "source_id": sid},
        ) as res:
            assert res.status_code == 200
            character_events = _collect_sse_events(res)

        character_artifact = next(
            e for e in reversed(character_events)
            if e.get("type") == "artifact"
            and e.get("agent") == "BookCharacters"
            and (e.get("data") or {}).get("artifact_type") == "book_characters"
        )
        character_chunk = client.get(
            f"/api/projects/{p['id']}/kb/chunks/{int((character_artifact.get('data') or {}).get('kb_chunk_id') or 0)}"
        )
        character_record = json.loads(character_chunk.json()["content"])
        graph = character_record.get("graph") or {}
        assert len(graph.get("characters") or []) >= 2
        assert len(graph.get("relations") or []) >= 1
