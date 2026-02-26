from fastapi.testclient import TestClient

from ai_writer_api.main import app


def test_health() -> None:
    with TestClient(app) as client:
        res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["service"] == "ai-writer-api"
