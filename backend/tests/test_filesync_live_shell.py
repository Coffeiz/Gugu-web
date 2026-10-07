"""用真实 Shell 变更临时个人目录，验证 TS watcher 到 File/journal 的即时链路。"""
import asyncio
import hashlib
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from uuid6 import uuid7

from app.core.tz import now_utc
from app.db import session as db_session
from app.db.base import Base
from app.models import File, FileSyncBinding, FileSyncJournal, User
from app.services.filesync.reconcile import _root_fingerprint
from app.services.filesync.watcher import FileSyncWatcherManager
from app.services.filesync.protocol import FileSyncSource


@pytest_asyncio.fixture
async def isolated_filesync_session(tmp_path, monkeypatch):
    """用多连接文件 SQLite 模拟生产多 session，避免 StaticPool 共用单连接竞态。"""
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'filesync-shell.sqlite'}",
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False,
    )
    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(db_session, "_SessionLocal", session_factory)
    monkeypatch.setattr(db_session, "_engine_loop", asyncio.get_running_loop())
    yield session_factory
    await engine.dispose()


@pytest.mark.asyncio
async def test_shell_create_equal_size_update_and_delete_project_without_manual_scan(
    isolated_filesync_session, monkeypatch,
):
    import app.services.filesync.bindings as bindings_service
    import app.services.filesync.protocol as protocol
    import app.services.filesync.reconcile as reconcile
    import app.services.filesync.targeted as targeted
    import app.services.filesync.watcher as watcher

    storage_root = Path(reconcile.get_settings().storage.local_path).expanduser().resolve()
    user_id = uuid7()
    root = storage_root / str(user_id)
    (root / "个人文件").mkdir(parents=True)
    settings = SimpleNamespace(
        filesync=SimpleNamespace(enabled=True, active_window_days=7),
        storage=SimpleNamespace(backend="local", local_path=str(storage_root)),
        quota=SimpleNamespace(default_storage_limit_bytes=1024 * 1024),
    )
    for module in (bindings_service, protocol, reconcile, targeted, watcher):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    for module in (protocol, reconcile, targeted, watcher):
        monkeypatch.setattr(module, "is_file_sync_enabled", lambda: True)
    for module in (reconcile, targeted, watcher, bindings_service):
        monkeypatch.setattr(module, "workspace_shell_supported", lambda: True)

    user = User(
        id=user_id,
        username="probe-user",
        email=f"{user_id}@test.local",
        hashed_password="x",
        is_active=True,
        last_active_at=now_utc(),
    )
    binding = FileSyncBinding(
        user_id=user_id,
        source=FileSyncSource.LOCAL_DIRECTORY,
        root_fingerprint=_root_fingerprint(root),
        root_path=".",
    )
    async with isolated_filesync_session() as session:
        session.add_all([user, binding])
        await session.commit()

    manager = FileSyncWatcherManager(refresh_interval=0.05)
    stop = asyncio.Event()
    observed_events = []
    projection_errors = []
    original_handle_event = manager._handle_event
    original_project = watcher.project_path_events

    async def capture_projection_error(*args, **kwargs):
        try:
            return await original_project(*args, **kwargs)
        except Exception as exc:
            projection_errors.append(type(exc).__name__)
            raise

    monkeypatch.setattr(watcher, "project_path_events", capture_projection_error)

    async def capture_event(event):
        observed_events.append({
            key: event.get(key)
            for key in ("event", "binding_id", "relative_path", "operation", "code")
            if key in event
        })
        await original_handle_event(event)

    manager._handle_event = capture_event
    watcher_task = asyncio.create_task(manager.run(stop))

    async def shell(command: str) -> None:
        process = await asyncio.create_subprocess_exec(
            "/bin/sh", "-c", command, cwd=root,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=5)
        assert process.returncode == 0, stderr.decode("utf-8", errors="replace")

    async def file_snapshot():
        async with db_session._SessionLocal() as session:
            row = await session.scalar(select(File).where(
                File.user_id == user_id,
                File.storage_key == f"{user_id}/个人文件/探针.txt",
            ))
            if row is not None:
                await session.refresh(row)
            return row

    try:
        for _ in range(100):
            if binding.id in manager._ready_bindings:
                break
            await asyncio.sleep(0.05)
        assert binding.id in manager._ready_bindings, "临时根目录监听未就绪"

        metrics = {}
        started_at = time.perf_counter()
        await shell("printf 'alpha' > '个人文件/探针.txt'")
        create_fingerprint = hashlib.sha256(b"alpha").hexdigest()
        create_journal = None
        for _ in range(100):
            created = await file_snapshot()
            async with db_session._SessionLocal() as session:
                create_journal = await session.scalar(select(FileSyncJournal).where(
                    FileSyncJournal.binding_id == binding.id,
                    FileSyncJournal.relative_path == "个人文件/探针.txt",
                    FileSyncJournal.operation == "create",
                ).order_by(FileSyncJournal.id.desc()))
            if (
                created is not None
                and created.deleted_at is None
                and create_journal is not None
                and create_journal.observed_fingerprint == create_fingerprint
            ):
                break
            await asyncio.sleep(0.05)
        async with db_session._SessionLocal() as session:
            observed_binding = await session.get(FileSyncBinding, binding.id)
            binding_state = (
                observed_binding.watcher_status,
                observed_binding.health_error_code,
                observed_binding.needs_reconcile,
            ) if observed_binding is not None else None
        assert (
            created is not None
            and created.deleted_at is None
            and create_journal is not None
            and create_journal.observed_fingerprint == create_fingerprint
        ), (
            "Shell 新建未完成即时投影；"
            f"events={observed_events!r}; ready={binding.id in manager._ready_bindings}; "
            f"buffered={manager._path_events.get(binding.id)!r}; "
            f"retries={manager._retry_count.get(binding.id)}; projection_errors={projection_errors!r}; "
            f"binding_state={binding_state!r}"
        )
        assert created.size_bytes == 5
        metrics["create_ms"] = round((time.perf_counter() - started_at) * 1000, 1)
        original_version = created.version

        started_at = time.perf_counter()
        await shell("printf 'bravo' > '个人文件/探针.txt'")
        update_fingerprint = hashlib.sha256(b"bravo").hexdigest()
        update_journal = None
        for _ in range(100):
            updated = await file_snapshot()
            async with db_session._SessionLocal() as session:
                update_journal = await session.scalar(select(FileSyncJournal).where(
                    FileSyncJournal.binding_id == binding.id,
                    FileSyncJournal.relative_path == "个人文件/探针.txt",
                    FileSyncJournal.operation == "update",
                ).order_by(FileSyncJournal.id.desc()))
            if (
                updated is not None
                and updated.version > original_version
                and update_journal is not None
                and update_journal.observed_fingerprint == update_fingerprint
            ):
                break
            await asyncio.sleep(0.05)
        assert (
            updated is not None
            and updated.version > original_version
            and update_journal is not None
            and update_journal.observed_fingerprint == update_fingerprint
        ), "等长 Shell 修改未即时投影"
        assert updated.size_bytes == 5
        metrics["equal_size_update_ms"] = round((time.perf_counter() - started_at) * 1000, 1)

        started_at = time.perf_counter()
        await shell("rm '个人文件/探针.txt'")
        for _ in range(100):
            deleted = await file_snapshot()
            if deleted is not None and deleted.deleted_at is not None:
                break
            await asyncio.sleep(0.05)
        assert deleted is not None and deleted.deleted_at is not None, "Shell 删除未即时投影到回收状态"
        metrics["delete_ms"] = round((time.perf_counter() - started_at) * 1000, 1)

        async with db_session._SessionLocal() as session:
            operations = list((await session.scalars(select(FileSyncJournal.operation).where(
                FileSyncJournal.binding_id == binding.id,
                FileSyncJournal.relative_path == "个人文件/探针.txt",
            ).order_by(FileSyncJournal.id))).all())
        assert operations == ["create", "update", "delete"]
        print(f"[filesync-shell-probe] {json.dumps(metrics, sort_keys=True)}")
    finally:
        stop.set()
        await asyncio.wait_for(watcher_task, timeout=10)
