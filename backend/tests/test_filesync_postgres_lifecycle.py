"""显式 PostgreSQL 集成验收；压测文件数可由 GUGU_TEST_POSTGRES_PRESSURE_FILES 调整。"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from uuid6 import uuid7

from app.db.base import Base
from app.models import FileSyncBinding, FileSyncReconcileRun, User
from app.services.filesync import jobs


POSTGRES_URL = os.environ.get("GUGU_TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL,
    reason="需显式设置 GUGU_TEST_POSTGRES_URL 指向专用 PostgreSQL 测试库",
)


@asynccontextmanager
async def _isolated_schema(application_name: str):
    schema = f"fs6_test_{uuid4().hex}"
    connect_args = {
        "server_settings": {
            "idle_in_transaction_session_timeout": "60000",
            "application_name": application_name,
        },
    }
    admin_engine = create_async_engine(POSTGRES_URL, connect_args=connect_args)
    app_engine = create_async_engine(
        POSTGRES_URL,
        connect_args={**connect_args, "server_settings": {
            **connect_args["server_settings"], "search_path": schema,
        }},
    )
    session_factory = async_sessionmaker(app_engine, expire_on_commit=False)
    schema_created = False
    try:
        async with admin_engine.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        schema_created = True
        async with app_engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        yield session_factory, admin_engine
    finally:
        await app_engine.dispose()
        if schema_created:
            async with admin_engine.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await admin_engine.dispose()


@pytest.mark.asyncio
async def test_scan_over_sixty_seconds_holds_no_idle_transaction(monkeypatch, tmp_path):
    """受控 61 秒磁盘等待仍完成，扫描期间同一任务无 idle-in-transaction。"""
    application_name = f"gugu_fs6_{uuid4().hex[:12]}"
    storage_root = tmp_path / "users"
    uid = uuid7()
    user_root = storage_root / str(uid)
    # 使用同步协议认可的个人文件根；测试临时目录本身不代表 workspace 绑定。
    root = user_root / "个人文件" / "workspace"
    root.mkdir(parents=True)
    (root / "integration.txt").write_text("synthetic PostgreSQL fixture", encoding="utf-8")
    async with _isolated_schema(application_name) as (session_factory, admin_engine):
        settings = SimpleNamespace(
            storage=SimpleNamespace(local_path=str(storage_root), backend="local"),
            filesync=SimpleNamespace(
                enabled=True, reconcile_timeout_seconds=1800,
                reconcile_slice_seconds=120, reconcile_batch_size=200,
                reconcile_user_batch_size=8, reconcile_scan_batch_size=1000,
                reconcile_hash_chunk_bytes=1_048_576,
                reconcile_hash_concurrency=1, reconcile_write_concurrency=1,
                reconcile_concurrency=1, compensation_interval_seconds=86400,
            ),
            quota=SimpleNamespace(default_storage_limit_bytes=10_000_000),
        )
        import app.services.filesync.baseline as baseline
        import app.services.filesync.bindings as bindings
        import app.services.filesync.checkpoint as checkpoint
        import app.services.filesync.protocol as protocol
        import app.services.filesync.targeted as targeted
        import app.services.filesync.snapshots as snapshots
        import app.services.workspaces as workspaces
        import app.services.filesync.outbox as outbox
        from app.services.filesync.file_ops import root_fingerprint

        for module in (jobs, baseline, checkpoint, bindings, protocol, targeted, snapshots):
            monkeypatch.setattr(module, "get_settings", lambda: settings)
        monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
        monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
        monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
        monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
        monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

        original_scan = jobs.scan_binding_tree
        scan_delay = float(os.environ.get("GUGU_TEST_POSTGRES_SCAN_DELAY_SECONDS", "61"))

        def delayed_scan(*args, **kwargs):
            time.sleep(scan_delay)
            return original_scan(*args, **kwargs)

        monkeypatch.setattr(jobs, "scan_binding_tree", delayed_scan)
        async with session_factory() as db:
            db.add(User(id=uid, username="fs6-test", email=f"{uid}@test.invalid", hashed_password="x"))
            await db.flush()
            binding = FileSyncBinding(
                user_id=uid, source="local_directory", status="active",
                root_path="个人文件/workspace",
                root_fingerprint=root_fingerprint(user_root / "workspace"),
            )
            db.add(binding)
            await db.commit()
            await db.refresh(binding)
            run = await jobs.enqueue_reconcile(
                db, binding, mode="integrity_full", reason="bootstrap",
            )
            await db.commit()
            run_id = run.id

        async with session_factory() as db:
            claim = await jobs.claim_due_job(db)
        assert claim is not None
        running = asyncio.create_task(jobs._run_claimed(session_factory, *claim))
        await asyncio.sleep(55 if scan_delay >= 60 else min(scan_delay / 2, 1))
        async with admin_engine.connect() as connection:
            idle = await connection.scalar(text(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE application_name = :application_name "
                "AND state = 'idle in transaction'"
            ), {"application_name": application_name})
        assert idle == 0
        await asyncio.wait_for(running, timeout=30)

        async with session_factory() as db:
            final_run = await db.get(FileSyncReconcileRun, run_id)
            projected = await db.scalar(
                text("SELECT count(*) FROM files WHERE user_id = :user_id"),
                {"user_id": uid},
            )
        assert final_run.status == "succeeded", final_run.error_code
        assert final_run.result_counts.get("created") == 1, (
            f"created={final_run.result_counts.get('created')} rejected={final_run.result_counts.get('rejected')}"
        )
        assert projected == 1


@pytest.mark.asyncio
async def test_concurrent_postgres_claims_keep_one_active_slot_per_user(monkeypatch):
    """真实 PostgreSQL 并发领取积压任务时，每轮不重复占用同一用户执行槽。"""
    user_count = 16
    bindings_per_user = 3
    worker_count = 8
    application_name = f"gugu_fs6_{uuid4().hex[:12]}"
    monkeypatch.setattr(jobs, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(
            reconcile_timeout_seconds=1800,
            compensation_interval_seconds=86400,
        ),
    ))

    async with _isolated_schema(application_name) as (session_factory, _admin_engine):
        users = [
            User(
                id=uuid7(), username=f"fs6-pressure-{index}",
                email=f"{uuid4()}@test.invalid", hashed_password="x",
            )
            for index in range(user_count)
        ]
        async with session_factory() as db:
            db.add_all(users)
            await db.flush()
            for user_index, user in enumerate(users):
                for binding_index in range(bindings_per_user):
                    binding = FileSyncBinding(
                        user_id=user.id, source="local_directory", status="active",
                        root_path=".",
                        root_fingerprint=f"{user_index * bindings_per_user + binding_index:064x}",
                    )
                    db.add(binding)
                    await db.flush()
                    await jobs.enqueue_reconcile(
                        db, binding, mode="integrity_full", reason="bootstrap",
                    )
            await db.commit()

        async def claim_one():
            async with session_factory() as db:
                return await jobs.claim_due_job(db)

        counts: dict[object, int] = {}
        elapsed = []
        for _ in range(user_count * bindings_per_user // worker_count):
            started = time.perf_counter()
            claims = await asyncio.gather(*(claim_one() for _ in range(worker_count)))
            elapsed.append(time.perf_counter() - started)
            assert all(claims), "有足够积压时并发 Worker 应都能领取任务"
            run_ids = [run_id for run_id, _token in claims]
            async with session_factory() as db:
                runs = (await db.scalars(
                    select(FileSyncReconcileRun).where(
                        FileSyncReconcileRun.id.in_(run_ids),
                    )
                )).all()
            claimed_users = [run.user_id for run in runs]
            assert len(set(claimed_users)) == worker_count
            for user_id in claimed_users:
                counts[user_id] = counts.get(user_id, 0) + 1
            await asyncio.gather(*(
                jobs._finish(
                    session_factory, run_id, token, status="succeeded",
                )
                for run_id, token in claims
            ))

        assert len(counts) == user_count
        assert set(counts.values()) == {bindings_per_user}
        print(
            "FS6 PostgreSQL pressure: "
            f"{user_count} users, {user_count * bindings_per_user} jobs, "
            f"{worker_count} concurrent workers, max claim wave {max(elapsed):.3f}s"
        )


@pytest.mark.asyncio
async def test_mult_worker_scan_pressure_records_loop_lag_reuse_and_cancel(monkeypatch, tmp_path):
    """合成多用户整树负载下记录事件循环延迟、热扫描复用与取消响应。"""
    user_count = 4
    files_per_user = int(os.environ.get("GUGU_TEST_POSTGRES_PRESSURE_FILES", "1000"))
    worker_count = user_count
    application_name = f"gugu_fs6_{uuid4().hex[:12]}"
    storage_root = tmp_path / "users"
    users = [uuid7() for _ in range(user_count)]
    roots = []
    for user_id in users:
        root = storage_root / str(user_id) / "个人文件" / "synthetic-workspace"
        root.mkdir(parents=True)
        for index in range(files_per_user):
            (root / f"item-{index:05d}.txt").write_bytes(b"x" * 16_384)
        roots.append(root)

    settings = SimpleNamespace(
        storage=SimpleNamespace(local_path=str(storage_root), backend="local"),
        filesync=SimpleNamespace(
            enabled=True, reconcile_timeout_seconds=1800,
            reconcile_slice_seconds=120, reconcile_batch_size=200,
            reconcile_user_batch_size=worker_count, reconcile_scan_batch_size=5_000,
            reconcile_hash_chunk_bytes=65_536, reconcile_hash_concurrency=2,
            reconcile_write_concurrency=2, reconcile_concurrency=worker_count,
            compensation_interval_seconds=86_400,
        ),
        quota=SimpleNamespace(default_storage_limit_bytes=10_000_000_000),
    )
    import app.services.filesync.baseline as baseline
    import app.services.filesync.bindings as bindings
    import app.services.filesync.checkpoint as checkpoint
    import app.services.filesync.outbox as outbox
    import app.services.filesync.protocol as protocol
    import app.services.filesync.snapshots as snapshots
    import app.services.filesync.targeted as targeted
    import app.services.workspaces as workspaces
    from app.services.filesync.file_ops import root_fingerprint
    from app.services.filesync.job_lifecycle import request_job_cancel

    for module in (jobs, baseline, bindings, checkpoint, protocol, snapshots, targeted):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(protocol, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "is_file_sync_enabled", lambda: True)
    monkeypatch.setattr(targeted, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(workspaces, "workspace_shell_supported", lambda: True)
    monkeypatch.setattr(targeted, "save_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(targeted, "delete_thumb_cache", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(outbox, "deliver_file_event", _delivered)

    async with _isolated_schema(application_name) as (session_factory, _admin_engine):
        async with session_factory() as db:
            db.add_all([
                User(
                    id=user_id, username=f"fs6-pressure-{index}",
                    email=f"{user_id}@test.invalid", hashed_password="x",
                )
                for index, user_id in enumerate(users)
            ])
            await db.flush()
            bindings_by_user = []
            initial_run_ids = []
            for user_id, root in zip(users, roots, strict=True):
                binding = FileSyncBinding(
                    user_id=user_id, source="local_directory", mode="bidirectional",
                    status="active", root_path="个人文件/synthetic-workspace",
                    root_fingerprint=root_fingerprint(root),
                )
                db.add(binding)
                await db.flush()
                run = await jobs.enqueue_reconcile(
                    db, binding, mode="integrity_full", reason="bootstrap",
                )
                bindings_by_user.append((user_id, binding.id))
                initial_run_ids.append(run.id)
            await db.commit()

        async def claim_wave():
            async def claim_one():
                async with session_factory() as db:
                    return await jobs.claim_due_job(db)

            claims = await asyncio.gather(*(claim_one() for _ in range(worker_count)))
            assert all(claims), "多用户积压时所有工作槽都应领取到任务"
            return claims

        loop_delays: list[float] = []
        stop_sampler = asyncio.Event()
        loop = asyncio.get_running_loop()

        async def sample_loop_delay():
            interval = 0.01
            target = loop.time() + interval
            while not stop_sampler.is_set():
                await asyncio.sleep(max(0.0, target - loop.time()))
                observed = loop.time()
                loop_delays.append(max(0.0, observed - target))
                target += interval

        sampler = asyncio.create_task(sample_loop_delay())
        cold_started = time.perf_counter()
        cold_claims = await claim_wave()
        assert {run_id for run_id, _ in cold_claims} == set(initial_run_ids)
        await asyncio.gather(*(
            jobs._run_claimed(session_factory, run_id, token)
            for run_id, token in cold_claims
        ))
        cold_elapsed = time.perf_counter() - cold_started
        async with session_factory() as db:
            cold_runs = [
                await db.get(FileSyncReconcileRun, run_id)
                for run_id, _token in cold_claims
            ]
        assert all(run.status == "succeeded" for run in cold_runs), [
            (run.status, run.error_code, run.result_counts) for run in cold_runs
        ]
        assert sum(run.result_counts.get("created", 0) for run in cold_runs) == (
            user_count * files_per_user
        )

        async with session_factory() as db:
            for _user_id, binding_id in bindings_by_user:
                binding = await db.get(FileSyncBinding, binding_id)
                await jobs.enqueue_reconcile(
                    db, binding, mode="snapshot_diff", reason="manual",
                )
            await db.commit()

        warm_started = time.perf_counter()
        warm_claims = await claim_wave()
        await asyncio.gather(*(
            jobs._run_claimed(session_factory, run_id, token)
            for run_id, token in warm_claims
        ))
        warm_elapsed = time.perf_counter() - warm_started

        async with session_factory() as db:
            warm_runs = [
                await db.get(FileSyncReconcileRun, run_id)
                for run_id, _token in warm_claims
            ]
        assert all(run.status == "succeeded" for run in warm_runs)
        assert sum(run.result_counts.get("hashed", 0) for run in warm_runs) == 0
        assert sum(run.result_counts.get("reused", 0) for run in warm_runs) == (
            user_count * files_per_user
        )

        # Inject a bounded disk stall, then cancel through the same lifecycle path used by the API.
        async with session_factory() as db:
            user_id, binding_id = bindings_by_user[0]
            binding = await db.get(FileSyncBinding, binding_id)
            cancel_run = await jobs.enqueue_reconcile(
                db, binding, mode="integrity_full", reason="manual",
            )
            await db.commit()
            cancel_run_id = cancel_run.id
        async with session_factory() as db:
            cancel_claim = await jobs.claim_due_job(db)
        assert cancel_claim is not None and cancel_claim[0] == cancel_run_id
        import app.services.filesync.scan as scan_module

        hash_chunk_started = threading.Event()
        original_push_chunk = scan_module._push_chunk_digest

        def delayed_hash_chunk(stack, digest):
            original_push_chunk(stack, digest)
            if not hash_chunk_started.is_set():
                hash_chunk_started.set()
                time.sleep(0.2)

        monkeypatch.setattr(scan_module, "_push_chunk_digest", delayed_hash_chunk)
        running = asyncio.create_task(jobs._run_claimed(session_factory, *cancel_claim))
        assert await asyncio.to_thread(hash_chunk_started.wait, 5), "扫描 Worker 未进入正文哈希"
        cancel_started = time.perf_counter()
        async with session_factory() as db:
            await request_job_cancel(db, user_id=user_id, run_id=cancel_run_id)
            await db.commit()
        await asyncio.wait_for(running, timeout=1)
        cancel_elapsed = time.perf_counter() - cancel_started
        stop_sampler.set()
        await sampler

        async with session_factory() as db:
            cancelled = await db.get(FileSyncReconcileRun, cancel_run_id)
        assert cancelled.status == "cancelled"
        assert cancel_elapsed < 1.0
        assert loop_delays, "压力期间必须至少采到一个事件循环延迟样本"
        loop_delays.sort()
        p95_index = min(len(loop_delays) - 1, int(len(loop_delays) * 0.95))
        event_loop_p95 = loop_delays[p95_index]
        assert event_loop_p95 < 0.2, (
            f"事件循环延迟 p95 超过 200ms：{event_loop_p95 * 1000:.1f}ms"
        )
        print(
            "FS6 sustained PostgreSQL scan pressure: "
            f"users={user_count}, workers={worker_count}, files={user_count * files_per_user}, "
            f"cold={cold_elapsed:.3f}s, warm={warm_elapsed:.3f}s, "
            f"warm_reused={sum(run.result_counts.get('reused', 0) for run in warm_runs)}, "
            f"loop_p95={event_loop_p95 * 1000:.1f}ms, cancel={cancel_elapsed * 1000:.1f}ms"
        )


async def _delivered(_db, _row):
    return True
