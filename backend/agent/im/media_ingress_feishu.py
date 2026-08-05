"""飞书入站媒体下载、暂存和引用媒体解析。"""
from __future__ import annotations

import json

from app.core.redaction import diag_log, redact


_TEXT_EXTS = {"md", "txt", "json", "csv", "yaml", "yml", "log", "py", "js", "ts", "tsx",
              "jsx", "vue", "html", "css", "scss", "java", "go", "rs", "c", "cpp", "h",
              "hpp", "sh", "sql", "xml", "toml", "ini", "conf", "env"}


def download_and_stage(client, message_id: str, owner: str, key: str, rtype: str,
                       fname: str, is_voice: bool) -> tuple[str, str]:
    from lark_oapi.api.im.v1 import GetMessageResourceRequest
    from agent.im import files as im_attachments
    if not key:
        noun = "语音" if is_voice else "文件"
        return (f"[用户发来一个{noun}，但没取到资源]", "")
    try:
        req = GetMessageResourceRequest.builder().message_id(message_id).file_key(key).type(rtype).build()
        resp = client.im.v1.message_resource.get(req)
        data = resp.file.read() if (resp.success() and resp.file) else b""
    except Exception as exc:
        diag_log("agent.im.media_ingress_feishu.download_resource", exc)
        print(f"[feishu] 下载资源出错: {redact(f'{type(exc).__name__}: {exc}')}", flush=True)
        data = b""
    if not data:
        return (f"[用户发来文件《{fname}》，但下载失败]", "")
    name = fname.rsplit(".", 1)[0] if "." in fname else fname
    ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
    duration = None
    if is_voice:
        from app.core import media_transcode
        conv = media_transcode.to_mimo_mp3(data, ext or "opus", "audio/ogg")
        if conv is not None:
            data, ext, name = conv, "mp3", "语音"
        duration = media_transcode.probe_duration(data, ext)
    try:
        if is_voice:
            aid = im_attachments.stage_voice_sync(
                owner, name, ext, "audio/mpeg" if ext == "mp3" else None, data,
                duration=duration, platform="feishu").get("attach_id", "")
        else:
            aid = im_attachments.stage_sync(owner, name, ext, None, data, platform="feishu").get("attach_id", "")
    except Exception as exc:
        diag_log("agent.im.media_ingress_feishu.stage_media", exc)
        print(f"[feishu] 暂存失败: {redact(f'{type(exc).__name__}: {exc}')}", flush=True)
        aid = ""
    if aid:
        return ("", aid)
    if is_voice:
        return ("[用户发来一条语音，但处理失败]", "")
    if ext in _TEXT_EXTS:
        return (f"[用户发来文件《{fname}》内容：]\n```\n{data.decode('utf-8', 'replace')[:30000]}\n```", "")
    return (f"[用户发来文件《{fname}》，但暂存失败]", "")


def ingest_media(client, msg, owner: str, download=download_and_stage) -> tuple[str, list]:
    mt = msg.message_type
    try:
        content = json.loads(msg.content) if msg.content else {}
    except (json.JSONDecodeError, TypeError):
        content = {}
    if mt == "image":
        key, rtype, fname = content.get("image_key", ""), "image", "图片.jpg"
    elif mt == "audio":
        key, rtype, fname = content.get("file_key", ""), "file", "语音.opus"
    elif mt == "media":
        key, rtype, fname = content.get("file_key", ""), "file", "视频.mp4"
    else:
        key, rtype, fname = content.get("file_key", ""), "file", (content.get("file_name") or "文件")
    fallback, aid = download(client, msg.message_id, owner, key, rtype, fname, is_voice=(mt == "audio"))
    return ("", [aid]) if aid else (fallback, [])


def ingest_post(client, msg, owner: str, download=download_and_stage) -> tuple[str, list]:
    try:
        content = json.loads(msg.content) if msg.content else {}
    except (json.JSONDecodeError, TypeError):
        content = {}
    title = (content.get("title") or "").strip()
    rows = content.get("content") or []
    lines: list[str] = []
    media_keys: list[tuple[str, str, str]] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, list):
            continue
        parts: list[str] = []
        for element in row:
            if not isinstance(element, dict):
                continue
            tag = element.get("tag")
            if tag == "text":
                parts.append(element.get("text") or "")
            elif tag == "a":
                parts.append(element.get("text") or element.get("href") or "")
            elif tag == "at":
                parts.append(f"@{element.get('user_name') or element.get('user_id') or ''}")
            elif tag == "img" and element.get("image_key"):
                media_keys.append((element["image_key"], "image", "图片.jpg"))
            elif tag == "media" and element.get("file_key"):
                media_keys.append((element["file_key"], "file", "视频.mp4"))
        if parts:
            lines.append("".join(parts))
    text = "\n".join(lines).strip()
    if title:
        text = f"{title}\n{text}".strip()
    attachments: list = []
    for key, rtype, fname in media_keys:
        fallback, aid = download(client, msg.message_id, owner, key, rtype, fname, is_voice=False)
        if aid:
            attachments.append(aid)
        elif fallback:
            text = f"{text}\n{fallback}".strip()
    return text, attachments
