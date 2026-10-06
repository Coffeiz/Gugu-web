"""文件同步成功基线的不可变代次存储。"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from bisect import bisect_left
from dataclasses import dataclass
from collections.abc import Iterator
from pathlib import Path
from typing import Iterable, Mapping
from uuid import UUID, uuid4

from app.core.config import get_settings
from app.services.filesync.paths import normalize_relative_path
from app.services.filesync.scan import FINGERPRINT_VERSION, ScanEntry

_SCHEMA_VERSION = 3
_MAX_MANIFEST_BYTES = 4 * 1024 * 1024
_SHARD_ENTRY_LIMIT = 1000


def _supported_fingerprint_version(object_type: str, version) -> bool:
    if not isinstance(version, int):
        return False
    if object_type == "folder":
        return version in {2, FINGERPRINT_VERSION}
    return any(
        profile * 1_000_000_000 < version < (profile + 1) * 1_000_000_000
        for profile in {2, FINGERPRINT_VERSION}
    )


@dataclass(frozen=True)
class BaselineManifest:
    generation: str
    root_fingerprint: str
    entries: Mapping[str, ScanEntry]
    created_at: str


class _BaselineEntries(Mapping[str, ScanEntry]):
    """按需读取不可变快照分片，避免将整个成功基线常驻内存。"""

    def __init__(self, directory: Path, shards: list[dict], entry_count: int):
        self._directory = directory
        self._shards = shards
        self._shard_ends = [shard["last_path"] for shard in shards]
        self._entry_count = entry_count
        self._cached_index: int | None = None
        self._cached_entries: dict[str, ScanEntry] = {}

    def __len__(self) -> int:
        return self._entry_count

    def __iter__(self) -> Iterator[str]:
        for index in range(len(self._shards)):
            yield from self._read_shard(index)

    def iter_sorted(self) -> Iterator[tuple[str, ScanEntry]]:
        for index in range(len(self._shards)):
            yield from self._read_shard(index).items()

    def __getitem__(self, relative_path: str) -> ScanEntry:
        if not self._shards:
            raise KeyError(relative_path)
        index = bisect_left(self._shard_ends, relative_path)
        if index >= len(self._shards) or relative_path < self._shards[index]["first_path"]:
            raise KeyError(relative_path)
        entries = self._read_shard(index)
        try:
            return entries[relative_path]
        except KeyError:
            raise KeyError(relative_path) from None

    def _read_shard(self, index: int) -> dict[str, ScanEntry]:
        if self._cached_index == index:
            return self._cached_entries
        shard = self._shards[index]
        path = self._directory / shard["name"]
        if path.is_symlink() or not path.is_file():
            raise ValueError("快照分片缺失")
        encoded = path.read_bytes()
        if hashlib.sha256(encoded).hexdigest() != shard.get("sha256"):
            raise ValueError("快照分片校验失败")
        raw_entries = json.loads(encoded)
        if not isinstance(raw_entries, dict) or len(raw_entries) != shard.get("entries"):
            raise ValueError("快照分片格式无效")
        if not raw_entries or next(iter(raw_entries)) != shard.get("first_path") or next(reversed(raw_entries)) != shard.get("last_path"):
            raise ValueError("快照分片路径范围无效")
        entries: dict[str, ScanEntry] = {}
        for raw_path, value in raw_entries.items():
            if not isinstance(value, dict):
                raise ValueError("快照条目无效")
            relative = normalize_relative_path(raw_path)
            object_type = value.get("type")
            size = value.get("size")
            mtime_ns = value.get("mtime_ns")
            ctime_ns = value.get("ctime_ns")
            fingerprint = value.get("fingerprint")
            fingerprint_version = value.get("fingerprint_version")
            if object_type not in {"file", "folder"} or any(
                not isinstance(number, int) or number < 0
                for number in (size, mtime_ns, ctime_ns)
            ):
                raise ValueError("快照元数据无效")
            if not _supported_fingerprint_version(object_type, fingerprint_version):
                raise ValueError("快照指纹版本不支持")
            if object_type == "file" and (
                not isinstance(fingerprint, str) or len(fingerprint) != 64
                or any(c not in "0123456789abcdef" for c in fingerprint)
            ):
                raise ValueError("文件指纹无效")
            if fingerprint is not None and (
                not isinstance(fingerprint, str) or len(fingerprint) != 64
                or any(c not in "0123456789abcdef" for c in fingerprint)
            ):
                raise ValueError("目录结构指纹无效")
            entries[relative] = ScanEntry(
                relative, object_type, size, mtime_ns, ctime_ns, fingerprint,
                fingerprint_version,
            )
        self._cached_index = index
        self._cached_entries = entries
        return entries


def _canonical(payload: dict) -> bytes:
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")


class FileSyncBaselineStore:
    """只负责候选代次的落盘/读取；成功发布指针由数据库事务负责。"""

    def __init__(self, user_id, binding_id: int):
        if not isinstance(binding_id, int) or binding_id <= 0:
            raise ValueError("绑定标识无效")
        owner = str(UUID(str(user_id)))
        storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
        self._directory = (
            storage_root.parent / ".filesync-snapshots" / owner / str(binding_id)
            / "generations"
        )

    def _path(self, generation: str) -> Path:
        value = str(UUID(generation))
        return self._directory / value

    def stage(
        self,
        *,
        root_fingerprint: str,
        entries: Mapping[str, ScanEntry] | Iterable[tuple[str, ScanEntry]],
    ) -> str:
        """先原子写入不可变候选文件；成功发布需之后 CAS 更新数据库指针。"""
        if len(root_fingerprint) != 64 or any(c not in "0123456789abcdef" for c in root_fingerprint):
            raise ValueError("绑定根指纹无效")
        iterator = getattr(entries, "iter_sorted", None)
        if iterator is not None:
            source = iterator()
        elif isinstance(entries, Mapping):
            source = iter(sorted(entries.items()))
        else:
            source = iter(entries)
        generation = str(uuid4())
        from app.core.tz import now_utc
        self._directory.mkdir(parents=True, exist_ok=True)
        temporary_dir = Path(tempfile.mkdtemp(prefix=".candidate-", dir=self._directory))
        shard_records: list[dict[str, str | int]] = []
        chunk: dict[str, dict] = {}
        entry_count = 0
        previous_path: str | None = None

        def write_shard(shard_index: int, body: dict[str, dict]) -> None:
            encoded = _canonical(body)
            shard_name = f"entries-{shard_index:06d}.json"
            shard_path = temporary_dir / shard_name
            with shard_path.open("xb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            shard_records.append({
                "name": shard_name,
                "entries": len(body),
                "first_path": next(iter(body)),
                "last_path": next(reversed(body)),
                "sha256": hashlib.sha256(encoded).hexdigest(),
            })

        try:
            for raw_path, entry in source:
                path = normalize_relative_path(raw_path)
                if path != entry.relative_path or entry.object_type not in {"file", "folder"}:
                    raise ValueError("快照条目无效")
                if previous_path is not None and path <= previous_path:
                    raise ValueError("快照条目必须按规范路径严格递增")
                previous_path = path
                if not _supported_fingerprint_version(entry.object_type, entry.fingerprint_version):
                    raise ValueError("快照指纹版本不支持")
                if min(entry.size_bytes, entry.mtime_ns, entry.ctime_ns) < 0:
                    raise ValueError("快照元数据无效")
                fingerprint = entry.fingerprint
                if entry.object_type == "file" and (
                    not fingerprint or len(fingerprint) != 64
                    or any(c not in "0123456789abcdef" for c in fingerprint)
                ):
                    raise ValueError("文件指纹无效")
                if fingerprint is not None and (
                    len(fingerprint) != 64
                    or any(c not in "0123456789abcdef" for c in fingerprint)
                ):
                    raise ValueError("目录结构指纹无效")
                chunk[path] = {
                    "type": entry.object_type,
                    "size": entry.size_bytes,
                    "mtime_ns": entry.mtime_ns,
                    "ctime_ns": entry.ctime_ns,
                    "fingerprint": fingerprint,
                    "fingerprint_version": entry.fingerprint_version,
                }
                entry_count += 1
                if len(chunk) == _SHARD_ENTRY_LIMIT:
                    write_shard(len(shard_records), chunk)
                    chunk = {}
            if chunk:
                write_shard(len(shard_records), chunk)

            manifest_body = {
                "schema_version": _SCHEMA_VERSION,
                "generation": generation,
                "root_fingerprint": root_fingerprint,
                "created_at": now_utc().isoformat(),
                "entry_count": entry_count,
                "shards": shard_records,
            }
            manifest = {
                **manifest_body,
                "checksum": hashlib.sha256(_canonical(manifest_body)).hexdigest(),
            }
            manifest_path = temporary_dir / "manifest.json"
            with manifest_path.open("xb") as stream:
                stream.write(_canonical(manifest))
                stream.flush()
                os.fsync(stream.fileno())
            directory_fd = os.open(temporary_dir, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            os.replace(temporary_dir, self._path(generation))
            directory_fd = os.open(self._directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if temporary_dir.exists():
                shutil.rmtree(temporary_dir, ignore_errors=True)
        return generation

    def load(self, generation: str, *, expected_root_fingerprint: str) -> BaselineManifest:
        path = self._path(generation)
        manifest_path = path / "manifest.json"
        if manifest_path.stat().st_size > _MAX_MANIFEST_BYTES:
            raise ValueError("快照文件过大")
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("快照格式无效")
        checksum = payload.pop("checksum", None)
        if not isinstance(checksum, str) or hashlib.sha256(_canonical(payload)).hexdigest() != checksum:
            raise ValueError("快照校验失败")
        if payload.get("schema_version") != _SCHEMA_VERSION:
            raise ValueError("快照版本不支持")
        if payload.get("generation") != str(UUID(generation)):
            raise ValueError("快照代次不匹配")
        if payload.get("root_fingerprint") != expected_root_fingerprint:
            raise ValueError("快照绑定范围不匹配")
        shards = payload.get("shards")
        if not isinstance(shards, list):
            raise ValueError("快照条目无效")
        entry_count = 0
        previous_last: str | None = None
        entries = _BaselineEntries(path, shards, int(payload.get("entry_count", -1)))
        for index, shard in enumerate(shards):
            if not isinstance(shard, dict):
                raise ValueError("快照分片无效")
            name = shard.get("name")
            if not isinstance(name, str) or not name.startswith("entries-") or "/" in name or "\\" in name:
                raise ValueError("快照分片路径无效")
            first_path = shard.get("first_path")
            last_path = shard.get("last_path")
            if (
                not isinstance(first_path, str) or not isinstance(last_path, str)
                or first_path > last_path or (previous_last is not None and first_path <= previous_last)
            ):
                raise ValueError("快照分片路径范围无效")
            shard_entries = entries._read_shard(index)
            if len(shard_entries) != shard.get("entries"):
                raise ValueError("快照分片格式无效")
            entry_count += len(shard_entries)
            previous_last = last_path
        if entry_count != payload.get("entry_count"):
            raise ValueError("快照条目数量不匹配")
        return BaselineManifest(
            str(payload["generation"]), str(payload["root_fingerprint"]),
            entries, str(payload["created_at"]),
        )

    def discard(self, generation: str) -> bool:
        """仅供调用方确认代次未被成功指针引用后删除候选文件。"""
        try:
            shutil.rmtree(self._path(generation))
        except FileNotFoundError:
            return False
        return True

    def prune(self, keep_generations: set[str]) -> int:
        """成功发布后保留当前与上一代；不接触正文/冲突快照。"""
        keep = {str(UUID(value)) for value in keep_generations if value}
        removed = 0
        try:
            children = tuple(self._directory.iterdir())
        except FileNotFoundError:
            return 0
        for path in children:
            if path.is_symlink() or not path.is_dir():
                continue
            try:
                generation = str(UUID(path.stem))
            except ValueError:
                continue
            if generation in keep:
                continue
            try:
                shutil.rmtree(path)
                removed += 1
            except OSError:
                continue
        return removed
