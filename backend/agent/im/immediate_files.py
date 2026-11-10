"""IM 工具调用中的文件即时投递与入站消息级去重。"""
from __future__ import annotations

import asyncio
import hashlib
import json


class ImmediateFileDelivery:
    """先记录提交状态，再调用平台；状态不明时禁止自动重发。"""

    def __init__(self, payload: dict, *, boundary=None):
        self.payload = payload
        self.boundary = boundary
        self._lock = asyncio.Lock()

    async def __call__(self, artifact: dict) -> str:
        payload = self.payload
        if payload.get("chat_type") == "group" and not payload.get("group_mentioned"):
            return "deferred"
        message_id = str(payload.get("message_id") or "")
        file_id = artifact.get("file_id") or artifact.get("attach_id")
        if not message_id or not file_id:
            return "deferred"

        from app.core import redis as redis_core
        from app.core.redaction import diag_log
        from agent.im.files import send_files

        key_data = [payload.get("owner_user_id"), payload.get("platform"), payload.get("channel_id"), payload.get("chat_id"),
                    payload.get("platform_user_id"), message_id,
                    "file" if artifact.get("file_id") else "attachment", str(file_id)]
        digest = hashlib.sha256(json.dumps(
            [str(value) if value is not None else None for value in key_data], ensure_ascii=False,
        ).encode()).hexdigest()
        key = f"im:file-delivery:{digest}"
        async with self._lock:
            try:
                redis = redis_core.get_redis()
                created = await redis.set(key, "submitted", nx=True, ex=604800)
                if not created:
                    existing = await redis.get(key)
                    if isinstance(existing, bytes):
                        existing = existing.decode()
                    return existing if existing in {"sent", "failed"} else "unknown"
                if self.boundary is not None and not await self.boundary.before_platform_event({"type": "tool_call"}):
                    # 未发出附件；保守保留提交记录，防止状态不确定时重复发送。
                    return "unknown"
                receipt = {}
                result = await send_files({**payload, "message_id": None, "_attention_delivery_role": "answer", "_im_file_receipt": receipt}, [artifact])
                platform_state = receipt.get("state")
                state = ("sent" if result.all_sent else platform_state if platform_state in {"failed", "unknown"}
                         else "unknown" if result.unconfirmed else "failed")
                await redis.set(key, state, ex=604800)
                return state
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                diag_log("agent.im.immediate_file_delivery", exc)
                return "unknown"
