from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.models import FileSyncBinding, FileSyncReconcileRun, FileSyncUserScanState, User
from app.core.tz import now_utc
from app.services.filesync import jobs
import app.db.session as db_session


@pytest.mark.asyncio
async def test_scheduler_pause_does_not_enqueue_automatic_jobs(monkeypatch):
    """回滚开关关闭时不查询或写入后台整树任务队列。"""
    monkeypatch.setattr(jobs, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(background_reconcile_enabled=False),
    ))

    async def forbidden_session_factory():
        raise AssertionError("暂停调度不应打开数据库会话")

    await jobs.enqueue_due_jobs(forbidden_session_factory)


@pytest.mark.asyncio
async def test_scheduler_pause_leaves_explicit_manual_jobs_claimable(db, user_a, user_b, monkeypatch):
    """暂停后台任务只拦自动任务，管理员明确发起的手动任务仍可执行。"""
    binding_auto = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="a" * 64,
    )
    binding_manual = FileSyncBinding(
        user_id=user_b.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="b" * 64,
    )
    db.add_all([binding_auto, binding_manual])
    await db.flush()
    db.add_all([
        FileSyncReconcileRun(
            user_id=user_a.id, binding_id=binding_auto.id, mode="snapshot_diff",
            reason="daily", status="queued",
        ),
        FileSyncReconcileRun(
            user_id=user_b.id, binding_id=binding_manual.id, mode="snapshot_diff",
            reason="manual", status="queued",
        ),
    ])
    await db.commit()
    monkeypatch.setattr(jobs, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(background_reconcile_enabled=False),
    ))

    claim = await jobs.claim_due_job(db)

    assert claim is not None
    claimed = await db.get(FileSyncReconcileRun, claim[0])
    assert claimed is not None and claimed.reason == "manual"


@pytest.mark.asyncio
async def test_claim_cancels_queued_job_for_unbound_scope(db, user_a):
    """解绑与领取竞争时，已失效绑定的队列任务不得进入扫描。"""
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="inactive",
        root_path="资料", root_fingerprint="synthetic-root",
    )
    db.add(binding)
    await db.flush()
    run = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=binding.id, mode="snapshot_diff",
        reason="manual", status="queued", stage="claiming", result_counts={},
    )
    db.add(run)
    await db.commit()

    assert await jobs.claim_due_job(db) is None
    refreshed = await db.get(FileSyncReconcileRun, run.id)
    assert refreshed is not None
    assert refreshed.status == "cancelled"
    assert refreshed.error_code == "binding_inactive"


async def _claim_user_slot_and_release(db):
    claim = await jobs.claim_due_job(db)
    assert claim is not None
    run = await db.get(FileSyncReconcileRun, claim[0])
    state = await db.get(FileSyncUserScanState, run.user_id)
    run.status = "paused"
    run.next_run_at = now_utc() - timedelta(seconds=1)
    run.lease_token = None
    run.lease_until = None
    state.lease_token = None
    state.lease_until = None
    await db.commit()
    return run.user_id


@pytest.mark.asyncio
async def test_due_scheduler_limits_user_batch_and_rotates_users(db, user_a, user_b, monkeypatch):
    """小批次调度会推进轮转水位，后续轮次不会永久偏向同一用户。"""
    monkeypatch.setattr(jobs, "get_settings", lambda: SimpleNamespace(filesync=SimpleNamespace(
        compensation_interval_seconds=86400,
        reconcile_user_batch_size=1,
    )))
    for user in (user_a, user_b):
        db.add(FileSyncBinding(
            user_id=user.id, source="local_directory", status="active", root_path=".",
            root_fingerprint=("a" if user.id == user_a.id else "b") * 64,
        ))
    await db.commit()

    await jobs.enqueue_due_jobs(db_session._SessionLocal)
    await jobs.enqueue_due_jobs(db_session._SessionLocal)

    runs = (await db.scalars(select(FileSyncReconcileRun))).all()
    assert {run.user_id for run in runs} == {user_a.id, user_b.id}
    assert len(runs) == 2


@pytest.mark.asyncio
async def test_failed_reconcile_uses_persisted_bounded_jittered_backoff(
    db, user_a, monkeypatch,
):
    """真实失败写入持久退避，随机抖动受配置上界限制以错开重试峰值。"""
    token = uuid4()
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="a" * 64,
    )
    db.add(binding)
    await db.flush()
    run = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=binding.id, mode="snapshot_diff", reason="daily",
        status="running", lease_token=token,
    )
    db.add(run)
    await db.commit()
    monkeypatch.setattr(jobs, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(compensation_interval_seconds=86400),
    ))
    bounds = []

    def max_jitter(lower, upper):
        bounds.append((lower, upper))
        return upper

    monkeypatch.setattr(jobs.random, "uniform", max_jitter)
    await jobs._finish(
        db_session._SessionLocal, run.id, token,
        status="failed", error_code="reconcile_failed",
    )
    await db.refresh(binding)
    assert bounds == [(0.9, 1.1)]
    assert binding.consecutive_failures == 1
    delay = (binding.next_reconcile_at - now_utc()).total_seconds()
    assert 65.5 <= delay <= 66


@pytest.mark.asyncio
async def test_failed_binding_backoff_does_not_block_another_binding(
    db, user_a, user_b, monkeypatch,
):
    """一个绑定失败进入退避后，另一用户的整树任务仍可领取并完成。"""
    monkeypatch.setattr(jobs, "get_settings", lambda: SimpleNamespace(
        filesync=SimpleNamespace(
            background_reconcile_enabled=True,
            compensation_interval_seconds=86400,
        ),
    ))
    failed_binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="a" * 64,
    )
    healthy_binding = FileSyncBinding(
        user_id=user_b.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="b" * 64,
    )
    db.add_all([failed_binding, healthy_binding])
    await db.flush()
    created_at = now_utc()
    failed_run = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=failed_binding.id,
        mode="snapshot_diff", reason="daily", status="queued",
        created_at=created_at - timedelta(seconds=1),
    )
    healthy_run = FileSyncReconcileRun(
        user_id=user_b.id, binding_id=healthy_binding.id,
        mode="snapshot_diff", reason="daily", status="queued",
        created_at=created_at,
    )
    db.add_all([failed_run, healthy_run])
    await db.commit()

    failed_claim = await jobs.claim_due_job(db)
    assert failed_claim is not None and failed_claim[0] == failed_run.id
    await jobs._finish(
        db_session._SessionLocal, *failed_claim,
        status="failed", error_code="reconcile_failed",
    )

    healthy_claim = await jobs.claim_due_job(db)
    assert healthy_claim is not None and healthy_claim[0] == healthy_run.id
    await jobs._finish(
        db_session._SessionLocal, *healthy_claim, status="succeeded",
    )

    async with db_session._SessionLocal() as verify_db:
        failed_after = await verify_db.get(FileSyncReconcileRun, failed_run.id)
        healthy_after = await verify_db.get(FileSyncReconcileRun, healthy_run.id)
        failed_binding_after = await verify_db.get(FileSyncBinding, failed_binding.id)
        healthy_binding_after = await verify_db.get(FileSyncBinding, healthy_binding.id)

    assert failed_after.status == "failed"
    assert failed_binding_after.consecutive_failures == 1
    assert failed_binding_after.next_reconcile_at > now_utc()
    assert healthy_after.status == "succeeded"
    assert healthy_binding_after.last_reconciled_at is not None


@pytest.mark.asyncio
async def test_claim_enforces_one_active_scan_per_user(db, user_a, user_b):
    """一个用户的第二个绑定不能并行占用另一个 Worker 的扫描槽。"""
    bindings = []
    for user, marker in ((user_a, "a"), (user_a, "b"), (user_b, "c")):
        binding = FileSyncBinding(
            user_id=user.id, source="local_directory", status="active", root_path=".",
            root_fingerprint=marker * 64,
        )
        db.add(binding)
        bindings.append(binding)
    await db.commit()
    for binding in bindings:
        await db.refresh(binding)
        await jobs.enqueue_reconcile(db, binding, mode="integrity_full", reason="bootstrap")
    await db.commit()

    first = await jobs.claim_due_job(db)
    second = await jobs.claim_due_job(db)

    assert first is not None and second is not None
    first_run = await db.get(FileSyncReconcileRun, first[0])
    second_run = await db.get(FileSyncReconcileRun, second[0])
    assert first_run.user_id != second_run.user_id


@pytest.mark.asyncio
async def test_small_users_get_a_slot_before_large_users_claim_second_binding(
    db, user_a, user_b,
):
    """多绑定用户让出片段后，轮转应先给其他排队用户一次执行机会。"""
    other_users = [
        User(
            id=uuid4(), username=f"filesync-fair-{index}",
            email=f"filesync-fair-{index}@test.local", hashed_password="x",
        )
        for index in range(2)
    ]
    db.add_all(other_users)
    await db.flush()

    bindings = []
    for index in range(4):
        bindings.append(FileSyncBinding(
            user_id=user_a.id, source="local_directory", status="active",
            root_path=".", root_fingerprint=f"{index:064x}",
        ))
    for user, marker in ((user_b, "b"), *[(user, f"c{index}") for index, user in enumerate(other_users)]):
        bindings.append(FileSyncBinding(
            user_id=user.id, source="local_directory", status="active",
            root_path=".", root_fingerprint=(marker * 64)[:64],
        ))
    db.add_all(bindings)
    await db.commit()

    for binding in bindings:
        await db.refresh(binding)
        await jobs.enqueue_reconcile(db, binding, mode="integrity_full", reason="bootstrap")
    await db.commit()

    claimed_users = []
    for _ in range(4):
        claimed_users.append(await _claim_user_slot_and_release(db))

    assert len(set(claimed_users)) == 4
    assert user_a.id in claimed_users
    assert user_b.id in claimed_users


@pytest.mark.asyncio
async def test_large_user_backlog_rotates_across_sixty_four_users(
    db, user_a, user_b,
):
    """多用户积压下，多绑定用户不能在其他用户首次获得执行槽前重复领取。"""
    other_users = [user_b]
    other_users.extend(
        User(
            id=uuid4(), username=f"filesync-pressure-{index}",
            email=f"filesync-pressure-{index}@test.local", hashed_password="x",
        )
        for index in range(62)
    )
    db.add_all(other_users[1:])
    await db.flush()

    bindings = [
        FileSyncBinding(
            user_id=user_a.id, source="local_directory", status="active",
            root_path=".", root_fingerprint=f"{index:064x}",
        )
        for index in range(4)
    ]
    bindings.extend(
        FileSyncBinding(
            user_id=user.id, source="local_directory", status="active",
            root_path=".", root_fingerprint=f"{index + 4:064x}",
        )
        for index, user in enumerate(other_users)
    )
    db.add_all(bindings)
    await db.commit()

    for binding in bindings:
        await db.refresh(binding)
        await jobs.enqueue_reconcile(db, binding, mode="integrity_full", reason="bootstrap")
    await db.commit()

    claimed_users = []
    for _ in range(64):
        claimed_users.append(await _claim_user_slot_and_release(db))

    # 63 其他用户各只有一个任务；若轮转失效，多绑定用户会重复出现在这段前缀中。
    assert len(set(claimed_users[:63])) == 63
    assert user_a.id not in claimed_users[1:63]
    assert len(set(claimed_users)) == 64


@pytest.mark.asyncio
async def test_claim_rechecks_user_lease_after_selecting_candidate(db, user_a):
    """另一个 Worker 在选中任务后先取得用户租约时，当前 Worker 不得覆盖它。"""
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="c" * 64,
    )
    db.add(binding)
    await db.commit()
    await db.refresh(binding)
    run = await jobs.enqueue_reconcile(db, binding, mode="integrity_full", reason="bootstrap")
    await db.commit()
    run_id = run.id

    class LeaseRacingSession:
        first = True

        async def scalar(self, statement):
            candidate = await db.scalar(statement)
            if candidate is not None and self.first:
                self.first = False
                await db.commit()
                db.add(FileSyncUserScanState(
                    user_id=user_a.id, lease_token=uuid4(),
                    lease_until=now_utc() + timedelta(minutes=1),
                ))
                await db.commit()
            return candidate

        async def get(self, *args, **kwargs):
            return await db.get(*args, **kwargs)

        async def rollback(self):
            await db.rollback()

    claimed = await jobs.claim_due_job(LeaseRacingSession())
    await db.refresh(run)

    assert claimed is None
    assert run.id == run_id
    assert run.status == "queued"


@pytest.mark.asyncio
async def test_expired_cancel_request_is_recovered_as_terminal_cancelled(db, user_a):
    """取消中的 Worker 崩溃后，租约恢复必须收敛终态而不是永久占槽或重启任务。"""
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="g" * 64,
    )
    db.add(binding)
    await db.flush()
    now = now_utc()
    token = uuid4()
    state = FileSyncUserScanState(
        user_id=user_a.id, lease_token=token,
        lease_until=now - timedelta(seconds=1),
    )
    run = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=binding.id,
        mode="snapshot_diff", reason="manual", status="cancelling",
        lease_token=token, lease_until=now - timedelta(seconds=1),
        started_at=now - timedelta(minutes=2),
    )
    db.add_all((state, run))
    await db.commit()

    claimed = await jobs.claim_due_job(db)
    await db.refresh(run)
    await db.refresh(state)

    assert claimed is None
    assert run.status == "cancelled"
    assert run.error_code == "cancelled"
    assert run.finished_at is not None
    assert run.lease_token is None
    assert state.lease_token is None
    assert state.lease_until is None


@pytest.mark.asyncio
async def test_expired_running_lease_resumes_same_run_and_keeps_checkpoint(db, user_a):
    """Worker 异常退出后回收过期租约应续跑原逻辑任务与检查点。"""
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="h" * 64,
    )
    db.add(binding)
    await db.flush()
    now = now_utc()
    old_token = uuid4()
    started_at = now - timedelta(minutes=12)
    state = FileSyncUserScanState(
        user_id=user_a.id, lease_token=old_token,
        lease_until=now - timedelta(seconds=1),
    )
    run = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=binding.id,
        mode="integrity_full", reason="bootstrap", status="running",
        lease_token=old_token, lease_until=now - timedelta(seconds=1),
        started_at=started_at, progress_current=42,
        checkpoint_ref="checkpoint:completed-directory-page-7",
    )
    db.add_all((state, run))
    await db.commit()

    claim = await jobs.claim_due_job(db)
    await db.refresh(run)
    await db.refresh(state)

    assert claim is not None
    assert claim[0] == run.id
    assert claim[1] != old_token
    assert run.status == "running"
    assert run.started_at == started_at
    assert run.progress_current == 42
    assert run.checkpoint_ref == "checkpoint:completed-directory-page-7"
    assert run.lease_token == claim[1]
    assert state.lease_token == claim[1]


@pytest.mark.asyncio
async def test_claim_skips_queued_daily_run_if_file_activity_arrived_after_enqueue(db, user_a):
    binding = FileSyncBinding(
        user_id=user_a.id, source="local_directory", status="active", root_path=".",
        root_fingerprint="d" * 64,
    )
    state = FileSyncUserScanState(
        user_id=user_a.id, activity_seq=5, cycle_activity_seq=4,
        activity_reliable=True,
    )
    db.add_all((binding, state))
    await db.commit()
    await db.refresh(binding)
    run = await jobs.enqueue_reconcile(db, binding, reason="daily", mode="snapshot_diff")
    await db.commit()

    claimed = await jobs.claim_due_job(db)
    await db.refresh(run)
    await db.refresh(state)

    assert claimed is None
    assert run.status == "cancelled"
    assert run.error_code == "skipped_file_active"
    assert state.last_cycle_decision == "skipped_file_active"
    assert state.skip_reason == "file_activity"
    assert state.cycle_activity_seq == state.activity_seq


@pytest.mark.asyncio
async def test_claim_rotates_bindings_for_a_user_after_each_slice(db, user_a):
    """同用户多绑定切片后轮转，较早创建的绑定不会持续占据唯一用户槽。"""
    bindings = []
    for marker in ("e", "f"):
        binding = FileSyncBinding(
            user_id=user_a.id, source="local_directory", status="active", root_path=".",
            root_fingerprint=marker * 64,
        )
        db.add(binding)
        bindings.append(binding)
    await db.commit()
    for binding in bindings:
        await db.refresh(binding)
        await jobs.enqueue_reconcile(db, binding, mode="integrity_full", reason="bootstrap")
    await db.commit()

    first_claim = await jobs.claim_due_job(db)
    assert first_claim is not None
    first_run = await db.get(FileSyncReconcileRun, first_claim[0])
    first_binding_id = first_run.binding_id
    state = await db.get(FileSyncUserScanState, user_a.id)
    first_run.status = "paused"
    first_run.next_run_at = now_utc() - timedelta(seconds=1)
    first_run.lease_token = None
    first_run.lease_until = None
    state.lease_token = None
    state.lease_until = None
    await db.commit()

    second_claim = await jobs.claim_due_job(db)
    assert second_claim is not None
    second_run = await db.get(FileSyncReconcileRun, second_claim[0])
    assert second_run.binding_id != first_binding_id


@pytest.mark.asyncio
async def test_waiting_daily_job_ages_ahead_of_new_high_priority_work(db, user_a, user_b):
    """每日任务等待超过老化门槛后可越过新到达的高优先级任务，避免饥饿。"""
    bindings = []
    for user, marker in ((user_a, "a"), (user_b, "b")):
        binding = FileSyncBinding(
            user_id=user.id, source="local_directory", status="active", root_path=".",
            root_fingerprint=marker * 64,
        )
        db.add(binding)
        bindings.append(binding)
    await db.commit()
    for binding in bindings:
        await db.refresh(binding)

    now = now_utc()
    aged_daily = FileSyncReconcileRun(
        user_id=user_a.id, binding_id=bindings[0].id,
        mode="snapshot_diff", reason="daily", status="queued",
        priority_since=now - timedelta(minutes=4), created_at=now - timedelta(minutes=4),
    )
    new_manual = FileSyncReconcileRun(
        user_id=user_b.id, binding_id=bindings[1].id,
        mode="integrity_full", reason="manual", status="queued",
        priority_since=now, created_at=now,
    )
    db.add_all((aged_daily, new_manual))
    await db.commit()

    claimed = await jobs.claim_due_job(db)
    assert claimed is not None
    claimed_run = await db.get(FileSyncReconcileRun, claimed[0])
    assert claimed_run.reason == "daily"
