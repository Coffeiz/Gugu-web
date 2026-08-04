"""QQ 入站消息中的表情协议与引用媒体解析。

这里只处理平台 payload 的纯解析，不负责 WebSocket、入队或发送回复。
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any, Dict, List, Optional


_QQ_FACE_RE = re.compile(
    r'<faceType=(?P<face_type>[^,>]+),faceId="(?P<face_id>[^"]*)",'
    r'ext="(?P<ext>[^"]*)">'
)
_QQ_FACE_PENDING_TTL = 3.0
_pending_qq_faces: dict[str, float] = {}


def _contains_qq_face(text: str) -> bool:
    return bool(text and _QQ_FACE_RE.search(text))


def _qq_face_pending_key(chat_type: str, chat_id: str, sender_id: str) -> str:
    return f"qq-face-pending:{chat_type}:{chat_id or sender_id}"


def _normalize_qq_faces(text: str) -> str:
    """将 QQ 内部表情标记转换成可展示文本，避免协议串进入会话。"""
    if not text or "<faceType=" not in text:
        return text

    def replace(match: re.Match) -> str:
        encoded = match.group("ext")
        if encoded:
            try:
                padding = "=" * (-len(encoded) % 4)
                payload = json.loads(base64.b64decode(encoded + padding).decode("utf-8"))
                label = str(payload.get("text") or "").strip()
                if label:
                    return label
            except (ValueError, TypeError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError):
                pass
        return "[QQ表情]"

    return _QQ_FACE_RE.sub(replace, text)


def _strip_qq_face_markers(text: str) -> str:
    """移除协议表情标记，图片附件会作为消息的视觉内容单独展示。"""
    return _QQ_FACE_RE.sub("", text or "").strip()


def _find_quoted_element(raw_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    msg_elements: List[Dict[str, Any]] = raw_data.get("msg_elements") or []
    if not msg_elements:
        return None
    scene_ext = _message_scene_ext(raw_data)
    ref_idx = _scene_ext_value(scene_ext, "ref_msg_idx") or _scene_ext_value(scene_ext, "msg_ref_idx")
    if not ref_idx:
        return None
    for elem in msg_elements:
        if isinstance(elem, dict) and str(elem.get("msg_idx", "")) == ref_idx:
            return elem
    own_idx = _scene_ext_value(scene_ext, "msg_idx")
    for elem in msg_elements:
        if isinstance(elem, dict) and str(elem.get("msg_idx", "")) != own_idx:
            return elem
    return None


def _message_scene_ext(raw_data: Dict[str, Any]) -> list:
    scene = raw_data.get("message_scene") or {}
    if not isinstance(scene, dict):
        return []
    ext = scene.get("ext") or []
    return ext if isinstance(ext, list) else []


def _scene_ext_value(scene_ext: list, key: str) -> str:
    prefix = f"{key}="
    for entry in scene_ext:
        if isinstance(entry, str) and entry.startswith(prefix):
            return entry[len(prefix):].strip()
        if isinstance(entry, dict):
            if entry.get("key") == key:
                return str(entry.get("value") or "").strip()
            if key in entry:
                return str(entry.get(key) or "").strip()
    return ""


def _extract_quoted(raw_data: Dict[str, Any]) -> tuple[str, list]:
    elem = _find_quoted_element(raw_data)
    if not elem:
        return "", []
    text = (elem.get("content") or elem.get("text") or "").strip()
    text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    attachments = elem.get("attachments") or []
    if not isinstance(attachments, list):
        attachments = []
    return text, _dedupe_attachments(attachments + _collect_media_attachments(elem))


def _collect_media_attachments(value) -> list:
    found: list = []

    def walk(item):
        if isinstance(item, dict):
            url = (item.get("url") or item.get("file_url") or item.get("download_url")
                   or item.get("image_url") or item.get("origin_url") or item.get("preview_url"))
            if isinstance(url, str) and url:
                found.append({
                    "url": url,
                    "filename": (item.get("filename") or item.get("file_name")
                                 or item.get("name") or "引用图片.jpg"),
                    "content_type": item.get("content_type") or item.get("type"),
                })
            for child in item.values():
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)

    walk(value)
    deduped: list = []
    seen: set[str] = set()
    for item in found:
        url = item.get("url")
        if url and url not in seen:
            seen.add(url)
            deduped.append(item)
    return deduped


def _dedupe_attachments(attachments: list) -> list:
    deduped: list = []
    seen: set[str] = set()
    for item in attachments:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if url and url in seen:
            continue
        if url:
            seen.add(url)
        deduped.append(item)
    return deduped
