from fastapi.testclient import TestClient

from ai_writer_api.main import app


def test_kb_chunk_create_and_search() -> None:
    with TestClient(app) as client:
        p = client.post("/api/projects", json={"title": "KB Test"}).json()

        created = client.post(
            f"/api/projects/{p['id']}/kb/chunks",
            json={"title": "Lore", "content": "The magic system uses mana."},
        )
        assert created.status_code == 200
        chunk = created.json()

        res = client.get(f"/api/projects/{p['id']}/kb/search", params={"q": "mana", "limit": 5})
        assert res.status_code == 200
        items = res.json()
        assert any(int(it["id"]) == int(chunk["id"]) for it in items)

