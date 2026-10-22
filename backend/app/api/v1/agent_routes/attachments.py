"""Agent API attachments endpoints."""

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, File as FastAPIFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import chat_attach
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User

router = APIRouter()


@router.post("/upload")
async def upload_attachment(
    file: UploadFile = FastAPIFile(...),
    voice: bool = Form(False),   # 网页录音传 voice=true → 渲染成语音条 + 独立 30 天存储 + 「让我听听」语气
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """聊天附件上传：暂存（不进文件库），返回 attach_id。咕咕可看内容/可保存。"""
    from app.core import media_transcode
    from app.core.config import get_settings
    from app.core.upload_stream import spool_upload
    from agent import providers
    # 分块收流：内存峰值与附件上限解耦；只有转码/语音路径才 materialize 成字节。
    # 不再按单个附件拒绝；本次请求最多消费当前用户暂存总容量的剩余部分。
    # stage/stage_stream 还会在写入前复核，避免并发上传绕过总容量。
    staging_remaining = await chat_attach.staging_capacity_remaining(current_user.id)
    spool, size, _sha = await spool_upload(
        file, limit=staging_remaining, status_code=413,
        message="聊天附件暂存空间已满，请先清理旧附件后再试")
    parts = (file.filename or "file").rsplit(".", 1)
    name = parts[0] or "file"
    ext = parts[1] if len(parts) > 1 else ""
    # 语音录音：浏览器多录成 webm/opus（mimo 不收）→ 转成 mp3 再暂存，让 mimo 能听。
    # m4a(Safari)/ogg(Firefox) 是 mimo 原生格式、免转；缺 ffmpeg 则原样、退文字提示。
    # 只有确认「这是待转码/待探测的音频」才 materialize 成字节——扩展名和 mime
    # 都是用户可控输入，普通 PDF/压缩包/图片一律留在流上走 stage_stream。
    ext_l = (ext or "").lower()
    content_type_l = (file.content_type or "").lower()
    needs_audio_processing = bool(voice) or content_type_l.startswith("audio") or "voice" in content_type_l or (
        ext_l in ("webm", "opus", "silk", "sil", "slk", "amr", "aac", "wma"))
    # spool 生命周期统一在 finally：所有分支（含提前 return / 抛错）都保证关闭。
    try:
        # 音频候选的转码/时长探测都要整字节，单独给 materialize 上限（分钟级录音
        # 不可能超过它；mime 和扩展名都是用户可控输入，不能放任 500MB「音频」整读）。
        if needs_audio_processing and size > chat_attach.AUDIO_MATERIALIZE_CAP:
            if voice:
                raise HTTPException(
                    400, f"语音录音过大（上限 {chat_attach.AUDIO_MATERIALIZE_CAP // 1048576}MB），请分段录制后再发送")
            # 非 voice 的大音频不做进程内转码，按原样流式暂存（转码留给小文件）。
            mime = "audio/mpeg" if ext_l == "mp3" else file.content_type
            meta = await chat_attach.stage_stream(
                current_user.id, name, ext, mime, stream=spool, size=size, platform="web")
            return {k: meta.get(k) for k in ("attach_id", "name", "ext", "size", "kind", "duration", "img_width", "img_height", "qq_face")}
        data: bytes | None = None
        if needs_audio_processing and ext_l not in ("mp3", "wav", "flac", "m4a", "ogg"):
            spool.seek(0)
            data = spool.read()   # 已过 materialize 上限，转码需要整字节
            conv = media_transcode.to_provider_audio(data, ext, file.content_type,
                                                     providers.adapter_for(get_settings().ai))
            if conv is not None:
                data, ext = conv, "mp3"
        mime = "audio/mpeg" if ext == "mp3" else file.content_type
        if voice:
            if data is None:
                spool.seek(0)
                data = spool.read()
            dur = media_transcode.probe_duration(data, ext)
            meta = await chat_attach.stage_voice(current_user.id, name or "语音", ext, mime, data, duration=dur, platform="web")
        elif data is not None:
            meta = await chat_attach.stage(current_user.id, name, ext, mime, data, platform="web")
        else:
            meta = await chat_attach.stage_stream(
                current_user.id, name, ext, mime, stream=spool, size=size, platform="web")
        return {k: meta.get(k) for k in ("attach_id", "name", "ext", "size", "kind", "duration", "img_width", "img_height", "qq_face")}
    except chat_attach.ChatAttachmentCapacityError as error:
        raise HTTPException(413, str(error)) from error
    finally:
        spool.close()

@router.get("/attachment/{attach_id}/thumb")
async def attachment_thumb(
    attach_id: str,
    size: str = "card",
    current_user: User = Depends(get_current_user),
):
    """暂存聊天附件的图片缩略图（按 attach_id）。
    刷新后历史气泡里用户发的图本来只有 attach_id（无 file_id、本地 objectURL 已丢），
    借此仍能显示缩略图。仅暂存 6h 内有效，过期/非图片 → 404，前端回退到 ext 角标。"""
    import asyncio
    from fastapi.responses import Response

    meta = await chat_attach.get_meta(current_user.id, attach_id)
    if not meta or meta.get("kind") != "image":
        raise HTTPException(404, "附件不存在或不是图片")
    try:
        raw = await chat_attach.read_bytes(meta)
    except FileNotFoundError:
        raise HTTPException(404, "附件已过期或物理文件丢失")
    if (meta.get("ext") or "").lower() == "svg":
        return Response(content=raw, media_type="image/svg+xml",
                        headers={"Cache-Control": "private, max-age=3600"})
    # QQ 表情可能是 GIF/动画 WebP；原图端点保留动画帧，普通缩略图则统一转 JPEG。
    mime = (meta.get("mime") or "").lower()
    if size == "full" and (
        meta.get("qq_face")
        or (meta.get("ext") or "").lower() in {"gif", "webp"}
        or mime in {"image/gif", "image/webp"}
    ):
        return Response(content=raw, media_type=mime or f"image/{(meta.get('ext') or 'gif').lower()}",
                        headers={"Cache-Control": "private, max-age=3600"})
    # 复用文件库的缩略图生成（JPEG 兜底版，按 size 取最大边）
    from app.services.files.previews import generate_thumb_jpeg_fallback
    jpeg = await asyncio.to_thread(generate_thumb_jpeg_fallback, raw, size)
    if jpeg:
        return Response(content=jpeg, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=3600"})
    return Response(content=raw, media_type=meta.get("mime") or "application/octet-stream",
                    headers={"Cache-Control": "private, max-age=3600"})

@router.get("/attachment/{attach_id}/download")
async def attachment_download(
    attach_id: str,
    current_user: User = Depends(get_current_user),
):
    """下载暂存聊天附件原文件（用户自己发的附件，6h 内有效）。"""
    from fastapi.responses import StreamingResponse
    from urllib.parse import quote
    from app.services.storage import get_storage
    meta = await chat_attach.get_meta(current_user.id, attach_id)
    if not meta:
        raise HTTPException(404, "附件不存在或已过期")
    filename = f"{meta.get('name', 'file')}.{meta.get('ext', '')}"
    encoded = quote(filename)
    storage = get_storage()
    if not await storage.exists(meta["storage_key"]):
        raise HTTPException(404, "附件已过期或物理文件丢失")
    return StreamingResponse(
        storage.iter_chunks(meta["storage_key"]),
        media_type=meta.get("mime") or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}",
                 "Cache-Control": "private, max-age=300",
                 "Content-Length": str(meta.get("size") or 0)},
    )

@router.delete("/attachments", status_code=200)
async def clear_attachments(current_user: User = Depends(get_current_user)):
    """清除当前用户所有草稿态（未发送）聊天暂存附件（字节 + DB 行）。"""
    n = await chat_attach.clear_staged(current_user.id)
    return {"deleted": n}

@router.delete("/attachment/{attach_id}", status_code=200)
async def delete_draft_attachment(
    attach_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除单个草稿态（未发送）暂存附件——发送消息失败时前端调用，降低草稿孤儿
    产生速度（PRD-STORAGE-1 §2 FR-STORAGE-1-1 步骤 8）。

    **状态守卫是这个接口存在的意义**：只删 `state='draft'` 的附件，非 draft
    一律拒绝。HTTP 响应丢失/超时不等于请求真的失败——消息可能已经在服务端
    提交成功、附件已经被 claim 成 `attached`；没有这层守卫，客户端一次误判的
    "发送失败"会把已经生效的正常附件删掉。"""
    from app.models import ChatAttachment
    from sqlalchemy import delete as sa_delete, select
    row = (await db.execute(
        select(ChatAttachment).where(
            ChatAttachment.user_id == current_user.id,
            ChatAttachment.attach_id == attach_id,
        )
    )).scalars().first()
    if row is None:
        raise HTTPException(404, "附件不存在")
    storage_key = row.storage_key
    result = await db.execute(
        sa_delete(ChatAttachment).where(
            ChatAttachment.attach_id == attach_id,
            ChatAttachment.user_id == current_user.id,
            ChatAttachment.state == "draft",
        )
    )
    if result.rowcount != 1:
        await db.rollback()
        raise HTTPException(409, "附件已被使用，无法删除")
    await db.commit()
    await chat_attach.try_delete_storage_if_unreferenced(current_user.id, storage_key)
    return {"deleted": True}
