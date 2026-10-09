#!/usr/bin/env python3
"""受限宿主机 inotify 容量服务，仅支持查询和按档扩容。"""
from __future__ import annotations

import json
import os
import socket
import struct
import socketserver
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

SOCKET_PATH = "/run/gugu-inotify-limitd/limitd.sock"
STATE_PATH = Path("/var/lib/gugu-inotify-limitd/last-expansion")
SYSCTL_PATH = Path("/proc/sys/fs/inotify/max_user_watches")
CONFIG_OVERRIDE_PATH = Path(os.getenv(
    "GUGU_CONFIG_OVERRIDE_FILE", "/run/gugu-inotify-limitd/config.override.json",
))
TIERS = (65_536, 131_072, 262_144, 524_288, 1_024_000)
ABSOLUTE_MAX = 1_024_000
DEFAULT_HARD_LIMIT = os.getenv("GUGU_INOTIFY_DEFAULT_HARD_LIMIT", str(ABSOLUTE_MAX))
REQUEST_READ_TIMEOUT_SECONDS = 3.0
MAX_CONNECTIONS = 8
_lock = threading.Lock()
_connection_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
_count_cache: dict[int, tuple[float, int]] = {}
try:
    _last_expansion_at: str | None = STATE_PATH.read_text(encoding="ascii").strip() or None
except OSError:
    _last_expansion_at = None


def watch_count_for_uid(uid: int, proc_root: Path = Path("/proc")) -> int:
    """统计该真实 UID 下所有进程持有的 inotify watch。"""
    now = time.monotonic()
    cached = _count_cache.get(uid)
    if cached and now - cached[0] < 3:
        return cached[1]
    total = 0
    for process in proc_root.iterdir():
        if not process.name.isdigit():
            continue
        try:
            status = (process / "status").read_text(encoding="ascii")
            uid_line = next(line for line in status.splitlines() if line.startswith("Uid:"))
            real_uid = int(uid_line.split()[1])
            if real_uid != uid:
                continue
            for fdinfo in (process / "fdinfo").iterdir():
                try:
                    with fdinfo.open(encoding="ascii") as handle:
                        total += sum(line.startswith("inotify wd:") for line in handle)
                except (OSError, UnicodeError):
                    continue
        except (OSError, StopIteration, ValueError, UnicodeError):
            continue
    _count_cache[uid] = (now, total)
    return total


def next_tier(current: int, hard_limit: int) -> int:
    if type(hard_limit) is not int or not TIERS[0] <= hard_limit <= ABSOLUTE_MAX:
        raise ValueError("invalid hard limit")
    tier = next((value for value in TIERS if value > current), hard_limit)
    return min(tier, hard_limit)


def configured_hard_limit(
    config_path: Path | None = None,
    default_limit: str | int | None = None,
) -> int:
    """读取服务端策略；请求内容不能提高 Admin 当前配置的上限。"""
    config_path = config_path or CONFIG_OVERRIDE_PATH
    default_limit = DEFAULT_HARD_LIMIT if default_limit is None else default_limit
    try:
        default = int(default_limit)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid configured hard limit") from exc
    if not TIERS[0] <= default <= ABSOLUTE_MAX:
        raise ValueError("invalid configured hard limit")

    try:
        override = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        override = {}
    if not isinstance(override, dict):
        raise ValueError("invalid config override")
    filesync = override.get("filesync", {}) or {}
    if not isinstance(filesync, dict):
        raise ValueError("invalid filesync config")
    hard_limit = filesync.get("watch_hard_limit", default)
    if type(hard_limit) is not int or not TIERS[0] <= hard_limit <= ABSOLUTE_MAX:
        raise ValueError("invalid configured hard limit")
    return hard_limit


def dispatch(request: dict, uid: int) -> dict:
    """只按宿主机读取到的可信策略执行固定操作。"""
    hard_limit = configured_hard_limit()
    operation = request.get("operation")
    if operation == "status":
        return snapshot(uid, hard_limit)
    if operation == "auto_expand":
        return expand(uid, hard_limit, automatic=True)
    if operation == "expand":
        return expand(uid, hard_limit, automatic=False)
    raise ValueError("unsupported operation")


def peer_uid(request: socket.socket) -> int:
    """返回 Unix Socket 对端 UID（仅用于按 UID 统计 watcher）。"""
    _pid, uid, _gid = struct.unpack(
        "3i", request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")),
    )
    return uid


def snapshot(
    uid: int,
    hard_limit: int,
    proc_root: Path = Path("/proc"),
    sysctl_path: Path = SYSCTL_PATH,
) -> dict:
    current = int(sysctl_path.read_text(encoding="ascii").strip())
    usage = watch_count_for_uid(uid, proc_root)
    next_limit = next_tier(current, hard_limit) if current < hard_limit else current
    return {
        "uid": uid,
        "usage": usage,
        "limit": current,
        "hardLimit": hard_limit,
        "percent": round(usage / current * 100, 2) if current else 0,
        "nextLimit": next_limit,
        "autoThreshold": (current * 80 + 99) // 100,
        "warningThreshold": (current * 90 + 99) // 100,
        "atWarningThreshold": usage * 100 >= current * 90,
        "atHardLimit": current >= hard_limit,
        "lastExpansionAt": _last_expansion_at,
    }


def expand(
    uid: int,
    hard_limit: int,
    *,
    automatic: bool,
    proc_root: Path = Path("/proc"),
    sysctl_path: Path = SYSCTL_PATH,
) -> dict:
    global _last_expansion_at
    with _lock:
        state = snapshot(uid, hard_limit, proc_root, sysctl_path)
        if automatic and state["usage"] * 100 < state["limit"] * 80:
            return {**state, "expanded": False, "reason": "below_threshold"}
        target = next_tier(state["limit"], hard_limit)
        if target <= state["limit"]:
            return {**state, "expanded": False, "reason": "hard_limit"}
        sysctl_path.write_text(f"{target}\n", encoding="ascii")
        _last_expansion_at = datetime.now(timezone.utc).isoformat()
        try:
            STATE_PATH.write_text(_last_expansion_at, encoding="ascii")
        except OSError:
            # 扩容已经生效；状态记录失败不应回滚 sysctl。
            pass
        _count_cache.pop(uid, None)
        return {
            **snapshot(uid, hard_limit, proc_root, sysctl_path),
            "expanded": True,
            "previousLimit": state["limit"],
        }


class Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        try:
            self.request.settimeout(REQUEST_READ_TIMEOUT_SECONDS)
            raw = self.rfile.readline(4097)
            if len(raw) > 4096 or not raw.endswith(b"\n"):
                raise ValueError("invalid request size")
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ValueError("invalid request")
            uid = peer_uid(self.request)
            response = {"ok": True, **dispatch(request, uid)}
        except Exception as exc:
            # Only fixed error class is returned; host paths and exception details stay private.
            response = {"ok": False, "error": type(exc).__name__}
        self.wfile.write((json.dumps(response, separators=(",", ":")) + "\n").encode())


class Server(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = MAX_CONNECTIONS

    def process_request(self, request, client_address) -> None:
        if not _connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            _connection_slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            _connection_slots.release()


def main() -> None:
    path = Path(SOCKET_PATH)
    path.unlink(missing_ok=True)
    with Server(SOCKET_PATH, Handler) as server:
        os.chmod(SOCKET_PATH, 0o660)
        os.chown(SOCKET_PATH, 0, os.getgid())
        server.serve_forever()


if __name__ == "__main__":
    main()
