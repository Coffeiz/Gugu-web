"""IM 附件回复。

附件的元数据解析、暂存归属和平台大小限制放在这里；"这个平台该调哪个 Gateway
函数发送"这一步统一收在 ``agent.im.replies.send_file``，跟文本/流式共用同一个
分发入口，不在这里再维护一份 if/elif。
"""
from __future__ import annotations

from dataclasses import dataclass

from agent.im.models import PlatformReply
from agent.im.replies import send_file


@dataclass
class FileSendResult:
    requested: int = 0
    sent: int = 0
    failed: int = 0
    reason: str = ""

    @property
    def all_sent(self) -> bool:
        return self.requested > 0 and self.sent == self.requested


# 入站附件暂存门面：IM 入站处理负责下载、解密和转码，这里统一处理 attach_id 生命周期。
async def stage(
    owner,
    name: str,
    ext: str,
    mime: str | None,
    data: bytes,
    *,
    platform: str,
    kind: str | None = None,
) -> dict:
    from app.core import chat_attach

    kwargs = {"platform": platform}
    if kind is not None:
        kwargs["kind"] = kind
    return await chat_attach.stage(owner, name, ext, mime, data, **kwargs)


async def stage_voice(
    owner,
    name: str,
    ext: str,
    mime: str | None,
    data: bytes,
    *,
    duration: float | None,
    platform: str,
) -> dict:
    from app.core import chat_attach

    return await chat_attach.stage_voice(
        owner, name, ext, mime, data, duration=duration, platform=platform
    )


def stage_sync(owner, name: str, ext: str, mime: str | None, data: bytes, *, platform: str) -> dict:
    from app.core import chat_attach

    return chat_attach.stage_sync(owner, name, ext, mime, data, platform=platform)


def stage_voice_sync(
    owner,
    name: str,
    ext: str,
    mime: str | None,
    data: bytes,
    *,
    duration: float | None,
    platform: str,
) -> dict:
    from app.core import chat_attach

    return chat_attach.stage_voice_sync(
        owner, name, ext, mime, data, duration=duration, platform=platform
    )


async def send_files(payload: dict, files: list) -> FileSendResult:
    """校验 artifact 归属后统一发送 file_id/attach_id 文件并返回结果。"""
    result = FileSendResult(requested=len(files))
    if not files:
        return result
    platform = payload.get("platform")
    if platform not in ("feishu", "qq", "wechat"):
        print(f"[im] {platform} 暂不支持发文件（{len(files)} 个）", flush=True)
        result.failed = len(files)
        result.reason = "这个平台暂时不能接收文件。"
        return result
    file_reply = PlatformReply.from_parts(payload, [{"type": "file"}])
    if file_reply.unsupported_capabilities(platform):
        result.failed = len(files)
        result.reason = "这个平台暂时不能接收文件，我放到文件库里了，你从网页打开吧～"
        return result

    from uuid import UUID

    from sqlalchemy import select

    import app.db.session as db_session
    from app.core import chat_attach
    from app.core.ownership import get_owned
    from app.models import File

    owner = payload.get("owner_user_id")
    try:
        owner_id = owner if isinstance(owner, UUID) else UUID(str(owner))
    except (TypeError, ValueError, AttributeError):
        owner_id = None
    file_ids = set()
    for item in files:
        if not isinstance(item, dict):
            continue
        raw_file_id = item.get("file_id")
        if isinstance(raw_file_id, bool) or not isinstance(raw_file_id, (int, str)):
            continue
        if isinstance(raw_file_id, str) and not raw_file_id.isdecimal():
            continue
        try:
            normalized_id = int(raw_file_id)
        except (TypeError, ValueError):
            continue
        if normalized_id > 0:
            file_ids.add(normalized_id)

    file_records = {}
    if file_ids and owner_id:
        db_session.ensure_engine()
        async with db_session._SessionLocal() as db:
            # 属主过滤的批量预载保留常规多附件性能；get_owned 复用 identity map，
            # 同时为缺失/越权 ID 执行统一归属检查，越权时仍能记安全事件。
            (await db.scalars(
                select(File).where(File.id.in_(file_ids), File.user_id == owner_id)
            )).all()
            for file_id in file_ids:
                record = await get_owned(db, File, file_id, owner)
                if record is not None and record.deleted_at is None:
                    file_records[file_id] = record

    attach_ids = [
        item.get("attach_id") for item in files
        if isinstance(item, dict) and item.get("attach_id")
    ]
    attach_meta = await chat_attach.get_meta_many(owner, attach_ids) if owner else {}

    for file_item in files:
        if not isinstance(file_item, dict):
            result.failed += 1
            continue
        file_id = file_item.get("file_id")
        attach_id = file_item.get("attach_id")
        try:
            if file_id:
                try:
                    record = file_records.get(int(file_id))
                except (TypeError, ValueError):
                    record = None
                if not record:
                    result.failed += 1
                    continue
                display_name, ext, storage_key = (
                    record.display_name, record.ext, record.storage_key
                )
            elif attach_id:
                meta = attach_meta.get(str(attach_id))
                if not meta:
                    result.failed += 1
                    continue
                display_name = file_item.get("name") or meta.get("name") or "图片"
                ext, storage_key = meta.get("ext", ""), meta["storage_key"]
            else:
                result.failed += 1
                continue

            fname = f"{display_name}.{ext}"
            ok = await send_file(
                payload, storage_key=storage_key, ext=ext, display_name=display_name, fname=fname,
            )
            if ok:
                result.sent += 1
            else:
                result.failed += 1
        except Exception as exc:
            result.failed += 1
            result.reason = "附件发送失败，你可以去网页或文件库查看。"
            print(f"[im] 发文件出错: {type(exc).__name__}", flush=True)
    if result.failed and not result.reason:
        result.reason = "附件没有成功发出，你可以去网页或文件库查看。"
    return result
