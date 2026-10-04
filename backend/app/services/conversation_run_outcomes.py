"""会话 run 的展示终态；与模型可见的 canonical message 正文分离。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import select

from app.core.tz import iso_utc, now_utc
from app.models import ConversationMessage, ConversationSession


_SAFE_ERROR_PARAM_KEYS = {
    "tag",
    "attempts",
    "diagnostic_id",
    "minimax_code",
    "minimax_error_type",
    "minimax_description_key",
    "minimax_request_id",
}


@dataclass(frozen=True)
class RunOutcomeTarget:
    """会话 run 结果要附着的用户消息身份。"""

    user_id: Any
    session_id: int
    user_message_id: int | None
    run_id: str


def build_run_outcome(
    *,
    status: str,
    run_id: str,
    error_code: str | None = None,
    message_key: str | None = None,
    message_params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构造仅含安全、可展示字段的 run 结果。"""
    if status not in {"failed", "interrupted"}:
        raise ValueError(f"不支持的 run 终态：{status}")

    outcome: dict[str, Any] = {
        "status": status,
        "runId": str(run_id)[:128],
        "completedAt": iso_utc(now_utc()),
    }
    if status == "failed":
        outcome["errorCode"] = str(error_code or "generation_failed")[:64]
        if isinstance(message_key, str) and message_key.startswith("chatUi."):
            outcome["messageKey"] = message_key[:100]
        safe_params = {
            key: value if isinstance(value, (int, float, bool)) else str(value)[:160]
            for key, value in (message_params or {}).items()
            if key in _SAFE_ERROR_PARAM_KEYS and isinstance(value, (str, int, float, bool))
        }
        if safe_params:
            outcome["messageParams"] = safe_params
    else:
        outcome["errorCode"] = "cancelled"
    return outcome


async def persist_run_outcome(
    session_factory,
    target: RunOutcomeTarget,
    outcome: dict[str, Any],
) -> bool:
    """将终态写到其触发的用户消息元数据列，不触碰消息正文或 history。"""
    if target.user_message_id is None:
        return False
    try:
        async with session_factory() as db:
            message = (await db.execute(
                select(ConversationMessage)
                .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
                .where(
                    ConversationMessage.id == target.user_message_id,
                    ConversationMessage.session_id == target.session_id,
                    ConversationMessage.role == "user",
                    ConversationSession.user_id == target.user_id,
                )
            )).scalars().first()
            if message is None:
                return False
            message.run_outcome = outcome
            await db.commit()
            return True
    except Exception as error:
        from app.core.redaction import diag_log
        diag_log("agent.conversation_run_outcome.persist", error)
        return False
