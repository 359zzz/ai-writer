from __future__ import annotations

from fastapi import APIRouter

from ..secrets import secrets_status


router = APIRouter(prefix="/api/secrets", tags=["secrets"])


@router.get("/status")
def get_status() -> dict[str, object]:
    # Intentionally returns presence booleans only (never return the keys).
    return secrets_status()

