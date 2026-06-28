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
    if isinstance(cfg, dict):   # apply_override 后嵌套配置段可能是 dict，统一成可属性访问（同 voice）
        from types import SimpleNamespace
        cfg = SimpleNamespace(**cfg)
    to = to_addr or cfg.to_addr
    if not cfg.host or not to:
        return False
    from_name, from_addr = _resolve_from(cfg.from_addr, cfg.user)
    msg = _build_msg(subject, body, from_name, from_addr, to, html)
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
    from_name, real_from = _resolve_from(from_addr, user)
    msg = _build_msg(
        "咕咕 · SMTP 测试邮件",
        "这是来自咕咕后台的 SMTP 连通性测试邮件，收到即表示配置正确。",
        from_name, real_from, to_addr)
    _deliver(host=host, port=port, user=user, password=password, use_ssl=use_ssl, msg=msg)


def send_reset_email(*, to_addr: str, username: str, link: str) -> bool:
    """发送密码重置邮件（含纯文本 + HTML 按钮）。走 send_email，沿用已保存的 SMTP 配置。"""
    subject = "咕咕 · 重置密码"
    body = (
        f"你正在重置咕咕账号「{username}」的密码。\n\n"
        f"点击下面的链接设置新密码（30 分钟内有效）：\n{link}\n\n"
        "如果这不是你本人操作，忽略此邮件即可，密码不会变动。"
    )
    html = f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1e2028">
  <p style="font-size:15px">你正在重置咕咕账号「<b>{username}</b>」的密码。</p>
  <p style="font-size:14px;color:#5a5f72">点击下面的按钮设置新密码，链接 <b>30 分钟内有效</b>：</p>
  <p style="margin:24px 0">
    <a href="{link}" style="display:inline-block;padding:11px 26px;background:linear-gradient(135deg,#7b7fb2,#9590c4);color:#fff;text-decoration:none;border-radius:11px;font-size:14px;font-weight:600">重置密码</a>
  </p>
  <p style="font-size:12px;color:#8a8fa8">按钮打不开就复制下面的链接到浏览器：<br><span style="color:#7b7fb2;word-break:break-all">{link}</span></p>
  <p style="font-size:12px;color:#a0a4b8;margin-top:20px;border-top:1px solid #eee;padding-top:14px">如果这不是你本人操作，忽略此邮件即可，密码不会变动。</p>
</div>"""
    return send_email(subject, body, to_addr=to_addr, html=html)


def notify_feedback(username: str, category: str, content: str) -> None:
    category_labels = {"bug": "Bug 反馈", "suggestion": "功能建议", "other": "其他"}
    label = category_labels.get(category, category)
    subject = f"[咕咕反馈] {label} · {username}"
    body = f"用户：{username}\n分类：{label}\n\n{content}"
    send_email(subject, body)
