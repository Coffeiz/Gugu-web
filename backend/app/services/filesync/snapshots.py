"""双向同步冲突用的本地远端快照；正文不进入 DB 和事件。"""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from app.core.config import get_settings


def _snapshot_root(user_id, binding_id: int) -> Path:
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    return storage_root.parent / ".filesync-snapshots" / str(user_id) / str(binding_id)


def _snapshot_path(user_id, binding_id: int, relative_path: str) -> Path:
    digest = hashlib.sha256(relative_path.encode("utf-8")).hexdigest()
    return _snapshot_root(user_id, binding_id) / f"{digest}.bin"


def snapshot_fingerprint(user_id, binding_id: int, relative_path: str) -> str | None:
    path = _snapshot_path(user_id, binding_id, relative_path)
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def read_snapshot(user_id, binding_id: int, relative_path: str) -> bytes | None:
    path = _snapshot_path(user_id, binding_id, relative_path)
    try:
        return path.read_bytes() if path.is_file() else None
    except OSError:
        return None


def save_snapshot(user_id, binding_id: int, relative_path: str, source: Path) -> None:
    destination = _snapshot_path(user_id, binding_id, relative_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".snapshot-", dir=destination.parent)
    try:
        with source.open("rb") as src, os.fdopen(fd, "wb") as dst:
            for chunk in iter(lambda: src.read(1024 * 1024), b""):
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def restore_snapshot(user_id, binding_id: int, relative_path: str, destination: Path) -> bool:
    data = read_snapshot(user_id, binding_id, relative_path)
    if data is None:
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".sync", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True
