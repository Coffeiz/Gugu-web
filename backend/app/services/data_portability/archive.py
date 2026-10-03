"""数据库无关归档的流式 ZIP 与 checksum 构造。"""
from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import AsyncIterator, Awaitable, Callable, BinaryIO
from uuid import UUID

from app.services.data_portability.crypto_stream import EncryptedArchiveWriter
from app.services.data_portability.schema import (
    FORMAT_VERSION, PORTABLE_CATEGORIES, PortableArchiveEntry,
    PortableArchiveManifest, PortableCategory, validate_archive_path,
)


@dataclass(frozen=True)
class ArchiveProducer:
    path: str = ""
    category: str = ""
    write: Callable[[BinaryIO], Awaitable[int | None]] | None = None
    compression: int = zipfile.ZIP_DEFLATED
    expand: Callable[[], AsyncIterator["ArchiveProducer"]] | None = None


class _HashingWriter:
    def __init__(self, target: BinaryIO):
        self.target = target
        self.digest = hashlib.sha256()
        self.size = 0

    def write(self, data: bytes) -> int:
        count = self.target.write(data)
        self.digest.update(data[:count])
        self.size += count
        return count

    def flush(self) -> None:
        self.target.flush()


async def build_encrypted_archive(
    destination: BinaryIO,
    *,
    context: str,
    origin_id: UUID,
    export_id: UUID,
    producers: list[ArchiveProducer],
    complete: bool,
    included_categories: set[str] | None = None,
    created_at: datetime | None = None,
) -> tuple[int, str, PortableArchiveManifest]:
    """以条目为单位写出 ZIP，再对完整包做分块加密；不会缓冲完整归档。"""
    if created_at is None:
        created_at = datetime.now(timezone.utc)
    if created_at.tzinfo is None or created_at.utcoffset() is None:
        raise ValueError("归档创建时间必须包含时区")
    seen_paths: set[str] = set()
    if included_categories is None:
        included_categories = {item.category for item in producers if item.category}
    if not included_categories.issubset(PORTABLE_CATEGORIES):
        raise ValueError("未知归档类别")
    for producer in producers:
        if producer.expand is not None:
            if producer.path or producer.write is not None:
                raise ValueError("动态归档生产器不能同时声明固定条目")
            if producer.category and producer.category not in PORTABLE_CATEGORIES:
                raise ValueError("动态归档生产器类别未知")
            continue
        validate_archive_path(producer.path)
        if producer.path in {"manifest.json", "README.txt", "checksums.sha256"}:
            raise ValueError("归档条目路径保留")
        if producer.category not in PORTABLE_CATEGORIES:
            raise ValueError("未知归档类别")
    envelope = EncryptedArchiveWriter(destination, context)
    hashes: list[tuple[str, str]] = []
    entries: list[PortableArchiveEntry] = []
    counts = {category: 0 for category in PORTABLE_CATEGORIES}
    sizes = {category: 0 for category in PORTABLE_CATEGORIES}
    async def expanded_producers():
        for item in producers:
            if item.expand is None:
                yield item
            else:
                async for nested in item.expand():
                    yield nested

    try:
        with zipfile.ZipFile(envelope, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            async for producer in expanded_producers():
                validate_archive_path(producer.path)
                if producer.path in seen_paths or producer.path in {"manifest.json", "README.txt", "checksums.sha256"}:
                    raise ValueError("归档条目路径重复或保留")
                if producer.category not in PORTABLE_CATEGORIES or producer.category not in included_categories:
                    raise ValueError("动态归档条目类别未包含")
                seen_paths.add(producer.path)
                if producer.write is None:
                    raise ValueError("归档条目缺少写入器")
                entry_info = zipfile.ZipInfo(producer.path)
                entry_info.compress_type = producer.compression
                raw = archive.open(entry_info, "w", force_zip64=True)
                hashing = _HashingWriter(raw)
                try:
                    records = await producer.write(hashing)
                finally:
                    hashing.flush()
                    raw.close()
                entries.append(PortableArchiveEntry(
                    path=producer.path,
                    category=producer.category,
                    size=hashing.size,
                    sha256=hashing.digest.hexdigest(),
                    records=records,
                ))
                hashes.append((producer.path, hashing.digest.hexdigest()))
                counts[producer.category] += records or 0
                sizes[producer.category] += hashing.size

            readme = (
                "Gugu 用户数据归档\n"
                f"格式版本：{FORMAT_VERSION}\n"
                "记录为数据库无关的 JSON/JSONL，二进制附件位于 assets/。\n"
                "此归档仅含 manifest 声明的数据类别；连接凭据、认证信息和服务器运行状态不会迁移。\n"
                "请使用支持该格式版本的 Gugu 导入器先校验 checksum，再导入。\n"
            ).encode("utf-8")
            archive.writestr("README.txt", readme)
            readme_digest = hashlib.sha256(readme).hexdigest()
            entries.append(PortableArchiveEntry(
                path="README.txt", category="archive_docs", size=len(readme),
                sha256=readme_digest, records=0,
            ))
            hashes.append(("README.txt", readme_digest))
            sizes["archive_docs"] += len(readme)

            manifest = PortableArchiveManifest(
                format_version=FORMAT_VERSION,
                origin_id=origin_id,
                export_id=export_id,
                created_at=created_at,
                complete=complete,
                categories={
                    name: PortableCategory(
                        included=(name == "archive_docs" or name in included_categories),
                        records=counts[name], bytes=sizes[name],
                    )
                    for name in PORTABLE_CATEGORIES
                },
                entries=entries,
            )
            manifest_bytes = (json.dumps(
                manifest.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ) + "\n").encode("utf-8")
            archive.writestr("manifest.json", manifest_bytes)

            checksum_data = "".join(f"{digest}  {path}\n" for path, digest in sorted(hashes)).encode("utf-8")
            archive.writestr("checksums.sha256", checksum_data)
        envelope.finish()
    except BaseException:
        # 目的流由调用方管理；失败时不写出 footer，容器读取器会拒绝该归档。
        raise

    destination.seek(0, 2)
    encrypted_size = destination.tell()
    destination.seek(0)
    encrypted_digest = hashlib.sha256()
    while chunk := destination.read(1024 * 1024):
        encrypted_digest.update(chunk)
    destination.seek(0)
    return encrypted_size, encrypted_digest.hexdigest(), manifest
