"""外部下载 URL 的 SSRF 安全校验。"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


def is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """判断地址是否属于不允许外连的范围，包括 IPv4-mapped IPv6。"""
    mapped = getattr(ip, "ipv4_mapped", None)
    target = mapped or ip
    return any((
        target.is_private,
        target.is_loopback,
        target.is_link_local,
        target.is_multicast,
        target.is_reserved,
        target.is_unspecified,
    ))


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
        if is_blocked_ip(ip):
            return "该地址指向内网/本机，出于安全考虑不予下载"
    return None
