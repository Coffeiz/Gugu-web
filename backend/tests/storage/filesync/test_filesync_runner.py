"""端到端保护异步任务从持久队列到短批次投影的可观察契约。"""
import asyncio
import gc
import os
import queue
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.tz import now_utc
from app.db import session as db_session
from app.db.base import Base
from app.models import (
    ConversationSession,
    File,
    FileSyncBinding,
    FileSyncJournal,
    FileSyncOutbox,
    FileSyncReconcileRun,
    Folder,
    StorageQuotaLedger,
    User,
    Workspace,
    WorkspaceDirectory,
)
from app.services.filesync.jobs import (
    claim_next_run,
    enqueue_reconcile_run,
    request_run_cancel,
)
from app.services.filesync.reconcile import _root_fingerprint
from app.services.filesync.runner import (
    _cleanup_stale_scan_artifacts,
    _publish_latest_progress,
    _run_claimed,
    run_reconcile_worker,
)
from app.services.storage.quota_ledger import FILE_LIBRARY


@pytest_asyncio.fixture
async def multi_session_filesync_db(tmp_path, user_a):
    """并发 Worker 屏障使用文件 SQLite，避免 StaticPool 把独立 session 合并成一条连接。"""
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'filesync-runner.sqlite'}",
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    original_engine = db_session._engine
    original_session_factory = db_session._SessionLocal
    original_engine_loop = db_session._engine_loop
    db_session._engine = engine
    db_session._SessionLocal = sessions
    db_session._engine_loop = asyncio.get_running_loop()
    try:
        async with sessions() as session:
            session.add(User(
                id=user_a.id,
                username=user_a.username,
                email=user_a.email,
                hashed_password=user_a.hashed_password,
                is_active=True,
            ))
            await session.commit()
        yield sessions
    finally:
        db_session._engine = original_engine
        db_session._SessionLocal = original_session_factory
        db_session._engine_loop = original_engine_loop
        await engine.dispose()


def test_user_root_reconcile_only_projects_canonical_library_folders(
    user_a, monkeypatch, tmp_path,
):
    """任务对账忽略项目年月/项目根容器，保留真实项目 Folder 与文件候选。"""
    import app.services.filesync.runner as runner

    settings = SimpleNamespace(storage=SimpleNamespace(local_path=str(tmp_path)))
    monkeypatch.setattr(runner, "get_settings", lambda: settings)
    root = tmp_path / str(user_a.id)
    scope = SimpleNamespace(user_id=user_a.id, root=root, workspace_id=None)
    project_folder = "项目文件/2026/10/示例项目 #17/图表"

    assert not runner._candidate_in_supported_space(
        scope, "项目文件", object_type="folder",
    )
    assert not runner._candidate_in_supported_space(
        scope, "项目文件/2026", object_type="folder",
    )
    assert not runner._candidate_in_supported_space(
        scope, "项目文件/2026/10/示例项目 #17", object_type="folder",
    )
    assert runner._candidate_in_supported_space(
        scope, project_folder, object_type="folder",
    )
    # 项目根目录中的文件仍属于项目文件库，不受文件夹容器过滤影响。
    assert runner._candidate_in_supported_space(
        scope, "项目文件/2026/10/示例项目 #17/方案.md", object_type="file",
    )


@pytest.mark.asyncio
async def test_initialize_task_imports_disk_files_and_persists_terminal_results(
    db, user_a, monkeypatch,
):
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    settings = runner.get_settings()
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    (root / "个人文件").mkdir(parents=True)
    (root / "个人文件" / "新建.txt").write_text("from disk", encoding="utf-8")
    runtime_workspace = root / "workspace" / "default"
    runtime_workspace.mkdir(parents=True)
    (runtime_workspace / "不属于文件库.txt").write_text("keep out of File projection", encoding="utf-8")
    workspace_file = File(
        user_id=user_a.id, display_name="工作区旧记录", ext="txt", space="workspace",
        storage_key=f"{user_a.id}/workspace/default/工作区旧记录.txt",
    )
    db.add(workspace_file)
    await db.flush()
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="initialize",
    )
    await db.commit()
    worker_stop = asyncio.Event()
    run_finished = asyncio.Event()
    original_finish_run = runner.finish_run

    async def signal_terminal_finish(*args, **kwargs):
        result = await original_finish_run(*args, **kwargs)
        if result:
            run_finished.set()
        return result

    monkeypatch.setattr(runner, "finish_run", signal_terminal_finish)
    worker_task = asyncio.create_task(run_reconcile_worker(
        worker_stop, worker_id="runner-test", session_factory=db_session._SessionLocal,
    ))
    try:
        try:
            await asyncio.wait_for(run_finished.wait(), timeout=10)
        except TimeoutError:
            async with db_session._SessionLocal() as check:
                stored = await check.get(FileSyncReconcileRun, run.id)
                state = (
                    stored.status, stored.stage, stored.error_code,
                    stored.result_counts, stored.lease_owner,
                ) if stored is not None else None
            pytest.fail(f"任务 Worker 未在测试时间内完成初始化核对：{state!r}")
    finally:
        worker_stop.set()
        await asyncio.wait_for(worker_task, timeout=5)

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/新建.txt",
        ))
        stored_workspace_file = await check.get(File, workspace_file.id)
        runtime_library_file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/workspace/default/不属于文件库.txt",
        ))
        journals = list((await check.scalars(select(FileSyncJournal).where(
            FileSyncJournal.binding_id == binding.id,
        ))).all())

    assert stored_run is not None
    assert stored_run.status == "succeeded", (
        stored_run.error_code,
        stored_run.result_counts,
    )
    assert stored_run.scanned_count == 2
    assert stored_run.result_counts["created"] == 1
    assert file is not None and file.size_bytes == len(b"from disk")
    assert stored_workspace_file is not None and stored_workspace_file.deleted_at is None
    assert runtime_library_file is None
    assert any(item.object_type == "file" for item in journals)
    version = file.version

    repair_run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()
    claimed_repair = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed_repair is not None and claimed_repair.id == repair_run.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal,
            executor,
            claimed_repair,
            "runner-test",
            asyncio.Event(),
        )
    async with db_session._SessionLocal() as check:
        repaired_file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/新建.txt",
        ))
        repeated_journals = list((await check.scalars(select(FileSyncJournal).where(
            FileSyncJournal.binding_id == binding.id,
        ))).all())
    assert repaired_file is not None and repaired_file.version == version
    assert len(repeated_journals) == len(journals)


@pytest.mark.asyncio
async def test_user_root_with_only_workspace_records_is_an_empty_library_scope(
    db, user_a, monkeypatch,
):
    """用户根绑定不把 workspace 记录算作文件库范围，也不因它们误判空扫描。"""
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    storage_root = Path(runner.get_settings().storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    runtime = root / "workspace" / "default"
    runtime.mkdir(parents=True)
    (runtime / "runtime.txt").write_text("workspace data", encoding="utf-8")
    workspace_file = File(
        user_id=user_a.id, display_name="运行时记录", ext="txt", space="workspace",
        storage_key=f"{user_a.id}/workspace/default/运行时记录.txt",
    )
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=None, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add_all([workspace_file, binding])
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()

    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    claimed = await claim_next_run(db, "empty-library-scope", now=now_utc())
    assert claimed is not None and claimed.id == run.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed,
            "empty-library-scope", asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        stored_workspace_file = await check.get(File, workspace_file.id)
    assert stored_run is not None and stored_run.status == "succeeded"
    assert stored_run.scanned_count == 0
    assert stored_workspace_file is not None and stored_workspace_file.deleted_at is None


@pytest.mark.asyncio
async def test_dry_run_reports_plan_without_business_side_effects(db, user_a, monkeypatch):
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    storage_root = Path(runner.get_settings().storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    (root / "个人文件").mkdir(parents=True)
    (root / "个人文件" / "仅预检.txt").write_text("preview", encoding="utf-8")
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="dry_run",
    )
    await db.commit()
    claimed = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id

    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed, "runner-test", asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        files = list((await check.scalars(select(File).where(File.user_id == user_a.id))).all())
        journals = list((await check.scalars(select(FileSyncJournal).where(
            FileSyncJournal.binding_id == binding.id,
        ))).all())
        outbox = list((await check.scalars(select(FileSyncOutbox).where(
            FileSyncOutbox.user_id == user_a.id,
        ))).all())

    assert stored_run is not None and stored_run.status == "succeeded", (
        stored_run.status if stored_run else None,
        stored_run.error_code if stored_run else None,
        stored_run.result_counts if stored_run else None,
    )
    assert stored_run.result_counts["plannedCreated"] == 2
    assert stored_run.result_counts["created"] == 0
    assert files == []
    assert journals == []
    assert outbox == []


@pytest.mark.asyncio
async def test_repair_recreates_only_a_missing_empty_workspace_root(db, user_a, monkeypatch):
    """恢复数据库后只允许重建确认为无旧 File/Folder 记录的空工作区目录。"""
    from app.core.config import get_settings
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    directory = WorkspaceDirectory(
        user_id=user_a.id, name="空工作区", directory_name="safe-empty",
    )
    db.add(directory)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name="空工作区", kind="directory",
        directory_id=directory.id, enabled=True,
    )
    db.add(workspace)
    await db.flush()
    root = storage_root / str(user_a.id) / "workspace" / directory.directory_name
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=workspace.id, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()

    scope = await runner._load_scope(db_session._SessionLocal, run.id)

    assert scope.root == root
    assert root.is_dir()
    assert list(root.iterdir()) == []
    assert await db.scalar(select(File.id).where(File.user_id == user_a.id)) is None
    assert await db.scalar(select(Folder.id).where(Folder.user_id == user_a.id)) is None

    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    claimed = await claim_next_run(db, "empty-root-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed,
            "empty-root-test", asyncio.Event(),
        )
    async with db_session._SessionLocal() as check:
        stored = await check.get(FileSyncReconcileRun, run.id)
        assert stored is not None and stored.status == "succeeded"
        assert stored.scanned_count == 0


@pytest.mark.asyncio
async def test_repair_refreshes_fingerprint_for_existing_empty_workspace_root(db, user_a, monkeypatch):
    """数据库恢复后，空且无 File/Folder 记录的目录可只更新绑定指纹。"""
    from app.core.config import get_settings
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    directory = WorkspaceDirectory(
        user_id=user_a.id, name="空目录指纹恢复", directory_name="empty-fingerprint",
    )
    db.add(directory)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name="空目录指纹恢复", kind="directory",
        directory_id=directory.id, enabled=True,
    )
    db.add(workspace)
    await db.flush()
    root = storage_root / str(user_a.id) / "workspace" / directory.directory_name
    root.mkdir(parents=True)
    stale_fingerprint = "stale-binding-root-fingerprint"
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=workspace.id, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint=stale_fingerprint,
    )
    db.add(binding)
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()

    claimed = await claim_next_run(db, "empty-fingerprint-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed,
            "empty-fingerprint-test", asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_binding = await check.get(FileSyncBinding, binding.id)
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        assert stored_binding is not None
        assert stored_run is not None and stored_run.status == "succeeded"
        assert stored_binding.root_fingerprint == _root_fingerprint(root)
        assert stored_run.root_fingerprint == stored_binding.root_fingerprint
        assert stored_binding.root_fingerprint != stale_fingerprint
        assert await check.scalar(select(File.id).where(File.user_id == user_a.id)) is None
        assert await check.scalar(select(Folder.id).where(Folder.user_id == user_a.id)) is None


@pytest.mark.asyncio
async def test_repair_refreshes_stale_fingerprint_for_canonical_nonempty_workspace_without_deleting_records(
    db, user_a, monkeypatch,
):
    """现存 canonical 根可刷新绑定指纹；旧记录和物理内容保持不变。"""
    from app.core.config import get_settings
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    directory = WorkspaceDirectory(
        user_id=user_a.id, name="已有数据工作区", directory_name="existing-data",
    )
    db.add(directory)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name="已有数据工作区", kind="directory",
        directory_id=directory.id, enabled=True,
    )
    db.add(workspace)
    await db.flush()
    root = storage_root / str(user_a.id) / "workspace" / directory.directory_name
    root.mkdir(parents=True)
    content = b"preserve existing content"
    (root / "existing.txt").write_bytes(content)
    file_row = File(
        user_id=user_a.id, display_name="existing", ext="txt", space="workspace",
        workspace_directory_id=directory.id,
        storage_key=f"{user_a.id}/workspace/{directory.directory_name}/existing.txt",
        size_bytes=len(content),
    )
    db.add(file_row)
    await db.flush()
    original_file_id = file_row.id
    stale_fingerprint = "stale-binding-root-fingerprint"
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=workspace.id, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint=stale_fingerprint,
    )
    db.add(binding)
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair", allow_delete=False,
    )
    await db.commit()

    claimed = await claim_next_run(db, "existing-root-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed,
            "existing-root-test", asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_binding = await check.get(FileSyncBinding, binding.id)
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        stored_file = await check.get(File, original_file_id)
        assert stored_binding is not None
        assert stored_run is not None and stored_run.status == "succeeded"
        assert stored_binding.root_fingerprint == _root_fingerprint(root)
        assert stored_run.root_fingerprint == stored_binding.root_fingerprint
        assert stored_file is not None and stored_file.storage_key.endswith("/existing.txt")
        assert stored_run.result_counts["deleted"] == 0
        assert (root / "existing.txt").read_bytes() == content


@pytest.mark.asyncio
async def test_repair_rejects_symlink_when_it_overlaps_existing_library_record(db, user_a, monkeypatch, tmp_path):
    """链接路径覆盖 File 记录时整轮不投影，避免链接被误当成缺失文件。"""
    from app.core.config import get_settings
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    directory = WorkspaceDirectory(
        user_id=user_a.id, name="链接边界工作区", directory_name="symlink-boundary",
    )
    db.add(directory)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name="链接边界工作区", kind="directory",
        directory_id=directory.id, enabled=True,
    )
    db.add(workspace)
    await db.flush()
    root = storage_root / str(user_a.id) / "workspace" / directory.directory_name
    root.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    physical = outside / "existing.txt"
    physical.write_bytes(b"keep physical data")
    (root / "linked").symlink_to(outside, target_is_directory=True)
    file_row = File(
        user_id=user_a.id, display_name="existing", ext="txt", space="workspace",
        workspace_directory_id=directory.id,
        storage_key=f"{user_a.id}/workspace/{directory.directory_name}/linked/existing.txt",
        size_bytes=18,
    )
    db.add(file_row)
    await db.flush()
    original_file_id = file_row.id
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=workspace.id, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id,
        action="repair", allow_delete=True,
    )
    await db.commit()

    claimed = await claim_next_run(db, "symlink-overlap-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed,
            "symlink-overlap-test", asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        stored_file = await check.get(File, original_file_id)
        assert stored_run is not None and stored_run.status == "failed"
        assert stored_run.error_code == "scan_unsupported_symlink"
        assert stored_file is not None and stored_file.deleted_at is None
        assert physical.read_bytes() == b"keep physical data"


@pytest.mark.asyncio
@pytest.mark.parametrize("record_kind", ["file", "folder"])
async def test_repair_does_not_recreate_missing_root_when_old_records_exist(
    db, user_a, monkeypatch, record_kind,
):
    """缺失根目录下仍有关联记录时拒绝空目录恢复，不改动旧记录。"""
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings.storage, "backend", "local")
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    directory = WorkspaceDirectory(
        user_id=user_a.id, name="有历史的工作区", directory_name="has-history",
    )
    db.add(directory)
    await db.flush()
    workspace = Workspace(
        user_id=user_a.id, name="有历史的工作区", kind="directory",
        directory_id=directory.id, enabled=True,
    )
    db.add(workspace)
    await db.flush()
    root = storage_root / str(user_a.id) / "workspace" / directory.directory_name
    if record_kind == "file":
        db.add(File(
            user_id=user_a.id, display_name="旧文件", ext="txt", space="workspace",
            workspace_directory_id=directory.id,
            storage_key=f"{user_a.id}/workspace/{directory.directory_name}/旧文件.txt",
        ))
    else:
        db.add(Folder(user_id=user_a.id, workspace_directory_id=directory.id, name="旧文件夹"))
    binding = FileSyncBinding(
        user_id=user_a.id, workspace_id=workspace.id, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()

    claimed = await claim_next_run(db, "protected-root-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed,
            "protected-root-test", asyncio.Event(),
        )

    assert not root.exists()
    async with db_session._SessionLocal() as check:
        stored = await check.get(FileSyncReconcileRun, run.id)
        assert stored is not None and stored.status == "failed"
        assert stored.error_code == "root_recovery_blocked"
        if record_kind == "file":
            assert await check.scalar(select(File.id).where(File.user_id == user_a.id)) is not None
        else:
            assert await check.scalar(select(Folder.id).where(Folder.user_id == user_a.id)) is not None


@pytest.mark.asyncio
async def test_empty_scan_without_history_does_not_delete_existing_library_file(
    db, user_a, monkeypatch,
):
    """空根无法证明 DB 文件已删除；无快照也不能把空清单当成缺失依据。"""
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    storage_root = Path(runner.get_settings().storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    root.mkdir(parents=True)
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    existing = File(
        user_id=user_a.id,
        display_name="遗留文件",
        ext="txt",
        space="personal",
        storage_key=f"{user_a.id}/个人文件/遗留文件.txt",
        size="4 B",
        size_bytes=4,
        version=3,
    )
    db.add_all([binding, existing])
    await db.flush()
    run = await enqueue_reconcile_run(
        db,
        user_id=user_a.id,
        binding_id=binding.id,
        action="repair",
        allow_delete=True,
    )
    await db.commit()
    claimed = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id

    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal,
            executor,
            claimed,
            "runner-test",
            asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        stored_file = await check.get(File, existing.id)

    assert stored_run is not None and stored_run.status == "failed"
    assert stored_file is not None and stored_file.deleted_at is None
    assert stored_file.version == 3


@pytest.mark.asyncio
async def test_manifest_budget_failure_does_not_delete_db_orphan(
    db, user_a, monkeypatch,
):
    """完整扫描清单超预算时失败收尾，不能把未完成清单用于缺失删除。"""
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted

    storage_root = Path(runner.get_settings().storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    personal = root / "个人文件"
    personal.mkdir(parents=True)
    (personal / "physical.txt").write_text("physical", encoding="utf-8")
    monkeypatch.setattr(runner, "default_manifest_budget", lambda: (1, 1))
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    orphan = File(
        user_id=user_a.id,
        display_name="数据库记录",
        ext="txt",
        space="personal",
        storage_key=f"{user_a.id}/个人文件/missing.txt",
        size="4 B",
        size_bytes=4,
        version=2,
    )
    db.add_all([binding, orphan])
    await db.flush()
    run = await enqueue_reconcile_run(
        db,
        user_id=user_a.id,
        binding_id=binding.id,
        action="repair",
        allow_delete=True,
    )
    await db.commit()
    claimed = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id

    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal,
            executor,
            claimed,
            "runner-test",
            asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, run.id)
        stored_orphan = await check.get(File, orphan.id)
    assert stored_run is not None and stored_run.status == "failed"
    assert stored_run.error_code == "scan_manifest_budget_exceeded"
    assert stored_orphan is not None and stored_orphan.deleted_at is None
    assert stored_orphan.version == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("stop_mode", ["cancel", "timeout"])
async def test_same_user_task_cannot_take_scan_slot_until_stopped_thread_exits(
    multi_session_filesync_db, user_a, monkeypatch, stop_mode,
):
    """扫描线程退出前取消/超时都保留同用户执行槽，之后才可接管。"""
    from app.api.v1 import agent as agent_api
    import agent.context.compress_conv as compress_conv
    import app.services.filesync.runner as runner
    import app.services.filesync.scan as scan
    import app.services.filesync.targeted as targeted

    storage_root = Path(runner.get_settings().storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    nested = root / "个人文件" / "正在扫描"
    nested.mkdir(parents=True)
    (nested / "entry.txt").write_text("entry", encoding="utf-8")
    entered_traversal = Event()
    release_traversal = Event()
    original_scandir = scan.os.scandir

    def gated_scandir(path):
        if Path(path) == nested:
            entered_traversal.set()
            assert release_traversal.wait(timeout=10)
        return original_scandir(path)

    monkeypatch.setattr(scan.os, "scandir", gated_scandir)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(runner, "_LEASE_RENEW_SECONDS", 0.02)
    monkeypatch.setattr(runner, "_POLL_SECONDS", 0.01)
    async def no_orphan_recovery(*_args, **_kwargs):
        return False

    async def chat_is_active(_session_id):
        return True

    async def chat_snapshot(_session_id):
        return {"owner_run_id": "synthetic-chat-run"}

    monkeypatch.setattr(compress_conv, "recover_orphaned_session", no_orphan_recovery)
    monkeypatch.setattr(agent_api.genstream, "is_active", chat_is_active)
    monkeypatch.setattr(agent_api.genstream, "snapshot", chat_snapshot)
    monkeypatch.setattr(agent_api.web_adapter, "cancel_local_generation", lambda *_args: True)

    scan_stop_events = []
    unhandled_loop_errors = []
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(
        loop, "call_exception_handler",
        lambda context: unhandled_loop_errors.append(context),
    )
    original_run_scan = runner.run_scan_in_thread

    async def capture_scan_stop(*args, **kwargs):
        scan_stop_events.append(kwargs["stop_event"])
        return await original_run_scan(*args, **kwargs)

    monkeypatch.setattr(runner, "run_scan_in_thread", capture_scan_stop)
    binding_a = FileSyncBinding(
        user_id=user_a.id, workspace_id=None, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    binding_b = FileSyncBinding(
        user_id=user_a.id, workspace_id=None, source="local_directory",
        mode="bidirectional", status="active", root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    async with multi_session_filesync_db() as setup_db:
        setup_db.add_all([binding_a, binding_b])
        chat_session = ConversationSession(
            user_id=user_a.id, title="扫描期间取消验收", source="web",
        )
        setup_db.add(chat_session)
        await setup_db.flush()
        run_a = await enqueue_reconcile_run(
            setup_db, user_id=user_a.id, binding_id=binding_a.id, action="repair",
        )
        run_b = await enqueue_reconcile_run(
            setup_db, user_id=user_a.id, binding_id=binding_b.id, action="initialize",
        )
        await setup_db.commit()
        claimed_a = await claim_next_run(setup_db, "runner-a", now=now_utc())
    assert claimed_a is not None and claimed_a.id == run_a.id
    initial_lease_until = claimed_a.lease_until

    worker_stop = asyncio.Event()
    with ThreadPoolExecutor(max_workers=1) as executor:
        task = asyncio.create_task(_run_claimed(
            db_session._SessionLocal, executor, claimed_a, "runner-a", worker_stop,
        ))
        assert await asyncio.to_thread(entered_traversal.wait, 5)
        await asyncio.sleep(0.05)
        async with db_session._SessionLocal() as heartbeat_db:
            live_run = await heartbeat_db.get(FileSyncReconcileRun, run_a.id)
            assert live_run is not None and live_run.lease_until > initial_lease_until
            await heartbeat_db.rollback()
        async with db_session._SessionLocal() as chat_db:
            chat_cancel = await agent_api.cancel_stream(
                chat_session.id, current_user=user_a, db=chat_db,
            )
            await chat_db.rollback()
        assert chat_cancel == {
            "ok": True, "active": True, "recovered": False, "cancelled_locally": True,
        }
        async with db_session._SessionLocal() as stop_db:
            if stop_mode == "cancel":
                stopping = await request_run_cancel(
                    stop_db, run_a.id, user_id=user_a.id,
                )
                assert stopping is not None and stopping.status == "cancelling"
            else:
                stopping = await stop_db.get(FileSyncReconcileRun, run_a.id)
                assert stopping is not None
                stopping.deadline_at = now_utc() - timedelta(seconds=1)
            await stop_db.commit()

        # 等到监视器确实向扫描线程发出停止信号；线程仍卡在目录遍历屏障。
        assert scan_stop_events
        assert await asyncio.to_thread(scan_stop_events[0].wait, 5)

        # 物理扫描线程仍被屏障阻塞；旧任务未完成且同用户新任务不能被领取。
        assert not task.done()
        async with db_session._SessionLocal() as claim_db:
            assert await claim_next_run(claim_db, "runner-b", now=now_utc()) is None
        release_traversal.set()
        await asyncio.wait_for(task, timeout=5)

    await asyncio.sleep(0)
    gc.collect()
    assert not unhandled_loop_errors, "取消/超时收尾遗留未消费的扫描任务异常"

    async with db_session._SessionLocal() as next_db:
        stored_a = await next_db.get(FileSyncReconcileRun, run_a.id)
        claimed_b = await claim_next_run(next_db, "runner-b", now=now_utc())
    expected_status = "cancelled" if stop_mode == "cancel" else "failed"
    expected_error = None if stop_mode == "cancel" else "execution_timeout"
    assert stored_a is not None and stored_a.status == expected_status
    assert stored_a.error_code == expected_error
    assert claimed_b is not None and claimed_b.id == run_b.id


@pytest.mark.asyncio
async def test_stale_scan_candidates_are_skipped_after_targeted_crud_and_move(
    db, user_a, monkeypatch,
):
    """扫描候选遇到实时更新/新建/移动/删除时，不覆盖或重复投影旧状态。"""
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted
    from app.services.filesync.scan import ReconcileCandidate

    settings = runner.get_settings()
    storage_root = Path(settings.storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    personal = root / "个人文件"
    personal.mkdir(parents=True)
    current_path = personal / "并发更新.txt"
    current_path.write_bytes(b"newer")
    new_path = personal / "实时已创建.txt"
    new_path.write_bytes(b"created")
    moved_target = personal / "实时移动目标.txt"
    moved_target.write_bytes(b"moved")
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    existing = File(
        user_id=user_a.id,
        display_name="并发更新",
        ext="txt",
        space="personal",
        storage_key=f"{user_a.id}/个人文件/并发更新.txt",
        size="3 B",
        size_bytes=3,
        version=4,
    )
    moved = File(
        user_id=user_a.id,
        display_name="移动文件",
        ext="txt",
        space="personal",
        storage_key=f"{user_a.id}/个人文件/移动源.txt",
        size="5 B",
        size_bytes=5,
        version=6,
    )
    deleted = File(
        user_id=user_a.id,
        display_name="实时删除",
        ext="txt",
        space="personal",
        storage_key=f"{user_a.id}/个人文件/实时删除.txt",
        size="7 B",
        size_bytes=7,
        version=3,
    )
    db.add_all([binding, existing, moved, deleted])
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()
    claimed = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id

    scope = runner._RunScope(
        run_id=run.id,
        user_id=user_a.id,
        binding_id=binding.id,
        root=root,
        mode="bidirectional",
        workspace_id=None,
        root_fingerprint=binding.root_fingerprint,
        gap_revision=binding.gap_revision,
        action="repair",
        allow_delete=True,
    )
    candidate = ReconcileCandidate(
        "个人文件/并发更新.txt",
        "file",
        "update",
        observed_size=3,
        observed_fingerprint="stale-scan-fingerprint",
        object_id=existing.id,
        object_version=4,
    )
    create_candidate = ReconcileCandidate(
        "个人文件/实时已创建.txt",
        "file",
        "create",
        observed_size=7,
        observed_fingerprint="new-file-fingerprint",
    )
    move_delete_candidate = ReconcileCandidate(
        "个人文件/移动源.txt",
        "file",
        "delete",
        object_id=moved.id,
        object_version=6,
    )
    move_create_candidate = ReconcileCandidate(
        "个人文件/实时移动目标.txt",
        "file",
        "create",
        observed_size=5,
        observed_fingerprint="stale-move-fingerprint",
    )
    delete_candidate = ReconcileCandidate(
        "个人文件/实时删除.txt",
        "file",
        "delete",
        object_id=deleted.id,
        object_version=3,
    )
    candidates = [
        candidate,
        create_candidate,
        move_delete_candidate,
        move_create_candidate,
        delete_candidate,
    ]
    counts = runner._empty_counts()
    candidates_ready = asyncio.Event()
    allow_projection = asyncio.Event()

    async def project_after_scan_barrier():
        candidates_ready.set()
        await allow_projection.wait()
        return await runner._project_batch(
            db_session._SessionLocal,
            scope,
            "runner-test",
            candidates,
            storage_prefix=f"{user_a.id}/",
            verified_files={
                candidate.relative_path: (3, 1, 1, "stale-scan-fingerprint"),
                create_candidate.relative_path: (7, 1, 2, "new-file-fingerprint"),
                move_create_candidate.relative_path: (5, 1, 3, "stale-move-fingerprint"),
            },
            missing_paths={
                move_delete_candidate.relative_path,
                delete_candidate.relative_path,
            },
            counts=counts,
            stop=Event(),
        )

    projection_task = asyncio.create_task(project_after_scan_barrier())
    await candidates_ready.wait()
    # 候选已经代表扫描时的旧状态；实时 targeted 先提交更新和新建后才放行投影。
    async with db_session._SessionLocal() as live_db:
        live_file = await live_db.get(File, existing.id)
        assert live_file is not None
        live_file.version = 5
        live_file.size_bytes = len(b"newer")
        live_moved = await live_db.get(File, moved.id)
        assert live_moved is not None
        live_moved.storage_key = f"{user_a.id}/个人文件/实时移动目标.txt"
        live_moved.version = 7
        live_deleted = await live_db.get(File, deleted.id)
        assert live_deleted is not None
        live_deleted.deleted_at = now_utc()
        live_deleted.version = 4
        live_db.add(File(
            user_id=user_a.id,
            display_name="实时已创建",
            ext="txt",
            space="personal",
            storage_key=f"{user_a.id}/个人文件/实时已创建.txt",
            size="7 B",
            size_bytes=7,
            version=1,
        ))
        await live_db.commit()
    allow_projection.set()
    projected = await projection_task

    async with db_session._SessionLocal() as check:
        stored = await check.get(File, existing.id)
        stored_moved = await check.get(File, moved.id)
        stored_deleted = await check.get(File, deleted.id)
        created_rows = list((await check.scalars(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/实时已创建.txt",
            File.deleted_at.is_(None),
        ))).all())
        stored_run = await check.get(FileSyncReconcileRun, run.id)
    assert projected is True
    assert stored is not None and stored.version == 5 and stored.size_bytes == len(b"newer")
    assert stored_moved is not None and stored_moved.version == 7
    assert stored_moved.storage_key.endswith("/实时移动目标.txt")
    assert stored_deleted is not None and stored_deleted.version == 4
    assert stored_deleted.deleted_at is not None
    assert len(created_rows) == 1
    assert stored_run is not None and stored_run.result_counts["skipped"] == 5


@pytest.mark.asyncio
async def test_live_write_after_scan_verification_is_not_projected_from_stale_fingerprint(
    db, user_a, monkeypatch,
):
    """在文件复核后、投影事务前发生写入时，旧 stat 证据必须被拒绝。"""
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted
    from app.services.filesync.scan import ReconcileCandidate

    storage_root = Path(runner.get_settings().storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    personal = root / "个人文件"
    personal.mkdir(parents=True)
    live_path = personal / "复核后写入.txt"
    live_path.write_bytes(b"old")
    verified_stat = live_path.stat()
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    existing = File(
        user_id=user_a.id,
        display_name="复核后写入",
        ext="txt",
        space="personal",
        storage_key=f"{user_a.id}/个人文件/复核后写入.txt",
        size="3 B",
        size_bytes=3,
        version=1,
    )
    db.add_all([binding, existing])
    await db.flush()
    run = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()
    claimed = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed is not None and claimed.id == run.id

    # 线程复核已完成；在候选进入短投影事务前由本地实时写入替换内容。
    live_path.write_bytes(b"new-live-content")
    scope = runner._RunScope(
        run_id=run.id,
        user_id=user_a.id,
        binding_id=binding.id,
        root=root,
        mode="bidirectional",
        workspace_id=None,
        root_fingerprint=binding.root_fingerprint,
        gap_revision=binding.gap_revision,
        action="repair",
        allow_delete=False,
    )
    candidate = ReconcileCandidate(
        "个人文件/复核后写入.txt",
        "file",
        "update",
        observed_size=3,
        observed_fingerprint="old-fingerprint",
        object_id=existing.id,
        object_version=1,
    )
    counts = runner._empty_counts()
    verified_files = {
        candidate.relative_path: (
            verified_stat.st_size,
            verified_stat.st_mtime_ns,
            verified_stat.st_ino,
            "old-fingerprint",
        ),
    }
    projection_started = asyncio.Event()
    allow_projection = asyncio.Event()
    project_events = runner.project_path_events

    async def wait_for_live_write(*args, **kwargs):
        projection_started.set()
        await allow_projection.wait()
        return await project_events(*args, **kwargs)

    monkeypatch.setattr(runner, "project_path_events", wait_for_live_write)
    projection = asyncio.create_task(runner._project_batch(
        db_session._SessionLocal,
        scope,
        "runner-test",
        [candidate],
        storage_prefix=f"{user_a.id}/",
        verified_files=verified_files,
        missing_paths=set(),
        counts=counts,
        stop=Event(),
    ))
    await projection_started.wait()
    live_path.write_bytes(b"new-live-content")
    allow_projection.set()
    await projection

    async with db_session._SessionLocal() as check:
        stored = await check.get(File, existing.id)
        stored_run = await check.get(FileSyncReconcileRun, run.id)
    assert stored is not None and stored.version == 1 and stored.size_bytes == 3
    assert stored_run is not None and stored_run.result_counts["failed"] == 1


@pytest.mark.asyncio
async def test_candidate_version_checks_are_batched_and_keep_stale_scan_guard(db, user_a):
    """批量复核保留版本/活动路径约束，同时避免每个扫描路径各发一条 SQL。"""
    import app.services.filesync.runner as runner
    from sqlalchemy import event

    prefix = f"{user_a.id}/"
    current = File(
        user_id=user_a.id, display_name="当前文件", ext="txt", space="personal",
        storage_key=f"{prefix}个人文件/当前.txt", version=4,
    )
    occupied = File(
        user_id=user_a.id, display_name="占用路径", ext="txt", space="personal",
        storage_key=f"{prefix}个人文件/占用.txt", version=1,
    )
    historical = File(
        user_id=user_a.id, display_name="已软删除历史", ext="txt", space="personal",
        storage_key=f"{prefix}个人文件/历史.txt", version=2, deleted_at=now_utc(),
    )
    db.add_all([current, occupied, historical])
    await db.flush()
    scope = SimpleNamespace(user_id=user_a.id, root=Path("/unused-for-file-candidates"))
    candidates = [
        runner.ReconcileCandidate(
            "个人文件/当前.txt", "file", "update",
            object_id=current.id, object_version=4,
        ),
        runner.ReconcileCandidate(
            "个人文件/当前.txt", "file", "update",
            object_id=current.id, object_version=3,
        ),
        runner.ReconcileCandidate("个人文件/新建.txt", "file", "create"),
        runner.ReconcileCandidate("个人文件/占用.txt", "file", "create"),
        runner.ReconcileCandidate("个人文件/历史.txt", "file", "create"),
    ]
    statements = []

    def record_sql(_connection, _cursor, statement, _parameters, _context, _many):
        if "files" in statement.lower():
            statements.append(statement)

    event.listen(db.bind.sync_engine, "before_cursor_execute", record_sql)
    try:
        valid = await runner._current_candidates(db, scope, candidates, prefix)
    finally:
        event.remove(db.bind.sync_engine, "before_cursor_execute", record_sql)

    assert valid == {0, 2, 4}
    assert len(statements) == 2


def _assert_optional_repair_quota(quota, *, ledger_preexists: bool, expected_bytes: int) -> None:
    if ledger_preexists:
        assert quota is not None and quota.used_bytes == expected_bytes
    else:
        assert quota is None


@pytest.mark.parametrize("ledger_preexists", [True, False])
@pytest.mark.asyncio
async def test_confirmed_repair_hashes_same_stat_update_and_applies_missing_file_delete(
    db, user_a, monkeypatch, ledger_preexists,
):
    import app.services.filesync.runner as runner
    import app.services.filesync.targeted as targeted
    from app.services.filesync.reconcile import SyncSummary

    storage_root = Path(runner.get_settings().storage.local_path).expanduser().resolve()
    root = storage_root / str(user_a.id)
    personal = root / "个人文件"
    nested = personal / "分类"
    nested.mkdir(parents=True)
    changed_path = nested / "等长更新.txt"
    deleted_path = nested / "确认删除.txt"
    move_source = personal / "移动源.txt"
    move_target = nested / "移动后.txt"
    changed_path.write_bytes(b"before")
    deleted_path.write_bytes(b"remove me")
    move_source.write_bytes(b"move contents")
    monkeypatch.setattr(runner, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)

    binding = FileSyncBinding(
        user_id=user_a.id,
        workspace_id=None,
        source="local_directory",
        mode="bidirectional",
        status="active",
        root_path=".",
        root_fingerprint=_root_fingerprint(root),
    )
    db.add(binding)
    await db.flush()
    initialize = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="initialize",
    )
    await db.commit()
    claimed = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed is not None and claimed.id == initialize.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal, executor, claimed, "runner-test", asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        changed_file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/分类/等长更新.txt",
        ))
        deleted_file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/分类/确认删除.txt",
        ))
        moved_file = await check.scalar(select(File).where(
            File.user_id == user_a.id,
            File.storage_key == f"{user_a.id}/个人文件/移动源.txt",
        ))
        assert changed_file is not None and deleted_file is not None and moved_file is not None
        original_version = changed_file.version
        moved_file_id = moved_file.id
        original_stat = changed_path.stat()

    changed_path.write_bytes(b"after!")
    os.utime(changed_path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    deleted_path.unlink()
    move_source.rename(move_target)
    if ledger_preexists:
        # 模拟既有额度账本；另一组用例覆盖首次删除时初始化账本。
        db.add(StorageQuotaLedger(
            user_id=user_a.id,
            category=FILE_LIBRARY,
            used_bytes=28,
            limit_bytes=10**12,
        ))
        await db.commit()
    repair = await enqueue_reconcile_run(
        db,
        user_id=user_a.id,
        binding_id=binding.id,
        action="repair",
        allow_delete=True,
    )
    await db.commit()
    claimed_repair = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed_repair is not None and claimed_repair.id == repair.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal,
            executor,
            claimed_repair,
            "runner-test",
            asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        stored_run = await check.get(FileSyncReconcileRun, repair.id)
        updated = await check.scalar(select(File).where(File.id == changed_file.id))
        deleted = await check.scalar(select(File).where(File.id == deleted_file.id))
        moved = await check.scalar(select(File).where(File.id == moved_file_id))
        quota = await check.scalar(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_a.id,
            StorageQuotaLedger.category == FILE_LIBRARY,
        ))

    assert stored_run is not None and stored_run.status == "succeeded"
    assert stored_run.result_counts["updated"] == 1
    assert stored_run.result_counts["deleted"] == 1
    assert stored_run.result_counts["moved"] == 1
    assert updated is not None and updated.version == original_version + 1
    assert deleted is not None and deleted.deleted_at is not None
    assert moved is not None and moved.storage_key == f"{user_a.id}/个人文件/分类/移动后.txt"
    # 无账本时不在任务中途建立偏离磁盘事实的局部基线。
    _assert_optional_repair_quota(quota, ledger_preexists=ledger_preexists, expected_bytes=19)

    changed_path.write_bytes(b"reject")
    move_target.write_bytes(b"move updated")
    monkeypatch.setattr(runner, "_DB_BATCH_SIZE", 2)
    project_batch = runner.project_path_events
    projection_calls = 0

    async def fail_second_batch(*args, **kwargs):
        nonlocal projection_calls
        projection_calls += 1
        if projection_calls == 2:
            return SyncSummary(rejected=1)
        return await project_batch(*args, **kwargs)

    monkeypatch.setattr(runner, "project_path_events", fail_second_batch)
    partial = await enqueue_reconcile_run(
        db, user_id=user_a.id, binding_id=binding.id, action="repair",
    )
    await db.commit()
    claimed_partial = await claim_next_run(db, "runner-test", now=now_utc())
    assert claimed_partial is not None and claimed_partial.id == partial.id
    with ThreadPoolExecutor(max_workers=1) as executor:
        await _run_claimed(
            db_session._SessionLocal,
            executor,
            claimed_partial,
            "runner-test",
            asyncio.Event(),
        )

    async with db_session._SessionLocal() as check:
        partial_run = await check.get(FileSyncReconcileRun, partial.id)
        unchanged = await check.scalar(select(File).where(File.id == changed_file.id))
        active_files = (await check.scalars(select(File).where(
            File.user_id == user_a.id,
            File.deleted_at.is_(None),
        ))).all()
        quota_after_partial = await check.scalar(select(StorageQuotaLedger).where(
            StorageQuotaLedger.user_id == user_a.id,
            StorageQuotaLedger.category == FILE_LIBRARY,
        ))

    assert partial_run is not None and partial_run.status == "failed"
    assert partial_run.error_code == "path_projection_failed"
    assert partial_run.result_counts["failed"] == 1
    assert partial_run.result_counts["updated"] + partial_run.result_counts["foldersUpdated"] > 0
    assert unchanged is not None and unchanged.version >= updated.version
    expected_active_bytes = sum(int(file.size_bytes or 0) for file in active_files)
    _assert_optional_repair_quota(
        quota_after_partial,
        ledger_preexists=ledger_preexists,
        expected_bytes=expected_active_bytes,
    )


@pytest.mark.asyncio
async def test_stale_scan_artifact_cleanup_preserves_active_runs_and_progress_is_bounded(
    tmp_path, monkeypatch,
):
    import app.services.filesync.runner as runner

    active_id = uuid4()
    finished_id = uuid4()
    active_dir = tmp_path / f"gugu-filesync-{active_id}-worker"
    finished_dir = tmp_path / f"gugu-filesync-{finished_id}-worker"
    unrelated_dir = tmp_path / "gugu-filesync-not-a-run"
    active_dir.mkdir()
    finished_dir.mkdir()
    unrelated_dir.mkdir()
    active_dir.chmod(0o700)
    finished_dir.chmod(0o700)
    monkeypatch.setattr(runner.tempfile, "gettempdir", lambda: str(tmp_path))

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _model, run_id):
            if run_id == active_id:
                return SimpleNamespace(status="running")
            return SimpleNamespace(status="failed")

        async def rollback(self):
            return None

    await _cleanup_stale_scan_artifacts(lambda: FakeSession())
    assert active_dir.exists()
    assert not finished_dir.exists()
    assert unrelated_dir.exists()

    progress: queue.Queue[tuple[int, int]] = queue.Queue(maxsize=1)
    _publish_latest_progress(progress, 10, 1000)
    _publish_latest_progress(progress, 20, 2000)
    assert progress.qsize() == 1
    assert progress.get_nowait() == (20, 2000)
