"""安全策略外部告警；默认关闭，且不阻塞主请求。"""
from __future__ import annotations
import asyncio
import logging
import re
from typing import Any

from app.core.config import get_settings

_log = logging.getLogger("security.alerts")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _recipients() -> list[str]:
    cfg = getattr(get_settings(), "security", None)
    if not cfg or not getattr(cfg, "alert_email_enabled", False):
        return []
    values = getattr(cfg, "alert_email_recipients", []) or []
    return [str(value).strip() for value in values if _EMAIL_RE.fullmatch(str(value).strip())]


async def notify_risk_action(*, action: str, user_count: int, reason_code: str) -> None:
    """发送脱敏聚合摘要；目标地址无效或 SMTP 失败均只记录类型。"""
    recipients = _recipients()
    if not recipients or action not in {"throttled", "suspended"}:
        return
    from app.services.email import send_email

    subject = f"咕咕安全告警 · {action}"
    body = (
        "检测到重复越权访问策略动作。\n\n"
        f"动作：{action}\n"
        f"用户窗口计数：{user_count}\n"
        f"原因：{reason_code}\n"
        "详细资源、IP、客户端、Token、Cookie 和正文未包含在邮件中。"
    )
    for recipient in recipients:
        try:
            await asyncio.to_thread(send_email, subject, body, to_addr=recipient)
        except Exception:
            _log.warning("安全告警发送失败 error_type=%s", "delivery_error")
