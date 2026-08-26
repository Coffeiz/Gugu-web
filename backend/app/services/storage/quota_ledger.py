"""用户存储空间统一账本。

账本只记录三类真正占用域：文件库、Shell 持久空间和 Shell 临时空间。
下载、构建和 Shell 是 operation，不重复创建配额判断。目录对账采用实际
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

FILE_LIBRARY = "file_library"
SHELL_PERSISTENT = "shell_persistent"
SHELL_EPHEMERAL = "shell_ephemeral"
_CATEGORIES = (FILE_LIBRARY, SHELL_PERSISTENT, SHELL_EPHEMERAL)
_UNLIMITED_BYTES = 2**63 - 1


def _limits(user: User) -> dict[str, int]:
    settings = get_settings()
    return {
        FILE_LIBRARY: int(
            user.storage_limit_bytes
            or settings.quota.default_storage_limit_bytes
            or _UNLIMITED_BYTES
        ),
        SHELL_PERSISTENT: int(settings.sandbox.persistent_quota_bytes),
        SHELL_EPHEMERAL: int(settings.sandbox.ephemeral_quota_bytes),
    }


def _shell_root(user_id: Any) -> Path:
    return (Path(get_settings().storage.local_path).resolve() / str(user_id) / "shell").resolve()


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
    existing_shell_bytes = measure_directory(root)
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
                used_bytes={FILE_LIBRARY: existing_file_bytes, SHELL_PERSISTENT: existing_shell_bytes, SHELL_EPHEMERAL: 0}[category],
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


async def record_usage(
    db: AsyncSession, user_id: Any, *, category: str, delta_bytes: int,
    operation: str, idempotency_key: str, resource_type: str | None = None,
    resource_id: str | int | None = None, metadata: dict[str, Any] | None = None,
) -> StorageQuotaLedger:
    """原子地记录用量事件；重复事件不会再次增加用量。"""
    row = await get_quota(db, user_id, category)
    existing = (await db.execute(select(StorageQuotaEvent).where(
        StorageQuotaEvent.user_id == user_id,
        StorageQuotaEvent.idempotency_key == idempotency_key,
    ))).scalar_one_or_none()
    if existing is not None:
        return row
    next_used = row.used_bytes + int(delta_bytes)
    if next_used < 0:
        raise ValueError("配额用量不能为负数")
    if next_used + row.reserved_bytes > row.limit_bytes:
        raise ValueError("存储空间已满")
    row.used_bytes = next_used
    row.updated_at = now_utc()
    db.add(StorageQuotaEvent(
        user_id=user_id, category=category, operation=operation,
        delta_bytes=int(delta_bytes), resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        idempotency_key=idempotency_key, metadata_json=metadata,
    ))
    await db.flush()
    return row


async def reconcile_user_storage(db: AsyncSession, user_id: Any) -> dict[str, int]:
    """重新测量文件库与 Shell 持久目录，并写入校准事件。"""
    file_bytes = int((await db.execute(select(func.coalesce(func.sum(File.size_bytes), 0)).where(
        File.user_id == user_id, File.deleted_at.is_(None),
    ))).scalar_one() or 0)
    shell_root = ensure_sandbox_root(_shell_root(user_id))
    measured = {
        FILE_LIBRARY: file_bytes,
        SHELL_PERSISTENT: measure_directory(shell_root),
        SHELL_EPHEMERAL: 0,
    }
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
    "FILE_LIBRARY", "SHELL_PERSISTENT", "SHELL_EPHEMERAL",
    "ensure_user_storage_space", "ensure_all_user_storage_spaces", "get_quota",
    "record_usage", "reconcile_user_storage", "verify_user_storage_space",
]
