"""Debug 面板：实时 tail 三个日志文件。"""
from __future__ import annotations
from app.core.tz import now_utc

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
_LOGS = _BACKEND / "logs"
LOG_FILES = {
    "web":        _LOGS / "gugu.log",
    "worker":     _LOGS / "gugu-worker.log",
    "gateway": _LOGS / "gugu-gateway.log",
}
# web 在 dev / prod 下写不同文件（dev=手动 uvicorn→gugu-web-dev.log；prod=systemd→gugu.log）。
# 取最近更新的那个，自动适配环境——否则 dev 时会一直 tail 停掉的 prod 日志（满屏历史 crash）。
_WEB_CANDIDATES = [_LOGS / "gugu-web-dev.log", _LOGS / "gugu.log"]


def _resolve(name: str) -> Path:
    if name == "web":
        existing = [p for p in _WEB_CANDIDATES if p.exists()]
        if existing:
            return max(existing, key=lambda p: p.stat().st_mtime)
    return LOG_FILES[name]

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[mK]")
# app logger 行首时间戳：「06-29 05:04:32 ...」（MM-DD HH:MM:SS，无年份）
_TS_RE = re.compile(r"^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})")
import datetime as _dt
_EPOCH = _dt.datetime(1970, 1, 1)


def _strip(s: str) -> str:
    return _ANSI_RE.sub("", s)


def _line_dt(line: str, carried: "_dt.datetime") -> "_dt.datetime":
    """解析行首 emit 时间用于排序；**无时间戳的行（uvicorn `INFO:` / print / traceback）沿用上一条**，
    使续行紧跟其父行、整体能按 emit 时间归并（而非各源拼接、或用接收时间）。无年份 → 用当前年。"""
    m = _TS_RE.match(line)
    if m:
        mo, d, h, mi, s = map(int, m.groups())
        try:
            return _dt.datetime(now_utc().year, mo, d, h, mi, s)
        except ValueError:
            return carried
    return carried


def _fmt_time(dt: "_dt.datetime") -> str:
    return dt.strftime("%H:%M:%S") if dt > _EPOCH else ""


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
    rows = []
    for src in sources:
        carried = _EPOCH
        for i, line in enumerate(_tail(_resolve(src), lines)):
            carried = _line_dt(line, carried)
            rows.append((carried, src, i, line))
    # 按 emit 时间归并（不再各源拼接）；同刻按源+原序稳定，使 traceback 等续行紧跟其父行
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    return {"lines": [{"source": s, "line": l, "time": _fmt_time(dt)} for (dt, s, i, l) in rows]}


@router.get("/logs/stream")
async def stream_logs(
    request: Request,
    source: Optional[str] = None,
    token: Optional[str] = Query(default=None),
):
    if token:
        _verify_admin_token(token)
    sources = {k: _resolve(k) for k in LOG_FILES if not source or k == source}

    async def generator():
        positions: dict[str, int] = {}
        carried: dict[str, "_dt.datetime"] = {}
        for name, path in sources.items():
            positions[name] = path.stat().st_size if path.exists() else 0
            carried[name] = _EPOCH

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
                                carried[name] = _line_dt(line, carried[name])
                                yield f"data: {json.dumps({'source': name, 'line': line, 'time': _fmt_time(carried[name])})}\n\n"
                    except Exception:
                        pass
            yield ": keepalive\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
