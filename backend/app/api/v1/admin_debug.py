"""Debug 面板：实时 tail 三个日志文件。"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from jose import JWTError, jwt

from app.core.config import get_settings
settings = get_settings()

router = APIRouter(prefix="/admin/debug", tags=["admin"])


def _verify_admin_token(token: str) -> None:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        if payload.get("role") not in ("superadmin", "admin"):
            raise HTTPException(403, "权限不足")
    except JWTError:
        raise HTTPException(401, "Token 无效")

_BACKEND = Path(__file__).resolve().parents[3]
LOG_FILES = {
    "web":        _BACKEND / "logs" / "gugu.log",
    "worker":     _BACKEND / "logs" / "gugu-worker.log",
    "supervisor": _BACKEND / "logs" / "gugu-supervisor.log",
}

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[mK]")


def _strip(s: str) -> str:
    return _ANSI_RE.sub("", s)


def _tail(path: Path, n: int = 200) -> list[str]:
    if not path.exists():
        return []
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            chunk = min(size, n * 160)
            f.seek(max(0, size - chunk), 0)
            raw = f.read().decode("utf-8", errors="replace")
        lines = [_strip(l) for l in raw.splitlines() if _strip(l).strip()]
        return lines[-n:]
    except Exception:
        return []


@router.get("/logs/tail")
async def tail_logs(lines: int = 200, source: str | None = None):
    sources = [source] if source and source in LOG_FILES else list(LOG_FILES)
    result = []
    for src in sources:
        for line in _tail(LOG_FILES[src], lines):
            result.append({"source": src, "line": line})
    return {"lines": result}


@router.get("/logs/stream")
async def stream_logs(
    request: Request,
    source: Optional[str] = None,
    token: Optional[str] = Query(default=None),
):
    if token:
        _verify_admin_token(token)
    sources = {k: v for k, v in LOG_FILES.items() if not source or k == source}

    async def generator():
        positions: dict[str, int] = {}
        for name, path in sources.items():
            positions[name] = path.stat().st_size if path.exists() else 0

        while not await request.is_disconnected():
            for name, path in sources.items():
                if not path.exists():
                    continue
                size = path.stat().st_size
                pos = positions.get(name, size)
                if size > pos:
                    try:
                        with open(path, "rb") as f:
                            f.seek(pos)
                            new_data = f.read().decode("utf-8", errors="replace")
                        positions[name] = size
                        for raw_line in new_data.splitlines():
                            line = _strip(raw_line).strip()
                            if line:
                                yield f"data: {json.dumps({'source': name, 'line': line})}\n\n"
                    except Exception:
                        pass
            yield ": keepalive\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
