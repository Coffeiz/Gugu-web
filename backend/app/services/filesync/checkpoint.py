"""本地可恢复扫描检查点；与应用数据库解耦，扫描时不持有 ORM session。"""
from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator, MutableMapping
from pathlib import Path
from typing import Mapping
from uuid import UUID

from app.core.config import get_settings
from app.services.filesync.scan import ScanEntry


class ScanCheckpointStore:
    """以 SQLite 行为分片保存候选条目和游标，避免单个巨型检查点文档。"""

    def __init__(self, user_id, binding_id: int, run_id):
        if not isinstance(binding_id, int) or binding_id <= 0:
            raise ValueError("绑定标识无效")
        owner = str(UUID(str(user_id)))
        run = str(UUID(str(run_id)))
        storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
        self._directory = (
            storage_root.parent / ".filesync-snapshots" / owner / str(binding_id) / "runs"
        )
        self._path = self._directory / f"{run}.sqlite3"
        self._connection = self._connect()
        self._lock = threading.RLock()
        self.entries = ScanCandidateEntries(self._connection, self._lock)
        self.pending_directories = ScanDirectoryQueue(self._connection, self._lock)

    def _connect(self) -> sqlite3.Connection:
        self._directory.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self._path, timeout=10, check_same_thread=False)
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS checkpoint_state "
            "(singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL)"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS candidate_entries "
            "(relative_path TEXT PRIMARY KEY, payload TEXT NOT NULL, "
            "parent_path TEXT NOT NULL DEFAULT '', basename TEXT NOT NULL DEFAULT '')"
        )
        columns = {row[1] for row in connection.execute("PRAGMA table_info(candidate_entries)")}
        if "parent_path" not in columns:
            connection.execute("ALTER TABLE candidate_entries ADD COLUMN parent_path TEXT NOT NULL DEFAULT ''")
        if "basename" not in columns:
            connection.execute("ALTER TABLE candidate_entries ADD COLUMN basename TEXT NOT NULL DEFAULT ''")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS ix_candidate_entries_parent_name "
            "ON candidate_entries(parent_path, basename)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS ix_candidate_entries_file_signature "
            "ON candidate_entries(json_extract(payload, '$.type'), "
            "json_extract(payload, '$.size'), json_extract(payload, '$.fingerprint'))"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS added_file_signatures "
            "(size_bytes INTEGER NOT NULL, fingerprint TEXT NOT NULL, "
            "PRIMARY KEY(size_bytes, fingerprint))"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS pending_directories "
            "(sequence INTEGER PRIMARY KEY AUTOINCREMENT, relative_path TEXT NOT NULL UNIQUE)"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS blocked_paths "
            "(relative_path TEXT PRIMARY KEY)"
        )
        connection.commit()
        return connection

    def load(self) -> tuple[dict, "ScanCandidateEntries"]:
        row = self._connection.execute(
            "SELECT payload FROM checkpoint_state WHERE singleton=1"
        ).fetchone()
        return (json.loads(row[0]) if row else {}), self.entries

    def begin_scan_segment(self) -> None:
        with self._lock:
            if not self._connection.in_transaction:
                self._connection.execute("BEGIN IMMEDIATE")

    def commit_scan_segment(self, state: Mapping) -> None:
        self.save_state(state)

    def reset(self) -> None:
        with self._lock:
            self._connection.execute("DELETE FROM candidate_entries")
            self.pending_directories.clear()
            self._connection.execute("DELETE FROM blocked_paths")
            self._connection.execute("DELETE FROM checkpoint_state")
            self._connection.commit()

    def save(
        self,
        state: Mapping,
        entries: Mapping[str, ScanEntry],
        *,
        reset_prefixes: tuple[str, ...] = (),
    ) -> None:
        encoded_state = json.dumps(state, sort_keys=True, separators=(",", ":"))
        connection = self._connection
        with self._lock:
            if not connection.in_transaction:
                connection.execute("BEGIN IMMEDIATE")
            for prefix in reset_prefixes:
                if prefix == "":
                    connection.execute("DELETE FROM candidate_entries")
                    connection.execute("DELETE FROM blocked_paths")
                    continue
                connection.execute(
                    "DELETE FROM candidate_entries WHERE relative_path=? "
                    "OR substr(relative_path, 1, ?) = ?",
                    (prefix, len(prefix) + 1, prefix + "/"),
                )
                connection.execute(
                    "DELETE FROM blocked_paths WHERE relative_path=? "
                    "OR substr(relative_path, 1, ?) = ?",
                    (prefix, len(prefix) + 1, prefix + "/"),
                )
            iterator = getattr(entries, "iter_sorted", None)
            source = iterator() if iterator is not None else entries.items()
            for relative, entry in source:
                self.entries[relative] = entry
            connection.execute(
                "INSERT INTO checkpoint_state(singleton, payload) VALUES (1, ?) "
                "ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload",
                (encoded_state,),
            )
            connection.commit()

    def save_state(self, state: Mapping) -> None:
        encoded_state = json.dumps(state, sort_keys=True, separators=(",", ":"))
        connection = self._connection
        with self._lock:
            if not connection.in_transaction:
                connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT INTO checkpoint_state(singleton, payload) VALUES (1, ?) "
                "ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload",
                (encoded_state,),
            )
            connection.commit()

    def rollback_scan_segment(self) -> None:
        with self._lock:
            if self._connection.in_transaction:
                self._connection.rollback()

    def block_paths(self, paths) -> None:
        """持久记录本轮冲突阻塞路径，不把路径集合写入任务数据库。"""
        with self._lock:
            self._connection.executemany(
                "INSERT OR IGNORE INTO blocked_paths(relative_path) VALUES (?)",
                ((path,) for path in paths),
            )
            self._connection.commit()

    def is_blocked(self, relative_path: str) -> bool:
        with self._lock:
            return self._connection.execute(
                "SELECT 1 FROM blocked_paths WHERE relative_path=?",
                (relative_path,),
            ).fetchone() is not None

    def blocked_count(self) -> int:
        with self._lock:
            return int(self._connection.execute(
                "SELECT count(*) FROM blocked_paths",
            ).fetchone()[0])

    def discard(self) -> bool:
        self.close()
        removed = False
        for path in (self._path, Path(str(self._path) + "-wal"), Path(str(self._path) + "-shm")):
            try:
                path.unlink()
                removed = True
            except FileNotFoundError:
                pass
        return removed

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None


class ScanCandidateEntries(MutableMapping[str, ScanEntry]):
    """SQLite-backed candidate map; scan/planning memory is independent of tree size."""

    def __init__(self, connection: sqlite3.Connection, lock: threading.RLock):
        self._connection = connection
        self._lock = lock

    def __getitem__(self, relative_path: str) -> ScanEntry:
        with self._lock:
            row = self._connection.execute(
                "SELECT payload FROM candidate_entries WHERE relative_path=?", (relative_path,),
            ).fetchone()
        if row is None:
            raise KeyError(relative_path)
        return _decode_entry(relative_path, row[0])

    def __setitem__(self, relative_path: str, entry: ScanEntry) -> None:
        parent, _, basename = relative_path.rpartition("/")
        payload = json.dumps({
            "type": entry.object_type,
            "size": entry.size_bytes,
            "mtime_ns": entry.mtime_ns,
            "ctime_ns": entry.ctime_ns,
            "fingerprint": entry.fingerprint,
            "fingerprint_version": entry.fingerprint_version,
        }, sort_keys=True, separators=(",", ":"))
        with self._lock:
            self._connection.execute(
                "INSERT INTO candidate_entries(relative_path, payload, parent_path, basename) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(relative_path) DO UPDATE SET "
                "payload=excluded.payload, parent_path=excluded.parent_path, basename=excluded.basename",
                (relative_path, payload, parent, basename),
            )

    def __delitem__(self, relative_path: str) -> None:
        with self._lock:
            cursor = self._connection.execute(
                "DELETE FROM candidate_entries WHERE relative_path=?", (relative_path,),
            )
        if cursor.rowcount == 0:
            raise KeyError(relative_path)

    def __iter__(self) -> Iterator[str]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT relative_path FROM candidate_entries ORDER BY relative_path"
            )
            for row in rows:
                yield row[0]

    def iter_sorted(self) -> Iterator[tuple[str, ScanEntry]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT relative_path, payload FROM candidate_entries ORDER BY relative_path"
            )
            for relative_path, payload in rows:
                yield relative_path, _decode_entry(relative_path, payload)

    def iter_sorted_after(self, cursor: str | None) -> Iterator[tuple[str, ScanEntry]]:
        """按稳定路径游标续读候选，避免每个时间片从头复查所有条目。"""
        with self._lock:
            if cursor is None:
                rows = self._connection.execute(
                    "SELECT relative_path, payload FROM candidate_entries ORDER BY relative_path"
                )
            else:
                rows = self._connection.execute(
                    "SELECT relative_path, payload FROM candidate_entries "
                    "WHERE relative_path>? ORDER BY relative_path", (cursor,),
                )
            for relative_path, payload in rows:
                yield relative_path, _decode_entry(relative_path, payload)

    def prepare_added_file_signatures(self, previous: Mapping[str, ScanEntry]) -> None:
        """以磁盘 SQLite 索引本轮新增文件指纹，避免整树签名集合占用内存。"""
        with self._lock:
            self._connection.execute("DELETE FROM added_file_signatures")
            self._connection.executemany(
                "INSERT OR IGNORE INTO added_file_signatures(size_bytes, fingerprint) VALUES (?, ?)",
                (
                    (entry.size_bytes, entry.fingerprint)
                    for relative_path, entry in self.iter_sorted()
                    if entry.object_type == "file"
                    and entry.fingerprint is not None
                    and relative_path not in previous
                ),
            )
            self._connection.commit()

    def has_added_file_signature(self, size_bytes: int, fingerprint: str) -> bool:
        """判断新增路径是否可能复用缺失文件的 File 身份。"""
        with self._lock:
            row = self._connection.execute(
                "SELECT 1 FROM added_file_signatures WHERE size_bytes=? AND fingerprint=? LIMIT 1",
                (size_bytes, fingerprint),
            ).fetchone()
        return row is not None

    def iter_folders_deepest(self) -> Iterator[tuple[str, ScanEntry]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT relative_path, payload FROM candidate_entries "
                "WHERE json_extract(payload, '$.type')='folder' "
                "ORDER BY length(relative_path)-length(replace(relative_path, '/', '')) DESC, relative_path DESC"
            )
            for relative_path, payload in rows:
                yield relative_path, _decode_entry(relative_path, payload)

    def iter_direct_children(self, parent_path: str) -> Iterator[tuple[str, ScanEntry]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT relative_path, payload FROM candidate_entries "
                "WHERE parent_path=? ORDER BY basename", (parent_path,),
            )
            for relative_path, payload in rows:
                yield relative_path, _decode_entry(relative_path, payload)

    def delete_prefix(self, prefix: str) -> None:
        with self._lock:
            self._connection.execute(
                "DELETE FROM candidate_entries WHERE relative_path=? "
                "OR substr(relative_path, 1, ?) = ?",
                (prefix, len(prefix) + 1, prefix + "/"),
            )

    def __len__(self) -> int:
        with self._lock:
            return int(self._connection.execute(
                "SELECT count(*) FROM candidate_entries",
            ).fetchone()[0])

    def clear(self) -> None:
        with self._lock:
            self._connection.execute("DELETE FROM candidate_entries")


def _decode_entry(relative_path: str, payload: str) -> ScanEntry:
    value = json.loads(payload)
    return ScanEntry(
        relative_path, value["type"], value["size"], value["mtime_ns"],
        value["ctime_ns"], value["fingerprint"], value["fingerprint_version"],
    )


class ScanDirectoryQueue:
    """磁盘持久化的待遍历目录栈，避免任务游标随目录数线性增长。"""

    def __init__(self, connection: sqlite3.Connection, lock: threading.RLock):
        self._connection = connection
        self._lock = lock

    def add(self, relative_path: str) -> None:
        with self._lock:
            self._connection.execute(
                "INSERT OR IGNORE INTO pending_directories(relative_path) VALUES (?)",
                (relative_path,),
            )

    def pop(self) -> str:
        with self._lock:
            row = self._connection.execute(
                "SELECT sequence, relative_path FROM pending_directories "
                "ORDER BY sequence DESC LIMIT 1"
            ).fetchone()
            if row is None:
                raise IndexError("目录队列为空")
            self._connection.execute(
                "DELETE FROM pending_directories WHERE sequence=?", (row[0],),
            )
            return row[1]

    def remove_prefix(self, prefix: str) -> None:
        with self._lock:
            if prefix == "":
                self.clear()
            else:
                self._connection.execute(
                    "DELETE FROM pending_directories WHERE relative_path=? "
                    "OR substr(relative_path, 1, ?) = ?",
                    (prefix, len(prefix) + 1, prefix + "/"),
                )

    def clear(self) -> None:
        with self._lock:
            self._connection.execute("DELETE FROM pending_directories")

    def __len__(self) -> int:
        with self._lock:
            return int(self._connection.execute(
                "SELECT count(*) FROM pending_directories",
            ).fetchone()[0])
