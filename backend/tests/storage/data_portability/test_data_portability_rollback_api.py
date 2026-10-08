from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.api.v1 import data_portability as api
from app.core.tz import now_utc
from app.models import DataImportJob


@pytest.mark.asyncio
async def test_rollback_api_queues_owner_scoped_idempotent_restore(db, user_a):
    source = DataImportJob(
        user_id=user_a.id,
        mode="replace",
        status="completed",
        rollback_key=f"{user_a.id.hex}/.data-portability/rollback/source.gupa",
        rollback_expires_at=now_utc() + timedelta(days=2),
    )
    db.add(source)
    await db.commit()

    first = await api.rollback_import(
        source.id, api.ImportRollback(idempotency_key="rollback-request-0001"),
        user=user_a, db=db,
    )
    repeated = await api.rollback_import(
        source.id, api.ImportRollback(idempotency_key="rollback-request-0001"),
        user=user_a, db=db,
    )

    assert first["id"] == repeated["id"]
    assert first["mode"] == "rollback"
    assert first["status"] == "queued"


@pytest.mark.asyncio
async def test_rollback_api_rejects_another_users_job(db, user_a, user_b):
    source = DataImportJob(
        user_id=user_b.id,
        mode="replace",
        status="completed",
        rollback_key="private-snapshot",
        rollback_expires_at=now_utc() + timedelta(days=2),
    )
    db.add(source)
    await db.commit()

    with pytest.raises(HTTPException) as exc:
        await api.rollback_import(
            source.id, api.ImportRollback(idempotency_key="rollback-request-0002"),
            user=user_a, db=db,
        )
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_recover_api_only_requeues_owned_replacement_recovery(db, user_a):
    job = DataImportJob(
        user_id=user_a.id,
        mode="replace",
        status="needs_recovery",
        stage="needs_recovery",
        staging_key="staging",
        rollback_key="rollback",
        lease_owner="dead-worker",
        lease_until=now_utc() + timedelta(days=1000),
    )
    db.add(job)
    await db.commit()

    result = await api.recover_import(job.id, user=user_a, db=db)

    assert result["status"] == "queued"
    assert job.lease_owner is None and job.lease_until is None
