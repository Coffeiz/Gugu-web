"""文件同步模块的按需兼容导出。

保持历史 package-level 导入可用，但纯扫描/路径模块导入时不预加载 ORM、API
服务或 watcher。新代码应优先从具体职责模块导入。
"""
from __future__ import annotations

from importlib import import_module

_EXPORTS = {
    "FILE_SYNC_PROTOCOL_VERSION": "protocol",
    "FileSyncDisabled": "protocol",
    "FileSyncOperation": "protocol",
    "FileSyncSource": "protocol",
    "FileSyncMode": "protocol",
    "FileSyncStatus": "protocol",
    "build_idempotency_key": "protocol",
    "normalize_relative_path": "paths",
    "validate_sync_path": "protocol",
    "is_file_sync_enabled": "protocol",
    "record_change": "protocol",
    "record_canonical_file_change": "protocol",
    "create_binding": "protocol",
    "SyncSummary": "summary",
    "get_user_binding": "bindings",
    "list_user_bindings": "bindings",
    "list_user_conflicts": "bindings",
    "resolve_local_binding_root": "bindings",
    "resolve_sync_conflict": "bindings",
    "deliver_file_event": "outbox",
    "deliver_pending_file_events": "outbox",
    "enqueue_file_event": "outbox",
    "FileSyncWatcherManager": "watcher",
}

__all__ = list(_EXPORTS)


def __getattr__(name: str):
    module_name = _EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f"{__name__}.{module_name}"), name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted((*globals(), *__all__))
