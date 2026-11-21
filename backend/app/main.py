"""FastAPI application entry point.

Run with:  ./.venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 8099
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import ai
from .config import settings
from .content import rebuild_search_index, store
from .db import engine, init_db
from .routers import ai_chat, interview_api, learning, playground, state

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("learn")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    store.load()
    with engine.connect() as conn:
        indexed = rebuild_search_index(conn)
    log.info(
        "content: %d technologies (%s), %d search rows, %d errors",
        len(store.techs),
        ", ".join(t.slug for t in store.list_techs()),
        indexed,
        len(store.errors),
    )
    for err in store.errors:
        log.warning("content error: %s", err)
    log.info("AI configured: %s (%s)", ai.configured(), settings.ai_model_chat)
    yield


app = FastAPI(title="Learn", version="0.1.0", lifespan=lifespan)

app.include_router(learning.router)
app.include_router(state.router)
app.include_router(ai_chat.router)
app.include_router(interview_api.router)
app.include_router(playground.router)


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "techs": len(store.techs),
        "errors": store.errors,
        "ai": ai.configured(),
    }


@app.post("/api/content/reload")
def reload_content() -> dict:
    """Re-read content/ from disk and rebuild search. Handy while authoring."""
    store.load()
    with engine.connect() as conn:
        rows = rebuild_search_index(conn)
    return {"techs": len(store.techs), "search_rows": rows, "errors": store.errors}


# ------------------------------------------------------------------ frontend
dist: Path = settings.frontend_dist
if (dist / "assets").exists():
    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")


@app.get("/{full_path:path}")
def spa(full_path: str, request: Request):
    """Serve the built SPA for any non-API route."""
    if full_path.startswith("api/"):
        return JSONResponse({"detail": "not found"}, status_code=404)
    index = dist / "index.html"
    if not index.exists():
        return JSONResponse(
            {
                "detail": "frontend not built",
                "hint": "cd frontend && npm install && npm run build",
            },
            status_code=503,
        )
    candidate = dist / full_path
    if full_path and candidate.is_file():
        return FileResponse(candidate)
    return FileResponse(index)
