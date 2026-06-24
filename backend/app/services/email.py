import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from app.core.config import get_settings


def send_email(subject: str, body: str) -> bool:
    cfg = get_settings().smtp
    if not cfg.host or not cfg.to_addr:
        return False

    from_addr = cfg.from_addr or cfg.user
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = cfg.to_addr
    msg.attach(MIMEText(body, "plain", "utf-8"))

    try:
        if cfg.use_ssl:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(cfg.host, cfg.port, context=ctx) as s:
                s.login(cfg.user, cfg.password)
                s.sendmail(from_addr, cfg.to_addr, msg.as_string())
        else:
            with smtplib.SMTP(cfg.host, cfg.port) as s:
                s.starttls(context=ssl.create_default_context())
                s.login(cfg.user, cfg.password)
                s.sendmail(from_addr, cfg.to_addr, msg.as_string())
        return True
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("邮件发送失败: %s", e)
        return False


def notify_feedback(username: str, category: str, content: str) -> None:
    category_labels = {"bug": "Bug 反馈", "suggestion": "功能建议", "other": "其他"}
    label = category_labels.get(category, category)
    subject = f"[咕咕反馈] {label} · {username}"
    body = f"用户：{username}\n分类：{label}\n\n{content}"
    send_email(subject, body)
