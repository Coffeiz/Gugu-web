"""咕咕邮件的语义字段与静态模板渲染。"""
from __future__ import annotations

from dataclasses import dataclass
from html import escape
from io import BytesIO
from functools import lru_cache
from pathlib import Path
from base64 import b64encode
from urllib.parse import urlparse

from PIL import Image, ImageColor


EMAIL_TOKENS = {
    "canvas": "#f3f4f8",
    "surface": "#ffffff",
    "brand": "#7b7fb2",
    "brand_dark": "#626694",
    "text": "#20222b",
    "muted": "#6f7486",
    "border": "#dfe2eb",
}
EMAIL_THEMES = {
    "light": EMAIL_TOKENS,
    "dark": {
        **EMAIL_TOKENS,
        "canvas": "#171925", "surface": "#232638", "brand": "#a5a3d4",
        "brand_dark": "#c0bee6", "text": "#f3f4f8", "muted": "#b7bbca", "border": "#41465c",
    },
}
EMAIL_PALETTES = {
    "mist": "#7b7fb2", "cafe": "#a67c5b", "rose": "#b56b82", "sky": "#598bb0", "sage": "#5f967e",
}
TEMPLATES = {"notification", "reminder", "report", "security", "test"}
_MAX_SECTIONS = 8
_MAX_ACTIONS = 3


@lru_cache(maxsize=32)
def _asset_payload(name: str, tint: str | None = None) -> bytes:
    path = Path(__file__).with_name("assets") / name
    if tint is None:
        return path.read_bytes()
    image = Image.open(path).convert("RGBA")
    color = ImageColor.getrgb(tint)
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            _, _, _, alpha = pixels[x, y]
            if alpha:
                pixels[x, y] = (*color, alpha)
    output = BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


@lru_cache(maxsize=32)
def _asset_data_uri(name: str, tint: str | None = None) -> str:
    """兼容旧调用方；邮件正文不再直接使用 data URI。"""
    payload = _asset_payload(name, tint)
    return "data:image/png;base64," + b64encode(payload).decode("ascii")


@dataclass(frozen=True)
class EmailInlineImage:
    """邮件 HTML 使用的 inline 资源，Content-ID 不来自用户输入。"""

    content_id: str
    data: bytes
    subtype: str = "png"
    filename: str = "image.png"


@dataclass(frozen=True)
class EmailContent:
    plain: str
    html: str
    inline_images: tuple[EmailInlineImage, ...] = ()

    def preview_html(self) -> str:
        """为浏览器预览内联资源；真实邮件仍使用 CID，避免 Gmail 过滤 data URI。"""
        result = self.html
        for image in self.inline_images:
            data_uri = f"data:image/{image.subtype};base64,{b64encode(image.data).decode('ascii')}"
            result = result.replace(f"cid:{image.content_id}", data_uri)
        return result


def _text(value: object, field: str, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是文本")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"{field} 不能超过 {limit} 个字符")
    return value


def _url(value: object) -> str:
    value = _text(value, "操作链接", 2048)
    parsed = urlparse(value)
    if parsed.scheme.lower() not in {"http", "https", "mailto"} or not parsed.netloc and parsed.scheme != "mailto":
        raise ValueError("操作链接只支持 http、https 或 mailto 协议")
    if any(ch in value for ch in "\r\n\x00"):
        raise ValueError("操作链接格式不合法")
    return value


def _sections(value: object) -> list[tuple[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > _MAX_SECTIONS:
        raise ValueError(f"sections 最多支持 {_MAX_SECTIONS} 个区块")
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("sections 必须是对象数组")
        heading = _text(item.get("heading"), "区块标题", 120)
        text = _text(item.get("text"), "区块正文", 5000)
        if not text:
            raise ValueError("区块正文不能为空")
        result.append((heading, text))
    return result


def _actions(value: object) -> list[tuple[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > _MAX_ACTIONS:
        raise ValueError(f"actions 最多支持 {_MAX_ACTIONS} 个操作")
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("actions 必须是对象数组")
        label = _text(item.get("label"), "操作名称", 80)
        if not label:
            raise ValueError("操作名称不能为空")
        result.append((label, _url(item.get("url"))))
    return result


def render_email(*, template: str = "notification", subject: str, body: str,
                 title: str | None = None, preheader: str | None = None,
                 sections: object = None, actions: object = None,
                 theme: str = "light", palette: str = "mist") -> EmailContent:
    """把模型提供的语义字段编译成稳定的纯文本和 HTML 双格式邮件。"""
    if template not in TEMPLATES:
        raise ValueError("不支持的邮件模板")
    token = dict(EMAIL_THEMES.get(theme, EMAIL_THEMES["light"]))
    if palette in EMAIL_PALETTES:
        token["brand"] = EMAIL_PALETTES[palette]
    subject = _text(subject, "邮件主题", 200)
    body = _text(body, "邮件正文", 20000)
    title = _text(title, "邮件标题", 200) or subject
    preheader = _text(preheader, "预览摘要", 180)
    section_items = _sections(sections)
    action_items = _actions(actions)
    defaults = {
        "reminder": "咕咕 · 日程提醒",
        "report": "咕咕 · 进展报告",
        "security": "咕咕 · 安全通知",
        "test": "咕咕 · SMTP 测试邮件",
    }
    if template in defaults and title == subject:
        title = defaults[template]
    plain_parts = [body]
    for heading, text in section_items:
        plain_parts.append(f"{heading}\n{text}" if heading else text)
    if action_items:
        plain_parts.append("\n".join(f"{label}: {url}" for label, url in action_items))
    plain = "\n\n".join(plain_parts)
    scrollbar_style = (
        f'<style>html{{color-scheme:dark}}::-webkit-scrollbar{{width:10px;height:10px}}'
        f'::-webkit-scrollbar-track{{background:{token["canvas"]}}}'
        f'::-webkit-scrollbar-thumb{{background:{token["border"]};border-radius:5px}}'
        f'</style>'
        if theme == "dark" else ""
    )
    logo_mark_cid = "gugu-logo-mark"
    logo_wordmark_cid = "gugu-logo-wordmark"
    logo_mark = f"cid:{logo_mark_cid}"
    logo_wordmark = f"cid:{logo_wordmark_cid}"
    logo_header = (
        f'<div style="text-align:center;padding:0 0 24px;margin:0;'
        f'border-bottom:1px solid {token["border"]}">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto">'
        f'<tr>'
        f'<td valign="middle" style="width:92px">'
        f'<img src="{logo_mark}" alt="" width="96" height="96" '
        f'style="display:block;width:96px;height:96px;object-fit:contain">'
        f'</td>'
        f'<td valign="middle" width="190" style="width:190px;text-align:center">'
        f'<img src="{logo_wordmark}" alt="咕咕" width="190" height="90" '
        f'style="display:block;width:190px;height:90px;object-fit:contain;margin:0 auto">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" style="width:190px;margin:0 auto">'
        f'<tr><td style="padding:2px 0 0;text-align:center;color:{token["muted"]};font-size:10px;'
        f'letter-spacing:.08em">{escape(template.upper())}</td></tr></table>'
        f'</td>'
        f'</tr></table></div>'
    )
    rows = [
        logo_header,
        '<div style="height:20px;line-height:20px;font-size:1px">&nbsp;</div>',
        f'<h1 style="margin:0;color:{token["text"]};font-size:24px;line-height:1.35">{escape(title)}</h1>',
    ]
    if preheader:
        rows.append(f'<div style="height:8px;line-height:8px;font-size:1px">&nbsp;</div>')
        rows.append(f'<p style="margin:0;color:{token["muted"]};font-size:13px">{escape(preheader)}</p>')
    rows.append('<div style="height:24px;line-height:24px;font-size:1px">&nbsp;</div>')
    rows.append(f'<div style="color:{token["text"]};font-size:15px;line-height:1.75">{escape(body).replace(chr(10), "<br>")}</div>')
    for heading, text in section_items:
        heading_html = f'<strong style="display:block;margin-bottom:6px;color:{token["text"]};font-size:13px">{escape(heading)}</strong>' if heading else ""
        rows.append('<div style="height:22px;line-height:22px;font-size:1px">&nbsp;</div>')
        rows.append(f'<div style="padding:17px;border-left:3px solid {token["brand"]};border-radius:0 8px 8px 0;background:{token["canvas"]};color:{token["muted"]};font-size:14px;line-height:1.7">{heading_html}{escape(text).replace(chr(10), "<br>")}</div>')
    if action_items:
        buttons = []
        for label, url in action_items:
            buttons.append(
                f'<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin:20px 8px 0 0">'
                f'<tr><td style="padding:9px 13px;background:{token["brand"]};border:1px solid transparent;'
                f'border-radius:8px;text-align:center;white-space:nowrap">'
                f'<a href="{escape(url, quote=True)}" style="display:block;color:#fff;text-decoration:none;'
                f'font-size:12px;line-height:1.3;font-weight:600">{escape(label)}</a></td></tr></table>'
            )
        rows.append("".join(buttons))
    html = f'''<!doctype html><html><head>{scrollbar_style}</head><body style="margin:0;background:{token["canvas"]};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:{token["text"]};color-scheme:{"dark" if theme == "dark" else "light"}">
<div style="display:none;max-height:0;overflow:hidden">{escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{token["canvas"]};padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;background:{token["surface"]};border:1px solid {token["border"]};border-radius:14px"><tr><td style="padding:40px">{''.join(rows)}
<p style="margin:28px 0 0;padding:16px 0 0;border-top:1px solid {token["border"]};color:{token["muted"]};font-size:12px">由咕咕发送 · SMTP 已接受不代表最终送达</p></td></tr></table></td></tr></table></body></html>'''
    return EmailContent(
        plain=plain,
        html=html,
        inline_images=(
            EmailInlineImage(logo_mark_cid, _asset_payload("logo-large2.png", token["brand"]), filename="logo-mark.png"),
            EmailInlineImage(logo_wordmark_cid, _asset_payload("logo-text2.png", token["brand"]), filename="logo-wordmark.png"),
        ),
    )
