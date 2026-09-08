"""邮件附件解析：只允许用户拥有的文件或本轮生成的聊天附件。"""
from __future__ import annotations

from dataclasses import dataclass
from mimetypes import guess_type
from pathlib import PurePath
import re

from sqlalchemy import select

from app.models import File
from app.services.storage import get_storage


MAX_ATTACHMENT_COUNT = 5
MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024
MAX_TOTAL_ATTACHMENT_SIZE = 25 * 1024 * 1024


class EmailAttachmentError(ValueError):
    """附件不满足邮件发送边界或已经不可用。"""


@dataclass(frozen=True)
class EmailAttachment:
    filename: str
    content: bytes
    mime_type: str
    file_id: int | None = None


def normalize_file_ids(value) -> list[int]:
    """校验并去重 file_ids，不接受路径或任意宿主机文件名。"""
    if value is None:
        return []
    if not isinstance(value, list):
        raise EmailAttachmentError("file_ids 必须是文件库 file_id 数组")
    if len(value) > MAX_ATTACHMENT_COUNT:
        raise EmailAttachmentError(f"附件最多 {MAX_ATTACHMENT_COUNT} 个")
    result: list[int] = []
    for raw in value:
        if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
            raise EmailAttachmentError("file_ids 只能包含正整数 file_id")
        if raw not in result:
            result.append(raw)
    return result


def _filename(display_name: str, ext: str, fallback: str) -> str:
    name = PurePath(str(display_name or "")).name
    name = re.sub(r"[\x00-\x1f\x7f\r\n]+", "_", name).strip(" .")
    extension = re.sub(r"[^A-Za-z0-9.+_-]", "", str(ext or "").strip().lstrip("."))
    if not name:
        name = fallback
    if extension and not name.lower().endswith(f".{extension.lower()}"):
        name = f"{name}.{extension}"
    return name[:200]


def _mime_type(mime_type: str | None, filename: str) -> str:
    candidate = str(mime_type or "").strip().lower()
    if re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", candidate):
        return candidate
    return guess_type(filename)[0] or "application/octet-stream"


def _check_size(total: int, size: int) -> None:
    if size > MAX_ATTACHMENT_SIZE:
        raise EmailAttachmentError(f"附件单个不能超过 {MAX_ATTACHMENT_SIZE // 1024 // 1024}MB")
    if total + size > MAX_TOTAL_ATTACHMENT_SIZE:
        raise EmailAttachmentError(f"附件总大小不能超过 {MAX_TOTAL_ATTACHMENT_SIZE // 1024 // 1024}MB")


async def resolve_email_attachments(db, user_id, *, file_ids=None, artifacts=None) -> tuple[EmailAttachment, ...]:
    """读取归属明确的文件，供交互式和定时邮件共用。

    ``artifacts`` 只接受 send_file 生成的 ``file_id``/``attach_id``，不接受
    任意路径；这样定时任务可以把本轮刚生成的文件一并投递到邮箱。
    """
    requested_ids = normalize_file_ids(file_ids)
    artifact_list = [item for item in (artifacts or []) if isinstance(item, dict)]
    artifact_file_ids = normalize_file_ids([
        item["file_id"] for item in artifact_list
        if item.get("file_id") is not None
    ])
    all_file_ids = list(dict.fromkeys([*requested_ids, *artifact_file_ids]))
    if len(all_file_ids) > MAX_ATTACHMENT_COUNT:
        raise EmailAttachmentError(f"附件最多 {MAX_ATTACHMENT_COUNT} 个")

    attach_ids = list(dict.fromkeys(
        str(item["attach_id"]).strip() for item in artifact_list
        if item.get("attach_id") and not item.get("file_id")
    ))
    if not all_file_ids and not attach_ids:
        return ()

    storage = get_storage()
    result: list[EmailAttachment] = []
    if all_file_ids:
        rows = (await db.execute(select(File).where(
            File.user_id == user_id,
            File.id.in_(all_file_ids),
            File.deleted_at.is_(None),
        ))).scalars().all()
        by_id = {row.id: row for row in rows}
        missing = [file_id for file_id in all_file_ids if file_id not in by_id]
        if missing:
            raise EmailAttachmentError("附件不存在、已删除或不属于当前用户")
        total = 0
        for file_id in all_file_ids:
            row = by_id[file_id]
            declared_size = int(row.size_bytes or 0)
            _check_size(total, declared_size)
            total += declared_size
            try:
                content = await storage.get(row.storage_key)
            except Exception as exc:
                raise EmailAttachmentError("附件内容读取失败，文件可能已丢失") from exc
            total -= declared_size
            _check_size(total, len(content))
            filename = _filename(row.display_name, row.ext, f"attachment-{row.id}")
            result.append(EmailAttachment(
                filename=filename,
                content=content,
                mime_type=_mime_type(row.mime_type, filename),
                file_id=row.id,
            ))
            total += len(content)

    if attach_ids:
        if len(result) + len(attach_ids) > MAX_ATTACHMENT_COUNT:
            raise EmailAttachmentError(f"附件最多 {MAX_ATTACHMENT_COUNT} 个")
        from app.core import chat_attach

        total = sum(len(item.content) for item in result)
        metas = await chat_attach.get_meta_many(user_id, attach_ids)
        for attach_id in attach_ids:
            meta = metas.get(attach_id)
            if not meta or not meta.get("storage_key"):
                raise EmailAttachmentError("本轮生成的附件已过期，无法添加到邮件")
            declared_size = int(meta.get("size") or 0)
            _check_size(total, declared_size)
            try:
                content = await storage.get(meta["storage_key"])
            except Exception as exc:
                raise EmailAttachmentError("本轮生成的附件内容读取失败") from exc
            total -= declared_size
            _check_size(total, len(content))
            filename = _filename(meta.get("name"), meta.get("ext"), f"attachment-{attach_id[:12]}")
            result.append(EmailAttachment(
                filename=filename,
                content=content,
                mime_type=_mime_type(meta.get("mime"), filename),
            ))
            total += len(content)
    return tuple(result)


async def validate_email_attachment_file_ids(db, user_id, value) -> list[int]:
    """校验定时任务配置的文件归属和当前可发送状态。"""
    ids = normalize_file_ids(value)
    if not ids:
        return []
    rows = (await db.execute(select(File.id).where(
        File.user_id == user_id,
        File.id.in_(ids),
        File.deleted_at.is_(None),
    ))).scalars().all()
    if len(rows) != len(ids):
        raise EmailAttachmentError("定时任务附件不存在、已删除或不属于当前用户")
    return ids
