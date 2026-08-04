"""外部下载 URL 的 SSRF 安全校验。"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


def url_is_safe(url: str) -> str | None:
    """校验外部 URL，拒绝内网、本机、链路本地和云元数据地址。"""
    try:
        parsed = urlparse(url)
    except Exception:
        return "URL 格式不合法"
    if parsed.scheme not in ("http", "https"):
        return "只支持 http/https 链接"
    host = parsed.hostname
    if not host:
        return "URL 缺少主机名"
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return "域名解析失败"
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return "该地址指向内网/本机，出于安全考虑不予下载"
    return None
