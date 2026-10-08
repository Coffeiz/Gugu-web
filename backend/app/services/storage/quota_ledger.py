"""用户存储空间统一账本。

账本保留三类用量明细：用户持久空间、Shell 持久目录明细和 Shell 临时空间。
Local 用户持久空间按 File 记录 + 未登记 Workspace/Shell 文件合计；OSS 文件库与
Shell 持久空间仍分别限额。下载、构建和 Shell 是 operation，不重复创建配额判断。目录对账采用实际
文件系统测量，数据库文件库采用存活 File 行汇总；两者都保留校准事件。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from agent.sandbox.quota import ensure_sandbox_root, measure_directory
from app.core.config import get_settings
from app.core.tz import now_utc
from app.models import File, StorageQuotaEvent, StorageQuotaLedger, User
from app.services.storage.quota_limits import resolve_file_library_limit

FILE_LIBRARY = "file_library"
SHELL_PERSISTENT = "shell_persistent"
SHELL_EPHEMERAL = "shell_ephemeral"
DEFAULT_WORKSPACE_FOLDER_NAME = "default"
_CATEGORIES = (FILE_LIBRARY, SHELL_PERSISTENT, SHELL_EPHEMERAL)


async def get_file_library_usage_by_user(db: AsyncSession) -> dict[str, int]:
    """返回管理面板使用的文件库与本地持久空间总量。"""
    rows = (await db.execute(
        select(StorageQuotaLedger.user_id, StorageQuotaLedger.used_bytes).where(
            StorageQuotaLedger.category == FILE_LIBRARY,
        )
    )).all()
    return {str(user_id): int(used_bytes or 0) for user_id, used_bytes in rows}


async def get_file_record_usage_by_user(db: AsyncSession) -> dict[str, int]:
    """聚合存活文件记录用量，供非本地存储的管理面板使用。"""
    rows = (await db.execute(
        select(File.user_id, func.sum(File.size_bytes)).where(
            File.deleted_at.is_(None),
        ).group_by(File.user_id)
    )).all()
    return {str(user_id): int(used_bytes or 0) for user_id, used_bytes in rows}


def _limits(user: User) -> dict[str, int]:
    settings = get_settings()
    local_storage = getattr(settings.storage, "backend", "local") == "local"
    return {
        FILE_LIBRARY: resolve_file_library_limit(
            user.storage_limit_bytes, settings.quota.default_storage_limit_bytes,
        ),
        # Local 的 Shell 与文件库共用 FILE_LIBRARY 总额度；该行只保留 Shell
        # 实际用量明细。OSS 没有可合并的本地 Workspace，继续使用独立 Shell 上限。
        SHELL_PERSISTENT: (2**63 - 1) if local_storage else int(settings.sandbox.persistent_quota_bytes),
        SHELL_EPHEMERAL: int(settings.sandbox.ephemeral_quota_bytes),
    }


def _shell_root(user_id: Any) -> Path:
    return (Path(get_settings().storage.local_path).resolve() / str(user_id) / "workspace").resolve()


def _local_quota_roots(user_id: Any) -> dict[str, Path]:
    user_root = Path(get_settings().storage.local_path).expanduser().resolve() / str(user_id)
    return {
        "workspace": (user_root / "workspace").resolve(),
        "personal": (user_root / "个人文件").resolve(),
        "project": (user_root / "项目文件").resolve(),
    }


async def _measure_local_unregistered_bytes(
    db: AsyncSession, user_id: Any,
) -> tuple[dict[str, int], dict[str, int]]:
    """测量本地可写持久根目录的物理字节与未登记字节。"""
    roots = _local_quota_roots(user_id)
    rows = (await db.execute(select(File.storage_key, File.size_bytes).where(
        File.user_id == user_id, File.deleted_at.is_(None),
    ))).all()
    registered_by_root = {name: 0 for name in roots}
    physical_by_root = {
        name: measure_directory(path) if path.is_dir() else 0
        for name, path in roots.items()
    }
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    for storage_key, size_bytes in rows:
        file_path = (storage_root / storage_key).resolve()
        for name, root in roots.items():
            try:
                file_path.relative_to(root)
            except ValueError:
                continue
            if file_path.is_file():
                registered_by_root[name] += int(size_bytes or 0)
            break
    unregistered_by_root = {
        name: max(0, physical_by_root[name] - registered_by_root[name])
        for name in roots
    }
    return unregistered_by_root, registered_by_root


async def _unregistered_shell_bytes(db: AsyncSession, user_id: Any, root: Path) -> int:
    """工作区与 Shell 共用物理根时，Shell 配额只统计没有文件库记录的字节。"""
    rows = (await db.execute(select(File.storage_key, File.size_bytes).where(
        File.user_id == user_id, File.workspace_directory_id.isnot(None), File.deleted_at.is_(None)
    ))).all()
    registered = 0
    for storage_key, size_bytes in rows:
        path = (root.parent.parent / storage_key).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            continue
        if path.is_file():
            registered += int(size_bytes or 0)
    return max(0, measure_directory(root) - registered)


async def measure_shell_persistent_usage(db: AsyncSession, user_id: Any) -> int:
    """按账本口径测量 Shell 持久空间用量，排除已登记的 Workspace 文件。"""
    root = _shell_root(user_id)
    if not root.is_dir():
        return 0
    return await _unregistered_shell_bytes(db, user_id, root)


async def measure_user_storage_usage(db: AsyncSession, user_id: Any) -> int:
    """测量用户额度用量；Local 将未登记的 Workspace/Shell 文件并入文件库总额度。"""
    file_bytes = int((await db.execute(select(func.coalesce(func.sum(File.size_bytes), 0)).where(
        File.user_id == user_id, File.deleted_at.is_(None),
    ))).scalar_one() or 0)
    if getattr(get_settings().storage, "backend", "local") != "local":
        return file_bytes
    unregistered, _registered = await _measure_local_unregistered_bytes(db, user_id)
    return file_bytes + sum(unregistered.values())


async def get_file_library_usage_snapshot(db: AsyncSession, user_id: Any) -> int:
    """快速读取文件库页面展示用量，不扫描物理目录。

    配额校验与显式对账仍使用 ``measure_user_storage_usage``；页面展示优先读由写入
    和对账流程维护的账本。老账号尚无账本行时，回退到存活 File 记录汇总，避免在
    普通页面请求中创建账本或遍历整个用户目录。
    """
    used_bytes = (await db.execute(select(StorageQuotaLedger.used_bytes).where(
        StorageQuotaLedger.user_id == user_id,
        StorageQuotaLedger.category == FILE_LIBRARY,
    ))).scalar_one_or_none()
    if used_bytes is not None:
        return int(used_bytes)
    return int((await db.execute(select(func.coalesce(func.sum(File.size_bytes), 0)).where(
        File.user_id == user_id,
        File.deleted_at.is_(None),
    ))).scalar_one() or 0)


async def get_local_storage_quota_watch(
    db: AsyncSession, user_id: Any, *, include_library: bool,
) -> tuple[tuple[Path, ...], int]:
    """返回 Shell 本轮可写持久根目录及其合计物理字节上限。

    Workspace 始终可写；只有完整用户授权时个人/项目根才可写并加入实时监测。
    已登记文件按 DB 字节计量，未监测根的未登记字节先从可用额度中预留。
    """
    all_roots = _local_quota_roots(user_id)
    watched_names = ("workspace", "personal", "project") if include_library else ("workspace",)
    watched = set(watched_names)
    unregistered, registered = await _measure_local_unregistered_bytes(db, user_id)
    user = await db.get(User, user_id)
    if user is None:
        raise ValueError("用户不存在")
    limit = _limits(user)[FILE_LIBRARY]
    file_bytes = int((await db.execute(select(func.coalesce(func.sum(File.size_bytes), 0)).where(
        File.user_id == user_id, File.deleted_at.is_(None),
    ))).scalar_one() or 0)
    unmonitored_unregistered = sum(
        unregistered[name] for name in all_roots if name not in watched
    )
    watched_registered = sum(registered[name] for name in watched)
    watched_limit = max(0, limit - file_bytes - unmonitored_unregistered + watched_registered)
    return tuple(all_roots[name] for name in watched_names), watched_limit


async def ensure_user_storage_space(db: AsyncSession, user: User | Any) -> list[StorageQuotaLedger]:
    """创建用户持久空间、三类账本行，并写入一次性初始化审计。"""
    user_id = user.id if isinstance(user, User) else user
    user_obj = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user_obj is None:
        raise ValueError("用户不存在")
    root = ensure_sandbox_root(_shell_root(user_id))
    limits = _limits(user_obj)
    existing_file_bytes = int((await db.execute(select(func.coalesce(func.sum(File.size_bytes), 0)).where(
        File.user_id == user_id, File.deleted_at.is_(None),
    ))).scalar_one() or 0)
    existing_shell_bytes = await _unregistered_shell_bytes(db, user_id, root)
    local_storage = getattr(get_settings().storage, "backend", "local") == "local"
    existing_local_unregistered = 0
    if local_storage:
        unregistered, _ = await _measure_local_unregistered_bytes(db, user_id)
        existing_local_unregistered = sum(unregistered.values())
    initial_usage = {
        FILE_LIBRARY: existing_file_bytes + existing_local_unregistered,
        SHELL_PERSISTENT: existing_shell_bytes,
        SHELL_EPHEMERAL: 0,
    }
    result: list[StorageQuotaLedger] = []
    for category in _CATEGORIES:
        row = (await db.execute(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_id,
            StorageQuotaLedger.category == category,
        ))).scalar_one_or_none()
        if row is None:
            row = StorageQuotaLedger(
                user_id=user_id, category=category,
                root_path=str(root) if category == SHELL_PERSISTENT else None,
                limit_bytes=limits[category],
                used_bytes=initial_usage[category],
                last_reconciled_at=now_utc(),
                status="active",
            )
            db.add(row)
            db.add(StorageQuotaEvent(
                user_id=user_id, category=category, operation="initialize", delta_bytes=0,
                resource_type="quota", resource_id=category,
                idempotency_key=f"quota-init:{user_id}:{category}",
                metadata_json={"root_path": str(root) if category == SHELL_PERSISTENT else None},
            ))
        else:
            row.limit_bytes = limits[category]
            if category == SHELL_PERSISTENT:
                row.root_path = str(root)
        result.append(row)
    await db.flush()
    return result


async def ensure_all_user_storage_spaces(db: AsyncSession) -> int:
    """为现有用户补齐空间和账本；可安全重复执行。"""
    users = (await db.execute(select(User).where(User.is_active.is_(True)))).scalars().all()
    for user in users:
        await ensure_user_storage_space(db, user)
    await db.commit()
    return len(users)


async def get_quota(db: AsyncSession, user_id: Any, category: str) -> StorageQuotaLedger:
    if category not in _CATEGORIES:
        raise ValueError("未知存储配额类别")
    row = (await db.execute(select(StorageQuotaLedger).where(
        StorageQuotaLedger.user_id == user_id, StorageQuotaLedger.category == category,
    ))).scalar_one_or_none()
    if row is None:
        await ensure_user_storage_space(db, user_id)
        row = (await db.execute(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_id, StorageQuotaLedger.category == category,
        ))).scalar_one()
    return row


async def get_file_library_download_budget(
    db: AsyncSession, user_id: Any, default_limit_bytes: int | None,
) -> tuple[int | None, int | None]:
    """返回文件库/Local 用户空间容量与可用字节数，供下载前限流。"""
    user = await db.get(User, user_id)
    limit_bytes = (
        user.storage_limit_bytes
        if user and user.storage_limit_bytes is not None
        else default_limit_bytes
    )
    if limit_bytes is None:
        return None, None
    used_bytes = await measure_user_storage_usage(db, user_id)
    return int(limit_bytes), max(int(limit_bytes) - used_bytes, 0)


async def record_usage(
    db: AsyncSession, user_id: Any, *, category: str, delta_bytes: int,
    operation: str, idempotency_key: str, resource_type: str | None = None,
    resource_id: str | int | None = None, metadata: dict[str, Any] | None = None,
    allow_over_limit: bool = False,
) -> StorageQuotaLedger:
    """原子记录用量事件；重复事件不会重复增加。

    ``allow_over_limit`` 仅用于观察已发生的外部文件系统变更：账本必须反映真实占用，
    即使它已超额；后续受控写入会基于超额账本拒绝执行。
    """
    row = await get_quota(db, user_id, category)
    # 多个文件写入并发时串行应用增量，避免两个事务读到同一旧值后互相覆盖。
    row = (await db.execute(select(StorageQuotaLedger).where(
        StorageQuotaLedger.user_id == user_id,
        StorageQuotaLedger.category == category,
    ).with_for_update().execution_options(populate_existing=True))).scalar_one()
    existing = (await db.execute(select(StorageQuotaEvent).where(
        StorageQuotaEvent.user_id == user_id,
        StorageQuotaEvent.idempotency_key == idempotency_key,
    ))).scalar_one_or_none()
    if existing is not None:
        return row
    next_used = row.used_bytes + int(delta_bytes)
    if next_used < 0:
        raise ValueError("配额用量不能为负数")
    if next_used + row.reserved_bytes > row.limit_bytes and not allow_over_limit:
        raise ValueError("存储空间已满")
    row.used_bytes = next_used
    row.updated_at = now_utc()
    if (
        category == SHELL_PERSISTENT
        and getattr(get_settings().storage, "backend", "local") == "local"
    ):
        shared_row = await get_quota(db, user_id, FILE_LIBRARY)
        shared_row = (await db.execute(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_id,
            StorageQuotaLedger.category == FILE_LIBRARY,
        ).with_for_update().execution_options(populate_existing=True))).scalar_one()
        shared_used = shared_row.used_bytes + int(delta_bytes)
        if shared_used < 0:
            raise ValueError("配额用量不能为负数")
        if shared_used + shared_row.reserved_bytes > shared_row.limit_bytes and not allow_over_limit:
            raise ValueError("存储空间已满")
        shared_row.used_bytes = shared_used
        shared_row.updated_at = now_utc()
    db.add(StorageQuotaEvent(
        user_id=user_id, category=category, operation=operation,
        delta_bytes=int(delta_bytes), resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        idempotency_key=idempotency_key, metadata_json=metadata,
    ))
    await db.flush()
    return row


async def reconcile_user_storage(
    db: AsyncSession, user_id: Any, *, preserve_concurrent_updates: bool = False,
) -> dict[str, int]:
    """重新测量持久空间总量与 Shell 明细，并写入校准事件。

    定时校准可启用 ``preserve_concurrent_updates``：扫描期间若有正常写入更新账本，
    本次校准放弃覆盖，避免用扫描开始前的旧物理快照抹掉并发增量。下一轮会重试。
    显式管理校验和 Shell 收尾仍可使用默认的强制校准语义。
    """
    initial_rows = {}
    if preserve_concurrent_updates:
        rows = (await db.scalars(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_id,
        ).execution_options(populate_existing=True))).all()
        initial_rows = {
            row.category: (int(row.used_bytes), row.updated_at)
            for row in rows
        }
    file_bytes = int((await db.execute(select(func.coalesce(func.sum(File.size_bytes), 0)).where(
        File.user_id == user_id, File.deleted_at.is_(None),
    ))).scalar_one() or 0)
    shell_bytes = await measure_shell_persistent_usage(db, user_id)
    local_storage = getattr(get_settings().storage, "backend", "local") == "local"
    local_unregistered: dict[str, int] = {}
    if local_storage:
        local_unregistered, _ = await _measure_local_unregistered_bytes(db, user_id)
    measured = {
        FILE_LIBRARY: file_bytes + sum(local_unregistered.values()),
        SHELL_PERSISTENT: shell_bytes,
        SHELL_EPHEMERAL: 0,
    }
    if preserve_concurrent_updates:
        rows = (await db.scalars(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_id,
        ).with_for_update().execution_options(populate_existing=True))).all()
        current_rows = {
            row.category: (int(row.used_bytes), row.updated_at)
            for row in rows
        }
        if current_rows != initial_rows:
            return measured
    for category, actual in measured.items():
        row = await get_quota(db, user_id, category)
        delta = actual - row.used_bytes
        row.used_bytes = actual
        row.last_reconciled_at = now_utc()
        row.updated_at = now_utc()
        if delta:
            db.add(StorageQuotaEvent(
                user_id=user_id, category=category, operation="reconcile",
                delta_bytes=delta, resource_type="quota", resource_id=category,
                idempotency_key=f"reconcile:{user_id}:{category}:{row.last_reconciled_at.isoformat()}",
                metadata_json={"measured_bytes": actual},
            ))
    await db.flush()
    return measured


async def verify_user_storage_space(db: AsyncSession, user_id: Any) -> dict[str, Any]:
    measured = await reconcile_user_storage(db, user_id)
    rows = (await db.execute(select(StorageQuotaLedger).where(
        StorageQuotaLedger.user_id == user_id,
    ))).scalars().all()
    return {
        "user_id": str(user_id),
        "root_exists": _shell_root(user_id).is_dir(),
        "categories": {
            row.category: {
                "used_bytes": row.used_bytes,
                "limit_bytes": row.limit_bytes,
                "within_limit": row.used_bytes + row.reserved_bytes <= row.limit_bytes,
                "last_reconciled_at": row.last_reconciled_at.isoformat() if row.last_reconciled_at else None,
            } for row in rows
        },
        "measured": measured,
    }


__all__ = [
    "FILE_LIBRARY", "SHELL_PERSISTENT", "SHELL_EPHEMERAL", "DEFAULT_WORKSPACE_FOLDER_NAME",
    "ensure_user_storage_space", "ensure_all_user_storage_spaces", "get_quota",
    "get_file_library_usage_snapshot", "measure_shell_persistent_usage", "record_usage",
    "reconcile_user_storage", "verify_user_storage_space",
]
