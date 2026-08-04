"""QQ 入站消息中的表情协议与引用媒体解析。

这里只处理平台 payload 的纯解析，不负责 WebSocket、入队或发送回复。
"""
from __future__ import annotations

import base64
import binascii
import json
import re
import unicodedata
from typing import Any, Dict, List, Optional


_QQ_FACE_RE = re.compile(
    r'<faceType=(?P<face_type>[^,>]+),faceId="(?P<face_id>[^"]*)",'
    r'ext="(?P<ext>[^"]*)">'
)
_QQ_FACE_LIKE_TAG_RE = re.compile(r"<\s*([A-Za-z][\w:-]*)")
_QQ_FACE_LIKE_ATTR_RE = re.compile(r"\b(face(?:Type|Id)?|emoji|sticker|market|package|url|ext)\s*=")
_QQ_FACE_PENDING_TTL = 3.0
_pending_qq_faces: dict[str, list[float]] = {}
_pending_qq_face_ids: dict[str, list[list[dict[str, str]]]] = {}


def _queue_pending_qq_face(key: str, face_ids: list[dict[str, str]], now: float) -> None:
    """按会话保存待关联表情，确保快速连续发送时不覆盖前一条。"""
    _pending_qq_faces.setdefault(key, []).append(now + _QQ_FACE_PENDING_TTL)
    _pending_qq_face_ids.setdefault(key, []).append(face_ids)


def _pop_pending_qq_face(key: str, now: float) -> list[dict[str, str]]:
    """按 FIFO 取出仍在有效期内的协议表情；过期项只在消费时清理。"""
    deadlines = _pending_qq_faces.get(key, [])
    face_batches = _pending_qq_face_ids.get(key, [])
    while deadlines and deadlines[0] <= now:
        deadlines.pop(0)
        if face_batches:
            face_batches.pop(0)
    if not deadlines or not face_batches:
        _pending_qq_faces.pop(key, None)
        _pending_qq_face_ids.pop(key, None)
        return []
    deadlines.pop(0)
    pending = face_batches.pop(0)
    if deadlines and face_batches:
        _pending_qq_faces[key] = deadlines
        _pending_qq_face_ids[key] = face_batches
    else:
        _pending_qq_faces.pop(key, None)
        _pending_qq_face_ids.pop(key, None)
    return pending


def _contains_qq_face(text: str) -> bool:
    return bool(text and _QQ_FACE_RE.search(text))


def _extract_qq_faces(text: str) -> list[dict[str, str]]:
    """提取表情协议的身份字段，供入站探针确认 ID 与图片附件的对应关系。

    这里只返回协议字段，不解码 ext，也不负责把 ID 绑定到附件；Phase 0 期间先
    观察真实 QQ payload，避免在映射关系未确认前缓存错图片。
    """
    return [
        {
            "face_type": match.group("face_type"),
            "face_id": match.group("face_id"),
        }
        for match in _QQ_FACE_RE.finditer(text or "")
    ]


def _inspect_qq_faces(text: str) -> list[dict[str, object]]:
    """返回表情协议的非内容结构，供运行时探针区分不同 QQ 表情来源。

    不返回 ext 解码后的文案，也不返回完整 faceId；只保留字段存在性、长度和
    JSON 顶层键，避免把用户可见内容或协议载荷写入日志。
    """
    result: list[dict[str, object]] = []
    for match in _QQ_FACE_RE.finditer(text or ""):
        face_id = match.group("face_id")
        encoded = match.group("ext")
        ext_keys: list[str] = []
        ext_resource_keys: list[str] = []
        ext_text_length = 0
        ext_text_categories: list[str] = []
        ext_text_has_url = False
        ext_shape = "empty"
        if encoded:
            ext_shape = "nonempty"
            try:
                padding = "=" * (-len(encoded) % 4)
                decoded = json.loads(base64.b64decode(encoded + padding).decode("utf-8"))
                if isinstance(decoded, dict):
                    ext_shape = "json-object"
                    ext_keys = sorted(str(key) for key in decoded.keys())[:16]
                    ext_resource_keys = [
                        key for key in ext_keys
                        if any(token in key.lower() for token in ("url", "image", "file", "emoji", "sticker", "resource"))
                    ]
                    ext_text = decoded.get("text")
                    if isinstance(ext_text, str):
                        ext_text_length = len(ext_text)
                        ext_text_categories = sorted({
                            unicodedata.category(char)[:1]
                            for char in ext_text
                            if char.strip()
                        })
                        ext_text_has_url = ext_text.startswith(("http://", "https://"))
                else:
                    ext_shape = type(decoded).__name__
            except (ValueError, TypeError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError):
                ext_shape = "non-json"
        result.append({
            "face_type": match.group("face_type"),
            "face_id_present": bool(face_id),
            "face_id_length": len(face_id),
            "ext_present": bool(encoded),
            "ext_length": len(encoded),
            "ext_shape": ext_shape,
            "ext_keys": ext_keys,
            "ext_resource_keys": ext_resource_keys,
            "ext_text_present": ext_text_length > 0,
            "ext_text_length": ext_text_length,
            "ext_text_categories": ext_text_categories,
            "ext_text_has_url": ext_text_has_url,
        })
    return result


def _inspect_qq_face_text(text: str) -> dict[str, object]:
    """记录未被标准协议正则识别的表情文本形状，不记录文本内容。"""
    value = text or ""
    return {
        "textLength": len(value),
        "hasFaceKeyword": "face" in value.lower(),
        "tagNames": sorted(set(_QQ_FACE_LIKE_TAG_RE.findall(value)))[:16],
        "attributeNames": sorted(set(_QQ_FACE_LIKE_ATTR_RE.findall(value)))[:16],
    }


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
