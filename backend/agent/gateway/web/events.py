"""Web Gateway events 实现。"""
from __future__ import annotations
import logging
from agent.security.logsafe import fingerprint
from agent.models import AgentRequest
logger = logging.getLogger(__name__)


async def _publish_session_append(req: AgentRequest, session_id: int,
                                  appended: list[dict]) -> None:
    """消息持久化后通知其他标签页从数据库增量补取。"""
    try:
        from app.core import events
        await events.publish(
            req.user_id,
            "sessions",
            session_id=session_id,
            origin=getattr(req, "origin", None),
            appended=appended,
        )
    except Exception as exc:
        # 实时通知是 best-effort，不能反向使已提交的聊天失败。
        logger.warning(
            "Web 会话消息实时通知异常 user_fp=%s session_fp=%s error_type=%s",
            fingerprint(str(req.user_id)), fingerprint(str(session_id)),
            type(exc).__name__,
        )
