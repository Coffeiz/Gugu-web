"""邮件模板兼容导出；新代码请从 ``app.services.email.templates`` 导入。"""

from app.services.email.templates import EMAIL_PALETTES, EMAIL_THEMES, EMAIL_TOKENS, TEMPLATES, EmailContent, EmailInlineImage, render_email

__all__ = ["EMAIL_PALETTES", "EMAIL_THEMES", "EMAIL_TOKENS", "TEMPLATES", "EmailContent", "EmailInlineImage", "render_email"]
