"""系统邮件能力判断。

能力判断只返回是否可用，不暴露 SMTP 配置细节。邮箱变更等账户安全邮件
必须使用全局 Admin SMTP，不使用用户自定义 SMTP。
"""

from __future__ import annotations

from email.utils import parseaddr

from app.core.config import AppSettings, get_settings


def is_system_email_configured(settings: AppSettings | None = None) -> bool:
    """判断系统 SMTP 是否填写了完整配置，不判断当前是否启用。"""
    smtp = (settings or get_settings()).smtp
    host = smtp.host.strip()
    user = smtp.user.strip()
    password = smtp.password
    from_addr = (smtp.from_addr or user).strip()
    parsed_address = parseaddr(from_addr)[1]
    return bool(
        host
        and user
        and password
        and parsed_address == from_addr
        and "@" in parsed_address
    )


def is_system_email_available(settings: AppSettings | None = None) -> bool:
    """判断系统是否具备发送账户安全邮件的最低配置。"""
    current = settings or get_settings()
    return getattr(current.smtp, "enabled", True) and is_system_email_configured(current)


def is_registration_verification_enabled(settings: AppSettings | None = None) -> bool:
    """注册邮箱验证需同时满足管理员开关开启和系统邮件能力可用。"""
    current = settings or get_settings()
    return current.smtp.registration_verification_enabled and is_system_email_available(current)


def email_capabilities(settings: AppSettings | None = None) -> dict[str, bool]:
    """返回可公开给已登录用户的非敏感系统邮件能力。"""
    return {"email_change": is_system_email_available(settings)}
