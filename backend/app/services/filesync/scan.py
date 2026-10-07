"""无数据库依赖的绑定目录扫描与变更文件指纹计算。"""
from __future__ import annotations

import hashlib
import os
import stat
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from app.services.filesync.paths import normalize_relative_path


@dataclass(frozen=True)
class ScanEntry:
    relative_path: str
    object_type: str
    size_bytes: int
    mtime_ns: int
    ctime_ns: int
    fingerprint: str | None = None
    fingerprint_version: int = 2_001_048_576


@dataclass(frozen=True)
class ScanResult:
    entries: Mapping[str, ScanEntry]
    complete: bool
    file_count: int
    directory_count: int
    hashed_count: int
    rejected_count: int
    error_code: str | None = None
    checkpoint_state: Mapping | None = None
    checkpoint_entries: Mapping[str, ScanEntry] | None = None
    reset_prefixes: tuple[str, ...] = ()
    excluded_count: int = 0


@dataclass(frozen=True)
class ScanControl:
    deadline_monotonic: float
    stop_event: threading.Event

    def check(self) -> None:
        if self.stop_event.is_set():
            raise _ScanStopped("cancelled")
        if time.monotonic() >= self.deadline_monotonic:
            raise _ScanStopped("slice_expired")


class _ScanStopped(Exception):
    def __init__(self, code: str):
        self.code = code


class _HashYield(Exception):
    def __init__(self, state: dict):
        self.state = state


FINGERPRINT_VERSION = 3
_HASH_CHUNK_BYTES = 1024 * 1024


def _push_chunk_digest(stack: list[bytes | None], value: bytes) -> None:
    level = 0
    while level < len(stack) and stack[level] is not None:
        value = hashlib.sha256(
            b"gugu-filesync-merkle-v3\0" + level.to_bytes(4, "big")
            + stack[level] + value
        ).digest()
        stack[level] = None
        level += 1
    if level == len(stack):
        stack.append(value)
    else:
        stack[level] = value


def _fingerprint_root(stack: list[bytes | None], size: int, chunk_bytes: int) -> str:
    digest = hashlib.sha256()
    digest.update(b"gugu-filesync-fingerprint-v3\0")
    digest.update(size.to_bytes(8, "big", signed=False))
    digest.update(chunk_bytes.to_bytes(8, "big", signed=False))
    for level, value in enumerate(stack):
        if value is not None:
            digest.update(level.to_bytes(4, "big"))
            digest.update(value)
    return digest.hexdigest()


def _fingerprint_stable(
    path: Path,
    control: ScanControl,
    chunk_bytes: int,
    resume_state: Mapping | None = None,
) -> tuple[str, None]:
    before = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode):
        raise OSError("unsafe_file_type")
    identity = {
        "size": before.st_size,
        "mtime_ns": before.st_mtime_ns,
        "ctime_ns": getattr(before, "st_ctime_ns", 0),
        "device": getattr(before, "st_dev", 0),
        "inode": getattr(before, "st_ino", 0),
        "chunk_bytes": chunk_bytes,
    }
    valid_resume = bool(
        isinstance(resume_state, Mapping)
        and all(resume_state.get(key) == value for key, value in identity.items())
        and isinstance(resume_state.get("offset"), int)
        and isinstance(resume_state.get("digest_stack"), list)
    )
    if valid_resume:
        offset_value = int(resume_state["offset"])
        digests_value = resume_state["digest_stack"]
        valid_resume = bool(
            0 <= offset_value <= before.st_size
            and (offset_value == before.st_size or offset_value % chunk_bytes == 0)
            and len(digests_value) <= 64
            and all(
                item is None or (isinstance(item, str) and len(item) == 64
                and all(char in "0123456789abcdef" for char in item))
                for item in digests_value
            )
        )
    offset = int(resume_state["offset"]) if valid_resume else 0
    digest_stack = (
        [bytes.fromhex(item) if item is not None else None for item in resume_state["digest_stack"]]
        if valid_resume else []
    )
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
            before.st_dev, before.st_ino,
        ):
            raise OSError("unstable_file")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            stream.seek(offset)
            while True:
                try:
                    control.check()
                except _ScanStopped as exc:
                    if exc.code == "slice_expired":
                        raise _HashYield({
                            **identity,
                            "offset": offset,
                            "digest_stack": [item.hex() if item is not None else None for item in digest_stack],
                        }) from exc
                    raise
                chunk = stream.read(chunk_bytes)
                if not chunk:
                    break
                _push_chunk_digest(digest_stack, hashlib.sha256(chunk).digest())
                offset += len(chunk)
        after = os.fstat(descriptor)
        path_after = path.stat(follow_symlinks=False)
    finally:
        os.close(descriptor)
    if (
        (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        or (path_after.st_dev, path_after.st_ino) != (before.st_dev, before.st_ino)
    ):
        raise OSError("unstable_file")
    if offset != before.st_size:
        raise OSError("unstable_file")
    return _fingerprint_root(digest_stack, before.st_size, chunk_bytes), None


def scan_binding_tree(
    root: Path,
    *,
    user_root: Path,
    previous: Mapping[str, ScanEntry] | None = None,
    integrity_full: bool = False,
    force_hash_paths: frozenset[str] | set[str] = frozenset(),
    hash_chunk_bytes: int = _HASH_CHUNK_BYTES,
    checkpoint_state: Mapping | None = None,
    checkpoint_entries: Mapping[str, ScanEntry] | None = None,
    checkpoint_queue=None,
    max_entries: int | None = None,
    hash_gate: threading.Semaphore | None = None,
    control: ScanControl | None = None,
) -> ScanResult:
    """扫描一段绑定目录，不访问 DB；达到预算时返回可持久化的路径游标。

    `previous` 是上次已发布成功快照。size/mtime/ctime 均未变且快照含指纹时，
    普通差异扫描复用当前版本指纹；完整校验、脏路径或 stat 变化时重新读取正文。
    `checkpoint_entries` 是已经完成的候选项，`checkpoint_state` 只保存目录名游标和
    当前大文件的固定大小摘要前沿，不保存目录句柄或 Python 迭代器。
    """
    if control is None:
        control = ScanControl(float("inf"), threading.Event())
    if not isinstance(hash_chunk_bytes, int) or hash_chunk_bytes <= 0:
        raise ValueError("哈希分块大小无效")
    file_fingerprint_profile = FINGERPRINT_VERSION * 1_000_000_000 + hash_chunk_bytes
    entries = checkpoint_entries if checkpoint_entries is not None else {}
    cursor = dict(checkpoint_state or {})
    file_count = int(cursor.get("file_count", 0))
    directory_count = int(cursor.get("directory_count", 0))
    hashed_count = int(cursor.get("hashed_count", 0))
    rejected_count = int(cursor.get("rejected_count", 0))
    processed = 0
    reset_prefixes: list[str] = []
    root_path = root.expanduser().resolve()
    user_path = user_root.expanduser().resolve()
    try:
        root_path.relative_to(user_path)
    except ValueError:
        return ScanResult({}, False, 0, 0, 0, 1, "invalid_root")
    if root.is_symlink() or not root_path.is_dir():
        return ScanResult({}, False, 0, 0, 0, 1, "invalid_root")

    pending_dirs = list(cursor.get("pending_dirs", [""])) if checkpoint_queue is None else checkpoint_queue
    if checkpoint_queue is not None and not cursor.get("queue_initialized"):
        checkpoint_queue.add("")
        cursor["queue_initialized"] = True
    active_dir = cursor.get("active_dir")
    active_ordinal = int(cursor.get("active_ordinal", 0))
    active_identity = cursor.get("active_identity")
    hash_state = cursor.get("hash_state")

    def paused() -> ScanResult:
        cursor.update({
            "active_dir": active_dir,
            "active_ordinal": active_ordinal,
            "active_identity": active_identity,
            "hash_state": hash_state,
            "file_count": file_count,
            "directory_count": directory_count,
            "hashed_count": hashed_count,
            "rejected_count": rejected_count,
            "excluded_count": sum(
                1 for _, entry in _iter_entries(entries) if entry.object_type == "excluded"
            ),
        })
        return ScanResult(
            entries, False, file_count, directory_count, hashed_count,
            rejected_count, "slice_expired", cursor, entries, tuple(reset_prefixes),
            sum(1 for _, entry in _iter_entries(entries) if entry.object_type == "excluded"),
        )

    def excluded_entry(relative: str, info) -> ScanEntry:
        return ScanEntry(
            relative, "excluded", 0, info.st_mtime_ns,
            getattr(info, "st_ctime_ns", 0), None, FINGERPRINT_VERSION,
        )

    def identity(info) -> dict[str, int]:
        return {
            "device": int(getattr(info, "st_dev", 0)),
            "inode": int(getattr(info, "st_ino", 0)),
            "mtime_ns": int(info.st_mtime_ns),
            "ctime_ns": int(getattr(info, "st_ctime_ns", 0)),
        }

    try:
        control.check()
        while len(pending_dirs) > 0 or active_dir is not None:
            control.check()
            if active_dir is None:
                active_dir = pending_dirs.pop()
                active_ordinal = 0
                hash_state = None
                active_identity = None
            directory = root_path / active_dir if active_dir else root_path
            try:
                if directory.is_symlink():
                    raise OSError("unsafe_directory")
                directory_info = directory.stat(follow_symlinks=False)
                if not stat.S_ISDIR(directory_info.st_mode):
                    raise OSError("unsafe_directory")
            except OSError:
                rejected_count += 1
                return ScanResult(entries, False, file_count, directory_count, hashed_count,
                                  rejected_count, "directory_unreadable")
            current_identity = identity(directory_info)
            if active_identity is not None and active_identity != current_identity:
                prefix = active_dir
                if prefix:
                    delete_prefix = getattr(entries, "delete_prefix", None)
                    if delete_prefix is not None:
                        delete_prefix(prefix)
                    else:
                        for path in list(entries):
                            if path == prefix or path.startswith(prefix + "/"):
                                del entries[path]
                    remove_pending_prefix = getattr(pending_dirs, "remove_prefix", None)
                    if remove_pending_prefix is not None:
                        remove_pending_prefix(prefix)
                    else:
                        pending_dirs = [
                            path for path in pending_dirs
                            if path != prefix and not path.startswith(prefix + "/")
                        ]
                    folder_entry = ScanEntry(
                        prefix, "folder", 0, current_identity["mtime_ns"],
                        current_identity["ctime_ns"], None, FINGERPRINT_VERSION,
                    )
                    entries[prefix] = folder_entry
                    reset_prefixes.append(prefix)
                else:
                    entries.clear()
                    pending_dirs.clear()
                    reset_prefixes.append("")
                active_ordinal = 0
                hash_state = None
            active_identity = current_identity
            try:
                iterator = os.scandir(directory)
            except OSError:
                rejected_count += 1
                return ScanResult(
                    entries, False, file_count, directory_count, hashed_count,
                    rejected_count, "directory_unreadable",
                )
            restart_directory = False
            with iterator:
                for ordinal, child in enumerate(iterator):
                    if ordinal < active_ordinal:
                        if child.name.startswith(".gugu-sync-") or child.name.endswith((".gugu-part", ".gugu-tmp")):
                            continue
                        try:
                            prior_relative = normalize_relative_path(
                                f"{active_dir}/{child.name}" if active_dir else child.name,
                            )
                            prior_info = child.stat(follow_symlinks=False)
                            prior_is_symlink = child.is_symlink()
                            prior_entry = entries.get(prior_relative)
                            prior_is_directory = child.is_dir(follow_symlinks=False)
                            prior_is_file = child.is_file(follow_symlinks=False)
                            prior_matches = bool(
                                prior_entry is not None
                                and (
                                    (prior_is_symlink and prior_entry.object_type == "excluded")
                                    or (
                                        not prior_is_symlink
                                        and (prior_is_directory or prior_is_file)
                                        and prior_entry.object_type == ("folder" if prior_is_directory else "file")
                                        and prior_entry.size_bytes == (0 if prior_is_directory else prior_info.st_size)
                                    )
                                )
                                and prior_entry.mtime_ns == prior_info.st_mtime_ns
                                and prior_entry.ctime_ns == getattr(prior_info, "st_ctime_ns", 0)
                                and (prior_is_directory or prior_is_symlink or prior_entry.fingerprint)
                            )
                        except (OSError, ValueError):
                            prior_matches = False
                            prior_relative = ""
                            prior_is_directory = False
                        if not prior_matches:
                            if prior_relative:
                                if prior_is_directory or (prior_entry is not None and prior_entry.object_type == "folder"):
                                    delete_prefix = getattr(entries, "delete_prefix", None)
                                    if delete_prefix is not None:
                                        delete_prefix(prior_relative)
                                    else:
                                        for saved_path in list(entries):
                                            if saved_path == prior_relative or saved_path.startswith(prior_relative + "/"):
                                                del entries[saved_path]
                                    remove_pending_prefix = getattr(pending_dirs, "remove_prefix", None)
                                    if remove_pending_prefix is not None:
                                        remove_pending_prefix(prior_relative)
                                else:
                                    entries.pop(prior_relative, None)
                            active_ordinal = 0
                            hash_state = None
                            restart_directory = True
                            break
                        continue
                    control.check()
                    if child.name.startswith(".gugu-sync-") or child.name.endswith((".gugu-part", ".gugu-tmp")):
                        active_ordinal = ordinal + 1
                        continue
                    path = Path(child.path)
                    try:
                        relative = normalize_relative_path(
                            f"{active_dir}/{child.name}" if active_dir else child.name,
                        )
                        info = child.stat(follow_symlinks=False)
                        candidate_old = entries.get(relative)
                        if child.is_symlink():
                            if (
                                candidate_old is not None
                                and candidate_old.object_type == "excluded"
                                and candidate_old.mtime_ns == info.st_mtime_ns
                                and candidate_old.ctime_ns == getattr(info, "st_ctime_ns", 0)
                            ):
                                active_ordinal = ordinal + 1
                                continue
                            if candidate_old is not None and candidate_old.object_type == "folder":
                                delete_prefix = getattr(entries, "delete_prefix", None)
                                if delete_prefix is not None:
                                    delete_prefix(relative)
                                else:
                                    for saved_path in list(entries):
                                        if saved_path == relative or saved_path.startswith(relative + "/"):
                                            del entries[saved_path]
                            if max_entries is not None and processed >= max_entries:
                                return paused()
                            entries[relative] = excluded_entry(relative, info)
                            processed += 1
                            active_ordinal = ordinal + 1
                            continue
                        if child.is_dir(follow_symlinks=False):
                            candidate_matches = bool(
                                candidate_old is not None
                                and candidate_old.object_type == "folder"
                                and candidate_old.mtime_ns == info.st_mtime_ns
                                and candidate_old.ctime_ns == getattr(info, "st_ctime_ns", 0)
                            )
                            if not candidate_matches:
                                if max_entries is not None and processed >= max_entries:
                                    return paused()
                                entry = ScanEntry(
                                    relative, "folder", 0, info.st_mtime_ns,
                                    getattr(info, "st_ctime_ns", 0), None, FINGERPRINT_VERSION,
                                )
                                entries[relative] = entry
                                pending_dirs.add(relative) if checkpoint_queue is not None else pending_dirs.append(relative)
                                directory_count += 1
                                processed += 1
                            active_ordinal = ordinal + 1
                            continue
                        elif child.is_file(follow_symlinks=False):
                            if (
                                candidate_old is not None
                                and candidate_old.object_type == "file"
                                and candidate_old.size_bytes == info.st_size
                                and candidate_old.mtime_ns == info.st_mtime_ns
                                and candidate_old.ctime_ns == getattr(info, "st_ctime_ns", 0)
                                and candidate_old.fingerprint
                                and candidate_old.fingerprint_version == file_fingerprint_profile
                                and relative not in force_hash_paths
                            ):
                                active_ordinal = ordinal + 1
                                continue
                            if max_entries is not None and processed >= max_entries:
                                return paused()
                            old = previous.get(relative) if previous else None
                            unchanged = bool(
                                old is not None
                                and old.object_type == "file"
                                and old.size_bytes == info.st_size
                                and old.mtime_ns == info.st_mtime_ns
                                and old.ctime_ns == getattr(info, "st_ctime_ns", 0)
                                and old.fingerprint
                                and old.fingerprint_version == file_fingerprint_profile
                                and relative not in force_hash_paths
                            )
                            try:
                                fingerprint = old.fingerprint if unchanged and not integrity_full else None
                                if fingerprint is None:
                                    acquired = False
                                    if hash_gate is not None:
                                        while not acquired:
                                            control.check()
                                            acquired = hash_gate.acquire(timeout=0.1)
                                    try:
                                        fingerprint, _ = _fingerprint_stable(
                                            path, control, hash_chunk_bytes,
                                            hash_state if hash_state and hash_state.get("relative_path") == relative else None,
                                        )
                                    finally:
                                        if acquired:
                                            hash_gate.release()
                            except _HashYield as yielded:
                                hash_state = {"relative_path": relative, **yielded.state}
                                return paused()
                            hash_state = None
                            file_count += 1
                            if not unchanged or integrity_full:
                                hashed_count += 1
                            entry = ScanEntry(
                                relative, "file", info.st_size, info.st_mtime_ns,
                                getattr(info, "st_ctime_ns", 0), fingerprint,
                                file_fingerprint_profile,
                            )
                        else:
                            rejected_count += 1
                            return ScanResult(
                                entries, False, file_count, directory_count, hashed_count,
                                rejected_count, "unsupported_entry",
                            )
                        entries[relative] = entry
                        processed += 1
                        active_ordinal = ordinal + 1
                    except _ScanStopped as exc:
                        if exc.code == "slice_expired":
                            return paused()
                        raise
                    except (OSError, ValueError):
                        rejected_count += 1
                        return ScanResult(
                            entries, False, file_count, directory_count, hashed_count,
                            rejected_count, "scan_entry_failed",
                        )
            if restart_directory:
                continue
            try:
                final_info = directory.stat(follow_symlinks=False)
            except OSError:
                rejected_count += 1
                return ScanResult(
                    entries, False, file_count, directory_count, hashed_count,
                    rejected_count, "directory_unreadable",
                )
            if identity(final_info) != current_identity:
                # 遍历期间目录发生变化；下轮按身份差异清除此子树候选并局部重扫。
                active_identity = current_identity
                active_ordinal = 0
                continue
            active_dir = None
            active_ordinal = 0
            active_identity = None
            hash_state = None
        control.check()
    except _ScanStopped as exc:
        if exc.code == "slice_expired":
            return paused()
        return ScanResult(
            entries, False, file_count, directory_count, hashed_count,
            rejected_count, exc.code,
        )
    except OSError:
        return ScanResult(
            entries, False, file_count, directory_count, hashed_count,
            rejected_count + 1, "scan_failed",
        )
    # 目录指纹自底向上流式汇总，不构建全量 parent→children 索引。
    iter_folders = getattr(entries, "iter_folders_deepest", None)
    folders = iter_folders() if iter_folders is not None else sorted(
        ((path, entry) for path, entry in entries.items() if entry.object_type == "folder"),
        key=lambda item: (item[0].count("/"), item[0]), reverse=True,
    )
    iter_children = getattr(entries, "iter_direct_children", None)
    for relative, entry in folders:
        digest = hashlib.sha256(b"gugu-filesync-directory-v2\0")
        children = iter_children(relative) if iter_children is not None else sorted(
            ((path, child) for path, child in entries.items()
             if path.rpartition("/")[0] == relative),
            key=lambda item: item[0].rpartition("/")[2],
        )
        for child_path, child in children:
            child_name = child_path.rpartition("/")[2]
            kind = {"folder": "d", "file": "f", "excluded": "x"}.get(child.object_type)
            if kind is None:
                raise ValueError("未知扫描条目类型")
            digest.update(kind.encode("ascii"))
            digest.update(b"\0")
            digest.update(child_name.encode("utf-8"))
            digest.update(b"\0")
            if child.fingerprint:
                digest.update(bytes.fromhex(child.fingerprint))
            elif child.object_type == "excluded":
                digest.update(child.mtime_ns.to_bytes(8, "big", signed=False))
                digest.update(child.ctime_ns.to_bytes(8, "big", signed=False))
            digest.update(b"\n")
        entries[relative] = ScanEntry(
            relative, "folder", 0, entry.mtime_ns, entry.ctime_ns, digest.hexdigest(),
            FINGERPRINT_VERSION,
        )
    return ScanResult(
        entries, True, file_count, directory_count, hashed_count,
        rejected_count,
        excluded_count=sum(1 for _, entry in _iter_entries(entries) if entry.object_type == "excluded"),
    )


def _iter_entries(entries):
    iterator = getattr(entries, "iter_sorted", None)
    yield from (iterator() if iterator is not None else entries.items())
