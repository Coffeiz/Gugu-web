"""web 工具集：http_get —— 给 prompt skills 用的窄口联网取数（GET only）。

安全（防 SSRF 打内网）：
- 解析目标主机的 IP，**拒绝私网 / 环回 / 链路本地 / 多播 / 保留地址**（挡掉 192.168/10/127/169.254 等，
  保护同网段的 Redis/DB 与云元数据 169.254.169.254）；
- **不跟随重定向**（否则公网域可 302 跳内网绕过校验）；
- 响应体截断，避免塞爆上下文。
默认放行所有公网地址；要更严格可在 `_ALLOW_HOSTS` 填正向白名单。

按 Content-Type 分支处理，而不是无脑截断原始响应体：
- `text/html` → trafilatura 提取正文转 markdown（去导航/广告/JS 噪音，顺带带出内联链接方便接力读）；
  提取不出实质内容（返回 None 或过短）大概率是纯 JS 渲染页面，直接告知模型别硬解析、改走搜索；
- `application/pdf` → 复用 `app/core/doctext.py` 现成的 pdftotext 提取（同文件库/聊天附件读 PDF 一套逻辑）；
- 其它（JSON/纯文本等）→ 原样返回，截断防塞爆上下文。
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

import httpx

from agent.tools.base import BaseSkill, Tool

_MAX_BODY = 4000
_ALLOW_HOSTS: set[str] = set()   # 非空时只放行这些主机；空 = 放行所有公网
_MIN_EXTRACTED = 100    # trafilatura 提取结果短于此视为「没读到正文」（空页/错误页/纯 JS 渲染）


def _host_allowed(host: str) -> bool:
    if _ALLOW_HOSTS and host not in _ALLOW_HOSTS:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return False
    return True


def _looks_like_html(text: str) -> bool:
    head = text.lstrip()[:100].lower()
    return head.startswith("<!doctype html") or head.startswith("<html")


async def _http_get(db, user_id, args: dict):
    url = (args.get("url") or "").strip()
    if not url:
        return {"error": "缺少 url"}
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return {"error": "非法 url"}
    if not _host_allowed(p.hostname):
        return {"error": "该地址不允许访问（仅放行公网地址）"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0), follow_redirects=False) as c:
            r = await c.get(url, headers={"User-Agent": "curl/8"})
    except Exception as e:
        return {"error": f"请求失败：{type(e).__name__}"}

    content_type = (r.headers.get("content-type") or "").split(";")[0].strip().lower()

    if content_type == "application/pdf":
        from app.core import doctext
        try:
            text = await doctext.extract_text(r.content, "pdf")
        except Exception as e:
            return {"error": f"PDF 提取失败：{e}"}
        return {"status": r.status_code, "url": url, "content_type": content_type,
                "body": text[:_MAX_BODY], "truncated": len(text) > _MAX_BODY}

    if content_type in ("text/html", "application/xhtml+xml") or (not content_type and _looks_like_html(r.text)):
        import trafilatura
        extracted = trafilatura.extract(r.text, include_links=True, output_format="markdown", with_metadata=True)
        if not extracted or len(extracted) < _MIN_EXTRACTED:
            return {"status": r.status_code, "url": url,
                    "error": "抓到了但没读出正文——可能是空页/错误页，也可能是纯 JS 渲染页面（HTTP 抓不到"
                             "客户端渲染的内容）。先看 status 是否正常；status 正常但读不到正文的话，"
                             "换 web_search/deep_research 查这个主题，或换个来源"}
        return {"status": r.status_code, "url": url, "content_type": content_type,
                "body": extracted[:_MAX_BODY], "truncated": len(extracted) > _MAX_BODY}

    body = r.text or ""
    return {
        "status": r.status_code,
        "url": url,
        "content_type": content_type,
        "body": body[:_MAX_BODY],
        "truncated": len(body) > _MAX_BODY,
    }


class WebSkill(BaseSkill):
    name = "web"
    tools = [
        Tool(
            name="http_get",
            label="联网取数 / 读网页",
            description="对指定 URL 发 GET 请求（仅公网、不跟随重定向）。网页（text/html）自动提取正文转 "
                        "markdown（去导航/广告/JS 噪音，带内联链接——想接着读某条链接就再调一次 http_get 传"
                        "那个 URL，不用重新搜）；PDF 自动提取文字；其它（JSON/纯文本等）原样返回，内容截断。"
                        "读不出正文（返回 error 提示可能是 JS 渲染页面）就换 web_search/deep_research。"
                        "也供天气等技能取实时数据用——通常由 use_skill 拉到的技能说明里指示你调用。",
            input_schema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "完整 URL，如 https://wttr.in/Beijing?format=3"},
                },
                "required": ["url"],
            },
            handler=_http_get,
        ),
    ]


WebSkill().register()
