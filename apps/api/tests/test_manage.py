from __future__ import annotations

from fastapi.testclient import TestClient
from sqlmodel import select

from ai_writer_api.db import get_session
from ai_writer_api.main import app
from ai_writer_api.models import Chapter, KBChunk, Project, Run, TraceEvent


def test_delete_chapter_also_deletes_manuscript_kb_chunk() -> None:
    with get_session() as session:
        p = Project(title="Delete Chapter Test")
        session.add(p)
        session.commit()
        session.refresh(p)

        ch = Chapter(project_id=p.id, chapter_index=1, title="C1", markdown="# C1\n\nhi\n")
        session.add(ch)
        session.add(
            KBChunk(
                project_id=p.id,
                source_type="manuscript",
                title="C1",
                content="# C1\n\nhi\n",
                tags=f"manuscript,chapter_id={ch.id}",
            )
        )
        session.commit()

    with TestClient(app) as client:
        res = client.delete(f"/api/projects/{p.id}/chapters/{ch.id}")
        assert res.status_code == 200

    with get_session() as session:
        assert session.get(Chapter, ch.id) is None
        remaining = list(
            session.exec(
                select(KBChunk).where(
                    KBChunk.project_id == p.id,
                    KBChunk.source_type == "manuscript",
                    KBChunk.tags.like(f"%chapter_id={ch.id}%"),
                )
            )
        )
        assert remaining == []


def test_reorder_chapters_renumbers_indices() -> None:
    with get_session() as session:
        p = Project(title="Reorder Chapter Test")
        session.add(p)
        session.commit()
        session.refresh(p)

        c1 = Chapter(project_id=p.id, chapter_index=1, title="A", markdown="a")
        c2 = Chapter(project_id=p.id, chapter_index=2, title="B", markdown="b")
        c3 = Chapter(project_id=p.id, chapter_index=3, title="C", markdown="c")
        session.add(c1)
        session.add(c2)
        session.add(c3)
        session.commit()

    with TestClient(app) as client:
        res = client.post(
            f"/api/projects/{p.id}/chapters/reorder",
            json={"chapter_ids": [c3.id, c1.id, c2.id], "start_index": 1},
        )
        assert res.status_code == 200
        data = res.json()
        assert [x["id"] for x in data[:3]] == [c3.id, c1.id, c2.id]
        assert [x["chapter_index"] for x in data[:3]] == [1, 2, 3]


def test_delete_project_removes_children() -> None:
    with get_session() as session:
        p = Project(title="Delete Project Test")
        session.add(p)
        session.commit()
        session.refresh(p)

        r = Run(project_id=p.id, kind="demo", status="completed")
        session.add(r)
        session.commit()
        session.refresh(r)

        session.add(TraceEvent(run_id=r.id, seq=1, event_type="run_started", agent="Director", payload={}))
        session.add(Chapter(project_id=p.id, chapter_index=1, title="C1", markdown="hi"))
        session.add(KBChunk(project_id=p.id, source_type="note", title="t", content="c", tags="x"))
        session.commit()

    with TestClient(app) as client:
        res = client.delete(f"/api/projects/{p.id}")
        assert res.status_code == 200

        assert client.get(f"/api/projects/{p.id}").status_code == 404
        assert client.get(f"/api/projects/{p.id}/chapters").status_code == 404

    with get_session() as session:
        assert session.get(Project, p.id) is None
