"""Admin API 的可选 Host 入口限制。"""

from __future__ import annotations


def _normalize_hostname(value: str | None) -> str | None:
    if not value:
        return None
    hostname = value.strip().rstrip(".").lower()
    if not hostname or any(char in hostname for char in "/:*@"):
        return None
    try:
        return hostname.encode("idna").decode("ascii")
    except UnicodeError:
        return None


def is_admin_api_host_allowed(
    path: str,
    hostname: str | None,
    configured_hosts: str,
) -> bool:
    """Host 白名单仅保护 Admin API；普通用户 API 不受其影响。

    白名单为空时保持兼容。配置非空但格式无效时不会放宽访问。
    """
    if path != "/api/v1/admin" and not path.startswith("/api/v1/admin/"):
        return True
    if not configured_hosts.strip():
        return True

    host = _normalize_hostname(hostname)
    if host is None:
        return False
    allowed_hosts = {
        normalized
        for item in configured_hosts.split(",")
        if (normalized := _normalize_hostname(item)) is not None
    }
    return host in allowed_hosts
