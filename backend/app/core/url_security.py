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
    """校验外部 URL，拒绝内网、本机、链路本地和云元数据地址。

    ⚠️ 仅校验用途：这里 resolve 出的 IP 不会被后续真正发起的连接复用——httpx 建连时会
    自己独立再 resolve 一次。攻击者控制的域名完全可以在两次解析之间把 A 记录从公网 IP
    换成 127.0.0.1/内网 IP（经典 DNS rebinding TOCTOU），"校验一次、连接再解析一次"这个
    模式本身堵不住这个洞。真正需要连接外部 URL 的调用方必须用 `resolve_pinned_ip()` 把
    校验和连接绑定到同一个 IP 上（见该函数文档）。这个函数目前只保留给不发起真实网络连接、
    仅做前置提示校验的场景使用。
    """
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


def resolve_pinned_ip(url: str) -> tuple[str | None, str | None]:
    """解析并校验 URL 的 host，返回 (安全的 IP, error)。

    专给"真的要发起网络连接"的调用方用，解决 url_is_safe() 天然带的 DNS rebinding
    TOCTOU：调用方必须把这里返回的 IP 原样用于实际连接（而不是再把 URL 交给 httpx
    自己 resolve），配合 Host 头/SNI 保留原始域名，才能保证「校验的地址」和「真正连接
    的地址」是同一个，不给攻击者在两次解析之间切换 A 记录的机会。

    同一域名解析出多个 IP 时，只要有一个落在禁止范围内就整体拒绝（保守策略：不去猜
    "会连到哪一个"），否则固定返回第一个解析结果，调用方每一跳都应重新调用本函数，
    不能复用上一跳解析到的 IP。
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return None, "URL 格式不合法"
    if parsed.scheme not in ("http", "https"):
        return None, "只支持 http/https 链接"
    host = parsed.hostname
    if not host:
        return None, "URL 缺少主机名"
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return None, "域名解析失败"
    ips: list[str] = []
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if is_blocked_ip(ip):
            return None, "该地址指向内网/本机，出于安全考虑不予下载"
        ips.append(str(ip))
    if not ips:
        return None, "域名解析失败"
    return ips[0], None
