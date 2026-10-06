"""持久文件对账任务执行期使用的只读规格。"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import TypedDict
from uuid import UUID

class ReconcileJobSpec(TypedDict):
    """领取时固定的任务输入；不包含 ORM 对象，适合跨线程边界传递。"""

    run_id: UUID
    token: UUID
    user_id: UUID
    binding_id: int
    workspace_id: int | None
    binding_mode: str
    root_path: str | None
    root_fingerprint: str
    binding_revision: int
    baseline_generation: str | None
    last_reconciled_at: datetime | None
    export_cutoff: datetime | None
    dirty_revision: int
    mode: str
    reason: str
    root: Path
    other_roots: tuple[Path, ...]
    result_counts: dict
    dry_run: bool
    allow_delete: bool
    deadline_at: datetime
    user_root: Path
    baseline_dirty_revision: int
    dirty_paths: frozenset[str]
    force_integrity_scan: bool
    checkpoint_ref: str | None
