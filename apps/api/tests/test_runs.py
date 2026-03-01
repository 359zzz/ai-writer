from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from ai_writer_api.llm import LLMError
from ai_writer_api.main import app


def test_continue_run_softfails_config_autofill(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Regression test:
    - ConfigAutofill is best-effort in weak mode.
    - A transient OpenAI-compatible 502 (often HTML) should not abort a continue run.
    """

    import ai_writer_api.routers.runs as runs_mod

    async def fake_generate_text(*, system_prompt: str, user_prompt: str, cfg: object) -> str:  # type: ignore[override]
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
                    "style_profile": {"pov": "third", "tense": "past", "tone": "neutral"},
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
            return "<think>planning</think>\n# Chapter 1: Test Chapter\n\nHello world.\n"
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

    async def fake_generate_text(*, system_prompt: str, user_prompt: str, cfg: object) -> str:  # type: ignore[override]
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

    async def fake_generate_text(*, system_prompt: str, user_prompt: str, cfg: object) -> str:  # type: ignore[override]
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

    async def fake_generate_text(*, system_prompt: str, user_prompt: str, cfg: object) -> str:  # type: ignore[override]
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
                    "style_profile": {"pov": "third", "tense": "past", "tone": "neutral"},
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


def test_editor_suspicious_output_fallbacks_to_writer(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Regression test:
    - Some models may summarize/shorten during the Editor pass, resulting in a
      "completed" run with an incomplete chapter. We should fall back to the
      Writer output when the Editor output looks suspiciously short.
    """

    import ai_writer_api.routers.runs as runs_mod

    writer_md = "# Chapter 1: Test\n\n" + ("Hello world. " * 120) + "\n"
    editor_md = "# Chapter 1: Test\n\nshort\n"

    async def fake_generate_text(*, system_prompt: str, user_prompt: str, cfg: object) -> str:  # type: ignore[override]
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
