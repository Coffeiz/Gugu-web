"""`app/core/storage_snapshots.py`（PRD-STORAGE-2 存储监控面板）：能直接用
DB 汇总列算的几类快照——聊天附件按 draft/attached 拆分 + 用户文件库总量，
不碰存储层。"""
import pytest
from sqlalchemy import select

from app.core import chat_attach, storage_snapshots
from app.models import ChatAttachment, File, StorageCategorySnapshot
from app.services.storage import LocalStorageBackend


class _FakeLock:
    def __init__(self, acquirable: bool = True):
        self._acquirable = acquirable

    async def acquire(self, blocking=False):
        return self._acquirable

    async def release(self):
        pass


class _FakeRedis:
    def __init__(self, acquirable: bool = True):
        self._acquirable = acquirable
        self.lock_calls: list[str] = []

    def lock(self, key, timeout=None, blocking=None):
        self.lock_calls.append(key)
        return _FakeLock(self._acquirable)


@pytest.fixture
def storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: backend)
    monkeypatch.setattr(chat_attach, "get_storage", lambda: backend)
    return backend


@pytest.mark.asyncio
async def test_sql_snapshots_splits_draft_and_attached(db, user_a, storage, monkeypatch):
    from app.models import ConversationSession, ConversationMessage
    monkeypatch.setattr(storage_snapshots.R, "get_redis", lambda: _FakeRedis())

    session = ConversationSession(user_id=user_a.id, title="t", source="web")
    db.add(session)
    await db.flush()
    msg = ConversationMessage(session_id=session.id, role="user", content="hi")
    db.add(msg)
    await db.flush()

    attached_meta = await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"x" * 100)
    await chat_attach.claim_attachments(db, user_a.id, msg.id, [attached_meta["attach_id"]])
    await chat_attach.stage(user_a.id, "b.png", "png", "image/png", b"y" * 50)   # 仍是 draft
    await db.commit()

    await storage_snapshots.record_sql_snapshots()

    draft = (await db.execute(
        select(StorageCategorySnapshot).where(StorageCategorySnapshot.category == storage_snapshots.CATEGORY_CHAT_DRAFT)
    )).scalars().first()
    attached = (await db.execute(
        select(StorageCategorySnapshot).where(StorageCategorySnapshot.category == storage_snapshots.CATEGORY_CHAT_ATTACHED)
    )).scalars().first()

    assert draft.object_count == 1 and draft.total_bytes == 50
    assert attached.object_count == 1 and attached.total_bytes == 100


@pytest.mark.asyncio
async def test_sql_snapshots_user_files_total(db, user_a, monkeypatch):
    monkeypatch.setattr(storage_snapshots.R, "get_redis", lambda: _FakeRedis())

    db.add_all([
        File(user_id=user_a.id, display_name="a", ext="TXT", storage_key="k1", size_bytes=100),
        File(user_id=user_a.id, display_name="b", ext="TXT", storage_key="k2", size_bytes=200),
    ])
    await db.commit()

    await storage_snapshots.record_sql_snapshots()

    snap = (await db.execute(
        select(StorageCategorySnapshot).where(StorageCategorySnapshot.category == storage_snapshots.CATEGORY_USER_FILES)
    )).scalars().first()
    assert snap.object_count == 2
    assert snap.total_bytes == 300


@pytest.mark.asyncio
async def test_sql_snapshots_noop_when_lock_held(db, user_a, monkeypatch):
    fake_redis = _FakeRedis(acquirable=False)
    monkeypatch.setattr(storage_snapshots.R, "get_redis", lambda: fake_redis)

    await storage_snapshots.record_sql_snapshots()

    count = (await db.execute(select(StorageCategorySnapshot))).scalars().all()
    assert count == []
    assert fake_redis.lock_calls == [storage_snapshots._LOCK_KEY]


@pytest.mark.asyncio
async def test_compute_sql_totals_does_not_write_snapshot(db, user_a):
    """compute_sql_totals() 是纯查询，不应该往 storage_category_snapshots 写
    任何行——这是它跟 record_sql_snapshots() 的关键区别。"""
    db.add(File(user_id=user_a.id, display_name="a", ext="TXT", storage_key="k1", size_bytes=100))
    await db.commit()

    totals = await storage_snapshots.compute_sql_totals()

    assert totals[storage_snapshots.CATEGORY_USER_FILES]["object_count"] == 1
    assert totals[storage_snapshots.CATEGORY_USER_FILES]["total_bytes"] == 100
    rows = (await db.execute(select(StorageCategorySnapshot))).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_storage_live_totals_endpoint(db, user_a):
    from app.api.v1.ops_admin import storage_live_totals

    db.add(File(user_id=user_a.id, display_name="a", ext="TXT", storage_key="k1", size_bytes=100))
    await db.commit()

    result = await storage_live_totals()

    assert result["categories"][storage_snapshots.CATEGORY_USER_FILES]["total_bytes"] == 100
