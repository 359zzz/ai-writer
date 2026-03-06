from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any, Iterable

from fastapi.testclient import TestClient

_API_ROOT = Path(__file__).resolve().parents[1]
if str(_API_ROOT) not in sys.path:
    sys.path.insert(0, str(_API_ROOT))

from ai_writer_api.main import app


def _iter_sse_events(resp) -> Iterable[dict[str, Any]]:
    for raw in resp.iter_lines():
        if not raw:
            continue
        line = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        if not line.startswith("data: "):
            continue
        payload = line[len("data: ") :].strip()
        if not payload:
            continue
        yield json.loads(payload)


def _run_stream(
    client: TestClient, project_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    url = f"/api/projects/{project_id}/runs/stream"
    errors: list[str] = []
    last_evt: dict[str, Any] | None = None
    seen_completed = False

    with client.stream("POST", url, json=payload) as resp:
        resp.raise_for_status()
        for evt in _iter_sse_events(resp):
            last_evt = evt
            if evt.get("type") == "run_error":
                raw_data = evt.get("data")
                data: dict[str, Any] = raw_data if isinstance(raw_data, dict) else {}
                msg = str(data.get("error") or "run_error")
                errors.append(msg)
            if evt.get("type") == "run_completed":
                seen_completed = True

    if errors:
        raise RuntimeError("stream_failed: " + " | ".join(errors[:3]))
    if not seen_completed:
        last_type = str(last_evt.get("type")) if isinstance(last_evt, dict) else "none"
        raise RuntimeError(f"stream_incomplete:last={last_type}")
    if not isinstance(last_evt, dict):
        raise RuntimeError("stream_incomplete:last=none")
    return last_evt


def main() -> int:
    book_path = Path(r"C:\Users\zhang\Desktop\红楼梦前30回.txt")
    if not book_path.exists():
        raise FileNotFoundError(str(book_path))

    with TestClient(app) as client:
        title = f"e2e-book-flow-{int(time.time())}"
        p = client.post("/api/projects", json={"title": title}).json()
        project_id = str(p["id"])

        client.patch(
            f"/api/projects/{project_id}",
            json={
                "settings": {
                    "llm": {
                        "provider": "openai",
                        "temperature": 0.2,
                        "max_tokens": 260,
                        "openai": {"wire_api": "chat"},
                    }
                }
            },
        ).raise_for_status()

        with book_path.open("rb") as f:
            up = client.post(
                "/api/tools/continue_sources/upload",
                params={"preview_mode": "tail", "preview_chars": 1200},
                files={"file": (book_path.name, f, "text/plain")},
            )
        up.raise_for_status()
        source_id = str(up.json()["source_id"])

        ch = client.get(
            f"/api/tools/continue_sources/{source_id}/chapter_index",
            params={"overwrite": True, "max_chapters": 80, "preview_chars": 80},
        )
        ch.raise_for_status()

        _run_stream(
            client,
            project_id,
            {
                "kind": "book_summarize",
                "source_id": source_id,
                "segment_mode": "chapter",
                "max_chapters": 5,
                "summary_chars": 220,
                "max_tokens": 160,
                "replace_existing": True,
            },
        )

        _run_stream(
            client,
            project_id,
            {
                "kind": "book_compile",
                "source_id": source_id,
                "max_tokens": 380,
            },
        )

        _run_stream(
            client,
            project_id,
            {
                "kind": "book_relations",
                "source_id": source_id,
                "max_tokens": 650,
            },
        )
        _run_stream(
            client,
            project_id,
            {
                "kind": "book_characters",
                "source_id": source_id,
                "max_tokens": 800,
            },
        )

        _run_stream(
            client,
            project_id,
            {
                "kind": "book_continue",
                "source_id": source_id,
                "chapter_words": 200,
                "max_tokens": 420,
            },
        )

        print(f"[e2e] ok project_id={project_id} source_id={source_id}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
