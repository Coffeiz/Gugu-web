"""事务外、有界内存的本地目录扫描与临时清单。"""
from __future__ import annotations

import asyncio
import hashlib
import os
import sqlite3
import stat
import tempfile
from concurrent.futures import Executor
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from threading import Event
from typing import Any, Callable

from app.core.config import get_settings
from app.services.filesync.protocol import validate_sync_path

_HASH_CHUNK_BYTES = 1024 * 1024
_HASH_CHECK_BYTES = 8 * 1024 * 1024
_MAX_RELATIVE_PATH_BYTES = 1000
_MAX_OPEN_DIRECTORIES = 64


class ScanIncomplete(RuntimeError):
    """扫描无法证明覆盖完整根目录；调用方不得据此处理缺失项。"""

    def __init__(self, message: str, *, code: str = "scan_incomplete") -> None:
        super().__init__(message)
        self.code = code


class ScanTimedOut(TimeoutError):
    """扫描超过预算；调用方应在线程退出后结束任务。"""


@dataclass(frozen=True)
class ScanManifest:
    path: Path
    scanned_count: int
    rejected_count: int
    manifest_bytes: int

    def close(self) -> None:
        self.path.unlink(missing_ok=True)


@dataclass(frozen=True)
class ReconcileCandidate:
    relative_path: str
    object_type: str
    operation: str
    observed_size: int | None = None
    observed_fingerprint: str | None = None
    object_id: int | None = None
    object_version: int | None = None
    baseline_fingerprint: str | None = None


def _digest_file(path: Path, stop_event: Event) -> tuple[int, int, str]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    digest = hashlib.sha256()
    byte_count = 0
    try:
        before = os.fstat(descriptor)
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            while True:
                if stop_event.is_set():
                    raise InterruptedError("扫描已取消")
                chunk = stream.read(_HASH_CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
                byte_count += len(chunk)
                if byte_count % _HASH_CHECK_BYTES == 0 and stop_event.is_set():
                    raise InterruptedError("扫描已取消")
        after = os.fstat(descriptor)
        path_after = path.stat(follow_symlinks=False)
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (
            after.st_size, after.st_mtime_ns, after.st_ino,
        ) or (after.st_dev, after.st_ino) != (path_after.st_dev, path_after.st_ino) or byte_count != after.st_size:
            raise ScanIncomplete("文件在扫描期间发生变化", code="scan_file_changed")
        return after.st_size, after.st_mtime_ns, digest.hexdigest()
    finally:
        os.close(descriptor)


def _create_manifest_file(directory: Path) -> Path:
    descriptor, filename = tempfile.mkstemp(
        prefix="gugu-filesync-", suffix=".sqlite", dir=directory,
    )
    os.fchmod(descriptor, 0o600)
    os.close(descriptor)
    path = Path(filename)
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA cache_size=-8192")
        connection.execute("PRAGMA temp_store=FILE")
        connection.execute(
            "CREATE TABLE entries ("
            "relative_path TEXT PRIMARY KEY, kind TEXT NOT NULL, "
            "size_bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, fingerprint TEXT)"
        )
        connection.execute("CREATE INDEX ix_entries_kind_path ON entries(kind, relative_path)")
        connection.execute(
            "CREATE TABLE excluded_paths (relative_path TEXT PRIMARY KEY)"
        )
        connection.execute(
            "CREATE TABLE db_files ("
            "id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL, storage_key TEXT NOT NULL, "
            "size_bytes INTEGER NOT NULL, version INTEGER NOT NULL, display_name TEXT NOT NULL, "
            "ext TEXT NOT NULL, space TEXT NOT NULL, project_id INTEGER, folder_id INTEGER, "
            "workspace_directory_id INTEGER, mime_type TEXT, fingerprint TEXT, "
            "file_updated_at REAL, journal_updated_at REAL)"
        )
        connection.execute("CREATE INDEX ix_db_files_path ON db_files(relative_path)")
        connection.execute("CREATE INDEX ix_db_files_fingerprint ON db_files(size_bytes, fingerprint)")
        connection.execute(
            "CREATE TABLE db_folders ("
            "id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL, version INTEGER NOT NULL, "
            "fingerprint TEXT)"
        )
        connection.execute("CREATE INDEX ix_db_folders_path ON db_folders(relative_path)")
        connection.commit()
    finally:
        connection.close()
    return path


def scan_to_manifest(
    root: Path,
    *,
    temp_directory: Path,
    stop_event: Event,
    max_manifest_bytes: int,
    commit_entries: int = 256,
    on_progress=None,
    included_root_entries: frozenset[str] | None = None,
) -> ScanManifest:
    """完整扫描一个已验证根目录；可限定根的一级命名空间，线程安全且不访问 DB。"""
    if root.is_symlink():
        raise ScanIncomplete("同步根目录不可用", code="binding_root_unavailable")
    try:
        root = root.resolve(strict=True)
    except OSError as exc:
        raise ScanIncomplete("同步根目录不可用", code="binding_root_unavailable") from exc
    if not root.is_dir():
        raise ScanIncomplete("同步根目录不可用", code="binding_root_unavailable")
    try:
        temp_directory.mkdir(parents=True, exist_ok=True)
        manifest_path = _create_manifest_file(temp_directory)
        connection = sqlite3.connect(manifest_path)
    except OSError as exc:
        raise ScanIncomplete("无法创建临时扫描清单", code="scan_manifest_unavailable") from exc
    except sqlite3.Error as exc:
        raise ScanIncomplete("无法创建临时扫描清单", code="scan_manifest_unavailable") from exc
    scanned = rejected = pending = 0
    try:
        # DFS 持有每层一个 scandir 迭代器，不将宽目录一次性 list 化。
        iterator_stack = [os.scandir(root)]
        from app.services.filesync.reconcile import _is_sync_temporary

        try:
            while iterator_stack:
                if stop_event.is_set():
                    raise InterruptedError("扫描已取消")
                try:
                    entry = next(iterator_stack[-1])
                except StopIteration:
                    iterator_stack.pop().close()
                    continue
                item_path = Path(entry.path)
                relative = item_path.relative_to(root).as_posix()
                if len(relative.encode("utf-8")) > _MAX_RELATIVE_PATH_BYTES:
                    raise ScanIncomplete("目录项路径超过支持长度", code="scan_path_too_long")
                if (
                    included_root_entries is not None
                    and len(iterator_stack) == 1
                    and relative not in included_root_entries
                ):
                    # 用户存储根还承载工作区、运行时缓存等非文件库数据；它们不属于
                    # 该绑定的核对范围，也不能阻塞文件库扫描或进入其差异清单。
                    continue
                try:
                    if _is_sync_temporary(item_path):
                        continue
                    if entry.is_symlink():
                        # 不跟随链接；后续与 DB 清单比对，若链接覆盖已有记录则整轮
                        # 停止，避免把链接目标或被遮蔽路径误判成缺失并删除。
                        connection.execute(
                            "INSERT OR IGNORE INTO excluded_paths VALUES (?)", (relative,),
                        )
                        rejected += 1
                        pending += 1
                    else:
                        validate_sync_path(root, relative)
                        if entry.is_dir(follow_symlinks=False):
                            if len(iterator_stack) >= _MAX_OPEN_DIRECTORIES:
                                raise ScanIncomplete("目录嵌套超过扫描资源上限", code="scan_depth_limit")
                            connection.execute(
                                "INSERT INTO entries VALUES (?, 'directory', 0, 0, NULL)",
                                (relative,),
                            )
                            pending += 1
                            scanned += 1
                            iterator_stack.append(os.scandir(item_path))
                        elif entry.is_file(follow_symlinks=False):
                            size, mtime_ns, fingerprint = _digest_file(item_path, stop_event)
                            connection.execute(
                                "INSERT INTO entries VALUES (?, 'file', ?, ?, ?)",
                                (relative, size, mtime_ns, fingerprint),
                            )
                            pending += 1
                            scanned += 1
                except ScanIncomplete:
                    raise
                except PermissionError as exc:
                    raise ScanIncomplete("绑定范围内有目录或文件不可访问", code="scan_permission_denied") from exc
                except (OSError, ValueError) as exc:
                    raise ScanIncomplete("目录遍历或文件读取不完整", code="scan_scope_incomplete") from exc
                if pending >= max(16, commit_entries):
                    connection.commit()
                    pending = 0
                    current_bytes = manifest_path.stat().st_size
                    if current_bytes > max_manifest_bytes:
                        raise ScanIncomplete("临时清单超过空间预算", code="scan_manifest_budget_exceeded")
                    if on_progress is not None:
                        on_progress(scanned, current_bytes)
        finally:
            for iterator in iterator_stack:
                iterator.close()
        connection.commit()
        _finalize_directory_fingerprints(connection, stop_event)
        connection.execute("PRAGMA optimize")
        connection.commit()
        manifest_bytes = manifest_path.stat().st_size
        if manifest_bytes > max_manifest_bytes:
            raise ScanIncomplete("临时清单超过空间预算", code="scan_manifest_budget_exceeded")
        if stop_event.is_set():
            raise InterruptedError("扫描已取消")
        if on_progress is not None:
            on_progress(scanned, manifest_bytes)
        return ScanManifest(manifest_path, scanned, rejected, manifest_bytes)
    except BaseException as exc:
        connection.rollback()
        connection.close()
        manifest_path.unlink(missing_ok=True)
        if isinstance(exc, sqlite3.Error):
            raise ScanIncomplete("临时扫描清单无法完整写入", code="scan_manifest_unavailable") from exc
        raise
    finally:
        if connection:
            try:
                connection.close()
            except sqlite3.Error:
                pass


async def run_scan_in_thread(
    executor: Executor,
    root: Path,
    *,
    temp_directory: Path,
    stop_event: Event,
    max_manifest_bytes: int,
    timeout_seconds: float,
    commit_entries: int = 256,
    on_progress=None,
    included_root_entries: frozenset[str] | None = None,
    scanner: Callable[..., ScanManifest] = scan_to_manifest,
) -> ScanManifest:
    """在线程池扫描；取消/超时后发停止信号并等待工作线程真实退出。

    对线程池 Future 使用 shield，避免协程取消将 Future 标记取消、却让底层
    扫描线程继续运行。调用方只有在本函数返回/抛出后才能释放该任务的执行槽。
    """
    loop = asyncio.get_running_loop()
    scan_future = loop.run_in_executor(
        executor,
        partial(
            scanner,
            root,
            temp_directory=temp_directory,
            stop_event=stop_event,
            max_manifest_bytes=max_manifest_bytes,
            commit_entries=commit_entries,
            on_progress=on_progress,
            included_root_entries=included_root_entries,
        ),
    )
    try:
        done, _ = await asyncio.wait({scan_future}, timeout=max(0.01, timeout_seconds))
    except asyncio.CancelledError:
        stop_event.set()
        await _wait_for_scan_exit(scan_future)
        raise
    if done:
        return scan_future.result()
    stop_event.set()
    await _wait_for_scan_exit(scan_future)
    raise ScanTimedOut("扫描超过执行预算")


async def _wait_for_scan_exit(scan_future: asyncio.Future) -> None:
    """即使调用方再次收到取消，也不提前返回并释放扫描执行槽。"""
    while not scan_future.done():
        try:
            await asyncio.shield(scan_future)
        except asyncio.CancelledError:
            continue
        except BaseException:
            break
    if scan_future.cancelled():
        return
    try:
        result = scan_future.result()
    except BaseException:
        return
    if isinstance(result, ScanManifest):
        result.close()


def _finalize_directory_fingerprints(connection: sqlite3.Connection, stop_event: Event) -> None:
    """流式生成目录结构指纹；工作集只随目录深度增长。"""
    stack: list[tuple[str, Any]] = [("", hashlib.sha256())]
    updates: list[tuple[str, str]] = []

    def compare_paths(left: str, right: str) -> int:
        """按路径段排序，使目录及其所有后代在同一连续区间内。"""
        left_parts = left.split("/")
        right_parts = right.split("/")
        for left_part, right_part in zip(left_parts, right_parts):
            if left_part != right_part:
                return -1 if left_part < right_part else 1
        return (len(left_parts) > len(right_parts)) - (len(left_parts) < len(right_parts))

    connection.create_collation("PATH_COMPONENTS", compare_paths)
    cursor = connection.execute(
        "SELECT relative_path, kind FROM entries "
        "ORDER BY relative_path COLLATE PATH_COMPONENTS"
    )

    def close_to(parent: str) -> None:
        while stack[-1][0] != parent:
            relative, digest = stack.pop()
            if relative:
                updates.append((digest.hexdigest(), relative))

    try:
        for index, (relative, kind) in enumerate(cursor):
            if index % 256 == 0 and stop_event.is_set():
                raise InterruptedError("扫描已取消")
            parent = relative.rpartition("/")[0]
            close_to(parent)
            marker = "d" if kind == "directory" else "f"
            for directory, digest in stack:
                suffix = relative[len(directory) + 1:] if directory else relative
                digest.update(f"{marker}:{suffix}\n".encode("utf-8"))
            if kind == "directory":
                stack.append((relative, hashlib.sha256()))
            if len(updates) >= 256:
                connection.executemany(
                    "UPDATE entries SET fingerprint = ? WHERE relative_path = ?", updates,
                )
                updates.clear()
        close_to("")
        if updates:
            connection.executemany(
                "UPDATE entries SET fingerprint = ? WHERE relative_path = ?", updates,
            )
        connection.commit()
    finally:
        cursor.close()


def iter_manifest_entries(manifest: ScanManifest, *, kind: str | None = None, batch_size: int = 256):
    """按小批读取已完整扫描的清单，避免把路径全量加载进内存。"""
    connection = sqlite3.connect(f"file:{manifest.path}?mode=ro", uri=True)
    try:
        query = "SELECT relative_path, kind, size_bytes, mtime_ns, fingerprint FROM entries"
        parameters: tuple = ()
        if kind is not None:
            query += " WHERE kind = ?"
            parameters = (kind,)
        query += " ORDER BY relative_path"
        cursor = connection.execute(query, parameters)
        while rows := cursor.fetchmany(max(1, min(2048, batch_size))):
            yield rows
    finally:
        connection.close()


def iter_reconcile_candidate_batches(
    manifest: ScanManifest,
    *,
    batch_size: int = 128,
):
    """在临时 SQLite 中有界归并完整磁盘树与活动 File/Folder 路径。

    只有磁盘扫描成功返回 ``ScanManifest`` 后才能调用。重复 DB 路径或对象类型
    冲突会被标成 ambiguous，绝不静默选一条记录或产生自动删除候选。
    """
    connection = sqlite3.connect(f"file:{manifest.path}?mode=ro", uri=True)
    try:
        cursor = connection.execute(
            "WITH paths AS ("
            "  SELECT relative_path FROM entries "
            "  UNION SELECT relative_path FROM db_files "
            "  UNION SELECT relative_path FROM db_folders"
            "), file_rows AS ("
            "  SELECT relative_path, COUNT(*) AS row_count, MIN(id) AS object_id, "
            "         MIN(version) AS object_version, MIN(size_bytes) AS size_bytes, "
            "         MIN(fingerprint) AS fingerprint, MIN(file_updated_at) AS file_updated_at, "
            "         MIN(journal_updated_at) AS journal_updated_at "
            "  FROM db_files GROUP BY relative_path"
            "), folder_rows AS ("
            "  SELECT relative_path, COUNT(*) AS row_count, MIN(id) AS object_id, "
            "         MIN(version) AS object_version, MIN(fingerprint) AS fingerprint "
            "  FROM db_folders GROUP BY relative_path"
            ") "
            "SELECT paths.relative_path, entries.kind, entries.size_bytes, entries.fingerprint, "
            "       COALESCE(file_rows.row_count, 0), file_rows.object_id, file_rows.object_version, "
            "       file_rows.size_bytes, file_rows.fingerprint, "
            "       file_rows.file_updated_at, file_rows.journal_updated_at, "
            "       COALESCE(folder_rows.row_count, 0), folder_rows.object_id, folder_rows.object_version, "
            "       folder_rows.fingerprint "
            "FROM paths "
            "LEFT JOIN entries ON entries.relative_path = paths.relative_path "
            "LEFT JOIN file_rows ON file_rows.relative_path = paths.relative_path "
            "LEFT JOIN folder_rows ON folder_rows.relative_path = paths.relative_path "
            "ORDER BY paths.relative_path"
        )
        batch: list[ReconcileCandidate] = []
        while rows := cursor.fetchmany(max(1, min(2048, batch_size))):
            for row in rows:
                (relative, disk_kind, disk_size, disk_fingerprint,
                 file_count, file_id, file_version, file_size, file_fingerprint,
                 file_updated_at, journal_updated_at,
                 folder_count, folder_id, folder_version, folder_fingerprint) = row
                candidate = _candidate_for_path(
                    relative, disk_kind, disk_size, disk_fingerprint,
                    file_count, file_id, file_version, file_size, file_fingerprint,
                    file_updated_at, journal_updated_at,
                    folder_count, folder_id, folder_version, folder_fingerprint,
                )
                if candidate is not None:
                    batch.append(candidate)
                    if len(batch) >= max(1, min(2048, batch_size)):
                        yield batch
                        batch = []
        if batch:
            yield batch
    finally:
        connection.close()


def manifest_exclusions_overlap_database(manifest: ScanManifest) -> bool:
    """链接未被跟随；若其路径遮蔽既有 File/Folder 记录则扫描不可用于投影。"""
    connection = sqlite3.connect(f"file:{manifest.path}?mode=ro", uri=True)
    try:
        row = connection.execute(
            "SELECT 1 FROM excluded_paths AS excluded "
            "JOIN ("
            "  SELECT relative_path FROM db_files "
            "  UNION SELECT relative_path FROM db_folders"
            ") AS stored ON ("
            "  stored.relative_path = excluded.relative_path OR ("
            "    length(stored.relative_path) > length(excluded.relative_path) "
            "    AND substr(stored.relative_path, 1, length(excluded.relative_path) + 1) "
            "        = excluded.relative_path || '/'"
            "  )"
            ") LIMIT 1"
        ).fetchone()
        return row is not None
    finally:
        connection.close()


def _candidate_for_path(
    relative: str,
    disk_kind: str | None,
    disk_size: int | None,
    disk_fingerprint: str | None,
    file_count: int,
    file_id: int | None,
    file_version: int | None,
    file_size: int | None,
    file_fingerprint: str | None,
    file_updated_at: float | None,
    journal_updated_at: float | None,
    folder_count: int,
    folder_id: int | None,
    folder_version: int | None,
    folder_fingerprint: str | None,
) -> ReconcileCandidate | None:
    if file_count > 1 or folder_count > 1 or (file_count and folder_count):
        return ReconcileCandidate(relative, "unknown", "ambiguous")
    if disk_kind == "file":
        if folder_count:
            return ReconcileCandidate(relative, "unknown", "ambiguous")
        if not file_count:
            return ReconcileCandidate(relative, "file", "create", disk_size, disk_fingerprint)
        if (
            file_updated_at is not None
            and journal_updated_at is not None
            and file_updated_at > journal_updated_at
            and disk_fingerprint != file_fingerprint
        ):
            return ReconcileCandidate(
                relative, "file", "conflict", disk_size, disk_fingerprint,
                file_id, file_version, file_fingerprint,
            )
        if disk_size != file_size or disk_fingerprint != file_fingerprint:
            return ReconcileCandidate(
                relative, "file", "update", disk_size, disk_fingerprint, file_id, file_version,
            )
        return None
    if disk_kind == "directory":
        if file_count:
            return ReconcileCandidate(relative, "unknown", "ambiguous")
        if not folder_count:
            return ReconcileCandidate(relative, "folder", "create", observed_fingerprint=disk_fingerprint)
        if disk_fingerprint != folder_fingerprint:
            return ReconcileCandidate(
                relative, "folder", "update",
                observed_fingerprint=disk_fingerprint,
                object_id=folder_id,
                object_version=folder_version,
            )
        return None
    if file_count:
        return ReconcileCandidate(relative, "file", "delete", object_id=file_id, object_version=file_version)
    if folder_count:
        return ReconcileCandidate(relative, "folder", "delete", object_id=folder_id, object_version=folder_version)
    return None


def verify_changed_file_candidates(
    root: Path,
    candidates: list[ReconcileCandidate],
    *,
    stop_event: Event,
) -> dict[str, tuple[int, int, int, str] | None]:
    """在线程中复核待投影文件；None 表示扫描后路径已变，调用方跳过该候选。"""
    verified: dict[str, tuple[int, int, int, str] | None] = {}
    for candidate in candidates:
        if stop_event.is_set():
            raise InterruptedError("扫描已取消")
        if candidate.object_type != "file" or candidate.operation not in {"create", "update"}:
            continue
        path = root / candidate.relative_path
        try:
            _assert_no_symlink_components(root, candidate.relative_path)
            before = path.stat(follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode):
                verified[candidate.relative_path] = None
                continue
            size, mtime_ns, fingerprint = _digest_file(path, stop_event)
            after = path.stat(follow_symlinks=False)
            if (size, mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
                verified[candidate.relative_path] = None
                continue
            verified[candidate.relative_path] = (size, mtime_ns, after.st_ino, fingerprint)
        except OSError:
            verified[candidate.relative_path] = None
    return verified


def verify_missing_candidates(
    root: Path,
    candidates: list[ReconcileCandidate],
    *,
    stop_event: Event,
) -> set[str]:
    """在线程中复核缺失路径；只有当前仍缺失的路径才进入删除投影。"""
    try:
        checked_root = root.resolve(strict=True)
    except OSError as exc:
        raise ScanIncomplete("同步根目录已失效") from exc
    if not checked_root.is_dir() or checked_root.is_symlink():
        raise ScanIncomplete("同步根目录已失效")
    missing: set[str] = set()
    for candidate in candidates:
        if stop_event.is_set():
            raise InterruptedError("扫描已取消")
        if candidate.operation != "delete":
            continue
        path = checked_root / candidate.relative_path
        try:
            _assert_no_symlink_components(checked_root, candidate.relative_path, allow_missing=True)
            path.lstat()
        except FileNotFoundError:
            missing.add(candidate.relative_path)
        except (OSError, ScanIncomplete):
            continue
    return missing


def _assert_no_symlink_components(
    root: Path, relative_path: str, *, allow_missing: bool = False,
) -> None:
    current = root
    parts = Path(relative_path).parts
    for index, part in enumerate(parts):
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if allow_missing:
                return
            raise
        if stat.S_ISLNK(info.st_mode):
            raise ScanIncomplete("扫描路径包含符号链接")
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise FileNotFoundError(current)


def connect_manifest(manifest: ScanManifest) -> sqlite3.Connection:
    """Open the private task manifest for bounded comparison/projection work."""
    return sqlite3.connect(manifest.path)


def new_scan_stop_event() -> Event:
    return Event()


def default_manifest_budget() -> tuple[int, int]:
    settings = get_settings().filesync
    return settings.reconcile_manifest_max_bytes, settings.reconcile_manifest_commit_entries
