from fastapi.testclient import TestClient

from ai_writer_api.main import app


def test_create_and_list_projects() -> None:
    with TestClient(app) as client:
        res = client.post("/api/projects", json={"title": "My Test Novel"})
        assert res.status_code == 200
        created = res.json()
        assert created["title"] == "My Test Novel"
        assert isinstance(created["id"], str) and created["id"]

        res2 = client.get("/api/projects")
        assert res2.status_code == 200
        items = res2.json()
        assert any(p["id"] == created["id"] for p in items)
