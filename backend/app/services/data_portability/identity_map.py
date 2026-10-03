"""私有磁盘身份映射，避免大账号导出把全部 ID 映射留在进程内存。"""
from __future__ import annotations

import os
import json
import sqlite3
import tempfile
from collections.abc import Iterable
from pathlib import Path


class SQLitePortableIdentityMap:
    def __init__(self, directory: str | Path | None = None):
        fd, path = tempfile.mkstemp(prefix="gugu-portable-ids-", suffix=".sqlite3", dir=directory)
        os.fchmod(fd, 0o600)
        os.close(fd)
        self.path = path
        self._db = sqlite3.connect(path)
        self._db.execute(
            "CREATE TABLE identities (record_type TEXT NOT NULL, target_id TEXT NOT NULL, "
            "portable_id TEXT NOT NULL, PRIMARY KEY(record_type, target_id)) WITHOUT ROWID"
        )
        self._db.execute(
            "CREATE TABLE metadata (record_type TEXT NOT NULL, target_id TEXT NOT NULL, "
            "value_json TEXT NOT NULL, PRIMARY KEY(record_type, target_id)) WITHOUT ROWID"
        )
        self._db.commit()

    def __setitem__(self, key: tuple[str, str], portable_id: str) -> None:
        self._db.execute(
            "INSERT INTO identities(record_type, target_id, portable_id) VALUES (?, ?, ?) "
            "ON CONFLICT(record_type, target_id) DO UPDATE SET portable_id=excluded.portable_id",
            (str(key[0]), str(key[1]), str(portable_id)),
        )

    def get(self, key: tuple[str, str], default=None):
        row = self._db.execute(
            "SELECT portable_id FROM identities WHERE record_type=? AND target_id=?",
            (str(key[0]), str(key[1])),
        ).fetchone()
        return row[0] if row else default

    def commit(self) -> None:
        self._db.commit()

    def set_metadata(self, record_type: str, target_id: str, value: dict) -> None:
        self._db.execute(
            "INSERT INTO metadata(record_type, target_id, value_json) VALUES (?, ?, ?) "
            "ON CONFLICT(record_type, target_id) DO UPDATE SET value_json=excluded.value_json",
            (record_type, str(target_id), json.dumps(value, ensure_ascii=False)),
        )

    def get_metadata(self, record_type: str, target_id: str, default=None):
        row = self._db.execute(
            "SELECT value_json FROM metadata WHERE record_type=? AND target_id=?",
            (record_type, str(target_id)),
        ).fetchone()
        return json.loads(row[0]) if row else default

    def view(self, record_types: Iterable[str]) -> "PortableIdentityView":
        return PortableIdentityView(self, frozenset(record_types))

    def close(self) -> None:
        if self._db is None:
            return
        self._db.close()
        self._db = None
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()


class PortableIdentityView:
    def __init__(self, source: SQLitePortableIdentityMap, record_types: frozenset[str]):
        self.source = source
        self.record_types = record_types

    def get(self, key: tuple[str, str], default=None):
        if key[0] not in self.record_types:
            return default
        return self.source.get(key, default)

    def get_metadata(self, record_type: str, target_id: str, default=None):
        if record_type not in self.record_types:
            return default
        return self.source.get_metadata(record_type, target_id, default)

    def set_metadata(self, record_type: str, target_id: str, value: dict) -> None:
        self.source.set_metadata(record_type, target_id, value)
