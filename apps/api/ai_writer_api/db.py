from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

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


@contextmanager
def get_session() -> Session:
    with Session(ENGINE) as session:
        yield session

