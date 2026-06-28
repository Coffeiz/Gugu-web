"""邮件发送（SMTP）。

用现代 `email.message.EmailMessage`（默认 `email.policy.default`）——**中文 Subject / 发件人名
自动按 RFC2047 编码**，根治旧 MIMEText/`as_string()` 下「'ascii' codec can't encode」的报错。
公共发送逻辑抽成 `_build_msg` / `_deliver`，正式发信与后台「SMTP 测试」共用一套。
"""
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_SENDER_NAME = "咕咕"   # 发件人显示名（自动 RFC2047 编码，不会再 ascii 报错）


def _build_msg(subject: str, body: str, from_addr: str, to_addr: str, html: str | None = None) -> EmailMessage:
    """构建一封邮件。EmailMessage 默认策略会自动把非 ASCII 头编成 =?utf-8?…?=。"""
    msg = EmailMessage()
    msg["Subject"] = subject
    # 友好发件名「咕咕 <addr>」；charset=utf-8 让中文名按 RFC2047 编码（无 from_addr 时退空）
    msg["From"] = formataddr((_SENDER_NAME, from_addr), "utf-8") if from_addr else from_addr
    msg["To"] = to_addr
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")
    return msg


def _deliver(*, host: str, port: int, user: str, password: str,
             use_ssl: bool, msg: EmailMessage, timeout: int = 15) -> None:
    """按配置发出一封 EmailMessage。失败抛异常（调用方决定吞或上抛）。"""
    if use_ssl:
        with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=timeout) as s:
            if user:
                s.login(user, password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=timeout) as s:
            s.starttls(context=ssl.create_default_context())
            if user:
                s.login(user, password)
            s.send_message(msg)


def send_email(subject: str, body: str, *, to_addr: str | None = None, html: str | None = None) -> bool:
    """用后台保存的 SMTP 配置发信。成功 True，失败 False（吞异常、记日志，不影响主流程）。
    `to_addr` 不传则发给配置里的默认收件人；`html` 可附 HTML 版本。"""
    cfg = get_settings().smtp
    to = to_addr or cfg.to_addr
    if not cfg.host or not to:
        return False
    from_addr = cfg.from_addr or cfg.user
    msg = _build_msg(subject, body, from_addr, to, html)
    try:
        _deliver(host=cfg.host, port=cfg.port, user=cfg.user, password=cfg.password,
                 use_ssl=cfg.use_ssl, msg=msg)
        return True
    except Exception as e:
        logger.warning("邮件发送失败: %s: %s", type(e).__name__, e)
        return False


def send_test_email(*, host: str, port: int, user: str, password: str,
                    from_addr: str, to_addr: str, use_ssl: bool) -> None:
    """SMTP 连通测试：用传入的（可能未保存的）参数发一封测试邮件。失败抛异常（调用方捕获给提示）。"""
    msg = _build_msg(
        "咕咕 · SMTP 测试邮件",
        "这是来自咕咕后台的 SMTP 连通性测试邮件，收到即表示配置正确。",
        from_addr or user, to_addr)
    _deliver(host=host, port=port, user=user, password=password, use_ssl=use_ssl, msg=msg)


def notify_feedback(username: str, category: str, content: str) -> None:
    category_labels = {"bug": "Bug 反馈", "suggestion": "功能建议", "other": "其他"}
    label = category_labels.get(category, category)
    subject = f"[咕咕反馈] {label} · {username}"
    body = f"用户：{username}\n分类：{label}\n\n{content}"
    send_email(subject, body)
