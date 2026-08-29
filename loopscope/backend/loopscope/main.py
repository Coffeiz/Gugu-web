from __future__ import annotations

import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .storage import TraceStore

app = FastAPI(title="LoopScope", version=__version__)
cors_origins = [
    "http://127.0.0.1:4319",
    "http://localhost:4319",
]
cors_origins.extend(
    origin.strip()
    for origin in os.getenv("LOOPSCOPE_CORS_ORIGINS", "").split(",")
    if origin.strip()
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = TraceStore()


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__, "db": str(store.path)}


@app.post("/api/collector/runs")
def ingest_run(payload: dict):
    if not payload.get("id") or not payload.get("session_key"):
        raise HTTPException(400, "id and session_key are required")
    return store.ingest_run(payload)


@app.get("/api/sessions")
def list_sessions():
    return store.list_sessions()


@app.get("/api/sessions/{session_key:path}/runs")
def list_runs(session_key: str):
    return store.list_runs(session_key)


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    return run


def run():
    import uvicorn
    uvicorn.run(
        "loopscope.main:app",
        host=os.getenv("LOOPSCOPE_HOST", "127.0.0.1"),
        port=int(os.getenv("LOOPSCOPE_PORT", "4320")),
        reload=False,
    )


if __name__ == "__main__":
    run()
