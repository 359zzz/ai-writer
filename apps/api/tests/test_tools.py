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


def test_continue_source_book_index() -> None:
    with TestClient(app) as client:
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=tail&preview_chars=200",
            json={"text": ("A" * 2200) + "\n" + ("B" * 2200), "filename": "book.txt"},
        ).json()
        sid = src["source_id"]

        res = client.get(
            f"/api/tools/continue_sources/{sid}/book_index?chunk_chars=500&overlap_chars=50&max_chunks=20&preview_chars=20"
        )
        assert res.status_code == 200
        body = res.json()
        assert body.get("source_id") == sid
        assert body.get("params", {}).get("chunk_chars") == 500
        assert isinstance(body.get("chunks"), list)
        assert body.get("total_chunks", 0) >= 3

        first = body["chunks"][0]
        assert first["index"] == 1
        assert isinstance(first.get("preview_head"), str)
        assert isinstance(first.get("preview_tail"), str)


def test_continue_source_chapter_index_build_and_update() -> None:
    txt = (
        "第1章：开端\n"
        + ("A" * 120)
        + "\n\n"
        + "第2章 继续\n"
        + ("B" * 180)
        + "\n"
    ).encode("utf-8")

    with TestClient(app) as client:
        src = client.post(
            "/api/tools/continue_sources/upload?preview_mode=head&preview_chars=200",
            files={"file": ("book.txt", txt, "text/plain")},
        ).json()
        sid = src["source_id"]

        res = client.get(
            f"/api/tools/continue_sources/{sid}/chapter_index?overwrite=true&preview_chars=40&max_chapters=100"
        )
        assert res.status_code == 200
        body = res.json()
        assert body.get("source_id") == sid
        assert body.get("total_chapters") == 2
        assert isinstance(body.get("chapters"), list)
        ch1 = body["chapters"][0]
        assert ch1.get("index") == 1
        assert "第" in (ch1.get("label") or "")

        # Micro-tune: merge by deleting chapter #2 and renaming title.
        chapters = body["chapters"]
        chapters = [dict(chapters[0], title="第1章：微调后的标题")]
        res2 = client.patch(
            f"/api/tools/continue_sources/{sid}/chapter_index?preview_chars=30&max_chapters=100",
            json={"chapters": chapters},
        )
        assert res2.status_code == 200
        body2 = res2.json()
        assert body2.get("total_chapters") == 1
        assert body2["chapters"][0]["title"] == "第1章：微调后的标题"

        # Cached load path (overwrite=false default).
        res3 = client.get(f"/api/tools/continue_sources/{sid}/chapter_index?preview_chars=30")
        assert res3.status_code == 200
        body3 = res3.json()
        assert body3.get("total_chapters") == 1


def test_continue_source_chapter_index_no_headings() -> None:
    with TestClient(app) as client:
        src = client.post(
            "/api/tools/continue_sources/text?preview_mode=head&preview_chars=200",
            json={"text": "no headings here\njust text\n", "filename": "book.txt"},
        ).json()
        sid = src["source_id"]

        res = client.get(
            f"/api/tools/continue_sources/{sid}/chapter_index?overwrite=true&preview_chars=40&max_chapters=100"
        )
        assert res.status_code == 400


def test_continue_source_chapter_index_inline_headings_and_dedupe() -> None:
    """
    Headings may appear inside body text (imperfect extraction), and the same
    "第X回/章" can appear multiple times (TOC / references / page headers).

    We should pick the most plausible boundaries based on the majority chapter
    length, not the earliest occurrence.
    """

    toc = "目录\n" + "\n".join([f"第{i}回 虚假目录" for i in range(1, 6)]) + "\n\n"
    body_parts: list[str] = [toc]
    for i in range(1, 6):
        body_parts.append(f"一些前文。第{i}回 真正第{i}回\n")
        body_parts.append(("甲" * (260 + i * 20)) + "\n")
        if i == 3:
            # A non-heading reference that still matches the permissive regex.
            body_parts.append("中间提到（第3回）但这不是标题。\n")
        body_parts.append("\n")

    txt = "".join(body_parts).encode("utf-8")

    with TestClient(app) as client:
        src = client.post(
            "/api/tools/continue_sources/upload?preview_mode=head&preview_chars=200",
            files={"file": ("book.txt", txt, "text/plain")},
        ).json()
        sid = src["source_id"]

        res = client.get(
            f"/api/tools/continue_sources/{sid}/chapter_index?overwrite=true&preview_chars=40&max_chapters=100"
        )
        assert res.status_code == 200
        body = res.json()
        assert body.get("source_id") == sid
        assert body.get("total_chapters") == 5
        assert isinstance(body.get("chapters"), list)
        assert "真正第1回" in (body["chapters"][0].get("header") or "")
