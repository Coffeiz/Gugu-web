"""文件操作的跨资源编排。

单文件的领域写入仍由 Storage FileService 负责；这里承载需要协调回收站、
数据库会话和批量输入的文件库动作，避免路由重复拼装同一套删除流程。
"""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.chat_attach import TEXT_EXTS
from app.core.ownership import get_owned
from app.core.security import create_stream_token
from app.models import File
from app.services.files.selection import move_file_to_trash_by_id, move_files_to_trash
from app.services.storage import LocalStorageBackend, OSSStorageBackend
from app.services.storage.file_service.files import _fmt_size


@dataclass(frozen=True)
class FileDownload:
    file: File
    content: bytes


@dataclass(frozen=True)
class FileStream:
    file: File
    path: Path


class FileContentError(ValueError):
    """文本正文更新的可预期业务错误。"""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FileStreamError(ValueError):
    """本地 stream 解析的可预期业务错误。"""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def read_file_download(db: AsyncSession, storage, user_id: int, file_id: int) -> FileDownload | None:
    """读取当前用户文件及其内容；路由层负责把缺失映射为 HTTP 404。"""
    file = await get_owned(db, File, file_id, user_id)
    if file is None:
        return None
    return FileDownload(file=file, content=await storage.get(file.storage_key))


async def resolve_local_file_stream(
    db: AsyncSession,
    storage,
    user_id: int,
    file_id: int,
) -> FileStream | None:
    """解析当前用户本地文件的可下载路径；OSS 文件不走本地 stream。"""
    if not isinstance(storage, LocalStorageBackend):
        raise FileStreamError(400, "OSS 后端请使用 stream-url 返回的 presigned URL")
    file = await get_owned(db, File, file_id, user_id)
    if file is None:
        return None
    path = storage.root / file.storage_key
    if not path.exists():
        raise FileStreamError(404, "文件不存在于存储")
    return FileStream(file=file, path=path)


async def update_file_content(
    db: AsyncSession,
    storage,
    user_id: int,
    file_id: int,
    content: str,
) -> File | None:
    """更新当前用户文本文件正文；路由层负责提交事务和响应组装。"""
    file = await get_owned(db, File, file_id, user_id)
    if file is None:
        return None
    if (file.ext or "").lower() not in TEXT_EXTS:
        raise FileContentError(400, "仅文本类文件可改内容")

    data = content.encode("utf-8")
    if len(data) > 1024 * 1024:
        raise FileContentError(400, "内容过大（上限 1MB）")

    await storage.put(file.storage_key, data, file.mime_type or "text/markdown")
    file.size_bytes = len(data)
    file.size = _fmt_size(len(data))
    return file


async def build_stream_url(storage, *, storage_key: str, file_id: int, user_id: int) -> str:
    """为已归属校验的文件生成 OSS 签名地址或本地 stream 地址。"""
    if isinstance(storage, OSSStorageBackend):
        return await asyncio.to_thread(
            storage.bucket.sign_url, "GET", storage.pfx + storage_key, 600
        )
    token = create_stream_token(file_id, user_id, expires_minutes=10)
    return f"/api/v1/files/{file_id}/stream?token={token}"


async def delete_file(
    db: AsyncSession,
    storage,
    user_id: int,
    file_id: int,
    deleted_at: datetime,
) -> bool:
    """将一个当前用户的存活文件移入回收站。"""
    return await move_file_to_trash_by_id(db, storage, user_id, file_id, deleted_at)


async def delete_files(
    db: AsyncSession,
    storage,
    user_id: int,
    file_ids: list[int],
    deleted_at: datetime,
) -> list[int]:
    """将一批当前用户的存活文件移入回收站，返回实际处理的 ID。"""
    return await move_files_to_trash(db, storage, user_id, file_ids, deleted_at)
