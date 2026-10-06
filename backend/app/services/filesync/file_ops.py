"""文件同步共用的文件指纹与安全路径辅助函数。"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from app.core.redaction import diag_log

_HASH_CHUNK_BYTES = 1024 * 1024
_CACHE_ADVISE_THRESHOLD_BYTES = 8 * 1024 * 1024
_CACHE_ADVISE_INTERVAL_BYTES = 8 * 1024 * 1024


def fingerprint(path: Path, *, discard_cache: bool = False) -> str:
    digest = hashlib.sha256()
    fadvise = getattr(os, "posix_fadvise", None)
    dontneed = getattr(os, "POSIX_FADV_DONTNEED", None)
    advise_cache = discard_cache and fadvise is not None and dontneed is not None
    offset = 0
    advised_offset = 0
    with path.open("rb") as stream:
        while chunk := stream.read(_HASH_CHUNK_BYTES):
            digest.update(chunk)
            offset += len(chunk)
            if advise_cache and offset - advised_offset >= _CACHE_ADVISE_INTERVAL_BYTES:
                if not _advise_drop_cache(
                    stream.fileno(), advised_offset, offset - advised_offset, dontneed,
                ):
                    advise_cache = False
                advised_offset = offset
        if advise_cache and offset > advised_offset:
            _advise_drop_cache(
                stream.fileno(), advised_offset, offset - advised_offset, dontneed,
            )
    return digest.hexdigest()


def _advise_drop_cache(fd: int, offset: int, length: int, advice: int) -> bool:
    fadvise = getattr(os, "posix_fadvise", None)
    if fadvise is None:
        return False
    try:
        fadvise(fd, offset, length, advice)
    except OSError as exc:
        diag_log("filesync.cache_advice_failed", exc)
        return False
    return True


def stable_fingerprint(path: Path, *, discard_cache: bool = False) -> str:
    """只接受一次完整、稳定的读取，避免把正在复制的文件写成半成品。"""
    before = path.stat()
    should_discard_cache = discard_cache and before.st_size >= _CACHE_ADVISE_THRESHOLD_BYTES
    digest = fingerprint(path, discard_cache=should_discard_cache)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("文件仍在写入")
    return digest


def root_fingerprint(root: Path) -> str:
    return hashlib.sha256(str(root.resolve()).encode("utf-8")).hexdigest()


def file_name(path: Path) -> tuple[str, str]:
    if path.suffix:
        return path.stem, path.suffix[1:].lower()
    return path.name, ""


def safe_storage_key(storage_root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(storage_root.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError("同步文件不在本地存储根内") from exc


def is_sync_temporary(path: Path) -> bool:
    return path.name.startswith(".gugu-sync-") or path.name.endswith((".gugu-part", ".gugu-tmp"))


def directory_fingerprint(directory: Path) -> str:
    """用目录结构生成稳定指纹，不把文件正文重复写入文件夹日志。"""
    digest = hashlib.sha256()
    for item in sorted(directory.rglob("*"), key=lambda path: path.relative_to(directory).as_posix()):
        if item.is_symlink() or not (item.is_file() or item.is_dir()):
            continue
        relative = item.relative_to(directory).as_posix()
        marker = "d" if item.is_dir() else "f"
        digest.update(f"{marker}:{relative}\n".encode("utf-8"))
    return digest.hexdigest()
