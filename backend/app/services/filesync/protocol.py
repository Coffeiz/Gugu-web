"""文件同步协议的稳定字段、幂等键和路径安全校验。"""
from __future__ import annotations

import hashlib
import re
from enum import StrEnum
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redaction import diag_log
from app.core.config import get_settings
from app.models import FileSyncBinding, FileSyncJournal, Workspace
from app.core.ownership import get_owned
from app.services.filesync.activity import record_file_activity
from app.services.filesync.paths import normalize_relative_path

FILE_SYNC_PROTOCOL_VERSION = 1


class FileSyncDisabled(RuntimeError):
    """同步功能开关关闭。"""


class FileSyncSource(StrEnum):
    LOCAL_DIRECTORY = "local_directory"
    FILE_API = "file_api"


class FileSyncMode(StrEnum):
    MIRROR_IN = "mirror_in"
    MIRROR_OUT = "mirror_out"
    BIDIRECTIONAL = "bidirectional"


class FileSyncOperation(StrEnum):
    BASELINE = "baseline"
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    MOVE = "move"


class FileSyncStatus(StrEnum):
    PENDING = "pending"
    SYNCED = "synced"
    CONFLICT = "conflict"
    REJECTED = "rejected"
    FAILED = "failed"


def is_file_sync_enabled() -> bool:
    settings = get_settings()
    return bool(settings.filesync.enabled)


async def create_binding(
    db: AsyncSession,
    *,
    user_id,
    source: str,
    root_fingerprint: str,
    workspace_id: int | None = None,
    mode: str = FileSyncMode.BIDIRECTIONAL,
    root_path: str = ".",
) -> FileSyncBinding:
    if not is_file_sync_enabled():
        raise FileSyncDisabled("文件同步未开启")
    if get_settings().storage.backend != "local":
        raise ValueError("OSS 存储模式不支持文件同步绑定")
    if workspace_id is not None:
        workspace = await get_owned(db, Workspace, workspace_id, user_id)
        if workspace is None or not workspace.enabled:
            raise LookupError("工作区不存在或已停用")
    if mode not in {item.value for item in FileSyncMode}:
        raise ValueError("同步模式无效")
    root_path = "." if (not root_path or root_path in {".", "./"}) else normalize_relative_path(root_path)
    if not re.fullmatch(r"[0-9a-f]{64}", root_fingerprint or ""):
        raise ValueError("同步根指纹无效")
    if source not in {item.value for item in FileSyncSource}:
        raise ValueError("同步来源无效")
    row = FileSyncBinding(
        user_id=user_id, workspace_id=workspace_id, source=str(source), mode=mode,
        protocol_version=FILE_SYNC_PROTOCOL_VERSION, root_path=root_path,
        root_fingerprint=root_fingerprint,
    )
    db.add(row)
    await db.flush()
    return row


async def record_canonical_path_change(
    db: AsyncSession,
    *,
    user_id,
    storage_key: str,
    operation: str,
    change_id: str,
    object_type: str = "file",
    observed_fingerprint: str | None = None,
) -> None:
    """把文件库中的路径变更登记到覆盖它的本地目录绑定。

    文件同步是文件库的可选旁路能力：开关关闭、存储后端不是 local 或绑定根
    无法解析时，主文件写入仍然必须成功。workspace 绑定必须解析真实根目录后
    再计算 journal 相对路径。调用方提供的 change_id 区分同一路径的不同变更。
    """
    settings = get_settings()
    if not is_file_sync_enabled():
        return
    if getattr(settings.storage, "backend", "local") != "local":
        return
    if operation not in {item.value for item in FileSyncOperation}:
        raise ValueError("同步操作无效")
    if object_type not in {"file", "folder"} or not change_id:
        raise ValueError("同步路径变更无效")
    prefix = f"{user_id}/"
    if not storage_key.startswith(prefix):
        return
    user_relative = storage_key.removeprefix(prefix)
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    user_root = (storage_root / str(user_id)).resolve()
    storage_path = (user_root / user_relative).resolve()
    try:
        storage_path.relative_to(user_root)
    except ValueError:
        return

    bindings = (await db.scalars(select(FileSyncBinding).where(
        FileSyncBinding.user_id == user_id,
        FileSyncBinding.source == FileSyncSource.LOCAL_DIRECTORY,
        FileSyncBinding.status == "active",
    ))).all()
    mirror_out_bindings = []
    for binding in bindings:
        if binding.mode == FileSyncMode.MIRROR_OUT:
            # mirror_out 的来源是整个文件库，通常不位于输出目录之下，不能
            # 用路径覆盖关系决定是否需要导出。脏水位让运行中的固定截止任务
            # 在完成后排入下一轮，避免吞掉任务开始后的文件库变更。
            binding.dirty_revision = int(binding.dirty_revision or 0) + 1
            mirror_out_bindings.append(binding)
            continue
        try:
            if binding.workspace_id is not None:
                # 自动 workspace binding 的 root_path 是“工作区根”的占位值，
                # 不能把它当成用户存储根来计算 journal 路径。
                from app.services.workspaces import resolve_workspace_root

                binding_root = await resolve_workspace_root(
                    db, user_id, binding.workspace_id,
                )
            else:
                # 延迟导入以避免 protocol ↔ bindings 的循环依赖。
                from app.services.filesync.bindings import resolve_local_binding_root

                _, binding_root = resolve_local_binding_root(user_id, binding.root_path)
            if binding_root is None:
                continue
            relative = storage_path.relative_to(binding_root).as_posix()
        except (OSError, ValueError):
            continue
        if not relative:
            continue
        try:
            # 用 savepoint 隔离同步 journal；即使同步校验/唯一键遇到异常，
            # 也不能回滚文件库本身已经完成的主事务。
            async with db.begin_nested():
                await record_change(
                    db, binding=binding, user_id=user_id, source=FileSyncSource.FILE_API,
                    operation=operation, object_type=object_type, relative_path=relative,
                    idempotency_key=build_idempotency_key(
                        source=FileSyncSource.FILE_API, operation=operation,
                        object_type=object_type, relative_path=relative,
                        fingerprint=f"{change_id}:{observed_fingerprint or ''}",
                    ), observed_fingerprint=observed_fingerprint,
                    status=FileSyncStatus.SYNCED,
                )
        except FileSyncDisabled:
            return
        except Exception as exc:
            # canonical journal 是可选旁路；保留受限诊断，放行主文件写入。
            diag_log("filesync.canonical_file_change", exc)

    if mirror_out_bindings:
        # 文件库事件只计一次用户活动；mirror_out 本身不反向导入目标目录。
        try:
            await record_file_activity(db, user_id)
        except Exception as exc:
            diag_log("filesync.mirror_out_activity", exc)
        try:
            from app.services.filesync.jobs import enqueue_reconcile

            for binding in mirror_out_bindings:
                async with db.begin_nested():
                    await enqueue_reconcile(
                        db, binding, mode=FileSyncMode.MIRROR_OUT, reason="file_event",
                    )
        except Exception as exc:
            # 文件同步是可选旁路，排队失败不能回滚已经完成的文件库写入。
            diag_log("filesync.mirror_out_enqueue", exc)


async def record_canonical_file_change(
    db: AsyncSession,
    *,
    user_id,
    storage_key: str,
    observed_fingerprint: str,
) -> None:
    """记录文件库正文变更，供上传、覆盖、编辑和归档导入复用。"""
    await record_canonical_path_change(
        db,
        user_id=user_id,
        storage_key=storage_key,
        operation=FileSyncOperation.UPDATE,
        change_id=observed_fingerprint,
        observed_fingerprint=observed_fingerprint,
    )


async def record_canonical_file_move(
    db: AsyncSession,
    *,
    user_id,
    old_storage_key: str,
    new_storage_key: str,
    entity_id: int,
    version: int,
) -> None:
    """登记文件库内移动的源/目标路径，使两个绑定范围都推进脏水位。"""
    change_id = f"file:{entity_id}:version:{version}:{uuid4().hex}"
    await record_canonical_path_change(
        db, user_id=user_id, storage_key=old_storage_key,
        operation=FileSyncOperation.DELETE, change_id=f"{change_id}:old",
    )
    await record_canonical_path_change(
        db, user_id=user_id, storage_key=new_storage_key,
        operation=FileSyncOperation.CREATE, change_id=f"{change_id}:new",
    )


async def record_canonical_file_delete(
    db: AsyncSession,
    *,
    user_id,
    storage_key: str,
    entity_id: int,
    version: int,
) -> None:
    """登记文件进入回收站前的原路径删除。"""
    await record_canonical_path_change(
        db, user_id=user_id, storage_key=storage_key,
        operation=FileSyncOperation.DELETE,
        change_id=f"file:{entity_id}:version:{version}:delete:{uuid4().hex}",
    )


async def record_canonical_file_restore(
    db: AsyncSession,
    *,
    user_id,
    storage_key: str,
    entity_id: int,
    version: int,
) -> None:
    """登记文件从回收站恢复到文件库路径。"""
    await record_canonical_path_change(
        db, user_id=user_id, storage_key=storage_key,
        operation=FileSyncOperation.CREATE,
        change_id=f"file:{entity_id}:version:{version}:restore:{uuid4().hex}",
    )


async def record_canonical_folder_change(
    db: AsyncSession,
    *,
    user_id,
    storage_key: str,
    operation: str,
    entity_id: int,
    version: int,
) -> None:
    """登记文件夹层级变化，避免只移动空目录时不推进绑定水位。"""
    await record_canonical_path_change(
        db, user_id=user_id, storage_key=storage_key, operation=operation,
        object_type="folder", change_id=f"folder:{entity_id}:version:{version}",
    )


def validate_sync_path(root: Path, relative_path: str) -> Path:
    """校验工作区边界、符号链接和特殊文件，不创建目标。"""
    relative = normalize_relative_path(relative_path)
    root = root.expanduser().resolve()
    candidate = (root / relative).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("同步路径越界") from exc
    if candidate.exists() and not (candidate.is_file() or candidate.is_dir()):
        raise ValueError("不支持同步特殊文件")
    return candidate


def build_idempotency_key(*, source: str, operation: str, relative_path: str,
                          fingerprint: str | None, object_type: str = "file") -> str:
    if object_type not in {"file", "folder"}:
        raise ValueError("同步对象类型无效")
    normalized = normalize_relative_path(relative_path)
    payload = "|".join((str(source), str(operation), object_type, normalized, fingerprint or ""))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


async def record_change(
    db: AsyncSession,
    *,
    binding: FileSyncBinding,
    user_id,
    source: str,
    operation: str,
    relative_path: str,
    idempotency_key: str,
    object_type: str = "file",
    baseline_fingerprint: str | None = None,
    observed_fingerprint: str | None = None,
    status: str = FileSyncStatus.PENDING,
    mark_dirty: bool = True,
) -> FileSyncJournal:
    if not is_file_sync_enabled():
        raise FileSyncDisabled("文件同步未开启")
    if binding.user_id != user_id:
        raise LookupError("同步绑定不存在")
    if source not in {item.value for item in FileSyncSource}:
        raise ValueError("同步来源无效")
    if operation not in {item.value for item in FileSyncOperation}:
        raise ValueError("同步操作无效")
    if object_type not in {"file", "folder"}:
        raise ValueError("同步对象类型无效")
    if status not in {item.value for item in FileSyncStatus}:
        raise ValueError("同步状态无效")
    relative_path = normalize_relative_path(relative_path)
    if len(idempotency_key) > 128 or not idempotency_key:
        raise ValueError("幂等键无效")
    existing = await db.scalar(select(FileSyncJournal).where(
        FileSyncJournal.binding_id == binding.id,
        FileSyncJournal.idempotency_key == idempotency_key,
        FileSyncJournal.user_id == user_id,
    ))
    if existing is not None:
        return existing
    binding.revision = int(binding.revision or 0) + 1
    if mark_dirty:
        binding.dirty_revision = int(binding.dirty_revision or 0) + 1
    dirty_revision = int(binding.dirty_revision or 0) if mark_dirty else None
    row = FileSyncJournal(
        binding_id=binding.id, user_id=user_id, idempotency_key=idempotency_key,
        source=str(source), operation=str(operation), object_type=object_type,
        relative_path=relative_path,
        baseline_fingerprint=baseline_fingerprint, observed_fingerprint=observed_fingerprint,
        revision=binding.revision, dirty_revision=dirty_revision, status=str(status),
    )
    db.add(row)
    await db.flush()
    if mark_dirty:
        await record_file_activity(db, user_id)
    return row
