"""草稿孤儿定时清理 + 安全网扫描（PRD-STORAGE-1 Phase A，`app/core/attachment_gc.py`）。

草稿 GC：DB 驱动、条件删除赢 DB 所有权。安全网：DB↔storage 交叉检查，两种
不一致分开处理——DB 有记录+storage 缺失是 integrity violation（告警不删），
DB 无记录+storage 存在（非最近写入）才是孤儿候选。
"""
import os
import time
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.core import attachment_gc, chat_attach
from app.core.tz import now_utc
from app.models import ChatAttachment
from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: backend)
    monkeypatch.setattr(chat_attach, "get_storage", lambda: backend)
    return backend


class _FakeLock:
    def __init__(self, acquirable: bool):
        self._acquirable = acquirable
        self.released = False

    async def acquire(self, blocking=False):
        return self._acquirable

    async def release(self):
        self.released = True


class _FakeRedis:
    def __init__(self, acquirable: bool = True):
        self._acquirable = acquirable
        self.lock_calls: list[str] = []
        self.last_lock: _FakeLock | None = None

    def lock(self, key, timeout=None, blocking=None):
        self.lock_calls.append(key)
        self.last_lock = _FakeLock(self._acquirable)
        return self.last_lock


async def _stage_and_age(user, storage, db, hours_old: float, name="a.png"):
    meta = await chat_attach.stage(user.id, name, "png", "image/png", b"hello")
    row = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"])
    )).scalars().first()
    row.created_at = now_utc() - timedelta(hours=hours_old)
    await db.commit()
    return meta


# ── 草稿 GC ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_draft_gc_deletes_expired_draft(db, user_a, storage, monkeypatch):
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: _FakeRedis())
    meta = await _stage_and_age(user_a, storage, db, hours_old=49)   # 超过 48h TTL

    n = await attachment_gc.sweep_draft_attachments()

    assert n == 1
    assert not await storage.exists(meta["storage_key"])
    remaining = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))).scalars().first()
    assert remaining is None


@pytest.mark.asyncio
async def test_draft_gc_skips_fresh_draft(db, user_a, storage, monkeypatch):
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: _FakeRedis())
    meta = await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"hello")

    n = await attachment_gc.sweep_draft_attachments()

    assert n == 0
    assert await storage.exists(meta["storage_key"])


@pytest.mark.asyncio
async def test_draft_gc_skips_attached_even_if_old(db, user_a, storage, monkeypatch):
    """`state='attached'` 的行即使物理 created_at 同样很老，也不该被草稿 GC 碰。"""
    from app.models import ConversationSession, ConversationMessage
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: _FakeRedis())

    session = ConversationSession(user_id=user_a.id, title="t", source="web")
    db.add(session)
    await db.flush()
    msg = ConversationMessage(session_id=session.id, role="user", content="hi")
    db.add(msg)
    await db.flush()

    meta = await _stage_and_age(user_a, storage, db, hours_old=100)
    await chat_attach.claim_attachments(db, user_a.id, msg.id, [meta["attach_id"]])
    await db.commit()

    n = await attachment_gc.sweep_draft_attachments()

    assert n == 0
    assert await storage.exists(meta["storage_key"])


@pytest.mark.asyncio
async def test_draft_gc_empty_returns_zero(db, storage, monkeypatch):
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: _FakeRedis())
    assert await attachment_gc.sweep_draft_attachments() == 0


@pytest.mark.asyncio
async def test_draft_gc_noop_when_lock_held(db, user_a, storage, monkeypatch):
    fake_redis = _FakeRedis(acquirable=False)
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: fake_redis)
    meta = await _stage_and_age(user_a, storage, db, hours_old=49)

    n = await attachment_gc.sweep_draft_attachments()

    assert n == 0
    assert await storage.exists(meta["storage_key"])
    assert fake_redis.lock_calls == [attachment_gc._DRAFT_LOCK_KEY]


# ── 安全网 ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_safety_net_identifies_integrity_violation(db, user_a, storage, monkeypatch):
    """DB 有记录、但物理对象缺失（比如被误删）——只告警，不删 DB 记录。"""
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: _FakeRedis())
    meta = await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"hello")
    await storage.delete(meta["storage_key"])   # 模拟物理对象被误删/损坏

    logged = {}
    async def _fake_write_system_log(message):
        logged["message"] = message
    monkeypatch.setattr(attachment_gc, "_write_system_log", _fake_write_system_log)

    result = await attachment_gc.sweep_orphans_and_report_integrity()

    assert result["integrity_violations"] == 1
    assert "message" in logged
    # 必须过 redact()：不能把原始 storage_key/路径直接暴露进 SystemLog 这个用户可达的出口
    assert meta["storage_key"] not in logged["message"]
    # DB 记录不应该被自动清理
    row = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))).scalars().first()
    assert row is not None


@pytest.mark.asyncio
async def test_safety_net_deletes_old_orphan_candidate(db, user_a, storage, monkeypatch):
    """DB 无记录、storage 里有一个非最近写入的孤儿对象——允许清理。"""
    from sqlalchemy import delete as sa_delete
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: _FakeRedis())
    meta = await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"hello")
    await db.execute(sa_delete(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))
    await db.commit()

    # 物理年龄改到安全窗口之外
    old_mtime = time.time() - attachment_gc._SAFETY_NET_ORPHAN_MIN_AGE - 3600
    path = storage.root / meta["storage_key"]
    os.utime(path, (old_mtime, old_mtime))

    result = await attachment_gc.sweep_orphans_and_report_integrity()

    assert result["orphans_deleted"] == 1
    assert not await storage.exists(meta["storage_key"])


@pytest.mark.asyncio
async def test_safety_net_skips_recent_orphan_candidate(db, user_a, storage, monkeypatch):
    """DB 无记录，但 storage 对象是最近写入的（可能是 stage() 的 put 已成功、
    DB insert 还没提交完的正常瞬间）——不该被安全网当孤儿删掉。"""
    from sqlalchemy import delete as sa_delete
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: _FakeRedis())
    meta = await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"hello")
    await db.execute(sa_delete(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))
    await db.commit()

    result = await attachment_gc.sweep_orphans_and_report_integrity()

    assert result["orphans_deleted"] == 0
    assert await storage.exists(meta["storage_key"])


@pytest.mark.asyncio
async def test_safety_net_normal_case_no_findings(db, user_a, storage, monkeypatch):
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: _FakeRedis())
    await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"hello")

    result = await attachment_gc.sweep_orphans_and_report_integrity()

    assert result == {"integrity_violations": 0, "orphans_deleted": 0}


@pytest.mark.asyncio
async def test_safety_net_noop_when_lock_held(db, user_a, storage, monkeypatch):
    fake_redis = _FakeRedis(acquirable=False)
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: fake_redis)
    await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"hello")

    result = await attachment_gc.sweep_orphans_and_report_integrity()

    assert result == {"integrity_violations": 0, "orphans_deleted": 0}
    assert fake_redis.lock_calls == [attachment_gc._SAFETY_NET_LOCK_KEY]


@pytest.mark.asyncio
async def test_safety_net_skips_orphan_candidate_with_missing_mtime(db, user_a, storage, monkeypatch):
    """orphan 候选对象 `stat()` 拿不到 mtime（比如对象在扫描和 stat 之间被删掉）时
    跳过、不当成"该删"处理——保守，避免误删。"""
    from sqlalchemy import delete as sa_delete
    monkeypatch.setattr(attachment_gc.R, "get_redis", lambda: _FakeRedis())
    meta = await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"hello")
    await db.execute(sa_delete(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))
    await db.commit()

    class _NoMtimeInfo:
        mtime = None

    async def fake_stat(key):
        return _NoMtimeInfo()

    monkeypatch.setattr(storage, "stat", fake_stat)

    result = await attachment_gc.sweep_orphans_and_report_integrity()

    assert result["orphans_deleted"] == 0
    assert await storage.exists(meta["storage_key"])
