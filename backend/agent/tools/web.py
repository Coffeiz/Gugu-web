"""web 工具集：http_get —— 给 prompt skills 用的窄口联网取数（GET only）。

安全（防 SSRF 打内网）：
- 解析目标主机的 IP，**拒绝私网 / 环回 / 链路本地 / 多播 / 保留地址**（挡掉 192.168/10/127/169.254 等，
  保护同网段的 Redis/DB 与云元数据 169.254.169.254）；
- **不跟随重定向**（否则公网域可 302 跳内网绕过校验）；
- 响应体截断，避免塞爆上下文。
默认放行所有公网地址；要更严格可在 `_ALLOW_HOSTS` 填正向白名单。
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

import httpx

from agent.tools.base import BaseSkill, Tool

_MAX_BODY = 4000
_ALLOW_HOSTS: set[str] = set()   # 非空时只放行这些主机；空 = 放行所有公网


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
    body = r.text or ""
    return {
        "status": r.status_code,
        "url": url,
        "body": body[:_MAX_BODY],
        "truncated": len(body) > _MAX_BODY,
    }


class WebSkill(BaseSkill):
    name = "web"
    tools = [
        Tool(
            name="http_get",
            label="联网取数",
            description="对指定 URL 发 GET 请求，返回响应文本（仅公网、不跟随重定向、内容截断）。"
                        "供天气等技能取实时数据用——通常由 use_skill 拉到的技能说明里指示你调用。",
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
