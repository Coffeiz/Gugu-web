"""文件同步监听状态与待手动核对标记。"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import FileSyncBinding


async def update_binding_health(
    db: AsyncSession,
    binding_id: int,
    *,
    status: str,
    error_code: str | None = None,
    gap_detected: bool = False,
) -> bool:
    """更新脱敏健康状态；恢复监听不会清除历史核对标记。"""
    binding = await db.scalar(select(FileSyncBinding).where(FileSyncBinding.id == binding_id))
    if binding is None:
        return False
    changed = binding.watcher_status != status or binding.health_error_code != error_code
    if changed:
        binding.watcher_status = status
        binding.health_error_code = error_code
        binding.health_revision += 1
    if gap_detected:
        binding.needs_reconcile = True
        binding.gap_revision += 1
        binding.health_revision += 1
    if changed or gap_detected:
        await db.commit()
    return True


def clear_reconcile_gap_if_current(
    binding: FileSyncBinding,
    *,
    gap_revision_at_start: int,
    mode: str,
    dry_run: bool,
    allow_delete: bool,
) -> bool:
    """只在完整修复覆盖既有缺口且监听仍健康时清除提示。"""
    if (
        mode != "integrity_full"
        or dry_run
        or not allow_delete
        or binding.watcher_status != "ready"
        or binding.health_error_code is not None
        or binding.gap_revision != gap_revision_at_start
    ):
        return False
    binding.needs_reconcile = False
    return True
