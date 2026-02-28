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

        updated = client.patch(
            f"/api/projects/{p['id']}/kb/chunks/{chunk['id']}",
            json={"title": "Lore v2", "tags": ["magic", "mana"], "content": "Mana is stored in crystals."},
        )
        assert updated.status_code == 200
        updated_chunk = updated.json()
        assert updated_chunk["title"] == "Lore v2"
        assert "magic" in (updated_chunk.get("tags") or "")
        assert "crystals" in updated_chunk["content"]

        chunks = client.get(f"/api/projects/{p['id']}/kb/chunks")
        assert chunks.status_code == 200
        listed = chunks.json()
        assert any(int(it["id"]) == int(chunk["id"]) and it["title"] == "Lore v2" for it in listed)

        deleted = client.delete(f"/api/projects/{p['id']}/kb/chunks/{chunk['id']}")
        assert deleted.status_code == 200

        chunks2 = client.get(f"/api/projects/{p['id']}/kb/chunks")
        assert chunks2.status_code == 200
        listed2 = chunks2.json()
        assert all(int(it["id"]) != int(chunk["id"]) for it in listed2)
