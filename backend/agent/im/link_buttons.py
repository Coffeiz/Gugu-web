"""链接按钮（PRD-LLM-24）的输入与 URL 安全校验。

send_link_buttons 工具入口和 Gateway 出站前共用同一套校验；只做静态安全检查，
不为验证 URL 而请求目标站点，也不跟随重定向。

链接按钮支持 HTTPS、HTTP、系统入口和自定义 App Scheme；仅禁止会执行脚本、
读取本地文件或进入浏览器内部上下文的危险 Scheme。按钮不会由后端请求目标 URL，
因此不复用面向服务端出站请求的公网地址或域名白名单限制。
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

MAX_MESSAGE_CHARS = 2000
MAX_BUTTONS = 5
MAX_BUTTON_ID_CHARS = 64
MAX_LABEL_CHARS = 40
MAX_URL_CHARS = 2048

# 标签禁止控制字符（含 C0 与 DEL），避免按钮渲染和日志被注入不可见内容。
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
# 这些 Scheme 可能执行脚本、读取本地资源或进入浏览器内部页面，不能作为
# 模型生成的导航按钮目标。其余已带 Scheme 的 URL 按黑名单策略放行。
_BLOCKED_SCHEMES = {
    "javascript",
    "data",
    "vbscript",
    "file",
    "blob",
    "filesystem",
    "about",
    "chrome",
    "chrome-extension",
    "resource",
    "view-source",
}


def validate_link_button_url(url: str) -> str | None:
    """校验单个按钮 URL；返回 None 表示通过，否则返回可直接展示给模型的拒绝原因。"""
    raw = str(url or "").strip()
    if not raw:
        return "URL 不能为空"
    if len(raw) > MAX_URL_CHARS:
        return f"URL 超过 {MAX_URL_CHARS} 字符上限"
    if _CONTROL_CHARS_RE.search(raw):
        return "URL 含有非法控制字符"
    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    if not scheme:
        return "URL 必须包含协议 Scheme"
    if scheme in _BLOCKED_SCHEMES:
        return "该 URL 使用了禁止的危险 Scheme"
    if parsed.username or parsed.password:
        return "URL 不能包含用户名或密码"
    return None


def validate_link_buttons_payload(message: str, buttons: object) -> tuple[list[dict] | None, str]:
    """校验 send_link_buttons 整组输入；返回 (规范化按钮列表, 错误文案)。

    任一按钮校验失败即整组拒绝（PRD §11）：不发送缺少按钮的残缺导航组。
    """
    text = str(message or "").strip()
    if not text:
        return None, "message 不能为空"
    if len(text) > MAX_MESSAGE_CHARS:
        return None, f"message 超过 {MAX_MESSAGE_CHARS} 字符上限"
    if _CONTROL_CHARS_RE.search(text):
        return None, "message 含有非法控制字符"
    if not isinstance(buttons, list) or not buttons:
        return None, "buttons 必须是 1 到 5 个按钮的数组"
    if len(buttons) > MAX_BUTTONS:
        return None, f"buttons 一次最多 {MAX_BUTTONS} 个"

    seen_ids: set[str] = set()
    normalized: list[dict] = []
    for index, item in enumerate(buttons, start=1):
        if not isinstance(item, dict):
            return None, f"第 {index} 个按钮格式不正确"
        button_id = str(item.get("id") or "").strip()
        label = str(item.get("label") or "").strip()
        url = str(item.get("url") or "").strip()
        if not 1 <= len(button_id) <= MAX_BUTTON_ID_CHARS:
            return None, f"第 {index} 个按钮的 id 长度须为 1~{MAX_BUTTON_ID_CHARS}"
        if button_id in seen_ids:
            return None, f"按钮 id「{button_id}」重复，同一调用内必须唯一"
        seen_ids.add(button_id)
        if not label:
            return None, f"第 {index} 个按钮缺少 label"
        if len(label) > MAX_LABEL_CHARS:
            return None, f"按钮「{label}」的 label 超过 {MAX_LABEL_CHARS} 字符上限"
        if _CONTROL_CHARS_RE.search(label):
            return None, f"按钮「{label}」的 label 含有非法控制字符"
        url_error = validate_link_button_url(url)
        if url_error:
            return None, f"按钮「{label}」的 URL 未通过安全校验：{url_error}"
        normalized.append({"id": button_id, "label": label, "url": url})
    return normalized, ""
