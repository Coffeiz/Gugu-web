"""Debug 面板：实时 tail 三个日志文件。"""
from __future__ import annotations
from app.core.tz import now_utc

import asyncio
import base64
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
    # 必须保留日期；tail 可能跨天返回历史日志，否则昨天的 17 点会被误认为今天的未来时间。
    return dt.strftime("%m-%d %H:%M:%S") if dt > _EPOCH else ""


def _decode_cursor(raw: str | None) -> dict[str, int]:
    if not raw:
        return {}
    try:
        padded = raw + "=" * (-len(raw) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        payload = json.loads(decoded)
        if not isinstance(payload, dict):
            return {}
        return {
            name: max(0, int(value))
            for name, value in payload.items()
            if name in LOG_FILES and isinstance(value, (int, float, str))
        }
    except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
        return {}


def _encode_cursor(positions: dict[str, int]) -> str | None:
    if not positions or not any(position > 0 for position in positions.values()):
        return None
    payload = json.dumps(positions, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _find_previous_timestamp(path: Path, offset: int) -> "_dt.datetime":
    """从指定字节位置前向查找最近的带时间戳日志行。"""
    cursor = max(0, offset)
    chunk_size = 64 * 1024
    try:
        while cursor > 0:
            start = max(0, cursor - chunk_size)
            with open(path, "rb") as handle:
                handle.seek(start)
                raw = handle.read(cursor - start)
            for raw_line in reversed(raw.split(b"\n")):
                carried = _line_dt(raw_line.decode("utf-8", errors="replace"), _EPOCH)
                if carried > _EPOCH:
                    return carried
            cursor = start
    except OSError:
        return _EPOCH
    return _EPOCH


def _read_log_page(
    path: Path, end: int | None, n: int,
) -> tuple[list[str], int, "_dt.datetime"]:
    """从文件尾部向前读取一页，并返回分页游标和页前继承时间。"""
    if not path.exists() or n <= 0:
        return [], 0, _EPOCH
    try:
        size = path.stat().st_size
        upper = min(size, max(0, end if end is not None else size))
        if upper <= 0:
            return [], 0, _EPOCH
        cursor = upper
        raw = b""
        chunk_size = 64 * 1024
        while cursor > 0:
            start = max(0, cursor - chunk_size)
            with open(path, "rb") as handle:
                handle.seek(start)
                raw = handle.read(cursor - start) + raw
            cursor = start
            starts = [0]
            starts.extend(index + 1 for index, value in enumerate(raw) if value == 10)
            if cursor > 0:
                starts = starts[1:]
            if len(starts) >= n or cursor == 0:
                break

        raw_lines = raw.split(b"\n")
        discarded_prefix = len(raw_lines[0]) + 1 if cursor > 0 and raw_lines else 0
        lines = raw_lines
        if cursor > 0 and lines:
            lines = lines[1:]
        if lines and lines[-1] == b"":
            lines.pop()
        if not lines:
            return [], cursor, _EPOCH
        selected = lines[-n:]
        first = len(lines) - len(selected)
        prefix_length = sum(len(line) + 1 for line in lines[:first])
        page_start = cursor + discarded_prefix + prefix_length
        carried = _EPOCH
        for context_line in reversed(lines[:first]):
            carried = _line_dt(context_line.decode("utf-8", errors="replace"), _EPOCH)
            if carried > _EPOCH:
                break
        if carried == _EPOCH and page_start > 0:
            carried = _find_previous_timestamp(path, page_start)
        decoded = [_strip(line.decode("utf-8", errors="replace")) for line in selected]
        return [line for line in decoded if line.strip()], page_start, carried
    except OSError:
        return [], 0, _EPOCH
@router.get("/logs/tail")
async def tail_logs(
    lines: int = Query(default=200, ge=1, le=500),
    source: str | None = None,
    cursor: str | None = None,
    query: str | None = Query(default=None, max_length=200),
):
    sources = [source] if source and source in LOG_FILES else list(LOG_FILES)
    previous = _decode_cursor(cursor)
    rows = []
    next_positions: dict[str, int] = {}
    needle = query.strip().lower() if query else ""
    for src in sources:
        path = _resolve(src)
        end = previous.get(src)
        matched = 0
        while True:
            page, page_start, carried = _read_log_page(path, end, lines)
            next_positions[src] = page_start
            for i, line in enumerate(page):
                carried = _line_dt(line, carried)
                if needle and needle not in line.lower():
                    continue
                rows.append((carried, src, i, line))
                matched += 1
            if not needle or matched >= lines or page_start <= 0 or not page:
                break
            end = page_start
    # 按 emit 时间归并（不再各源拼接）；同刻按源+原序稳定，使 traceback 等续行紧跟其父行
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    return {
        "lines": [{"source": s, "line": l, "time": _fmt_time(dt)} for (dt, s, i, l) in rows],
        "next_cursor": _encode_cursor(next_positions),
        "has_more": any(position > 0 for position in next_positions.values()),
    }


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
