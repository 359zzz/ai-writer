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


def test_extract_text_unsupported() -> None:
    with TestClient(app) as client:
        res = client.post(
            "/api/tools/extract_text",
            files={"file": ("demo.bin", b"xx", "application/octet-stream")},
        )

    assert res.status_code == 400
