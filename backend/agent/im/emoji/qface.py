"""QFace QQ 系统表情资源提供器。

QFace 只作为可替换的远程资源索引使用，不把腾讯表情资源打包进 Gugu-web。
当前接入 QQ 消息协议里的系统表情 ``faceType=1/3``；表情商店留给后续 provider。
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Optional

import aiohttp


QFACE_INDEX_URL = "https://koishi.js.org/QFace/assets/qq_emoji/_index.json"
QFACE_ASSET_BASE = "https://koishi.js.org/QFace/"
_INDEX_TTL = 6 * 3600
_INDEX_FAILURE_BACKOFF = 60


@dataclass(frozen=True)
class QFaceAsset:
    url: str
    filename: str
    mime: str


_index_cache: Optional[list[dict[str, Any]]] = None
_index_cached_at = 0.0
_index_retry_after = 0.0
_index_lock = asyncio.Lock()


def _select_asset(index: list[dict[str, Any]], face_id: str) -> Optional[QFaceAsset]:
    """按 QQ faceId 匹配资源，优先精确 emojiId，再回退 qzoneCode。"""
    target = str(face_id or "").strip()
    if not target:
        return None

    exact = [item for item in index if isinstance(item, dict) and str(item.get("emojiId", "")) == target]
    fallback = [
        item for item in index
        if isinstance(item, dict)
        and str(item.get("qzoneCode", "")) == target
        and item not in exact
    ]
    for item in exact + fallback:
        if not isinstance(item, dict):
            continue
        assets = item.get("assets") or []
        if not isinstance(assets, list):
            continue
        candidates = [asset for asset in assets if isinstance(asset, dict)]
        selected = next((asset for asset in candidates if asset.get("type") == 2), None)
        selected = selected or next((asset for asset in candidates if asset.get("type") == 0), None)
        if not selected:
            continue
        path = str(selected.get("path") or "")
        if not path.startswith("assets/qq_emoji/") or ".." in path:
            continue
        name = str(selected.get("name") or "qq-face.png")
        return QFaceAsset(
            url=QFACE_ASSET_BASE + path,
            filename=name,
            mime="image/png",
        )
    return None


async def _load_index() -> list[dict[str, Any]]:
    global _index_cache, _index_cached_at
    now = time.monotonic()
    if _index_cache is not None and now - _index_cached_at < _INDEX_TTL:
        return _index_cache
    async with _index_lock:
        now = time.monotonic()
        if _index_cache is not None and now - _index_cached_at < _INDEX_TTL:
            return _index_cache
        timeout = aiohttp.ClientTimeout(total=3)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(QFACE_INDEX_URL) as response:
                response.raise_for_status()
                payload = await response.json()
        if not isinstance(payload, list):
            raise ValueError("QFace 索引格式无效")
        _index_cache = [item for item in payload if isinstance(item, dict)]
        _index_cached_at = time.monotonic()
        return _index_cache


async def resolve_qq_system_face(face_type: str, face_id: str) -> Optional[QFaceAsset]:
    """解析 QQ 系统表情资源；未知类型或未匹配时返回 None。"""
    if str(face_type) not in {"1", "3"} or not str(face_id or "").strip():
        return None
    global _index_retry_after
    if time.monotonic() < _index_retry_after:
        return None
    try:
        return _select_asset(await _load_index(), face_id)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
        _index_retry_after = time.monotonic() + _INDEX_FAILURE_BACKOFF
        return None
