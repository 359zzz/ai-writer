from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from ..secrets import secrets_status, update_secrets_store


router = APIRouter(prefix="/api/secrets", tags=["secrets"])


@router.get("/status")
def get_status() -> dict[str, object]:
    # Intentionally returns presence booleans only (never return the keys).
    return secrets_status()


class SecretsSetRequest(BaseModel):
    # We accept user-friendly field names from the UI, and map to env-var keys
    # in the local secrets store.
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    openai_model: str | None = None
    gemini_api_key: str | None = None
    gemini_base_url: str | None = None
    gemini_model: str | None = None


@router.post("/set")
def set_secrets(req: SecretsSetRequest) -> dict[str, object]:
    update: dict[str, object] = {}
    if req.openai_api_key is not None:
        update["OPENAI_API_KEY"] = req.openai_api_key
    if req.openai_base_url is not None:
        update["OPENAI_BASE_URL"] = req.openai_base_url
    if req.openai_model is not None:
        update["OPENAI_MODEL"] = req.openai_model
    if req.gemini_api_key is not None:
        update["GEMINI_API_KEY"] = req.gemini_api_key
    if req.gemini_base_url is not None:
        # We support both names internally.
        update["GEMINI_BASE_URL"] = req.gemini_base_url
        update["GOOGLE_GEMINI_BASE_URL"] = req.gemini_base_url
    if req.gemini_model is not None:
        update["GEMINI_MODEL"] = req.gemini_model

    update_secrets_store(update)
    return secrets_status()
