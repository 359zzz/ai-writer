from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import Column
from sqlalchemy.types import JSON
from sqlmodel import Field, SQLModel


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class Project(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid4()), primary_key=True)
    title: str
    settings: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)


class Run(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid4()), primary_key=True)
    project_id: str = Field(foreign_key="project.id", index=True)
    kind: str
    status: str = Field(default="running", index=True)  # running|completed|failed
    created_at: datetime = Field(default_factory=now_utc)
    finished_at: datetime | None = None
    error: str | None = None


class TraceEvent(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    run_id: str = Field(foreign_key="run.id", index=True)
    seq: int = Field(index=True)
    ts: datetime = Field(default_factory=now_utc, index=True)
    event_type: str = Field(index=True)
    agent: str | None = Field(default=None, index=True)
    payload: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))


class ProjectCreate(SQLModel):
    title: str


class ProjectUpdate(SQLModel):
    title: str | None = None
    settings: dict[str, Any] | None = None
