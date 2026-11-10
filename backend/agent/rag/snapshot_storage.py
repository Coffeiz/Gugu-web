"""Cython RAG 快照的跨进程读写锁与访问时间标记。"""
from __future__ import annotations

import fcntl
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path

_TOUCH_INTERVAL_SECONDS = 60
_touch_guard = threading.Lock()
_last_touch: dict[str, float] = {}


def _metadata_dir(index_dir: str | Path) -> Path:
    directory = Path(index_dir)
    return directory.parent / ".locks"


def _metadata_path(index_dir: str | Path, suffix: str) -> Path:
    directory = Path(index_dir)
    return _metadata_dir(directory) / f"{directory.name}.{suffix}"


@contextmanager
def snapshot_lock(index_dir: str | Path, *, exclusive: bool):
    """锁定快照目录；锁文件位于快照目录之外，GC 删除目录时 inode 保持稳定。"""
    metadata_dir = _metadata_dir(index_dir)
    metadata_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = _metadata_path(index_dir, "lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def touch_snapshot_access(index_dir: str | Path) -> None:
    """为热快照刷新访问时间；同进程与跨进程均限制为每分钟一次。"""
    directory = Path(index_dir)
    marker = _metadata_path(directory, "access")
    now = time.time()
    key = str(marker)
    with _touch_guard:
        local_last = _last_touch.get(key, 0.0)
        try:
            external_last = marker.stat().st_mtime
        except OSError:
            external_last = 0.0
        if max(local_last, external_last) > now - _TOUCH_INTERVAL_SECONDS:
            return
        with snapshot_lock(directory, exclusive=False):
            marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            marker.touch(exist_ok=True)
            os.utime(marker, (now, now))
        _last_touch[key] = now


def access_marker_path(index_dir: str | Path) -> Path:
    return _metadata_path(index_dir, "access")


__all__ = ["access_marker_path", "snapshot_lock", "touch_snapshot_access"]
