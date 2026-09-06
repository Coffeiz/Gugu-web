"""文件事实源同步的协议、投影、TS watcher 与恢复入口。"""
from .protocol import (
    FILE_SYNC_PROTOCOL_VERSION,
    FileSyncDisabled,
    FileSyncOperation,
    FileSyncSource,
    FileSyncMode,
    FileSyncStatus,
    build_idempotency_key,
    normalize_relative_path,
    validate_sync_path,
    is_file_sync_enabled,
    record_change,
    create_binding,
)
from .reconcile import SyncSummary, reconcile_local_directory
from .bindings import (
    BindingSyncResult,
    dry_run_local_binding,
    get_user_binding,
    list_user_bindings,
    list_user_conflicts,
    resolve_local_binding_root,
    resolve_sync_conflict,
    sync_local_binding,
    sync_existing_binding,
)
from .outbox import deliver_file_event, deliver_pending_file_events, enqueue_file_event
from .watcher import FileSyncWatcherManager

__all__ = [
    "FILE_SYNC_PROTOCOL_VERSION", "FileSyncDisabled", "FileSyncOperation",
    "FileSyncSource", "FileSyncMode", "FileSyncStatus", "build_idempotency_key",
    "normalize_relative_path", "validate_sync_path", "is_file_sync_enabled",
    "record_change", "create_binding",
    "SyncSummary", "reconcile_local_directory",
    "BindingSyncResult", "dry_run_local_binding", "sync_local_binding",
    "sync_existing_binding",
    "get_user_binding", "list_user_bindings", "list_user_conflicts",
    "resolve_local_binding_root", "resolve_sync_conflict",
    "enqueue_file_event", "deliver_file_event", "deliver_pending_file_events",
    "FileSyncWatcherManager",
]
