"""IM 入站媒体处理。

Gateway 只传平台原始附件；下载、转码和暂存由 worker 侧统一完成，
并通过原始 message_id 保持附件与消息的稳定关联。
"""
from __future__ import annotations

import aiohttp
import json

from app.core.redaction import diag_log, redact


async def ingest_qq_media(attachments: list, owner: str, message_id: str = "") -> list:
    """下载 QQ 附件并返回当前消息专属的 attach_id 列表。"""
    raw = [item for item in attachments if isinstance(item, dict)]
    if not raw or not owner:
        return []

    from agent.im import files as im_attachments

    out: list[str] = []
    async with aiohttp.ClientSession() as sess:
        for index, item in enumerate(raw):
            url = item.get("url")
            print(
                "[runtime-qq-face-probe] " + json.dumps({
                    "phase": "ingress-raw",
                    "index": index,
                    "keys": sorted(item.keys()),
                    "hasUrl": bool(url),
                    "qqFace": bool(item.get("qq_face")),
                }, ensure_ascii=False),
                flush=True,
            )
            if not url:
                print(
                    "[runtime-qq-face-probe] " + json.dumps({
                        "phase": "ingress-skip-no-url",
                        "qqFace": bool(item.get("qq_face")),
                    }, ensure_ascii=False),
                    flush=True,
                )
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
                async with sess.get(url, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                    if resp.status != 200:
                        print(f"[qq] 下载附件失败 status={resp.status}", flush=True)
                        continue
                    data = await resp.read()

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
                print(
                    "[runtime-qq-face-probe] " + json.dumps({
                        "phase": "ingress-staged",
                        "qqFace": is_qq_face,
                        "kind": "image" if is_qq_face else ("voice" if is_voice else "file"),
                        "ext": ext,
                        "hasAttachId": bool(meta.get("attach_id")),
                    }, ensure_ascii=False),
                    flush=True,
                )
            except Exception as exc:
                diag_log("agent.im.media_ingress.ingest_qq_media", exc)
                print(
                    f"[qq] 暂存附件出错: {redact(f'{type(exc).__name__}: {exc}')}",
                    flush=True,
                )
    return out
