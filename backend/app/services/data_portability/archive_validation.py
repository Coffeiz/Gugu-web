"""加密可移植归档的无写入预检与完整性验证。"""
from __future__ import annotations

import hashlib
import json
import stat
import zipfile
from dataclasses import dataclass
from typing import BinaryIO

from pydantic import BaseModel, ConfigDict, Field

from app.services.data_portability.crypto_stream import EncryptedArchiveReader
from app.services.data_portability.schema import (
    PortableArchiveManifest, PortableEntityRecord, validate_archive_path,
)

MAX_ENTRIES = 20_000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 20 * 1024**3
MAX_SINGLE_ENTRY_BYTES = 4 * 1024**3
MAX_COMPRESSION_RATIO = 500
MAX_RECORD_LINE_BYTES = 8 * 1024**2
MAX_RECORDS = 2_000_000
MAX_PATH_DEPTH = 32
MAX_PATH_BYTES = 1024
_READ_CHUNK = 1024 * 1024


class _MemoryScopeRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    platform: str = Field(min_length=1, max_length=64)
    bot_id: str = Field(min_length=1, max_length=200)
    scope_type: str = Field(pattern=r"^(group|platform-user)$")
    scope_id: str = Field(min_length=1, max_length=500)
    deleted: bool


@dataclass(frozen=True)
class ArchiveValidationResult:
    manifest: PortableArchiveManifest
    record_count: int
    expanded_bytes: int
    archive_sha256: str
    categories: dict[str, int]


def validate_encrypted_archive(
    source: BinaryIO,
    *,
    context: str,
    allow_incomplete: bool = True,
) -> ArchiveValidationResult:
    """校验 ZIP 容器、manifest、摘要、路径和 JSONL 引用，不解包到业务存储。"""
    reader = EncryptedArchiveReader(source, context)
    archive_digest = hashlib.sha256()
    reader.seek(0)
    while chunk := reader.read(_READ_CHUNK):
        archive_digest.update(chunk)
    reader.seek(0)

    with zipfile.ZipFile(reader, mode="r") as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise ValueError("归档条目数量超过上限")
        paths: set[str] = set()
        expanded = 0
        for info in infos:
            path = validate_archive_path(info.filename)
            if len(path.encode("utf-8")) > MAX_PATH_BYTES or len(path.split("/")) > MAX_PATH_DEPTH:
                raise ValueError("归档路径过深或过长")
            if path in paths:
                raise ValueError("归档包含重复路径")
            paths.add(path)
            mode = (info.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(mode)
            if info.is_dir() or file_type not in (0, stat.S_IFREG):
                raise ValueError("归档包含目录或特殊文件类型")
            if info.file_size > MAX_SINGLE_ENTRY_BYTES:
                raise ValueError("归档单项大小超过上限")
            expanded += info.file_size
            if expanded > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                raise ValueError("归档解压后体积超过上限")
            if info.file_size and (not info.compress_size or info.file_size / info.compress_size > MAX_COMPRESSION_RATIO):
                raise ValueError("归档压缩比例超过上限")

        if not {"manifest.json", "checksums.sha256", "README.txt"}.issubset(paths):
            raise ValueError("归档缺少 manifest、README 或 checksum")
        manifest_bytes = _read_limited(archive, "manifest.json", 32 * 1024 * 1024)
        manifest = PortableArchiveManifest.model_validate_json(manifest_bytes)
        if manifest.complete:
            manifest.require_replaceable()
        elif not allow_incomplete:
            raise ValueError("此操作要求完整归档")

        declared = {entry.path: entry for entry in manifest.entries}
        expected_paths = set(declared) | {"manifest.json", "checksums.sha256"}
        if paths != expected_paths:
            raise ValueError("归档实际条目与 manifest 不一致")
        checksums = _parse_checksums(_read_limited(archive, "checksums.sha256", 8 * 1024 * 1024))
        if set(checksums) != set(declared):
            raise ValueError("checksum 清单与 manifest 不一致")

        known_records: dict[str, set[str]] = {}
        pending_relations: list[tuple[str, str, str]] = []
        record_count = 0
        for path, entry in declared.items():
            digest = hashlib.sha256()
            counted_size = 0
            with archive.open(path, "r") as stream:
                if path.endswith(".jsonl"):
                    lines = _iter_bounded_lines(stream)
                    actual_records = 0
                    for line in lines:
                        if not line.strip():
                            raise ValueError("JSONL 归档不允许空行")
                        if path in {"memory/im/scopes.jsonl", "memory/im/deletion_markers.jsonl"}:
                            scoped = _MemoryScopeRecord.model_validate_json(line)
                            if path.endswith("deletion_markers.jsonl") and not scoped.deleted:
                                raise ValueError("记忆删除墓碑必须标记为已删除")
                        elif path.startswith("records/") or path in {
                            "memory/im/entries.jsonl", "memory/im/sources.jsonl",
                        }:
                            record = PortableEntityRecord.model_validate_json(line)
                            _validate_record_contract(record, entry.category)
                            identities = known_records.setdefault(record.source_type, set())
                            if record.portable_id in identities:
                                raise ValueError("同类别中 portable_id 重复")
                            identities.add(record.portable_id)
                            pending_relations.extend(
                                (relation.target_type, relation.target_portable_id, relation.relation_type)
                                for relation in record.relations
                            )
                        else:
                            raise ValueError("归档包含未知 JSONL 清单")
                        actual_records += 1
                        record_count += 1
                        if record_count > MAX_RECORDS:
                            raise ValueError("归档记录数量超过上限")
                        digest.update(line)
                        counted_size += len(line)
                    if entry.records != actual_records:
                        raise ValueError("JSONL 记录数与 manifest 不一致")
                elif path.startswith("records/") and path.endswith(".json"):
                    payload = _read_entry_limited(stream, MAX_RECORD_LINE_BYTES)
                    record = PortableEntityRecord.model_validate_json(payload)
                    _validate_record_contract(record, entry.category)
                    identities = known_records.setdefault(record.source_type, set())
                    if record.portable_id in identities:
                        raise ValueError("同类别中 portable_id 重复")
                    identities.add(record.portable_id)
                    pending_relations.extend(
                        (relation.target_type, relation.target_portable_id, relation.relation_type)
                        for relation in record.relations
                    )
                    actual_records = 1
                    record_count += 1
                    digest.update(payload)
                    counted_size += len(payload)
                    if entry.records != actual_records:
                        raise ValueError("JSON 记录数与 manifest 不一致")
                else:
                    while chunk := stream.read(_READ_CHUNK):
                        digest.update(chunk)
                        counted_size += len(chunk)
            if counted_size != entry.size or digest.hexdigest() != entry.sha256:
                raise ValueError("归档内容与 manifest 摘要不一致")
            if checksums[path] != digest.hexdigest():
                raise ValueError("归档文件 checksum 校验失败")

        all_ids: dict[str, set[str]] = {}
        for source_type, identifiers in known_records.items():
            all_ids.setdefault(source_type, set()).update(identifiers)
        for target_type, portable_id, _relation_type in pending_relations:
            if portable_id not in all_ids.get(target_type, set()):
                raise ValueError("归档包含未闭合的对象关系")

    return ArchiveValidationResult(
        manifest=manifest,
        record_count=record_count,
        expanded_bytes=expanded,
        archive_sha256=archive_digest.hexdigest(),
        categories={category: value.records for category, value in manifest.categories.items()},
    )


def _read_limited(archive: zipfile.ZipFile, path: str, limit: int) -> bytes:
    info = archive.getinfo(path)
    if info.file_size > limit:
        raise ValueError("归档控制文件超过大小上限")
    with archive.open(info, "r") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("归档控制文件超过大小上限")
    return data


def _read_entry_limited(stream, limit: int) -> bytes:
    data = stream.read(limit + 1)
    if len(data) > limit or stream.read(1):
        raise ValueError("JSON 控制记录超过大小上限")
    return data


def _validate_record_contract(record: PortableEntityRecord, category: str) -> None:
    """确认记录类型、schema 版本和 manifest 类别彼此一致。"""
    from app.services.data_portability.projection import RECORD_SPECS

    categories = {spec.record_type: spec.category for spec in RECORD_SPECS}
    categories.update({"account": "account", "preferences": "preferences"})
    if categories.get(record.source_type) != category:
        raise ValueError("可移植记录类型与类别不匹配")
    if record.record_schema != f"gugu.{record.source_type}.v1":
        raise ValueError("不支持的可移植记录 schema")


def _parse_checksums(content: bytes) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in content.decode("utf-8").splitlines():
        if len(line) < 67 or line[64:66] != "  ":
            raise ValueError("checksum 清单格式无效")
        digest, path = line[:64], line[66:]
        validate_archive_path(path)
        if any(char not in "0123456789abcdef" for char in digest) or len(digest) != 64:
            raise ValueError("checksum 摘要格式无效")
        if path in result:
            raise ValueError("checksum 清单包含重复路径")
        result[path] = digest
    return result


def _iter_bounded_lines(stream):
    pending = bytearray()
    while chunk := stream.read(_READ_CHUNK):
        pending.extend(chunk)
        while True:
            newline = pending.find(b"\n")
            if newline < 0:
                break
            if newline > MAX_RECORD_LINE_BYTES:
                raise ValueError("JSONL 单条记录超过大小上限")
            yield bytes(pending[:newline + 1])
            del pending[:newline + 1]
        if len(pending) > MAX_RECORD_LINE_BYTES:
            raise ValueError("JSONL 单条记录超过大小上限")
    if pending:
        raise ValueError("JSONL 最后一条记录缺少换行")
