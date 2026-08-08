"""微信 iLink 入站媒体下载、解密和引用媒体解析。"""
from __future__ import annotations

from urllib.parse import quote

from app.core.redaction import diag_log, diag_log_raw, redact

_WECHAT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c"


def image_ext_mime(data: bytes) -> tuple[str, str]:
    if data[:3] == b"\xff\xd8\xff":
        return "jpg", "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", "image/png"
    if data[:4] == b"GIF8":
        return "gif", "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    return "jpg", "image/jpeg"


def media_url(media: dict) -> str:
    full_url = media.get("full_url") or ""
    if full_url:
        return full_url
    encrypted = media.get("encrypt_query_param") or ""
    if encrypted:
        return f"{_WECHAT_CDN_BASE}/download?encrypted_query_param={quote(encrypted, safe='')}"
    return ""


async def ingest_media(items: list, owner: str, decrypt) -> list:
    import httpx
    from agent.im import files as im_attachments
    out: list = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for item in items:
            image = item.get("image_item")
            if not image:
                other = [key for key, value in item.items() if key.endswith("_item") and value]
                if other:
                    print(f"[wechat] 暂不支持的媒体项（格式待补）: {other}", flush=True)
                continue
            aeskey = image.get("aeskey") or ""
            url = media_url(image.get("media") or {})
            if not aeskey or not url:
                print("[wechat] 图片项缺 aeskey/可用下载地址，跳过", flush=True)
                continue
            try:
                raw = (await client.get(url)).content
                data = decrypt(raw, bytes.fromhex(aeskey))
                ext, mime = image_ext_mime(data)
                meta = await im_attachments.stage(owner, "微信图片", ext, mime, data, kind="image", platform="wechat")
                out.append(meta["attach_id"])
            except Exception as exc:
                diag_log("agent.im.media_ingress_wechat.ingest_media", exc)
                print(f"[wechat] 图片下载/解密失败: {redact(f'{type(exc).__name__}: {exc}')}", flush=True)
    return out


def extract_quoted(ref_msg) -> tuple[str | None, list]:
    if not isinstance(ref_msg, dict):
        return None, []
    title = (ref_msg.get("title") or "").strip()
    item = ref_msg.get("message_item")
    if not isinstance(item, dict):
        return (title, []) if title else (None, [])
    quoted_type = item.get("type")
    text = (item.get("text_item") or {}).get("text", "").strip()
    if text:
        return text, []
    if quoted_type == 3 or item.get("voice_item"):
        voice_text = (item.get("voice_item") or {}).get("text", "").strip()
        return (voice_text or "[语音消息]"), []
    if quoted_type == 2 or item.get("image_item"):
        _probe_quoted_media(item.get("image_item") or {})
        return "[图片消息]", [{"type": 2, "image_item": item.get("image_item") or {}}]
    if quoted_type == 4 or item.get("file_item"):
        return "[文件消息]", []
    if quoted_type == 5 or item.get("video_item"):
        return "[视频消息]", []
    if title:
        return title, []
    return "[微信暂不支持消息引用识别]", []


def _probe_quoted_media(image_item: dict) -> None:
    """临时探针（PRD-STORAGE-1 引用附件复用可行性调查），同 qq.py 版本：落进受限诊断出口
    `logs/gugu-diag.log`，确认微信引用消息的 image_item 里有没有稳定的 id/hash（比如
    `encrypt_query_param` 是否在多次引用同一条历史消息时保持不变）。调查完应删除。"""
    try:
        import json
        diag_log_raw("agent.im.media_ingress_wechat._probe_quoted_media",
                      json.dumps(image_item, ensure_ascii=False)[:4000])
    except Exception:
        pass
