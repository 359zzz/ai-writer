from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import text
from sqlmodel import Session, SQLModel, create_engine


def _default_db_path() -> Path:
    # Keep local state inside the repo but gitignored (any "data/" dir is ignored).
    api_root = Path(__file__).resolve().parents[1]  # .../apps/api
    data_dir = api_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "ai_writer.sqlite3"


DB_PATH = _default_db_path()
ENGINE = create_engine(f"sqlite:///{DB_PATH}", echo=False)


def init_db() -> None:
    SQLModel.metadata.create_all(ENGINE)
    # Local KB full-text search (SQLite FTS5).
    # Triggers keep the FTS table in sync with kb_chunk.
    with ENGINE.connect() as conn:
        conn.execute(
            text(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_fts
                USING fts5(title, content, tags, content='kb_chunk', content_rowid='id');
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TRIGGER IF NOT EXISTS kb_chunk_ai AFTER INSERT ON kb_chunk BEGIN
                  INSERT INTO kb_chunk_fts(rowid, title, content, tags)
                  VALUES (new.id, new.title, new.content, new.tags);
                END;
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TRIGGER IF NOT EXISTS kb_chunk_ad AFTER DELETE ON kb_chunk BEGIN
                  INSERT INTO kb_chunk_fts(kb_chunk_fts, rowid, title, content, tags)
                  VALUES('delete', old.id, old.title, old.content, old.tags);
                END;
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TRIGGER IF NOT EXISTS kb_chunk_au AFTER UPDATE ON kb_chunk BEGIN
                  INSERT INTO kb_chunk_fts(kb_chunk_fts, rowid, title, content, tags)
                  VALUES('delete', old.id, old.title, old.content, old.tags);
                  INSERT INTO kb_chunk_fts(rowid, title, content, tags)
                  VALUES (new.id, new.title, new.content, new.tags);
                END;
                """
            )
        )
        conn.commit()


@contextmanager
def get_session() -> Session:
    # IMPORTANT:
    # SSE pipelines keep some ORM objects (e.g. Project) in memory across yields.
    # SQLAlchemy defaults to expire_on_commit=True, which expires attributes on commit.
    # When the session is later closed, accessing expired attributes triggers
    # DetachedInstanceError. For this app, we prefer keeping loaded values stable
    # across commits and using explicit refresh/reload when needed.
    with Session(ENGINE, expire_on_commit=False) as session:
        yield session
