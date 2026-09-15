"""链接按钮（PRD-LLM-24）的输入与 URL 安全校验。

send_link_buttons 工具入口和 Gateway 出站前共用同一套校验；只做静态安全检查，
不为验证 URL 而请求目标站点，也不跟随重定向。
"""
from __future__ import annotations

import os
import re
from urllib.parse import urlparse

from app.core.url_security import url_is_safe

MAX_MESSAGE_CHARS = 2000
MAX_BUTTONS = 5
MAX_BUTTON_ID_CHARS = 64
MAX_LABEL_CHARS = 40
MAX_URL_CHARS = 2048

# 标签禁止控制字符（含 C0 与 DEL），避免按钮渲染和日志被注入不可见内容。
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
# 显式端口只放行 https/http 的默认语义端口；其余一律视为非法端口拒绝。
_ALLOWED_EXPLICIT_PORTS = {80, 443}


def _allow_http() -> bool:
    """http:// 是否放行由部署配置决定（GUGU_LINK_BUTTON_ALLOW_HTTP=on）；生产默认拒绝。"""
    return os.getenv("GUGU_LINK_BUTTON_ALLOW_HTTP", "off").strip().lower() in {"on", "1", "true", "yes"}


def _domain_allowlist() -> list[str]:
    """部署配置的域名白名单（GUGU_LINK_BUTTON_DOMAIN_ALLOWLIST，逗号分隔）。

    为空 = 放行全部公网 HTTPS 域名；非空时只允许列表内域名（含子域）。
    白名单只能由部署配置管理，模型无法动态扩大（PRD-LLM-24 §12）。
    """
    raw = os.getenv("GUGU_LINK_BUTTON_DOMAIN_ALLOWLIST", "")
    return [item.strip().lower().lstrip(".") for item in raw.split(",") if item.strip()]


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
    if scheme not in {"https"} and not (scheme == "http" and _allow_http()):
        return "只支持 https:// 链接（http 与自定义 scheme 未开放）"
    if parsed.username or parsed.password:
        return "URL 不能包含用户名或密码"
    if parsed.port is not None and parsed.port not in _ALLOWED_EXPLICIT_PORTS:
        return "URL 使用了不允许的端口"
    host = (parsed.hostname or "").lower()
    allowlist = _domain_allowlist()
    if allowlist and not any(host == domain or host.endswith("." + domain) for domain in allowlist):
        return "该域名不在链接按钮白名单内，请使用已配置的 HTTPS 域名"
    # 复用外部请求安全边界：拒绝内网、本机、链路本地和云元数据地址。
    return url_is_safe(raw)


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
