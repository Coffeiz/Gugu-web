"""文件同步协议的稳定字段、幂等键和路径安全校验。"""
from __future__ import annotations

import hashlib
import re
from enum import StrEnum
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redaction import diag_log
from app.core.config import get_settings
from app.models import FileSyncBinding, FileSyncJournal, Workspace
from app.core.ownership import get_owned

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


def normalize_relative_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("同步路径无效")
    path = value.replace("\\", "/")
    if path.startswith("/") or re.match(r"^[A-Za-z]:/", path):
        raise ValueError("同步路径必须是相对路径")
    parts = [part for part in path.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError("同步路径越界")
    return "/".join(parts)


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


async def record_canonical_file_change(
    db: AsyncSession,
    *,
    user_id,
    storage_key: str,
    observed_fingerprint: str,
) -> None:
    """把文件库正式写入登记到覆盖它的本地目录绑定。

    文件同步是文件库的可选旁路能力：开关关闭、存储后端不是 local 或绑定根
    无法解析时，主文件写入仍然必须成功。workspace 绑定的 ``root_path`` 固定
    为 ``.``，因此必须解析真实 workspace 根后再计算 journal 相对路径。
    """
    settings = get_settings()
    if not is_file_sync_enabled():
        return
    if getattr(settings.storage, "backend", "local") != "local":
        return
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
    for binding in bindings:
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
        operation = FileSyncOperation.UPDATE
        try:
            # 用 savepoint 隔离同步 journal；即使同步校验/唯一键遇到异常，
            # 也不能回滚文件库本身已经完成的主事务。
            async with db.begin_nested():
                await record_change(
                    db, binding=binding, user_id=user_id, source=FileSyncSource.FILE_API,
                    operation=operation, relative_path=relative,
                    idempotency_key=build_idempotency_key(
                        source=FileSyncSource.FILE_API, operation=operation,
                        relative_path=relative, fingerprint=observed_fingerprint,
                    ), observed_fingerprint=observed_fingerprint,
                    status=FileSyncStatus.SYNCED,
                )
        except FileSyncDisabled:
            return
        except Exception as exc:
            # canonical journal 是可选旁路；保留受限诊断，放行主文件写入。
            diag_log("filesync.canonical_file_change", exc)


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
    row = FileSyncJournal(
        binding_id=binding.id, user_id=user_id, idempotency_key=idempotency_key,
        source=str(source), operation=str(operation), object_type=object_type,
        relative_path=relative_path,
        baseline_fingerprint=baseline_fingerprint, observed_fingerprint=observed_fingerprint,
        revision=binding.revision, status=str(status),
    )
    db.add(row)
    await db.flush()
    return row
