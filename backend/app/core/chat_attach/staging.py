"""附件暂存写入：把上传字节落到 StorageBackend，并登记一条 draft 状态的附件行。

暂存 ≠ 文件库——用户说「存」时，`save_uploaded_file` 工具才把暂存字节落成正式
文件库记录。这里只负责「先收下」。
"""
from __future__ import annotations

import uuid

from app.services import storage as storage_service

from . import records
from .constants import STAGING_TOTAL_BYTES, TTL, TTL_VOICE
from .file_types import kind_for_ext


class ChatAttachmentCapacityError(ValueError):
    """聊天暂存总容量不足。"""


async def staging_capacity_remaining(user_id) -> int:
    from sqlalchemy import func, select
    from app.models import ChatAttachment
    import app.db.session as db_session

    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        used = (await db.execute(
            select(func.coalesce(func.sum(ChatAttachment.size), 0)).where(
                ChatAttachment.user_id == user_id,
                ChatAttachment.state.in_(("draft", "attached")),
            )
        )).scalar_one()
    return max(STAGING_TOTAL_BYTES - int(used or 0), 0)


async def _ensure_staging_capacity(user_id, incoming_size: int) -> None:
    if int(incoming_size) > await staging_capacity_remaining(user_id):
        raise ChatAttachmentCapacityError("聊天附件暂存空间已满，请先清理旧附件后再试")


def _current_platform(explicit: str | None) -> str | None:
    """暂存项打上「来自哪个渠道」标签：网关（qq/feishu/wechat）在收到消息、队列还没派发给
    worker 前就调用 stage，此时 imctx 还没 set，必须显式传 platform；其余在 agent 工具/请求
    处理过程中调用的（如生图/网络图暂存），走 imctx 自动识别当前所在的 IM 对话（web 路径不
    set imctx，识别不到即 None，等同网页上传）。用途：resolve_attach 按渠道收窄候选，避免
    「同一用户在别的渠道/网页留下的旧附件」被这边的模糊匹配误取（见 resolve_attach 文档字符串）。"""
    if explicit:
        return explicit
    try:
        from agent.im import imctx
        ctx = imctx.get_im()
        return ctx.get("platform") if ctx else None
    except Exception:
        return None


def _probe_image_size(data, ext: str) -> tuple[int | None, int | None]:
    """探真实像素尺寸（与 files.py 上传时同一套逻辑）：SVG 是矢量、Pillow 读不出「像素」尺寸，跳过；
    失败也别报错——没探到就是 None，前端退回旧的占位图估算兜底。
    data 可以是字节，也可以是可 seek 的文件对象（Pillow 只读 header，探尺寸不整包进内存）。"""
    if (ext or "").lower() == "svg":
        return None, None
    try:
        from PIL import Image
        import io as _io
        if isinstance(data, (bytes, bytearray)):
            source = _io.BytesIO(data)
        else:
            source = data
            source.seek(0)
        img = Image.open(source)
        w, h = img.size
        img.close()
        return w, h
    except Exception:
        return None, None


async def stage(user_id, name: str, ext: str, mime: str | None, data: bytes,
                *, kind: str | None = None, ttl: int = TTL,
                subdir: str = ".chat_staging", extra: dict | None = None,
                platform: str | None = None,
                platform_message_id: str | None = None,
                attachment_index: int | None = None) -> dict:
    """暂存一个上传文件，返回元数据（含 attach_id）。
    语音条走 kind='voice' / subdir='.voice'（见 stage_voice）。
    图片顺带探真实像素尺寸（img_width/img_height）：前端预览窗口据此直接定尺，不用再靠缩略图猜。
    `platform`：附件来自哪个渠道（qq/feishu/wechat/web），不传则按 imctx 自动识别，见 _current_platform。
    `ttl` 参数保留只为兼容旧调用签名（`stage_voice` 等仍会传），**不再控制任何行为**——
    草稿的存活期统一由 `DRAFT_TTL` 常量 + 草稿 GC 任务管理，不区分 `.chat_staging`/`.voice`；
    这里不再写 Redis 元数据（DB 是所有权真相来源，见包级说明）。"""
    await _ensure_staging_capacity(user_id, len(data))
    attach_id = uuid.uuid4().hex[:16]
    ext_l = (ext or "").lower()[:10]
    storage_key = f"{user_id}/{subdir}/{attach_id}.{ext_l or 'bin'}"
    await storage_service.get_storage().put(storage_key, data, mime or "application/octet-stream")
    meta = {
        "attach_id": attach_id, "name": name, "ext": ext_l, "mime": mime or "",
        "size": len(data), "storage_key": storage_key, "kind": kind or kind_for_ext(ext_l),
        "platform": _current_platform(platform),
        "platform_message_id": platform_message_id,
        "attachment_index": attachment_index,
    }
    if meta["kind"] == "image":
        img_w, img_h = _probe_image_size(data, ext_l)
        meta["img_width"], meta["img_height"] = img_w, img_h
    if extra:
        meta.update(extra)
    try:
        await records.record_draft(user_id, attach_id, storage_key, meta)
    except Exception:
        try:
            await storage_service.get_storage().delete(storage_key)
        except Exception:
            pass
        raise
    return meta


async def stage_stream(user_id, name: str, ext: str, mime: str | None, *,
                       stream, size: int, kind: str | None = None,
                       subdir: str = ".chat_staging", extra: dict | None = None,
                       platform: str | None = None,
                       platform_message_id: str | None = None,
                       attachment_index: int | None = None) -> dict:
    """分块版 stage：网页大附件直进暂存，内存峰值与文件大小解耦。

    stream 须可 seek(0)，由调用方负责 close。图片仍会把内容读进内存探真实
    尺寸（图片实际都很小）；语音转码等需要整字节的路由继续走 stage(data)。
    """
    await _ensure_staging_capacity(user_id, size)
    attach_id = uuid.uuid4().hex[:16]
    ext_l = (ext or "").lower()[:10]
    storage_key = f"{user_id}/{subdir}/{attach_id}.{ext_l or 'bin'}"
    await storage_service.get_storage().put_stream(storage_key, stream, size, mime or "application/octet-stream")
    meta = {
        "attach_id": attach_id, "name": name, "ext": ext_l, "mime": mime or "",
        "size": size, "storage_key": storage_key, "kind": kind or kind_for_ext(ext_l),
        "platform": _current_platform(platform),
        "platform_message_id": platform_message_id,
        "attachment_index": attachment_index,
    }
    if meta["kind"] == "image":
        img_w, img_h = _probe_image_size(stream, ext_l)
        meta["img_width"], meta["img_height"] = img_w, img_h
    if extra:
        meta.update(extra)
    try:
        await records.record_draft(user_id, attach_id, storage_key, meta)
    except Exception:
        try:
            await storage_service.get_storage().delete(storage_key)
        except Exception:
            pass
        raise
    return meta


async def stage_voice(user_id, name: str, ext: str, mime: str | None, data: bytes,
                      duration: float | None = None, platform: str | None = None,
                      platform_message_id: str | None = None,
                      attachment_index: int | None = None) -> dict:
    """语音消息（IM 语音 / 网页录音）：独立 .voice/ 存储 + 30 天留存 + kind='voice' + 时长。"""
    return await stage(user_id, name, ext, mime, data, kind="voice", ttl=TTL_VOICE,
                       subdir=".voice", extra={"duration": duration} if duration is not None else None,
                       platform=platform, platform_message_id=platform_message_id,
                       attachment_index=attachment_index)


def stage_voice_sync(user_id, name: str, ext: str, mime: str | None, data: bytes,
                     duration: float | None = None, platform: str | None = None) -> dict:
    return stage_sync(user_id, name, ext, mime, data, kind="voice", ttl=TTL_VOICE,
                      subdir=".voice", extra={"duration": duration} if duration is not None else None,
                      platform=platform)


def stage_sync(user_id, name: str, ext: str, mime: str | None, data: bytes,
               *, kind: str | None = None, ttl: int = TTL,
               subdir: str = ".chat_staging", extra: dict | None = None,
               platform: str | None = None,
               platform_message_id: str | None = None,
               attachment_index: int | None = None) -> dict:
    """同步暂存（给 IM 网关用）。

    网关 handler 跑在一个**已运行的 asyncio loop** 里（lark SDK），所以不能在当前线程
    new_event_loop().run_until_complete。改为把 storage.put + DB insert 一起丢到
    **独立线程**用 asyncio.run 跑（新线程无运行中的 loop，storage 后端不绑定 loop）。

    DB 插入用 `record_draft_isolated()`（独立引擎，不复用主进程共享连接池）——
    asyncpg 连接绑定创建它的事件循环，这里每次调用都是一次性新开的 loop，不能像
    `async with db_session._SessionLocal()` 那样直接复用全局共享的连接池，否则会
    在跨循环复用连接时报错；不再写 Redis 元数据（DB 是所有权真相来源）。
    `platform`：附件来自哪个渠道，网关调用时必须显式传（此时 imctx 还没 set，见 _current_platform）。
    """
    import asyncio
    import concurrent.futures
    import uuid as _uuid
    attach_id = _uuid.uuid4().hex[:16]
    ext_l = (ext or "").lower()[:10]
    storage_key = f"{user_id}/{subdir}/{attach_id}.{ext_l or 'bin'}"

    meta = {
        "attach_id": attach_id, "name": name, "ext": ext_l, "mime": mime or "",
        "size": len(data), "storage_key": storage_key, "kind": kind or kind_for_ext(ext_l),
        "platform": _current_platform(platform),
        "platform_message_id": platform_message_id,
        "attachment_index": attachment_index,
    }
    if meta["kind"] == "image":
        img_w, img_h = _probe_image_size(data, ext_l)
        meta["img_width"], meta["img_height"] = img_w, img_h
    if extra:
        meta.update(extra)

    async def _put_and_record():
        await storage_service.get_storage().put(storage_key, data, mime or "application/octet-stream")
        try:
            await records.record_draft_isolated(user_id, attach_id, storage_key, meta)
        except Exception:
            try:
                await storage_service.get_storage().delete(storage_key)
            except Exception:
                pass
            raise

    def _run():
        asyncio.run(_put_and_record())

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        ex.submit(_run).result()

    return meta
