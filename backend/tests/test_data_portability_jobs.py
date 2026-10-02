from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import DataExportJob, DataImportJob, DataPortableIdentity, DataPortabilityOrigin
from app.services.data_portability.jobs import claim_next_job, release_for_retry, renew_lease


@pytest.mark.asyncio
async def test_export_and_import_tasks_persist_owner_scoped_lifecycle(db, user_a) -> None:
    export = DataExportJob(user_id=user_a.id, options={"include_drafts": True})
    imported = DataImportJob(user_id=user_a.id, mode="incremental", status="validating")
    db.add_all([export, imported])
    await db.commit()
    await db.refresh(export)
    await db.refresh(imported)

    assert export.status == "queued"
    assert export.options == {"include_drafts": True}
    assert imported.mode == "incremental"
    assert imported.status == "validating"


@pytest.mark.asyncio
async def test_portable_origin_is_stable_per_account_and_different_across_accounts(db, user_a, user_b) -> None:
    origin_a = DataPortabilityOrigin(user_id=user_a.id)
    origin_b = DataPortabilityOrigin(user_id=user_b.id)
    db.add_all([origin_a, origin_b])
    await db.commit()

    assert origin_a.origin_id != origin_b.origin_id


@pytest.mark.asyncio
async def test_portable_identity_prevents_duplicate_source_object_mapping(db, user_a) -> None:
    origin_id = uuid4()
    identity = DataPortableIdentity(
        user_id=user_a.id,
        origin_id=origin_id,
        source_type="project",
        portable_id="prj_fixture_01",
        target_type="project",
        target_id="501",
    )
    db.add(identity)
    await db.commit()

    db.add(DataPortableIdentity(
        user_id=user_a.id,
        origin_id=origin_id,
        source_type="project",
        portable_id="prj_fixture_01",
        target_type="project",
        target_id="502",
    ))
    with pytest.raises(IntegrityError):
        await db.commit()


@pytest.mark.asyncio
async def test_worker_claims_oldest_job_and_expired_lease_but_not_active_lease(db, user_a) -> None:
    now = datetime(2026, 10, 2, tzinfo=timezone.utc)
    old_export = DataExportJob(user_id=user_a.id, options={}, created_at=now - timedelta(minutes=2))
    new_import = DataImportJob(
        user_id=user_a.id,
        mode="incremental",
        status="queued",
        created_at=now - timedelta(minutes=1),
    )
    active_import = DataImportJob(
        user_id=user_a.id,
        mode="replace",
        status="running",
        lease_owner="worker-old",
        lease_until=now + timedelta(seconds=20),
        created_at=now - timedelta(minutes=3),
    )
    db.add_all([old_export, new_import, active_import])
    await db.commit()

    claimed = await claim_next_job(db, "worker-a", now=now)

    assert claimed is not None
    assert claimed.kind == "export"
    assert claimed.job_id == old_export.id
    assert old_export.lease_owner == "worker-a"
    assert active_import.lease_owner == "worker-old"

    assert await claim_next_job(db, "worker-a", now=now) is not None
    assert await claim_next_job(db, "worker-a", now=now) is None


@pytest.mark.asyncio
async def test_expired_lease_can_be_reclaimed_and_old_worker_cannot_renew(db, user_a) -> None:
    now = datetime(2026, 10, 2, tzinfo=timezone.utc)
    job = DataExportJob(
        user_id=user_a.id,
        options={},
        status="running",
        lease_owner="worker-dead",
        lease_until=now - timedelta(seconds=1),
    )
    db.add(job)
    await db.commit()

    claim = await claim_next_job(db, "worker-new", now=now)

    assert claim is not None and claim.job_id == job.id
    assert job.lease_owner == "worker-new"
    assert not await renew_lease(db, "export", job.id, "worker-dead", now=now)
    assert await release_for_retry(
        db, "export", job.id, "worker-new", retry_stage="exporting", error_code="storage.retry", now=now,
    )
    assert job.status == "queued"
    assert job.error_code == "storage.retry"
    assert job.lease_owner is None


@pytest.mark.asyncio
async def test_needs_recovery_waits_for_explicit_owner_action(db, user_a) -> None:
    """维护门禁异常时不能让 worker 自动重试破坏人工恢复窗口。"""
    job = DataImportJob(
        user_id=user_a.id,
        mode="replace",
        status="needs_recovery",
        stage="needs_recovery",
        lease_owner=None,
        lease_until=None,
    )
    db.add(job)
    await db.commit()

    assert await claim_next_job(db, "worker-a") is None

    job.status = "queued"  # /recover API performs this transition after owner confirmation.
    await db.commit()
    claimed = await claim_next_job(db, "worker-a")
    assert claimed is not None and claimed.job_id == job.id
    assert job.status == "running"
