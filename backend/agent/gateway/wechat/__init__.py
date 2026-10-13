"""微信 Gateway 的稳定兼容入口。

兼容模块从 ``agent.gateway.wechat_*`` 导入包内实现时，包初始化不能预先导入
``outbound``，否则会反向导入尚未完成初始化的兼容模块。按需加载保留旧入口，
同时让包内低层模块可独立导入。
"""

from importlib import import_module

_EXPORTS = {
    "DEFAULT_BASE_URL": (".client", "DEFAULT_BASE_URL"),
    "ILinkClient": (".client", "ILinkClient"),
    "TypingIndicator": (".typing", "TypingIndicator"),
    "send_file": (".outbound", "send_file"),
    "send_image": (".outbound", "send_image"),
    "send_text": (".outbound", "send_text"),
    "start_typing": (".outbound", "start_typing"),
    "stop_typing": (".outbound", "stop_typing"),
    "serve": (".runtime", "serve"),
}


def __getattr__(name: str):
    try:
        module_name, attribute = _EXPORTS[name]
    except KeyError as exc:
        raise AttributeError(name) from exc
    return getattr(import_module(module_name, __name__), attribute)

__all__ = [
    "DEFAULT_BASE_URL",
    "ILinkClient",
    "TypingIndicator",
    "send_file",
    "send_image",
    "send_text",
    "serve",
    "start_typing",
    "stop_typing",
]
