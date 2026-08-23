"""上下文边界变化审计日志。

这里只记录长度、指纹和作用域元数据，不记录摘要正文、消息正文或用户输入。
用于定位 cache 前缀变化究竟来自压缩、会话摘要还是记忆反思。
"""
from __future__ import annotations

import logging
from typing import Any

from agent.security.logsafe import fingerprint

logger = logging.getLogger("agent.context.audit")


def _fp(value: Any) -> str:
    return fingerprint("" if value is None else str(value))


def session_scope(session: Any) -> dict[str, Any]:
    """提取可安全记录的会话作用域元数据。"""
    return {
        "session_id": getattr(session, "id", None),
        "source": getattr(session, "source", None),
        "chat_type": getattr(session, "chat_type", None),
        "chat_id_fp": _fp(getattr(session, "chat_id", None)),
        "bot_id_fp": _fp(getattr(session, "bot_id", None)),
        "user_id_fp": _fp(getattr(session, "user_id", None)),
    }


def summary_change(*, source: str, old: str | None, new: str | None, **fields: Any) -> None:
    """记录摘要变更，不打印摘要正文。"""
    logger.info(
        "[context-summary-audit] %s old_len=%d new_len=%d old_fp=%s new_fp=%s %s",
        source,
        len(old or ""),
        len(new or ""),
        fingerprint(old or ""),
        fingerprint(new or ""),
        " ".join(f"{key}={value}" for key, value in fields.items() if value is not None),
    )


def provider_history_change(*, session: Any, previous_provider: str | None,
                            previous_api_format: str | None, provider: str,
                            api_format: str, stripped: bool) -> None:
    """记录历史协议边界变化；不记录消息正文或用户标识。"""
    logger.info(
        "[context-provider-history] session=%s old_provider=%s old_format=%s "
        "provider=%s api_format=%s stripped=%s %s",
        getattr(session, "id", None), previous_provider or "unknown",
        previous_api_format or "unknown", provider, api_format, stripped,
        " ".join(f"{key}={value}" for key, value in session_scope(session).items()
                 if key not in {"session_id"}),
    )
