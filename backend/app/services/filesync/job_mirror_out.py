"""`mirror_out` 持久任务的分页导出执行。"""
from __future__ import annotations

import time
import threading
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Callable

from sqlalchemy import select

from app.models import File, FileSyncReconcileRun
from app.services.filesync.job_errors import ProjectionSliceExpired
from app.services.filesync.job_lifecycle import record_run_progress
from app.services.filesync.job_spec import ReconcileJobSpec
from app.services.filesync.protocol import validate_sync_path


@dataclass(slots=True)
class MirrorOutExecution:
    """一次文件库→绑定目录分页复制片段的固定输入。"""

    session_factory: Callable
    spec: ReconcileJobSpec
    stop: threading.Event
    deadline: float
    slice_deadline: float
    slice_started: float


@dataclass(frozen=True, slots=True)
class MirrorOutRuntime:
    check_active: Callable
    finish_run: Callable
    batch_size: int


async def apply_mirror_out_segment(
    execution: MirrorOutExecution,
    runtime: MirrorOutRuntime,
) -> None:
    """分页把文件库对象复制到绑定目录，不扫描或反向导入本地文件。"""
    from app.services.storage import get_storage

    session_factory = execution.session_factory
    spec = execution.spec
    stop = execution.stop
    deadline = execution.deadline
    slice_deadline = execution.slice_deadline
    slice_started = execution.slice_started
    check_active = runtime.check_active
    finish_run = runtime.finish_run
    batch_size = runtime.batch_size

    cursor = 0
    checkpoint_ref = spec["checkpoint_ref"]
    if checkpoint_ref and checkpoint_ref.startswith("mirror-out-v1:"):
        try:
            cursor = int(checkpoint_ref.partition(":")[2])
        except ValueError as exc:
            raise RuntimeError("checkpoint_invalid") from exc
    counts = dict(spec["result_counts"])
    counts.setdefault("scanned", 0)
    counts.setdefault("copied", 0)
    counts.setdefault("updated", 0)
    counts.setdefault("rejected", 0)
    user_prefix = f"{spec['user_id']}/"
    storage_root = spec["user_root"].parent.resolve()
    try:
        binding_relative = spec["root"].relative_to(storage_root).as_posix()
    except ValueError as exc:
        raise RuntimeError("binding_unavailable") from exc
    binding_parts = PurePosixPath(binding_relative).parts
    if not binding_parts or binding_parts[0] != str(spec["user_id"]):
        raise RuntimeError("binding_unavailable")
    binding_user_relative = PurePosixPath(*binding_parts[1:]).as_posix()
    storage = get_storage()

    while True:
        if time.monotonic() >= slice_deadline:
            raise ProjectionSliceExpired
        if not await check_active(
            session_factory, spec["run_id"], spec["token"], stop, deadline,
            binding_id=spec["binding_id"],
            binding_revision=spec["binding_revision"],
        ):
            raise TimeoutError("cancelled_or_timed_out")
        async with session_factory() as db:
            rows = (await db.execute(select(
                File.id, File.storage_key, File.updated_at,
            ).where(
                File.user_id == spec["user_id"],
                File.deleted_at.is_(None),
                File.updated_at <= spec["export_cutoff"],
                File.id > cursor,
            ).order_by(File.id).limit(batch_size))).all()
        if not rows:
            await finish_run(
                session_factory, spec["run_id"], spec["token"],
                status="succeeded", counts=counts, slice_started=slice_started,
            )
            return

        for file_id, storage_key, source_updated_at in rows:
            if time.monotonic() >= slice_deadline:
                raise ProjectionSliceExpired
            if not await check_active(
                session_factory, spec["run_id"], spec["token"], stop, deadline,
                binding_id=spec["binding_id"],
                binding_revision=spec["binding_revision"],
            ):
                raise TimeoutError("cancelled_or_timed_out")
            try:
                if not isinstance(storage_key, str) or not storage_key.startswith(user_prefix):
                    raise ValueError("unsafe_storage_key")
                stored_path = PurePosixPath(storage_key)
                parts = stored_path.parts
                if stored_path.is_absolute() or ".." in parts or len(parts) < 2:
                    raise ValueError("unsafe_storage_key")
                relative_key = PurePosixPath(*parts[1:]).as_posix()
                validate_sync_path(spec["root"], relative_key)
                # 已在输出绑定内的源对象不能再次复制到自己的子目录。
                source_is_inside_target = (
                    relative_key == binding_user_relative
                    or relative_key.startswith(f"{binding_user_relative}/")
                )
                destination_key = storage_key if source_is_inside_target else "/".join(
                    part for part in (binding_relative, relative_key) if part not in {"", "."}
                )
            except (OSError, ValueError):
                counts["rejected"] += 1
            else:
                if not await storage.exists(storage_key):
                    counts["rejected"] += 1
                elif storage_key != destination_key:
                    destination_exists = await storage.exists(destination_key)
                    source_changed = (
                        spec["last_reconciled_at"] is None
                        or source_updated_at is None
                        or source_updated_at >= spec["last_reconciled_at"]
                    )
                    if source_changed or not destination_exists:
                        if not spec["dry_run"]:
                            await storage.copy(storage_key, destination_key)
                        counts["copied"] += 1
                        counts["updated"] += 1
            counts["scanned"] += 1
            cursor = int(file_id)
            async with session_factory() as db:
                run = await db.get(FileSyncReconcileRun, spec["run_id"])
                if (
                    run is None or run.lease_token != spec["token"]
                    or run.status != "running"
                ):
                    raise RuntimeError("lease_lost")
                record_run_progress(
                    run,
                    stage="projecting",
                    progress_current=int(run.progress_current or 0) + 1,
                    result_counts=dict(counts),
                    checkpoint_ref=f"mirror-out-v1:{cursor}",
                )
                await db.commit()
            if time.monotonic() >= slice_deadline:
                raise ProjectionSliceExpired
