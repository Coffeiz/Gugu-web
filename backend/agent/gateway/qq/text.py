"""QQ 正文链接适配；只改变出站展示，不修改会话原文。"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlencode, urlsplit

from agent.outbound import sanitize_im_links

_MARKDOWN_LINK = re.compile(r"\[([^\]\n]*)\]\(([^\s)]*)(\)?)")
_CUSTOM_URI = re.compile(r"(?<![\w])([a-zA-Z][a-zA-Z0-9+.-]*):/{1,2}[^\s<>`\[\]（）()]*")
_UNSUPPORTED = "（QQ 不支持直接打开此链接）"


def _web_target(target: str) -> str | None:
    """仅将可明确等价的百度 POI 协议转换为网页，不猜测其他应用路由。"""
    try:
        parsed = urlsplit(target)
        if parsed.scheme.lower() in {"http", "https"}:
            return target
        if (parsed.scheme.lower(), parsed.netloc.lower(), parsed.path) == (
            "baidumap", "map", "/place/detail",
        ):
            values = parse_qs(parsed.query).get("uid", [])
            if len(values) == 1 and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", values[0]):
                return "https://api.map.baidu.com/place/detail?" + urlencode({
                    "uid": values[0], "output": "html",
                })
    except ValueError:
        pass
    return None


def complete_qq_lines(text: str) -> str:
    """只提交完整行，未完成 URI/Markdown 所在行不得进入不可修改的流前缀。"""
    return text[:text.rfind("\n") + 1]


def prepare_qq_text(text: str, *, final: bool = True) -> str:
    """共享正文转换；流中只转换完整行，结束时再提交尾行，避免改写已发送前缀。"""
    if not final:
        text = complete_qq_lines(text)
    text = sanitize_im_links(text)

    def markdown_link(match: re.Match) -> str:
        label, target, _closed = match.groups()
        replacement = _web_target(target)
        if replacement:
            return f"[{label}]({replacement})"
        return label + _UNSUPPORTED

    text = _MARKDOWN_LINK.sub(markdown_link, text)

    def bare_uri(match: re.Match) -> str:
        if match.group(1).lower() in {"http", "https"}:
            return match.group(0)
        return _web_target(match.group(0)) or _UNSUPPORTED

    return _CUSTOM_URI.sub(bare_uri, text)


def prepare_qq_link_buttons(buttons: list[dict]) -> tuple[list[dict], list[dict]]:
    """平台适配独立于通用安全校验；保留可发送按钮，明确列出不支持的入口。"""
    supported, unsupported = [], []
    for button in buttons:
        target = _web_target(button['url'])
        if target is None:
            unsupported.append(dict(button))
        else:
            supported.append({**button, 'url': target})
    return supported, unsupported


def prepare_qq_link_button_message(message: str, buttons: list[dict]) -> tuple[str, list[dict], dict]:
    """组合原生按钮与不支持入口说明，让跨平台发送编排只负责投递。"""
    supported, unsupported = prepare_qq_link_buttons(buttons)
    text = prepare_qq_text(message)
    details = {}
    if unsupported:
        text += "\n" + "\n".join(
            f"· {button['label']}：QQ 不支持直接打开此链接" for button in unsupported
        )
        details = {
            "requested_button_count": len(buttons),
            "unsupported_button_ids": [button['id'] for button in unsupported],
        }
    return text, supported, details
