import pytest
from fastapi import HTTPException

from app.api.v1 import data_portability as api
from app.models import DataImportJob


class _Storage:
    def __init__(self):
        self.deleted = []

    async def delete(self, key):
        self.deleted.append(key)


@pytest.mark.asyncio
async def test_import_delete_removes_terminal_job_and_staged_objects_only(db, user_a, monkeypatch):
    storage = _Storage()
    monkeypatch.setattr(api, "get_storage", lambda: storage)
    job = DataImportJob(
        user_id=user_a.id, mode="incremental", status="failed",
        staging_key="private/import/staged.gupi", rollback_key="private/import/rollback.gupi",
    )
    db.add(job)
    await db.commit()

    await api.delete_import(job.id, user=user_a, db=db)

    assert set(storage.deleted) == {"private/import/staged.gupi", "private/import/rollback.gupi"}
    assert await db.get(DataImportJob, job.id) is None


@pytest.mark.asyncio
async def test_import_delete_allows_preflight_but_rejects_active_and_foreign_jobs(db, user_a, user_b, monkeypatch):
    storage = _Storage()
    monkeypatch.setattr(api, "get_storage", lambda: storage)
    preflight = DataImportJob(
        user_id=user_a.id, mode="preflight", status="preview_ready", staging_key="private/ready.gupi",
    )
    active = DataImportJob(
        user_id=user_a.id, mode="incremental", status="running", staging_key="private/active.gupi",
    )
    foreign = DataImportJob(
        user_id=user_b.id, mode="incremental", status="failed", staging_key="private/other.gupi",
    )
    db.add_all([preflight, active, foreign])
    await db.commit()

    await api.delete_import(preflight.id, user=user_a, db=db)
    with pytest.raises(HTTPException) as active_error:
        await api.delete_import(active.id, user=user_a, db=db)
    with pytest.raises(HTTPException) as owner_error:
        await api.delete_import(foreign.id, user=user_a, db=db)

    assert active_error.value.status_code == 409
    assert owner_error.value.status_code == 404
    assert storage.deleted == ["private/ready.gupi"]
    assert await db.get(DataImportJob, active.id) is not None
    assert await db.get(DataImportJob, foreign.id) is not None
