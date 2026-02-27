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
            return "# Chapter 1: Test Chapter\n\nHello world.\n"
        if "EditorAgent" in system_prompt:
            return "# Chapter 1: Test Chapter\n\nHello world (edited).\n"

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
