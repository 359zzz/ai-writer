from fastapi.testclient import TestClient

from ai_writer_api.main import app


def test_extract_text_txt() -> None:
    with TestClient(app) as client:
        res = client.post(
            "/api/tools/extract_text",
            files={"file": ("demo.txt", b"hello\\nworld\\n", "text/plain")},
        )

    assert res.status_code == 200
    body = res.json()
    assert "text" in body
    assert "hello" in body["text"]
    assert body["meta"]["ext"] == ".txt"


def test_extract_text_json() -> None:
    with TestClient(app) as client:
        res = client.post(
            "/api/tools/extract_text",
            files={"file": ("demo.json", b'{\"hello\": \"world\"}\\n', "application/json")},
        )

    assert res.status_code == 200
    body = res.json()
    assert "hello" in body["text"]
    assert body["meta"]["ext"] == ".json"


def test_extract_text_unsupported() -> None:
    with TestClient(app) as client:
        res = client.post(
            "/api/tools/extract_text",
            files={"file": ("demo.bin", b"xx", "application/octet-stream")},
        )

    assert res.status_code == 400


def test_continue_source_upload_and_preview() -> None:
    with TestClient(app) as client:
        res = client.post(
            "/api/tools/continue_sources/upload?preview_mode=head&preview_chars=200",
            files={"file": ("demo.txt", b"hello\nworld\n", "text/plain")},
        )

        assert res.status_code == 200
        body = res.json()
        assert isinstance(body.get("source_id"), str)
        assert "hello" in (body.get("preview") or "")
        assert body.get("meta", {}).get("ext") == ".txt"

        source_id = body["source_id"]
        res2 = client.get(
            f"/api/tools/continue_sources/{source_id}/preview?mode=tail&limit_chars=200"
        )
        assert res2.status_code == 200
        body2 = res2.json()
        assert body2.get("source_id") == source_id
        assert "world" in (body2.get("text") or "")


def test_continue_source_upload_json() -> None:
    with TestClient(app) as client:
        res = client.post(
            "/api/tools/continue_sources/upload?preview_mode=head&preview_chars=200",
            files={"file": ("demo.json", b'{\"hello\": \"world\"}\\n', "application/json")},
        )

    assert res.status_code == 200
    body = res.json()
    assert isinstance(body.get("source_id"), str)
    assert "hello" in (body.get("preview") or "")
    assert body.get("meta", {}).get("ext") == ".json"


def test_continue_source_text() -> None:
    with TestClient(app) as client:
        res = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={"text": "hello\nworld\n", "filename": "pasted.txt"},
        )
    assert res.status_code == 200
    body = res.json()
    assert isinstance(body.get("source_id"), str)
    assert "world" in (body.get("preview") or "")
