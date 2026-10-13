"""兼容旧导入路径；实现位于 `agent.gateway.wechat.config_cache`。"""

from .wechat.config_cache import (
    CONFIG_CACHE_INITIAL_RETRY_MS,
    CONFIG_CACHE_MAX_RETRY_MS,
    CONFIG_CACHE_TTL_MS,
    WeixinConfigManager,
)

__all__ = [
    "CONFIG_CACHE_INITIAL_RETRY_MS",
    "CONFIG_CACHE_MAX_RETRY_MS",
    "CONFIG_CACHE_TTL_MS",
    "WeixinConfigManager",
]
