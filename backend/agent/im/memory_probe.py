"""IM 记忆上下文的临时运行探针。

仅在 ``GUGU_IM_MEMORY_PROBE=1`` 或 devserver 标记文件存在时写入独立 JSONL
文件。所有身份和路由值都只写不可逆指纹，不写消息正文，方便验证不同用户的
scope/权限组装是否串线。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable

from agent.logsafe import fingerprint
from app.core.tz import now_utc


def enabled() -> bool:
    if os.getenv("GUGU_IM_MEMORY_PROBE", "0") == "1":
        return True
    return (_default_path().parent / ".im-memory-context-probe.enabled").exists()


def fp(value: Any) -> str:
    return fingerprint(str(value)) if value is not None else ""


def _default_path() -> Path:
    return Path(__file__).resolve().parents[2] / "logs" / "im-memory-context-probe.log"


def record(event: str, **fields: Any) -> None:
    """写一行安全 JSON；探针故障不能影响 IM 主链路。"""
    if not enabled():
        return
    try:
        path = Path(os.getenv("GUGU_IM_MEMORY_PROBE_LOG", str(_default_path())))
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {"ts": now_utc().isoformat(), "event": event, **fields}
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        return


def record_actor(actor, owner_user_id: Any, bot_id: Any = None) -> None:
    record(
        "actor-resolved",
        owner_fp=fp(owner_user_id),
        source=actor.platform,
        bot_fp=fp(bot_id),
        sender_fp=fp(actor.platform_user_id),
        sender_name_fp=fp(actor.platform_user_name),
        chat_type=actor.chat_type,
        chat_fp=fp(actor.chat_id),
        role=actor.role or "unknown",
        allowed_tools=sorted(actor.allowed_tool_names or []),
    )


def record_memory_load(request, data: dict) -> None:
    group = data.get("group") or {}
    member = data.get("platform_user") or {}
    record(
        "memory-loaded",
        owner_fp=fp(request.user_id),
        source=request.source,
        bot_fp=fp(request.platform_bot_id),
        sender_fp=fp(request.platform_user_id),
        chat_fp=fp(request.chat_id),
        role=(request.actor_context.role if request.actor_context else request.im_role) or "unknown",
        group_sections=sorted(key for key, value in group.items() if value),
        member_sections=sorted(key for key, value in member.items() if value),
        member_scope_loaded=bool(member),
    )


def record_context_assembly(
    request,
    context_data,
    history: Iterable[Any],
    mode: str,
    *,
    session_id: Any = None,
) -> None:
    history = list(history)
    owner_memory = context_data.memory or {}
    im_memory = context_data.im_memory or {}
    group_memory = im_memory.get("group") or {}
    member_memory = im_memory.get("platform_user") or {}
    record(
        "context-assembled",
        owner_fp=fp(request.user_id),
        source=request.source,
        bot_fp=fp(request.platform_bot_id),
        sender_fp=fp(request.platform_user_id),
        chat_type="group" if request.chat_id else "c2c" if request.source else None,
        chat_fp=fp(request.chat_id),
        session_id=session_id if session_id is not None else request.session_id,
        role=(request.actor_context.role if request.actor_context else request.im_role) or "unknown",
        allowed_tools=sorted(request.allowed_tool_names or []),
        history_count=len(history),
        history_roles=[getattr(item, "role", None) for item in history],
        history_sender_fps=[fp(getattr(item, "platform_user_id", None)) for item in history],
        owner_memory_sections=sorted(key for key, value in owner_memory.items() if value),
        owner_memory_loaded=bool(owner_memory),
        im_memory_sections=sorted(im_memory.keys()),
        group_memory_sections=sorted(key for key, value in group_memory.items() if value),
        member_memory_sections=sorted(key for key, value in member_memory.items() if value),
        member_memory_loaded=bool(member_memory),
        mode=mode,
    )
