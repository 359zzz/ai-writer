from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .db import init_db
from .routers.kb import router as kb_router
from .routers.chapters import router as chapters_router
from .routers.export import router as export_router
from .routers.projects import router as projects_router
from .routers.runs import router as runs_router
from .routers.secrets import router as secrets_router
from .routers.tools import router as tools_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="ai-writer API", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "ai-writer-api", "version": __version__}


app.include_router(projects_router)
app.include_router(runs_router)
app.include_router(secrets_router)
app.include_router(kb_router)
app.include_router(chapters_router)
app.include_router(export_router)
app.include_router(tools_router)
