"""邮件发送（SMTP）。

用现代 `email.message.EmailMessage`（默认 `email.policy.default`）——**中文 Subject / 发件人名
自动按 RFC2047 编码**，根治旧 MIMEText/`as_string()` 下「'ascii' codec can't encode」的报错。
公共发送逻辑抽成 `_build_msg` / `_deliver`，正式发信与后台「SMTP 测试」共用一套。
"""
import logging
import re
import smtplib
import ssl
import time
from html import escape
from html.parser import HTMLParser
from email.message import EmailMessage
from email.utils import formataddr

from app.core.config import get_settings
from .templates import render_email

logger = logging.getLogger(__name__)


def _record_email(status: str, started_at: float, error_code: str | None = None) -> None:
    """把邮件结果送入脱敏运维指标；指标异常不能影响邮件调用方。"""
    try:
        from app.core.opsmetrics import record_email
        record_email(status, int((time.monotonic() - started_at) * 1000), error_code)
    except Exception:
        pass

_SENDER_NAME = "咕咕"   # 发件人显示名（自动 RFC2047 编码，不会再 ascii 报错）

_HTML_TAGS = {
    "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "img",
    "hr", "i", "li", "ol", "p", "pre", "span", "strong", "table", "tbody",
    "td", "th", "thead", "tr", "u", "ul",
}
_HTML_ATTRS = {
    "a": {"href", "title", "target", "rel"},
    "img": {"src", "alt", "width", "height"},
    "table": {"role", "width", "cellpadding", "cellspacing", "align"},
    "td": {"width", "align", "valign"},
    "th": {"width", "align", "valign"},
    "*": {"style"},
}
_SAFE_STYLE_PROPERTIES = {
    "background", "background-color", "border", "border-bottom", "border-left", "border-radius", "border-top", "color", "display",
    "color-scheme", "font-family", "font-size", "font-weight", "height", "line-height", "margin", "max-height",
    "max-width", "object-fit", "overflow", "padding", "text-align", "text-decoration", "width", "filter",
}


class _EmailHtmlSanitizer(HTMLParser):
    """保留邮件排版所需标签，剥离脚本、事件属性和危险链接。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._open_tags: list[str] = []
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag not in _HTML_TAGS:
            if tag in {"script", "style", "iframe", "object", "embed", "svg", "math"}:
                self._ignored_depth += 1
            return
        if self._ignored_depth:
            return
        allowed = _HTML_ATTRS.get(tag, set()) | _HTML_ATTRS.get("*", set())
        rendered_attrs: list[str] = []
        for key, value in attrs:
            key = key.lower()
            if key not in allowed or value is None:
                continue
            if key == "style":
                value = self._sanitize_style(value)
                if not value:
                    continue
            if key == "href" and not value.lower().startswith(("https://", "http://", "mailto:")):
                continue
            if key == "src" and not value.lower().startswith("data:image/png;base64,"):
                continue
            if key == "role" and value.lower() != "presentation":
                continue
            if key in {"align", "valign"} and value.lower() not in {"left", "center", "right", "top", "middle", "bottom"}:
                continue
            if key in {"width", "height", "cellpadding", "cellspacing"} and not re.fullmatch(r"\d{1,4}%?", value.strip()):
                continue
            rendered_attrs.append(f' {key}="{escape(value, quote=True)}"')
        self.parts.append(f"<{tag}{''.join(rendered_attrs)}>")
        if tag not in {"br", "hr", "img"}:
            self._open_tags.append(tag)

    @staticmethod
    def _sanitize_style(value: str) -> str:
        """只保留模板需要的静态 CSS，拒绝表达式、外链和任意注入。"""
        if any(token in value.lower() for token in ("url(", "expression", "@import", "behavior", "-moz-binding")):
            return ""
        safe: list[str] = []
        for declaration in value.split(";"):
            if ":" not in declaration:
                continue
            prop, raw = declaration.split(":", 1)
            prop, raw = prop.strip().lower(), raw.strip()
            if prop not in _SAFE_STYLE_PROPERTIES or not raw or any(ch in raw for ch in "{}<>\r\n"):
                continue
            if prop in {"color", "background", "background-color"} and not re.fullmatch(
                r"(?:#[0-9a-f]{3,8}|rgba?\([^)]*\)|transparent|none)(?:\s+[^;]+)?", raw, re.I
            ):
                continue
            if prop in {"border", "border-bottom", "border-left", "border-top"} and not re.fullmatch(
                r"(?:0|[0-9.]+px)\s+(?:solid|dashed)\s+(?:#[0-9a-f]{3,8}|rgba?\([^)]*\)|transparent)", raw, re.I
            ):
                continue
            safe.append(f"{prop}:{raw}")
        return ";".join(safe)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "iframe", "object", "embed", "svg", "math"} and self._ignored_depth:
            self._ignored_depth -= 1
            return
        if self._ignored_depth:
            return
        if tag not in self._open_tags:
            return
        while self._open_tags:
            current = self._open_tags.pop()
            self.parts.append(f"</{current}>")
            if current == tag:
                break

    def handle_data(self, data: str) -> None:
        if self._ignored_depth:
            return
        self.parts.append(escape(data))

    def sanitized(self) -> str:
        while self._open_tags:
            self.parts.append(f"</{self._open_tags.pop()}>")
        return "".join(self.parts)


def sanitize_email_html(value: str) -> str:
    parser = _EmailHtmlSanitizer()
    parser.feed(value)
    parser.close()
    return parser.sanitized()


def _resolve_from(from_field: str, user: str) -> tuple[str, str]:
    """解析出 (显示名, 发件地址)。

    后台「发件人」字段常被填成显示名（如「咕咕」）而非邮箱——若直接当地址塞进
    From，信封发件人会是 `<咕咕>`，smtplib 发 `MAIL FROM` 时按 ASCII 编码即崩。
    规则：含 `@` 的字段才当地址，否则当显示名、地址退回登录账号 `user`（真实邮箱）。"""
    name = from_field if (from_field and "@" not in from_field) else _SENDER_NAME
    addr = from_field if (from_field and "@" in from_field) else user
    return name, addr


def _build_msg(subject: str, body: str, from_name: str, from_addr: str, to_addr: str, html: str | None = None) -> EmailMessage:
    """构建一封邮件。EmailMessage 默认策略会自动把非 ASCII 头编成 =?utf-8?…?=。"""
    msg = EmailMessage()
    msg["Subject"] = subject
    # 友好发件名「name <addr>」；charset=utf-8 让中文显示名按 RFC2047 编码（地址须是 ASCII 邮箱）
    msg["From"] = formataddr((from_name, from_addr), "utf-8") if from_addr else from_addr
    msg["To"] = to_addr
    msg.set_content(body)
    if html:
        clean_html = sanitize_email_html(html)
        if clean_html:
            msg.add_alternative(clean_html, subtype="html")
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


def send_email_with_status(subject: str, body: str, *, to_addr: str | None = None,
                           html: str | None = None, smtp_config=None,
                           template: str = "notification", title: str | None = None,
                           preheader: str | None = None, sections=None, actions=None,
                           theme: str = "light", palette: str = "mist") -> dict:
    """发送邮件并返回可交付状态；``sent`` 只表示 SMTP 已接受，不代表最终送达。"""
    started_at = time.monotonic()
    cfg = smtp_config or get_settings().smtp
    if isinstance(cfg, dict):   # apply_override 后嵌套配置段可能是 dict，统一成可属性访问（同 voice）
        from types import SimpleNamespace
        cfg = SimpleNamespace(**cfg)
    to = to_addr or getattr(cfg, "to_addr", "")
    if not cfg.host or not to:
        _record_email("failed", started_at, "smtp_not_configured")
        return {"status": "failed", "error_code": "smtp_not_configured", "message": "SMTP 未配置"}
    from_name, from_addr = _resolve_from(cfg.from_addr, cfg.user)
    if html is None:
        try:
            html = render_email(
                template=template, subject=subject, body=body, title=title,
                preheader=preheader, sections=sections, actions=actions,
                theme=theme, palette=palette,
            ).html
        except ValueError as exc:
            _record_email("failed", started_at, "email_template_invalid")
            return {"status": "failed", "error_code": "email_template_invalid", "message": str(exc)}
    msg = _build_msg(subject, body, from_name, from_addr, to, html)
    try:
        _deliver(host=cfg.host, port=cfg.port, user=cfg.user, password=cfg.password,
                 use_ssl=cfg.use_ssl, msg=msg)
        _record_email("sent", started_at)
        return {"status": "sent", "delivery": "smtp_accepted", "message": "SMTP 已接受邮件"}
    except ssl.SSLError as e:
        logger.warning("邮件发送失败: %s: %s", type(e).__name__, e)
        code = "smtp_tls_mismatch" if "WRONG_VERSION_NUMBER" in str(e).upper() else "smtp_tls_error"
        _record_email("failed", started_at, code)
        return {"status": "failed", "error_code": code,
                "message": "SMTP TLS 连接失败，请检查端口与 SSL/TLS 设置"}
    except Exception as e:
        logger.warning("邮件发送失败: %s: %s", type(e).__name__, e)
        _record_email("failed", started_at, "smtp_delivery_error")
        return {"status": "failed", "error_code": "smtp_delivery_error",
                "message": "SMTP 连接、认证或发送失败，请检查配置和服务状态"}


def send_email(subject: str, body: str, *, to_addr: str | None = None, html: str | None = None,
               smtp_config=None, template: str = "notification", title: str | None = None,
               preheader: str | None = None, sections=None, actions=None,
               theme: str = "light", palette: str = "mist") -> bool:
    """兼容旧调用方：只返回是否已被 SMTP 接受。"""
    return send_email_with_status(
        subject, body, to_addr=to_addr, html=html, smtp_config=smtp_config,
        template=template, title=title, preheader=preheader, sections=sections, actions=actions,
        theme=theme, palette=palette,
    ).get("status") == "sent"


def send_test_email(*, host: str, port: int, user: str, password: str,
                    from_addr: str, to_addr: str, use_ssl: bool,
                    template: str = "test", theme: str = "light", palette: str = "mist") -> None:
    """SMTP 连通测试：用传入的（可能未保存的）参数发一封测试邮件。失败抛异常（调用方捕获给提示）。"""
    from_name, real_from = _resolve_from(from_addr, user)
    content = render_email(
        template=template, subject="咕咕 · 邮件样式测试", title="邮件样式测试",
        preheader="咕咕为你整理了一封结构清晰的邮件",
        body="这是来自咕咕开发页面的邮件样式测试，收到即表示 SMTP 配置和邮件模板均可用。",
        sections=[{"heading": "模板预览", "text": f"当前模板：{template}"}],
        theme=theme, palette=palette,
    )
    msg = _build_msg(
        "咕咕 · 邮件样式测试", content.plain, from_name, real_from, to_addr, content.html,
    )
    _deliver(host=host, port=port, user=user, password=password, use_ssl=use_ssl, msg=msg)


def send_reset_email(*, to_addr: str, username: str, link: str, theme: str = "light", palette: str = "mist") -> bool:
    """发送密码重置邮件（含纯文本 + HTML 按钮）。"""
    subject = "咕咕 · 重置密码"
    body = (
        f"你正在重置咕咕账号「{username}」的密码。\n\n"
        f"点击下面的链接设置新密码（30 分钟内有效）：\n{link}\n\n"
        "如果这不是你本人操作，忽略此邮件即可，密码不会变动。"
    )
    return send_email(subject, body, to_addr=to_addr, template="security", title="咕咕 · 重置密码",
                      sections=[{"heading": "操作说明", "text": f"点击下面的按钮设置新密码，链接 30 分钟内有效。\n{link}"}],
                      actions=[{"label": "重置密码", "url": link}], theme=theme, palette=palette)


def notify_feedback(username: str, category: str, content: str, *, theme: str = "light", palette: str = "mist") -> None:
    cfg = get_settings().smtp
    enabled = cfg.get("feedback_email_enabled", True) if isinstance(cfg, dict) else cfg.feedback_email_enabled
    if not enabled:
        return
    category_labels = {"bug": "Bug 反馈", "suggestion": "功能建议", "other": "其他"}
    label = category_labels.get(category, category)
    subject = f"[咕咕反馈] {label} · {username}"
    body = f"用户：{username}\n分类：{label}\n\n{content}"
    send_email(subject, body, template="report", title=subject, theme=theme, palette=palette)
