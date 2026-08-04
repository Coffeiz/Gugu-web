"""IM 入站媒体处理。

Gateway 只传平台原始附件；下载、转码和暂存由 worker 侧统一完成，
并通过原始 message_id 保持附件与消息的稳定关联。
"""
from __future__ import annotations

from urllib.parse import urljoin

import aiohttp

from app.core.redaction import diag_log, redact
from app.core.url_security import url_is_safe


async def ingest_qq_media(
    attachments: list,
    owner: str,
    message_id: str = "",
    emoji_refs: list[dict] | None = None,
) -> list:
    """下载 QQ 附件和可解析的系统表情，并返回当前消息的 attach_id 列表。"""
    raw = [item for item in attachments if isinstance(item, dict)]
    cached_attach_ids: list[str] = []
    if emoji_refs and not raw:
        from agent.im.emoji.qface import resolve_qq_system_face
        from app.core import chat_attach

        for ref in emoji_refs:
            if not isinstance(ref, dict):
                continue
            face_type = str(ref.get("face_type") or "")
            face_id = str(ref.get("face_id") or "")
            cached = await chat_attach.get_qq_face_cached(owner, face_type, face_id)
            if cached:
                cached_attach_ids.append(cached["attach_id"])
                continue
            asset = await resolve_qq_system_face(face_type, face_id)
            if asset:
                raw.append({
                    "url": asset.url,
                    "filename": asset.filename,
                    "content_type": asset.mime,
                    "qq_face": True,
                    "qq_face_type": str(ref.get("face_type") or ""),
                    "qq_face_id": str(ref.get("face_id") or ""),
                })
    if (not raw and not cached_attach_ids) or not owner:
        return []

    from agent.im import files as im_attachments

    out: list[str] = list(cached_attach_ids)
    async with aiohttp.ClientSession() as sess:
        for item in raw:
            url = item.get("url")
            if not url:
                continue
            if not url.startswith("http"):
                url = "https://" + url.lstrip("/")
            filename = item.get("filename") or item.get("file_name") or "file"
            name, _, ext = filename.rpartition(".")
            name = name or filename
            mime = item.get("content_type") or item.get("type")
            is_qq_face = bool(item.get("qq_face"))
            if is_qq_face:
                # 部分 QQ 表情附件的 filename 只有 ``file``，没有扩展名；
                # 仅靠扩展名会被暂存为 binary，聊天缩略图接口也就无法渲染。
                mime_ext = str(mime or "").split("/", 1)[-1].split(";", 1)[0]
                ext = ext or (mime_ext if mime_ext in {"jpeg", "jpg", "png", "gif", "webp"} else "png")
                name = "QQ表情"
            try:
                data = b""
                for _ in range(4):
                    reason = url_is_safe(url)
                    if reason:
                        diag_log("agent.im.media_ingress.unsafe_url", ValueError(reason))
                        break
                    async with sess.get(
                        url,
                        allow_redirects=False,
                        timeout=aiohttp.ClientTimeout(total=60),
                    ) as resp:
                        if resp.status in {301, 302, 303, 307, 308}:
                            location = resp.headers.get("Location")
                            if not location:
                                break
                            url = urljoin(url, location)
                            continue
                        if resp.status != 200:
                            break
                        data = await resp.read()
                        break
                else:
                    data = b""
                if not data:
                    continue

                from app.core import media_transcode

                is_voice = False
                if ext not in ("mp3", "wav", "flac", "m4a", "ogg"):
                    converted = media_transcode.to_mimo_mp3(data, ext, mime)
                    if converted is not None:
                        data, ext, mime, name = converted, "mp3", "audio/mpeg", (name or "语音")
                        is_voice = True

                extra = {}
                if message_id:
                    extra["source_message_id"] = message_id
                # QQ 表情的协议文本与图片是两条消息，标记必须跟随图片
                # 一起写入暂存元数据，后续前端才能按图片卡片展示而不显示随机文件名。
                if is_qq_face:
                    extra["qq_face"] = True
                    if item.get("qq_face_type"):
                        extra["qq_face_type"] = item["qq_face_type"]
                    if item.get("qq_face_id"):
                        extra["qq_face_id"] = item["qq_face_id"]
                if item.get("quoted"):
                    extra["quoted"] = True
                if is_voice:
                    duration = media_transcode.probe_duration(data, ext)
                    meta = await im_attachments.stage_voice(
                        owner, name, ext, mime, data, duration=duration, platform="qq"
                    )
                else:
                    from app.core import chat_attach

                    stage_kwargs = {"platform": "qq", "extra": extra or None}
                    if is_qq_face:
                        stage_kwargs["kind"] = "image"
                    meta = await chat_attach.stage(owner, name, ext, mime, data, **stage_kwargs)
                out.append(meta["attach_id"])
                if is_qq_face and item.get("qq_face_type") and item.get("qq_face_id"):
                    from app.core import chat_attach
                    await chat_attach.set_qq_face_cached(
                        owner,
                        str(item["qq_face_type"]),
                        str(item["qq_face_id"]),
                        meta["attach_id"],
                    )
            except Exception as exc:
                diag_log("agent.im.media_ingress.ingest_qq_media", exc)
                print(
                    f"[qq] 暂存附件出错: {redact(f'{type(exc).__name__}: {exc}')}",
                    flush=True,
                )
    return out
