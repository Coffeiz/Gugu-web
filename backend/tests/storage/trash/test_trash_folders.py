"""P2.2-P2.5 文件夹回收站：软删端点、顶层列表、恢复端点、过期清理。

同 test_folders_api：直接调路由函数（current_user/db/origin 显式传），不起 TestClient。
FileService(db) 内部走 get_storage()，monkeypatch 指向 tmp_path 本地后端；事件广播 noop。
"""
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import folders as folders_api
from app.api.v1 import trash as trash_api
from app.core.errors import NotFound
from app.core.tz import now_utc
from app.models import File, Folder, StorageQuotaEvent
from app.schemas import FolderCreate
from app.services.storage import LocalStorageBackend
from app.services.storage.file_service import FileService
from app.services.storage.quota_ledger import FILE_LIBRARY, get_quota
from app.services.files.trash import restore_file_by_id
from app.services.files.selection import move_file_to_trash_by_id


@pytest.fixture(autouse=True)
def _storage_and_events(tmp_path, monkeypatch):
    storage = LocalStorageBackend(Path(tmp_path))
    monkeypatch.setattr("app.services.storage.file_service.get_storage", lambda: storage)
    monkeypatch.setattr(trash_api, "get_storage", lambda: storage)

    async def _noop(*a, **k):
        pass
    monkeypatch.setattr(folders_api.events, "publish", _noop)
    monkeypatch.setattr(trash_api.events, "publish", _noop)
    monkeypatch.setattr("app.core.events.publish_trash_purge_progress", _noop)
    return storage


async def _mk_folder_with_file(db, user, name, data=b"x"):
    svc = FileService(db)
    folder = await folders_api.create_folder(
        FolderCreate(name=name), current_user=user, origin=None, db=db)
    r = await svc.create_file(
        user.id, space="personal", project_id=None, folder_id=folder.id, stage_name="",
        mind_map_id=None, display_name="note", ext="TXT", mime_type="text/plain", data=data)
    await db.commit()
    return folder, r.file


async def test_delete_folder_endpoint_soft_deletes(db, user_a):
    folder, f = await _mk_folder_with_file(db, user_a, "资料")
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)
    row = await db.get(Folder, folder.id)
    assert row is not None and row.deleted_at is not None       # 行还在，软删
    await db.refresh(f)
    assert f.deleted_at is not None


async def test_delete_folder_endpoint_not_found(db, user_a):
    with pytest.raises(NotFound):
        await folders_api.delete_folder(999, current_user=user_a, origin=None, db=db)


async def test_delete_folder_hidden_from_list_endpoint(db, user_a):
    folder, _ = await _mk_folder_with_file(db, user_a, "资料")
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)
    kids = await folders_api.list_folder_page(project_id=None, parent_id=None, limit=100, cursor=None,
        sort_by='createdAt', sort_order='desc', current_user=user_a, db=db)
    assert kids['items'] == []


async def test_list_trash_folders_top_level_only(db, user_a):
    parent, _ = await _mk_folder_with_file(db, user_a, "parent")
    child_svc = FileService(db)
    child = await child_svc.create_folder(user_a.id, name="child", parent_id=parent.id, project_id=None)
    await db.commit()

    await folders_api.delete_folder(parent.id, current_user=user_a, origin=None, db=db)
    out = await trash_api.list_trash_folders_page(limit=100, cursor=None, current_user=user_a, db=db)
    out = out['items']
    assert [f.id for f in out] == [parent.id]        # child 被祖先那次删除连带扫入，不单列
    assert out[0].file_count == 1                     # parent 自己直接包含的那个文件
    assert out[0].folder_count == 1


async def test_list_trash_folders_excludes_live(db, user_a):
    await _mk_folder_with_file(db, user_a, "live")
    out = await trash_api.list_trash_folders_page(limit=100, cursor=None, current_user=user_a, db=db)
    assert out['items'] == []


async def test_trash_folder_endpoints_isolate_other_users(db, user_a, user_b):
    folder, _ = await _mk_folder_with_file(db, user_b, "他人的回收站")
    await folders_api.delete_folder(folder.id, current_user=user_b, origin=None, db=db)

    folders = await trash_api.list_trash_folders_page(limit=100, cursor=None, current_user=user_a, db=db)
    assert folders['items'] == []

    with pytest.raises(HTTPException) as contents_error:
        await trash_api.list_trash_folder_contents_page(folder.id, limit=100, folder_cursor=None,
            file_cursor=None, current_user=user_a, db=db)
    assert contents_error.value.status_code == 404

    with pytest.raises(HTTPException) as delete_error:
        await trash_api.hard_delete_folder(folder.id, current_user=user_a, origin=None, db=db)
    assert delete_error.value.status_code == 404
    assert await db.get(Folder, folder.id) is not None


async def test_list_trash_folder_contents_returns_children(db, user_a):
    parent, parent_file = await _mk_folder_with_file(db, user_a, "可展开")
    child = await FileService(db).create_folder(
        user_a.id, name="二级目录", parent_id=parent.id, project_id=None)
    child_file = (await FileService(db).create_file(
        user_a.id, space="personal", project_id=None, folder_id=child.id, stage_name="",
        mind_map_id=None, display_name="子文件", ext="TXT", mime_type="text/plain", data=b"x"
    )).file
    await db.commit()
    await folders_api.delete_folder(parent.id, current_user=user_a, origin=None, db=db)

    out = await trash_api.list_trash_folder_contents_page(parent.id, limit=100, folder_cursor=None,
        file_cursor=None, current_user=user_a, db=db)

    assert [folder.name for folder in out['folders']['items']] == ["二级目录"]
    assert out['folders']['items'][0].file_count == 1
    assert out['folders']['items'][0].folder_count == 0
    assert {file.display_name for file in out['files']['items']} == {parent_file.display_name}
    assert child_file.display_name not in {file.display_name for file in out['files']['items']}


async def test_folder_deleted_files_are_hidden_and_cannot_restore_individually(db, user_a):
    folder, f = await _mk_folder_with_file(db, user_a, "资料")
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)

    # 文件夹是唯一恢复单元：子文件既不应单列，也不能被直接恢复成指向已删父目录的幽灵。
    page = await trash_api.list_trash_page(limit=100, cursor=None, current_user=user_a, db=db)
    assert page['items'] == []
    with pytest.raises(HTTPException) as exc:
        await trash_api.restore_file(f.id, current_user=user_a, origin=None, db=db)
    assert exc.value.status_code == 409
    await db.refresh(f)
    assert f.deleted_at is not None


async def test_empty_trash_removes_deleted_folder_with_its_files(db, user_a, monkeypatch):
    folder, f = await _mk_folder_with_file(db, user_a, "待清空")
    file_id = f.id
    user_id = user_a.id
    quota = await get_quota(db, user_a.id, FILE_LIBRARY)
    assert quota.used_bytes == 1
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)
    assert quota.used_bytes == 1

    job = await trash_api.empty_trash(current_user=user_a, db=db)
    job_id = job.id
    assert job.status == "queued"

    from app.db import session as db_session
    from app.services.files import trash_purge
    progress_events = []

    async def capture_progress(user_id, **payload):
        progress_events.append((user_id, payload))

    monkeypatch.setattr(
        "app.core.events.publish_trash_purge_progress", capture_progress,
    )
    worker_id = "test-trash-purge"
    claimed_id = await trash_purge._claim(db_session._SessionLocal, worker_id)
    assert claimed_id == job.id
    await trash_purge._process(claimed_id, worker_id, db_session._SessionLocal)

    db.expire_all()
    assert await db.get(Folder, folder.id) is None
    assert await db.get(File, file_id) is None
    persisted_user = await db.get(type(user_a), user_id)
    persisted = await trash_api.get_empty_trash_job(job_id, current_user=persisted_user, db=db)
    assert persisted.status == "completed"
    assert persisted.progress_current == persisted.progress_total == 1
    await db.refresh(quota)
    assert quota.used_bytes == 0
    assert [(event[1]["status"], event[1]["progress_current"]) for event in progress_events] == [
        ("running", 1), ("completed", 1),
    ]


async def test_empty_trash_reconciles_legacy_underreported_quota_before_delete(
    db, user_a, monkeypatch, _storage_and_events,
):
    """旧账本漏记回收站占用时先对账，再删除文件并将账本安全归零。"""
    user_id = user_a.id
    folder, file = await _mk_folder_with_file(db, user_a, "历史回收站", data=b"legacy")
    file_id = file.id
    quota = await get_quota(db, user_a.id, FILE_LIBRARY)
    assert quota.used_bytes == len(b"legacy")

    # 模拟旧版本只写 deleted_at，没有写配额事件的回收站记录。
    stamp = now_utc()
    (await db.get(Folder, folder.id)).deleted_at = stamp
    (await db.get(File, file.id)).deleted_at = stamp
    quota.used_bytes = 0
    await db.commit()

    job = await trash_api.empty_trash(current_user=user_a, db=db)
    job_id = job.id
    from app.db import session as db_session
    from app.services.files import trash_purge

    # 独立 worker 复用同一个临时存储；对账边界返回该文件实际占用，模拟升级前漏记账本。
    monkeypatch.setattr(trash_purge, "get_storage", lambda: _storage_and_events)

    async def measure_existing_file(_db, _user_id):
        return len(b"legacy")

    monkeypatch.setattr(
        "app.services.storage.quota_ledger._measure_file_library_usage",
        measure_existing_file,
    )
    worker_id = "test-trash-purge-legacy"
    claimed_id = await trash_purge._claim(db_session._SessionLocal, worker_id)
    assert claimed_id == job.id
    await trash_purge._process(claimed_id, worker_id, db_session._SessionLocal)

    db.expire_all()
    persisted_user = await db.get(type(user_a), user_id)
    persisted_job = await trash_api.get_empty_trash_job(job_id, current_user=persisted_user, db=db)
    assert persisted_job.status == "completed", persisted_job.error_code
    await db.refresh(quota)
    assert quota.used_bytes == 0
    assert await db.get(File, file_id) is None
    event = await db.scalar(select(StorageQuotaEvent).where(
        StorageQuotaEvent.user_id == user_id,
        StorageQuotaEvent.idempotency_key == f"trash-permanent-delete:{file_id}",
    ))
    events = (await db.execute(select(StorageQuotaEvent).where(
        StorageQuotaEvent.user_id == user_id,
    ))).scalars().all()
    assert event is not None, [(item.operation, item.delta_bytes, item.idempotency_key) for item in events]
    assert event.delta_bytes == -len(b"legacy")
    reconciliation = await db.scalar(select(StorageQuotaEvent).where(
        StorageQuotaEvent.user_id == user_id,
        StorageQuotaEvent.category == FILE_LIBRARY,
        StorageQuotaEvent.operation == "reconcile",
    ))
    assert reconciliation is not None
    assert reconciliation.delta_bytes == len(b"legacy")


async def test_empty_trash_reuses_active_job(db, user_a):
    folder, _ = await _mk_folder_with_file(db, user_a, "排队任务")
    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)
    first = await trash_api.start_empty_trash(current_user=user_a, db=db)
    second = await trash_api.start_empty_trash(current_user=user_a, db=db)
    assert first.id == second.id
    assert first.status == "queued"


async def test_hard_delete_trash_folder_removes_its_subtree(db, user_a):
    parent, parent_file = await _mk_folder_with_file(db, user_a, "待永久删除")
    child = await FileService(db).create_folder(
        user_a.id, name="子文件夹", parent_id=parent.id, project_id=None)
    child_file = (await FileService(db).create_file(
        user_a.id, space="personal", project_id=None, folder_id=child.id, stage_name="",
        mind_map_id=None, display_name="child", ext="TXT", mime_type="text/plain", data=b"x"
    )).file
    await db.commit()
    await folders_api.delete_folder(parent.id, current_user=user_a, origin=None, db=db)

    await trash_api.hard_delete_folder(parent.id, current_user=user_a, origin=None, db=db)

    assert await db.get(Folder, parent.id) is None
    assert await db.get(Folder, child.id) is None
    assert await db.get(File, parent_file.id) is None
    assert await db.get(File, child_file.id) is None


async def test_restore_folder_endpoint_round_trip(db, user_a):
    folder, f = await _mk_folder_with_file(db, user_a, "资料", data=b"body")
    quota = await get_quota(db, user_a.id, FILE_LIBRARY)
    assert quota.used_bytes == len(b"body")

    await folders_api.delete_folder(folder.id, current_user=user_a, origin=None, db=db)
    assert quota.used_bytes == len(b"body")

    resp = await trash_api.restore_folder(folder.id, current_user=user_a, origin=None, db=db)
    assert resp.id == folder.id
    assert quota.used_bytes == len(b"body")

    row = await db.get(Folder, folder.id)
    assert row.deleted_at is None
    await db.refresh(f)
    assert f.deleted_at is None
    kids = await folders_api.list_folder_page(project_id=None, parent_id=None, limit=100, cursor=None,
        sort_by='createdAt', sort_order='desc', current_user=user_a, db=db)
    assert folder.id in {k.id for k in kids['items']}


async def test_file_trash_round_trip_keeps_quota_until_permanent_deletion(db, user_a, _storage_and_events):
    storage = _storage_and_events
    result = await FileService(db, storage=storage).create_file(
        user_a.id, space="personal", project_id=None, folder_id=None, stage_name="",
        mind_map_id=None, display_name="单文件", ext="TXT", mime_type="text/plain",
        data=b"payload",
    )
    await db.commit()
    quota = await get_quota(db, user_a.id, FILE_LIBRARY)
    assert quota.used_bytes == len(b"payload")

    assert await move_file_to_trash_by_id(
        db, storage, user_a.id, result.file.id, now_utc(),
    )
    assert quota.used_bytes == len(b"payload")

    assert await restore_file_by_id(db, storage, user_a.id, result.file.id)
    assert quota.used_bytes == len(b"payload")


async def test_restore_folder_endpoint_not_found_when_live(db, user_a):
    folder, _ = await _mk_folder_with_file(db, user_a, "live")
    with pytest.raises(NotFound):
        await trash_api.restore_folder(folder.id, current_user=user_a, origin=None, db=db)


async def test_cleanup_expired_purges_old_folder_and_keeps_recent(db, user_a, _storage_and_events):
    old_folder, old_file = await _mk_folder_with_file(db, user_a, "old")
    new_folder, new_file = await _mk_folder_with_file(db, user_a, "recent")

    await folders_api.delete_folder(old_folder.id, current_user=user_a, origin=None, db=db)
    await folders_api.delete_folder(new_folder.id, current_user=user_a, origin=None, db=db)

    # 把 old 那批的时间戳往前拨 31 天，模拟「早已过期」
    stale = now_utc() - timedelta(days=31)
    old_folder_row = await db.get(Folder, old_folder.id)
    old_folder_row.deleted_at = stale
    await db.refresh(old_file)
    old_file.deleted_at = stale
    await db.commit()

    n = await trash_api.cleanup_expired(db)
    assert n == 1                                     # 只清了 old_file 这一个过期文件

    assert await db.get(Folder, old_folder.id) is None            # 过期文件夹被硬删
    assert await db.get(File, old_file.id) is None                # 对应文件行也没了

    assert await db.get(Folder, new_folder.id) is not None        # 近期删除的不受影响
    fresh_new_file = await db.get(File, new_file.id)
    assert fresh_new_file is not None and fresh_new_file.deleted_at is not None
