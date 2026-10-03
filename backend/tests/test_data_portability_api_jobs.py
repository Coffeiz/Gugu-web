"""归档 API 任务服务的幂等与互斥行为回归。"""
import hashlib
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.core.tz import now_utc
from app.models import DataExportJob, DataImportJob
from app.services.data_portability.api_jobs import (
    PortabilityJobError,
    apply_import_job,
    begin_preflight_import,
    create_export_job,
)


@pytest.mark.asyncio
async def test_export_creation_is_idempotent_but_key_cannot_change_scope(db, user_a):
    first = await create_export_job(
        db,
        user_id=user_a.id,
        categories={"projects"},
        idempotency_key="export-request-0001",
        expires_at=now_utc() + timedelta(hours=1),
    )
    repeated = await create_export_job(
        db,
        user_id=user_a.id,
        categories={"projects"},
        idempotency_key="export-request-0001",
        expires_at=now_utc() + timedelta(hours=1),
    )

    assert repeated.id == first.id
    assert repeated.options == {"categories": ["projects"]}
    with pytest.raises(PortabilityJobError) as exc:
        await create_export_job(
            db,
            user_id=user_a.id,
            categories={"files"},
            idempotency_key="export-request-0001",
            expires_at=now_utc() + timedelta(hours=1),
        )
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_preflight_and_export_share_per_user_active_job_exclusion(db, user_a):
    db.add(DataExportJob(
        user_id=user_a.id, status="running", idempotency_key="running-export",
    ))
    await db.commit()

    with pytest.raises(PortabilityJobError) as exc:
        await begin_preflight_import(
            db,
            user_id=user_a.id,
            token_hash=hashlib.sha256(b"one-time-token").hexdigest(),
            expires_at=now_utc(),
        )
    assert exc.value.status_code == 409
    assert await db.scalar(
        select(DataImportJob.id).where(DataImportJob.user_id == user_a.id)
    ) is None


@pytest.mark.asyncio
async def test_apply_import_consumes_token_and_retries_idempotently(db, user_a):
    token = "preflight-confirmation-token-with-sufficient-length"
    job = DataImportJob(
        user_id=user_a.id,
        mode="preflight",
        status="preview_ready",
        stage="preview_ready",
        import_token_hash=hashlib.sha256(token.encode()).hexdigest(),
        preview={"complete": True, "conflicts": {"total": 0}},
    )
    db.add(job)
    await db.commit()

    queued = await apply_import_job(
        db,
        user_id=user_a.id,
        job_id=job.id,
        mode="replace",
        import_token=token,
        idempotency_key="apply-request-0001",
    )
    repeated = await apply_import_job(
        db,
        user_id=user_a.id,
        job_id=job.id,
        mode="replace",
        import_token="no-longer-needed-after-queueing",
        idempotency_key="apply-request-0001",
    )

    assert queued.id == repeated.id
    assert repeated.status == "queued"
    assert repeated.import_token_hash is None
