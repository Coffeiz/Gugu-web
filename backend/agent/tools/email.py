"""邮件工具：复用 Admin SMTP 配置发送受控的纯文本/HTML 双格式邮件。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re

from agent.security import confirm
from agent.tools.base import BaseSkill, Tool, automation_tool_allowed
from app.services.email import send_email_with_status
from app.services.email.templates import EMAIL_PALETTES, EMAIL_THEMES, TEMPLATES
from app.services.email.queries import (
    get_enabled_user_smtp,
    get_owned_client,
    get_user_email,
    get_user_email_preferences,
)


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


def _confirmation_identity(*, recipient, subject, body, html, template, title,
                           preheader, sections, actions, theme, palette) -> str:
    payload = {
        "recipient": recipient, "subject": subject, "body": body, "html": html,
        "template": template, "title": title, "preheader": preheader,
        "sections": sections, "actions": actions, "theme": theme, "palette": palette,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"send_email:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


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
    requested_theme = str(args.get("theme") or "auto").strip().lower()
    requested_palette = str(args.get("palette") or "auto").strip().lower()
    if requested_theme not in {"auto", *EMAIL_THEMES}:
        return {"error": "不支持的邮件主题，仅支持 auto、light 或 dark"}
    if requested_palette not in {"auto", *EMAIL_PALETTES}:
        return {"error": "不支持的邮件配色，仅支持 auto、mist、cafe、rose、sky 或 sage"}
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
        client = await get_owned_client(db, user_id, client_id)
        if client is None:
            return {"error": "客户不存在"}
        recipient = (client.email or "").strip()
        recipient_source = f"客户 {client.name}"
        if not recipient:
            return {"error": "该客户没有邮箱地址"}
    elif not recipient:
        recipient = await get_user_email(db, user_id)
        recipient_source = "当前用户注册邮箱"

    if not _EMAIL_RE.fullmatch(recipient):
        return {"error": "收件人邮箱格式无效"}

    format_label = "咕咕标准 HTML + 纯文本" if not html else "纯文本 + HTML"
    summary = f"将发送{format_label}邮件至 {_mask_email(recipient)}（{recipient_source}），主题：{subject}。正文共 {len(body)} 个字符。"
    preferences = await get_user_email_preferences(db, user_id)
    theme = requested_theme if requested_theme != "auto" else preferences.get("theme", "light")
    palette = requested_palette if requested_palette != "auto" else preferences.get("palette", "mist")
    if not automation_tool_allowed("send_email"):
        blocked = confirm.needs_confirmation(
            args, summary, user_id,
            identity=_confirmation_identity(
                recipient=recipient, subject=subject, body=body, html=html,
                template=template, title=title, preheader=preheader,
                sections=sections, actions=actions, theme=theme, palette=palette,
            ),
            instruction="邮件发送不可撤回。请确认收件人、主题和正文后，带 confirm=true 与本次 confirm_token 再次调用。",
        )
        if blocked is not None:
            return blocked

    smtp_config = await get_enabled_user_smtp(db, user_id)
    try:
        send_kwargs = {"to_addr": recipient, "smtp_config": smtp_config}
        if html is not None:
            send_kwargs["html"] = html
        elif any(key in args for key in ("template", "title", "preheader", "sections", "actions", "theme", "palette")) or theme != "light" or palette != "mist":
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
            description_short="发送标准或受控 HTML+纯文本邮件；发送前确认并返回 SMTP 状态。",
            description="发送邮件。subject 和 body 必填，body 是所有客户端的纯文本降级内容。默认使用 notification 模板，由服务端生成咕咕标准排版；可用 notification、reminder、report、security 或 test 模板，并用 title、preheader、sections（heading/text 数组）和 actions（label/url 数组）表达结构化内容。theme 和 palette 默认 auto，跟随用户偏好；也可分别指定 light/dark 和 mist/cafe/rose/sky/sage。用户明确要求自定义邮件排版时，也可以传 html，但必须同时提供完整 body；html 只能使用基础邮件标签（a、b、blockquote、br、code、div、em、h1-h3、hr、i、img、li、ol、p、pre、span、strong、table、tbody、td、th、thead、tr、u、ul）、允许的内联样式和 http/https/mailto 链接，不要使用 script、style、事件属性、表单、iframe、svg、外部资源、flex/grid 或复杂定位。服务端会再次清洗 HTML，不能依赖被清洗的内容；html 最多 40000 个字符。test 仅用于 SMTP 测试场景。用户说‘发我邮箱’、‘发到我的邮箱’或未指定收件人时，必须省略 to，工具会自动发送到当前用户注册邮箱；不要向用户索要邮箱地址。可用 to 指定其他邮箱，或用 client_id 发给当前用户的客户邮箱。交互式发送前必须确认；已由用户授权的定时任务执行时不要再次请求确认。",
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
                    "theme": {"type": "string", "enum": ["auto", "light", "dark"]},
                    "palette": {"type": "string", "enum": ["auto", "mist", "cafe", "rose", "sky", "sage"]},
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
