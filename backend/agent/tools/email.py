"""邮件工具：复用 Admin SMTP 配置发送受控的纯文本/HTML 双格式邮件。"""
from __future__ import annotations

import asyncio
import hashlib
import re

from sqlalchemy import select

from agent.security import confirm
from agent.tools.base import BaseSkill, Tool, automation_tool_allowed
from app.models import Client, User, UserPreferences, UserSmtpConfig
from app.services.email import send_email_with_status
from app.services.email.templates import TEMPLATES


_EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")
_MAX_SUBJECT_LENGTH = 200
_MAX_BODY_LENGTH = 20_000
_MAX_HTML_LENGTH = 40_000
_EMAIL_DELIVERY_TIMEOUT_SECONDS = 30
_SUPPORTED_TEMPLATES = tuple(sorted(TEMPLATES))


def _mask_email(value: str) -> str:
    local, _, domain = value.partition("@")
    masked = local if len(local) <= 2 else f"{local[0]}{'*' * (len(local) - 2)}{local[-1]}"
    return f"{masked}@{domain}"


async def _send_email(db, user_id, args: dict):
    subject = str(args.get("subject") or "").strip()
    body = str(args.get("body") or "").strip()
    html = str(args.get("html") or "").strip() or None
    template = str(args.get("template") or "notification").strip()
    if template not in TEMPLATES:
        return {"error": "不支持的邮件模板，仅支持 notification、reminder、report、security 或 test"}
    title = args.get("title")
    preheader = args.get("preheader")
    sections = args.get("sections")
    actions = args.get("actions")
    if not subject:
        return {"error": "邮件主题不能为空"}
    if len(subject) > _MAX_SUBJECT_LENGTH:
        return {"error": f"邮件主题不能超过 {_MAX_SUBJECT_LENGTH} 个字符"}
    if not body:
        return {"error": "邮件正文不能为空"}
    if len(body) > _MAX_BODY_LENGTH:
        return {"error": f"邮件正文不能超过 {_MAX_BODY_LENGTH} 个字符"}
    if html is not None and len(html) > _MAX_HTML_LENGTH:
        return {"error": f"HTML 邮件正文不能超过 {_MAX_HTML_LENGTH} 个字符"}

    explicit_to = str(args.get("to") or "").strip()
    client_id = args.get("client_id")
    if explicit_to and client_id is not None:
        return {"error": "to 与 client_id 不能同时指定"}

    recipient = explicit_to
    recipient_source = "用户指定"
    if client_id is not None:
        client = await db.scalar(select(Client).where(Client.id == client_id, Client.user_id == user_id))
        if client is None:
            return {"error": "客户不存在"}
        recipient = (client.email or "").strip()
        recipient_source = f"客户 {client.name}"
        if not recipient:
            return {"error": "该客户没有邮箱地址"}
    elif not recipient:
        recipient = (await db.scalar(select(User.email).where(User.id == user_id)) or "").strip()
        recipient_source = "当前用户注册邮箱"

    if not _EMAIL_RE.fullmatch(recipient):
        return {"error": "收件人邮箱格式无效"}

    format_label = "咕咕标准 HTML + 纯文本" if not html else "纯文本 + HTML"
    summary = f"将发送{format_label}邮件至 {_mask_email(recipient)}（{recipient_source}），主题：{subject}。正文共 {len(body)} 个字符。"
    if not automation_tool_allowed("send_email"):
        blocked = confirm.needs_confirmation(
            args, summary, user_id,
            identity=(
                f"send_email:{recipient}:{subject}:{len(body)}:{hashlib.sha256(body.encode('utf-8')).hexdigest()}"
                f":{hashlib.sha256((html or '').encode('utf-8')).hexdigest()}"
            ),
            instruction="邮件发送不可撤回。请确认收件人、主题和正文后，带 confirm=true 与本次 confirm_token 再次调用。",
        )
        if blocked is not None:
            return blocked

    smtp_config = await db.scalar(select(UserSmtpConfig).where(UserSmtpConfig.user_id == user_id, UserSmtpConfig.enabled.is_(True)))
    preferences = await db.scalar(select(UserPreferences).where(UserPreferences.user_id == user_id))
    preference_data = preferences.data if preferences else {}
    theme = preference_data.get("theme", "light")
    palette = preference_data.get("palette", "mist")
    try:
        send_kwargs = {"to_addr": recipient, "smtp_config": smtp_config}
        if html is not None:
            send_kwargs["html"] = html
        elif any(key in args for key in ("template", "title", "preheader", "sections", "actions")) or theme != "light" or palette != "mist":
            send_kwargs.update(
                template=template, title=title, preheader=preheader,
                sections=sections, actions=actions, theme=theme, palette=palette,
            )
        delivery = await asyncio.wait_for(asyncio.to_thread(
            send_email_with_status, subject, body, **send_kwargs,
        ), timeout=_EMAIL_DELIVERY_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        try:
            from app.core.opsmetrics import record_email
            record_email("failed", _EMAIL_DELIVERY_TIMEOUT_SECONDS * 1000, "smtp_timeout")
        except Exception:
            pass
        return {
            "status": "failed",
            "error_code": "smtp_timeout",
            "message": "邮件发送超时，SMTP 服务未在规定时间内响应",
        }
    if delivery.get("status") != "sent":
        return delivery
    return {
        "status": "sent",
        "delivery": "smtp_accepted",
        "success": True,
        "message": f"邮件已提交给 SMTP（收件人：{_mask_email(recipient)}），不代表最终送达",
    }


class EmailSkill(BaseSkill):
    name = "email"
    tools = [
        Tool(
            name="send_email", label="发送邮件",
            description_short="使用咕咕标准模板发送 HTML+纯文本邮件；交互式发送前确认并返回 SMTP 状态。",
            description="发送邮件。subject 和 body 必填，body 是所有客户端的纯文本降级内容。默认使用 notification 模板，由服务端生成咕咕标准排版；可用 notification、reminder、report、security 或 test 模板，并用 title、preheader、sections（heading/text 数组）和 actions（label/url 数组）表达结构化内容。test 仅用于 SMTP 测试场景。不要自行拼接 HTML；html 仅保留给受控的内部兼容调用。用户说‘发我邮箱’、‘发到我的邮箱’或未指定收件人时，必须省略 to，工具会自动发送到当前用户注册邮箱；不要向用户索要邮箱地址。可用 to 指定其他邮箱，或用 client_id 发给当前用户的客户邮箱。交互式发送前必须确认；已由用户授权的定时任务执行时不要再次请求确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "to": {"type": "string", "maxLength": 320},
                    "client_id": {"type": "integer"},
                    "subject": {"type": "string", "minLength": 1, "maxLength": _MAX_SUBJECT_LENGTH},
                    "body": {"type": "string", "minLength": 1, "maxLength": _MAX_BODY_LENGTH},
                    "template": {"type": "string", "enum": list(_SUPPORTED_TEMPLATES)},
                    "title": {"type": "string", "maxLength": 200},
                    "preheader": {"type": "string", "maxLength": 180},
                    "sections": {
                        "type": "array", "maxItems": 8,
                        "items": {"type": "object", "properties": {
                            "heading": {"type": "string", "maxLength": 120},
                            "text": {"type": "string", "minLength": 1, "maxLength": 5000},
                        }, "required": ["text"], "additionalProperties": False},
                    },
                    "actions": {
                        "type": "array", "maxItems": 3,
                        "items": {"type": "object", "properties": {
                            "label": {"type": "string", "minLength": 1, "maxLength": 80},
                            "url": {"type": "string", "minLength": 1, "maxLength": 2048},
                        }, "required": ["label", "url"], "additionalProperties": False},
                    },
                    "html": {"type": "string", "minLength": 1, "maxLength": _MAX_HTML_LENGTH},
                    "confirm": {"type": "boolean"},
                    "confirm_token": {"type": "string"},
                },
                "required": ["subject", "body"],
                "not": {"required": ["to", "client_id"]},
            },
            handler=_send_email, mutates=True, destructive=True,
        ),
    ]


EmailSkill().register()
