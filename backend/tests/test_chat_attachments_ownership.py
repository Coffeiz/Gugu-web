"""附件所有权状态机（PRD-STORAGE-1 Phase A）：stage() DB 写入、claim 原子性、
DB 优先查询 + IDOR、delete_session 级联清理（含共享 storage_key 隔离）、
单附件删除状态守卫、GC-vs-claim 竞态、插入失败回滚、DB 提交失败不提前删 storage。

用 `LocalStorageBackend` + `tmp_path`，`db`/`user_a`/`user_b` 复用 conftest 里
的通用 SQLite 测试基座。
"""
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.core import chat_attach
from app.core.tz import now_utc
from app.models import ChatAttachment, ConversationMessage, ConversationSession
from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: backend)
    monkeypatch.setattr(chat_attach, "get_storage", lambda: backend)
    return backend


async def _stage(user, storage, name="a.png", ext="png", mime="image/png", data=b"hello"):
    return await chat_attach.stage(user.id, name, ext, mime, data)


async def _mk_session(db, user, **kw):
    session = ConversationSession(user_id=user.id, title="t", source="web", **kw)
    db.add(session)
    await db.flush()
    return session


async def _mk_message(db, session, **kw):
    msg = ConversationMessage(session_id=session.id, role="user", content="hi", **kw)
    db.add(msg)
    await db.flush()
    return msg


# ── stage() 写 DB / 插入失败回滚 ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stage_creates_draft_row(db, user_a, storage):
    meta = await _stage(user_a, storage)
    row = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"])
    )).scalars().first()
    assert row is not None
    assert row.state == "draft"
    assert row.message_id is None
    assert row.storage_key == meta["storage_key"]
    assert await storage.exists(meta["storage_key"])


@pytest.mark.asyncio
async def test_reuse_attachment_creates_new_row_with_shared_storage_key(db, user_a, storage):
    source = await chat_attach.stage(
        user_a.id, "source.png", "png", "image/png", b"hello",
        platform="qq", platform_message_id="msg-1", attachment_index=0,
    )

    reused = await chat_attach.reuse_attachment(
        user_a.id,
        platform="qq",
        platform_message_id="msg-1",
        attachment_index=0,
        extra={"quoted": True},
    )

    assert reused is not None
    assert reused["attach_id"] != source["attach_id"]
    assert reused["storage_key"] == source["storage_key"]
    assert reused["quoted"] is True
    rows = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.platform_message_id == "msg-1")
    )).scalars().all()
    assert {row.attach_id for row in rows} == {source["attach_id"], reused["attach_id"]}
    assert await storage.exists(source["storage_key"])


@pytest.mark.asyncio
async def test_reuse_attachment_selects_the_requested_source_index(db, user_a, storage):
    """同一条 QQ 消息有多个附件时，引用必须按稳定的附件序号复用对应字节。"""
    first = await chat_attach.stage(
        user_a.id, "first.png", "png", "image/png", b"first",
        platform="qq", platform_message_id="multi-msg", attachment_index=0,
    )
    second = await chat_attach.stage(
        user_a.id, "second.png", "png", "image/png", b"second",
        platform="qq", platform_message_id="multi-msg", attachment_index=1,
    )

    reused = await chat_attach.reuse_attachment(
        user_a.id,
        platform="qq",
        platform_message_id="multi-msg",
        attachment_index=1,
        extra={"quoted": True},
    )

    assert reused is not None
    assert reused["storage_key"] == second["storage_key"]
    assert reused["storage_key"] != first["storage_key"]
    assert reused["quoted"] is True


@pytest.mark.asyncio
async def test_reuse_attachment_falls_back_when_source_object_is_missing(db, user_a, storage):
    """源附件行残留但物理对象丢失时，不能返回指向不存在对象的新附件行。"""
    source = await chat_attach.stage(
        user_a.id, "missing.png", "png", "image/png", b"hello",
        platform="qq", platform_message_id="missing-object", attachment_index=0,
    )
    await storage.delete(source["storage_key"])

    reused = await chat_attach.reuse_attachment(
        user_a.id,
        platform="qq",
        platform_message_id="missing-object",
        attachment_index=0,
    )

    assert reused is None
    rows = (await db.execute(
        select(ChatAttachment).where(
            ChatAttachment.platform_message_id == "missing-object",
        )
    )).scalars().all()
    assert [row.attach_id for row in rows] == [source["attach_id"]]


@pytest.mark.asyncio
async def test_reuse_attachment_isolated_by_user(db, user_a, user_b, storage):
    """相同平台消息标识不能跨用户命中源附件。"""
    source = await chat_attach.stage(
        user_a.id, "private.png", "png", "image/png", b"private",
        platform="qq", platform_message_id="same-platform-id", attachment_index=0,
    )

    reused = await chat_attach.reuse_attachment(
        user_b.id,
        platform="qq",
        platform_message_id="same-platform-id",
        attachment_index=0,
    )

    assert reused is None
    assert await storage.exists(source["storage_key"])


@pytest.mark.asyncio
async def test_stage_rolls_back_storage_when_db_insert_fails(db, user_a, storage, monkeypatch):
    async def _boom(*a, **kw):
        raise RuntimeError("db insert failed")
    monkeypatch.setattr(chat_attach, "_record_draft", _boom)

    with pytest.raises(RuntimeError):
        await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"hello")

    # storage.put 成功过，但 insert 失败应该 best-effort 把刚写的字节删掉——
    # 断言存储里不应该残留一个 DB 完全不知道的孤儿对象。
    keys = await storage.list_keys()
    assert not any(f"/{user_a.id}/.chat_staging/" in f"/{k}" for k in keys)


# ── claim：all-or-nothing ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_claim_attaches_all_on_success(db, user_a, storage):
    m1 = await _stage(user_a, storage, name="1.png")
    m2 = await _stage(user_a, storage, name="2.png")
    session = await _mk_session(db, user_a)
    msg = await _mk_message(db, session)

    await chat_attach.claim_attachments(db, user_a.id, msg.id, [m1["attach_id"], m2["attach_id"]])
    await db.commit()

    rows = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.attach_id.in_([m1["attach_id"], m2["attach_id"]]))
    )).scalars().all()
    assert len(rows) == 2
    assert all(r.state == "attached" and r.message_id == msg.id for r in rows)


@pytest.mark.asyncio
async def test_claim_all_or_nothing_on_partial_failure(db, user_a, storage):
    """一条消息带 2 个附件，其中 1 个已经不是 draft（模拟已被别的请求 claim 走）——
    claim_attachments 必须整体抛异常，调用方据此回滚整个事务：不允许消息落库、
    只有部分附件被 claim 成功的半完整状态（PRD-STORAGE-1 不变量 3）。"""
    m1 = await _stage(user_a, storage, name="1.png")
    m2 = await _stage(user_a, storage, name="2.png")
    session = await _mk_session(db, user_a)
    other_msg = await _mk_message(db, session)
    # m2 提前被 claim 给另一条消息，模拟并发竞态
    await chat_attach.claim_attachments(db, user_a.id, other_msg.id, [m2["attach_id"]])
    await db.commit()

    new_msg = await _mk_message(db, session)
    with pytest.raises(chat_attach.AttachmentClaimError):
        await chat_attach.claim_attachments(db, user_a.id, new_msg.id, [m1["attach_id"], m2["attach_id"]])
    await db.rollback()

    # m1 不应该被 claim 成功（虽然它本身合法，但同批次里 m2 失败，整体应该没有生效）
    row1 = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == m1["attach_id"]))).scalars().first()
    assert row1.state == "draft"


@pytest.mark.asyncio
async def test_claim_ignores_empty_list(db, user_a, storage):
    session = await _mk_session(db, user_a)
    msg = await _mk_message(db, session)
    await chat_attach.claim_attachments(db, user_a.id, msg.id, [])   # 不应抛异常
    await db.commit()


# ── get_meta：DB 优先 + IDOR ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_meta_reads_from_db(db, user_a, storage):
    meta = await _stage(user_a, storage)
    got = await chat_attach.get_meta(user_a.id, meta["attach_id"])
    assert got is not None
    assert got["storage_key"] == meta["storage_key"]


@pytest.mark.asyncio
async def test_get_meta_idor_other_user_cannot_read(db, user_a, user_b, storage):
    """另一个用户用同一个 attach_id 查，应该拿不到——DB 查询必须带 user_id 过滤。"""
    meta = await _stage(user_a, storage)
    got = await chat_attach.get_meta(user_b.id, meta["attach_id"])
    assert got is None


@pytest.mark.asyncio
async def test_get_meta_falls_back_to_legacy_redis_when_db_misses(db, user_a, storage, monkeypatch):
    """模拟 v3 上线前遗留、只存在 Redis 里的旧数据：DB 查不到时应该回退查 Redis。"""
    import json

    class _FakeRedisClient:
        async def get(self, key):
            return json.dumps({"attach_id": "legacy1", "name": "old.png",
                               "storage_key": "legacy/key.png", "kind": "image"})

    monkeypatch.setattr(chat_attach, "get_redis", lambda: _FakeRedisClient())
    got = await chat_attach.get_meta(user_a.id, "legacy1")
    assert got is not None
    assert got["storage_key"] == "legacy/key.png"


# ── try_delete_storage_if_unreferenced：引用计数 ────────────────────────────

@pytest.mark.asyncio
async def test_try_delete_skips_when_still_referenced(db, user_a, storage):
    meta = await _stage(user_a, storage)
    # 手动再插一条指向同一个 storage_key 的行，模拟 PRD-IM-9 的共享复用场景
    session = await _mk_session(db, user_a)
    msg = await _mk_message(db, session)
    db.add(ChatAttachment(
        attach_id="shared-ref", user_id=user_a.id, storage_key=meta["storage_key"],
        name="dup.png", ext="png", kind="image", state="attached", message_id=msg.id,
    ))
    await db.commit()

    result = await chat_attach.try_delete_storage_if_unreferenced(user_a.id, meta["storage_key"])
    assert result == "skipped"
    assert await storage.exists(meta["storage_key"])


@pytest.mark.asyncio
async def test_try_delete_deletes_when_unreferenced(db, user_a, storage):
    meta = await _stage(user_a, storage)
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))
    await db.commit()

    result = await chat_attach.try_delete_storage_if_unreferenced(user_a.id, meta["storage_key"])
    assert result == "deleted"
    assert not await storage.exists(meta["storage_key"])


# ── delete_session：DB 优先 + 共享 storage_key 隔离 ─────────────────────────

@pytest.mark.asyncio
async def test_delete_session_deletes_attachment_bytes(db, user_a, storage):
    from app.api.v1.agent import delete_session
    session = await _mk_session(db, user_a)
    msg = await _mk_message(db, session)
    meta = await _stage(user_a, storage)
    await chat_attach.claim_attachments(db, user_a.id, msg.id, [meta["attach_id"]])
    await db.commit()

    await delete_session(session.id, current_user=user_a, db=db)

    remaining = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))).scalars().first()
    assert remaining is None
    assert not await storage.exists(meta["storage_key"])


@pytest.mark.asyncio
async def test_delete_session_shared_storage_key_isolation(db, user_a, storage):
    """两条独立消息（分属不同会话）共享同一个 storage_key——删除其中一个会话，
    物理字节不应该被删（另一条还活着），另一条消息仍能正常访问附件；
    再删第二条消息所在会话，这次物理字节才真正被删除（PRD-STORAGE-1 P0）。"""
    from app.api.v1.agent import delete_session

    session1 = await _mk_session(db, user_a)
    msg1 = await _mk_message(db, session1)
    meta = await _stage(user_a, storage)
    await chat_attach.claim_attachments(db, user_a.id, msg1.id, [meta["attach_id"]])
    await db.commit()

    session2 = await _mk_session(db, user_a)
    msg2 = await _mk_message(db, session2)
    # 模拟 PRD-IM-9 的复用：msg2 拿到自己独立的 chat_attachments 行，storage_key 相同
    db.add(ChatAttachment(
        attach_id="reused-attach", user_id=user_a.id, storage_key=meta["storage_key"],
        name=meta["name"], ext=meta["ext"], kind=meta["kind"],
        state="attached", message_id=msg2.id,
    ))
    await db.commit()

    await delete_session(session1.id, current_user=user_a, db=db)

    assert await storage.exists(meta["storage_key"]), "另一条消息还在用，物理字节不该被删"
    still_there = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == "reused-attach"))).scalars().first()
    assert still_there is not None

    await delete_session(session2.id, current_user=user_a, db=db)
    assert not await storage.exists(meta["storage_key"]), "最后一个引用没了，物理字节应该被删"


@pytest.mark.asyncio
async def test_delete_session_storage_failure_does_not_block(db, user_a, storage, monkeypatch):
    """storage.delete() 抛异常时，delete_session 本身仍应成功返回（DB 层面已完成），
    不阻塞会话删除的主流程。"""
    from app.api.v1.agent import delete_session

    session = await _mk_session(db, user_a)
    msg = await _mk_message(db, session)
    meta = await _stage(user_a, storage)
    await chat_attach.claim_attachments(db, user_a.id, msg.id, [meta["attach_id"]])
    await db.commit()

    async def _boom(key):
        raise RuntimeError("storage backend down")
    monkeypatch.setattr(storage, "delete", _boom)

    await delete_session(session.id, current_user=user_a, db=db)   # 不应该抛异常

    remaining = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))).scalars().first()
    assert remaining is None, "DB 层面的删除应该已经成功"


# ── 单附件删除接口：状态守卫 ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_draft_attachment_succeeds_on_draft(db, user_a, storage):
    from app.api.v1.agent import delete_draft_attachment
    meta = await _stage(user_a, storage)

    result = await delete_draft_attachment(meta["attach_id"], current_user=user_a, db=db)
    assert result == {"deleted": True}
    assert not await storage.exists(meta["storage_key"])


@pytest.mark.asyncio
async def test_delete_draft_attachment_rejects_attached(db, user_a, storage):
    """已经 claim 成 attached 的附件必须拒绝删除——HTTP 响应丢失导致的误判"发送
    失败"不能把已经生效的正常附件删掉。"""
    from fastapi import HTTPException
    from app.api.v1.agent import delete_draft_attachment

    session = await _mk_session(db, user_a)
    msg = await _mk_message(db, session)
    meta = await _stage(user_a, storage)
    await chat_attach.claim_attachments(db, user_a.id, msg.id, [meta["attach_id"]])
    await db.commit()

    with pytest.raises(HTTPException) as exc_info:
        await delete_draft_attachment(meta["attach_id"], current_user=user_a, db=db)
    assert exc_info.value.status_code == 409
    assert await storage.exists(meta["storage_key"]), "已生效的附件不该被删"


@pytest.mark.asyncio
async def test_delete_draft_attachment_404_for_unknown_or_other_user(db, user_a, user_b, storage):
    from fastapi import HTTPException
    from app.api.v1.agent import delete_draft_attachment
    meta = await _stage(user_a, storage)

    with pytest.raises(HTTPException) as exc_info:
        await delete_draft_attachment(meta["attach_id"], current_user=user_b, db=db)
    assert exc_info.value.status_code == 404


# ── GC-vs-claim 竞态 ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_gc_conditional_delete_loses_to_concurrent_claim(db, user_a, storage):
    """草稿孤儿清理和消息发送并发操作同一行：GC 用条件删除（WHERE state='draft'），
    如果这行已经被 claim 成 attached，GC 的条件删除应该 affected_rows=0、天然是
    no-op，不会跟 claim 冲突——不能出现"消息引用了一个被 GC 删掉的附件"。"""
    from sqlalchemy import delete as sa_delete
    meta = await _stage(user_a, storage)
    session = await _mk_session(db, user_a)
    msg = await _mk_message(db, session)

    # 模拟 claim 先赢（发送成功）
    await chat_attach.claim_attachments(db, user_a.id, msg.id, [meta["attach_id"]])
    await db.commit()

    # GC 随后尝试按草稿条件删除同一行——条件不匹配，必须是 no-op
    result = await db.execute(
        sa_delete(ChatAttachment).where(
            ChatAttachment.attach_id == meta["attach_id"],
            ChatAttachment.state == "draft",
        )
    )
    await db.commit()
    assert result.rowcount == 0

    row = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))).scalars().first()
    assert row.state == "attached"
    assert row.message_id == msg.id
    assert await storage.exists(meta["storage_key"]), "已经被消息引用的附件不该被 GC 碰"


# ── 不变量 4：检查-删除竞态（边界测试，非完整解） ────────────────────────────

@pytest.mark.asyncio
async def test_try_delete_check_logic_does_not_use_stale_result(db, user_a, storage, monkeypatch):
    """这个测试**不能证明"检查完成到真正删除之间不会冒出新引用"这个竞态已经
    整体解决**——完整解决依赖 PRD-IM-9 落地时对源行加锁（见 PRD-STORAGE-1 第 4
    条不变量）。这里只测 `try_delete_storage_if_unreferenced()` 自身的检查逻辑：
    每次调用都应该重新查一次 DB，不能缓存/复用上一次的检查结果——模拟"检查时
    确实没有引用，但在 storage.delete() 真正执行前又插入了一条新引用"，如果
    实现里有陈旧结果被复用的 bug，这里会先删后发现新引用已经存在，暴露问题。"""
    meta = await _stage(user_a, storage)
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"]))
    await db.commit()

    original_delete = storage.delete
    inserted = {}

    async def delete_with_race(key):
        # 在真正物理删除之前，模拟一个并发请求插入了新的共享引用
        session = await _mk_session(db, user_a)
        msg = await _mk_message(db, session)
        db.add(ChatAttachment(
            attach_id="race-new-ref", user_id=user_a.id, storage_key=meta["storage_key"],
            name="dup.png", ext="png", kind="image", state="attached", message_id=msg.id,
        ))
        await db.commit()
        inserted["done"] = True
        return await original_delete(key)

    monkeypatch.setattr(storage, "delete", delete_with_race)

    # try_delete_storage_if_unreferenced 内部会重新开一个 db session 做检查，
    # 不会看到我们在 delete_with_race 里刚插入的行（检查发生在删除之前，不是
    # 之后）——这条测试如实反映了检查和删除本身不是原子操作的现状。
    result = await chat_attach.try_delete_storage_if_unreferenced(user_a.id, meta["storage_key"])

    assert result == "deleted"
    assert inserted.get("done") is True
    # 暴露真实后果：新插入的共享引用现在指向一个已经被删除的物理对象——
    # 这正是不变量 4 描述的问题，完整解决依赖 PRD-IM-9 的源行加锁，这条测试
    # 只是把这个已知边界用代码固定下来，不是"已解决"的证明。
    assert not await storage.exists(meta["storage_key"])
    dangling = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == "race-new-ref"))).scalars().first()
    assert dangling is not None, "这条新引用会指向一个不存在的物理对象——已知边界，见 PRD-IM-9"


# ── stage() 插入失败：回滚也失败时不掩盖原始异常 ─────────────────────────────

@pytest.mark.asyncio
async def test_stage_insert_failure_with_rollback_failure_still_raises_original(db, user_a, storage, monkeypatch):
    async def _boom_insert(*a, **kw):
        raise RuntimeError("original db insert error")
    monkeypatch.setattr(chat_attach, "_record_draft", _boom_insert)

    async def _boom_rollback(key):
        raise RuntimeError("storage delete also failed")
    monkeypatch.setattr(storage, "delete", _boom_rollback)

    with pytest.raises(RuntimeError, match="original db insert error"):
        await chat_attach.stage(user_a.id, "a.png", "png", "image/png", b"hello")


# ── DB commit 失败：不能提前删 storage ───────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_session_db_failure_prevents_storage_delete(db, user_a, storage, monkeypatch):
    from app.api.v1.agent import delete_session

    session = await _mk_session(db, user_a)
    msg = await _mk_message(db, session)
    meta = await _stage(user_a, storage)
    await chat_attach.claim_attachments(db, user_a.id, msg.id, [meta["attach_id"]])
    await db.commit()

    delete_called = {"n": 0}

    async def _tracking_delete(key):
        delete_called["n"] += 1

    monkeypatch.setattr(storage, "delete", _tracking_delete)

    async def _boom_commit():
        raise RuntimeError("db commit failed")
    monkeypatch.setattr(db, "commit", _boom_commit)

    with pytest.raises(RuntimeError, match="db commit failed"):
        await delete_session(session.id, current_user=user_a, db=db)

    assert delete_called["n"] == 0, "DB commit 失败时不应该有任何 storage.delete() 被调用"


# ── 集成测试：走真实 /agent/upload 接口 + 真实草稿 GC 任务（PRD §6.2 手测第 4 条的自动化版本）

@pytest.mark.asyncio
async def test_e2e_draft_upload_expires_but_attached_survives(db, user_a, storage):
    """走真实 `upload_attachment` 接口（而不是直接调 `chat_attach.stage()`）产生草稿，
    再走真实 `attachment_gc.sweep_draft_attachments()`（而不是直接操作 DB 行）验证：
    ① 过期草稿被清理（DB 行 + 物理字节都消失）；
    ② 已经发送成功（claim 成 attached）的附件，哪怕物理创建时间同样很老，也不会
       被草稿 GC 误删——对应 PRD-STORAGE-1 §6.2 手测清单第 4 条，用真实接口/真实
       任务函数覆盖，不再需要每次手动跑一遍。"""
    import io
    from starlette.datastructures import Headers
    from fastapi import UploadFile
    from app.api.v1.agent import upload_attachment
    from app.core import attachment_gc

    class _FakeLock:
        async def acquire(self, blocking=False):
            return True
        async def release(self):
            pass

    class _FakeRedis:
        def lock(self, key, timeout=None, blocking=None):
            return _FakeLock()

    from unittest.mock import patch

    # 草稿 1：只上传，不发送——过期后应该被清理
    upload_file_1 = UploadFile(file=io.BytesIO(b"draft-image-bytes"), filename="draft.png",
                               headers=Headers({"content-type": "image/png"}))
    result_1 = await upload_attachment(file=upload_file_1, voice=False, current_user=user_a)
    draft_attach_id = result_1["attach_id"]

    # 草稿 2：上传后立刻"发送"（走真实 claim_attachments，同 web.py/runner.py 的路径）
    upload_file_2 = UploadFile(file=io.BytesIO(b"attached-image-bytes"), filename="sent.png",
                               headers=Headers({"content-type": "image/png"}))
    result_2 = await upload_attachment(file=upload_file_2, voice=False, current_user=user_a)
    attached_attach_id = result_2["attach_id"]

    session = await _mk_session(db, user_a)
    msg = await _mk_message(db, session)
    await chat_attach.claim_attachments(db, user_a.id, msg.id, [attached_attach_id])
    await db.commit()

    # 两个附件的物理创建时间都改到草稿 TTL 之外，模拟"很久以前上传的"
    old = now_utc() - timedelta(hours=chat_attach.DRAFT_TTL // 3600 + 1)
    for aid in (draft_attach_id, attached_attach_id):
        row = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == aid))).scalars().first()
        row.created_at = old
    await db.commit()

    with patch.object(attachment_gc.R, "get_redis", lambda: _FakeRedis()):
        n = await attachment_gc.sweep_draft_attachments()

    assert n == 1, "只应该清理那 1 个真正的草稿"

    draft_row = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == draft_attach_id))).scalars().first()
    assert draft_row is None, "过期草稿应该被清理"

    attached_row = (await db.execute(select(ChatAttachment).where(ChatAttachment.attach_id == attached_attach_id))).scalars().first()
    assert attached_row is not None and attached_row.state == "attached", "已发送的附件不该被草稿 GC 碰，即使物理创建时间同样很老"
    assert await storage.exists(attached_row.storage_key), "已发送附件的物理字节应该还在"


# ── stage_stream()：分块收流的附件暂存 ───────────────────────────────────────

@pytest.mark.asyncio
async def test_stage_stream_writes_exact_content(db, user_a, storage):
    import io
    stream = io.BytesIO(b"stream-attachment-body")
    meta = await chat_attach.stage_stream(
        user_a.id, "大附件", "bin", "application/octet-stream",
        stream=stream, size=22,
    )
    assert meta["size"] == 22
    assert meta["kind"] != "image"
    assert await storage.exists(meta["storage_key"])
    assert await storage.get(meta["storage_key"]) == b"stream-attachment-body"
    row = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"])
    )).scalars().first()
    assert row is not None and row.state == "draft"


# ── 流式上传路由回归：普通附件不得 materialize ───────────────────────────────

def _png_bytes(w=4, h=7):
    from io import BytesIO
    from PIL import Image as PILImage
    buf = BytesIO()
    PILImage.new("RGB", (w, h), (200, 10, 10)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_upload_attachment_pdf_goes_through_stage_stream(db, user_a, storage, monkeypatch):
    """普通附件（pdf/zip/psd…）不允许整包 materialize：chat_attach.stage() 被调用
    即失败；必须走 stage_stream 分块落盘，内容字节级一致。"""
    import io
    from starlette.datastructures import Headers
    from fastapi import UploadFile
    from app.api.v1.agent import upload_attachment

    async def _must_not_materialize(*a, **k):
        raise AssertionError("普通附件不应走 stage() 整包字节路径")

    monkeypatch.setattr(chat_attach, "stage", _must_not_materialize)
    body = b"%PDF-1.4 fake" * 2048
    upload = UploadFile(file=io.BytesIO(body), filename="doc.pdf",
                        headers=Headers({"content-type": "application/pdf"}))
    meta = await upload_attachment(file=upload, voice=False, current_user=user_a)
    assert meta["ext"] == "pdf"
    row = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"])
    )).scalars().one()
    assert await storage.get(row.storage_key) == body


@pytest.mark.asyncio
async def test_upload_attachment_fake_image_dims_none(db, user_a, storage):
    """mime 是用户可控输入：假 PNG 不能为探尺寸整包读，探不到就 None。"""
    import io
    from starlette.datastructures import Headers
    from fastapi import UploadFile
    from app.api.v1.agent import upload_attachment

    body = b"\x89PNG\r\n\x1a\n" + b"\x00" * (64 * 1024)
    upload = UploadFile(file=io.BytesIO(body), filename="fake.png",
                        headers=Headers({"content-type": "image/png"}))
    meta = await upload_attachment(file=upload, voice=False, current_user=user_a)
    assert meta["kind"] == "image"
    assert meta["img_width"] is None and meta["img_height"] is None
    row = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"])
    )).scalars().one()
    assert await storage.get(row.storage_key) == body


@pytest.mark.asyncio
async def test_stage_stream_real_image_gets_dimensions(db, user_a, storage):
    import io
    body = _png_bytes(4, 7)
    meta = await chat_attach.stage_stream(
        user_a.id, "真图", "png", "image/png", stream=io.BytesIO(body), size=len(body),
    )
    assert (meta["img_width"], meta["img_height"]) == (4, 7)
    assert await storage.get(meta["storage_key"]) == body


# ── 音频候选路径的 materialize 上限 ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_oversized_voice_recording_rejected(db, user_a, storage, monkeypatch):
    """voice=true 超过音频 materialize 上限直接拒绝（含原生 mp3/wav）。"""
    import io
    from fastapi import HTTPException, UploadFile
    from starlette.datastructures import Headers
    from app.api.v1 import agent as _agent_api
    from app.api.v1.agent import upload_attachment

    monkeypatch.setattr(_agent_api, "_AUDIO_MATERIALIZE_CAP", 8)
    upload = UploadFile(file=io.BytesIO(b"wav-bytes-here" * 2), filename="rec.mp3",
                        headers=Headers({"content-type": "audio/mpeg"}))
    with pytest.raises(HTTPException) as ei:
        await upload_attachment(file=upload, voice=True, current_user=user_a)
    assert ei.value.status_code == 400
    assert "语音录音过大" in str(ei.value.detail)


@pytest.mark.asyncio
async def test_oversized_audio_attachment_staged_raw_via_stream(db, user_a, storage, monkeypatch):
    """非 voice 的大音频不做进程内转码：按原样走 stage_stream，内容字节一致。"""
    import io
    from fastapi import UploadFile
    from starlette.datastructures import Headers
    from app.api.v1 import agent as _agent_api
    from app.api.v1.agent import upload_attachment

    async def _must_not_materialize(*a, **k):
        raise AssertionError("超限大音频不应走 stage() 整包字节路径")

    monkeypatch.setattr(_agent_api, "_AUDIO_MATERIALIZE_CAP", 8)
    monkeypatch.setattr(chat_attach, "stage", _must_not_materialize)
    body = b"aac-audio-bytes" * 4
    upload = UploadFile(file=io.BytesIO(body), filename="big.aac",
                        headers=Headers({"content-type": "audio/aac"}))
    meta = await upload_attachment(file=upload, voice=False, current_user=user_a)
    assert meta["ext"] == "aac"          # 未转码，保留原扩展名
    row = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"])
    )).scalars().one()
    assert await storage.get(row.storage_key) == body


@pytest.mark.asyncio
async def test_small_webm_still_transcodes_under_cap(db, user_a, storage, monkeypatch):
    """上限内的小 webm 录音行为不变：转码成 mp3 再暂存。"""
    import io
    from fastapi import UploadFile
    from starlette.datastructures import Headers
    from app.api.v1 import agent as _agent_api
    from app.api.v1.agent import upload_attachment

    monkeypatch.setattr(_agent_api, "_AUDIO_MATERIALIZE_CAP", 1024 * 1024)
    monkeypatch.setattr("app.core.media_transcode.to_provider_audio", lambda *a, **k: b"converted-mp3")
    upload = UploadFile(file=io.BytesIO(b"webm-recording"), filename="rec.webm",
                        headers=Headers({"content-type": "audio/webm"}))
    meta = await upload_attachment(file=upload, voice=False, current_user=user_a)
    assert meta["ext"] == "mp3"
    row = (await db.execute(
        select(ChatAttachment).where(ChatAttachment.attach_id == meta["attach_id"])
    )).scalars().one()
    assert await storage.get(row.storage_key) == b"converted-mp3"


# ── 消费侧硬门：resolve_for_message 按 meta["size"] 在 read_bytes 之前拒绝 ───

@pytest.mark.asyncio
async def test_resolve_oversized_audio_gates_before_read(db, user_a, storage, monkeypatch):
    """400MB 的 mp3 在发送消息时也不得先整包读进内存再拒绝。"""
    meta = await chat_attach.stage(user_a.id, "大音频", "mp3", "audio/mpeg", b"mp3-bytes")

    async def _big_meta(_user_id, _aid):
        return dict(meta, size=100 * 1024 * 1024)

    async def _must_not_read(m):
        raise AssertionError("超限音频必须在 read_bytes 之前被 size 门拦下")

    monkeypatch.setattr(chat_attach, "get_meta", _big_meta)
    monkeypatch.setattr(chat_attach, "read_bytes", _must_not_read)
    monkeypatch.setattr(chat_attach, "_vision_enabled", lambda *a, **k: False)
    monkeypatch.setattr(chat_attach, "_video_enabled", lambda *a, **k: False)
    monkeypatch.setattr(chat_attach, "_audio_enabled", lambda *a, **k: True)
    monkeypatch.setattr(chat_attach, "_voice_recognition_enabled", lambda *a, **k: False)

    parts, _cards, _images, media = await chat_attach.resolve_for_message(
        user_a.id, [meta["attach_id"]], "你好")
    assert "太大" in parts
    assert media == []


@pytest.mark.asyncio
async def test_resolve_oversized_image_gates_before_read(db, user_a, storage, monkeypatch):
    """假 PNG 声明成几百 MB 时，vision 分支同样读前拒绝。"""
    meta = await chat_attach.stage(user_a.id, "假大图", "png", "image/png", b"png-bytes")

    async def _big_meta(_user_id, _aid):
        return dict(meta, size=100 * 1024 * 1024)

    async def _must_not_read(m):
        raise AssertionError("超限图片必须在 read_bytes 之前被 size 门拦下")

    monkeypatch.setattr(chat_attach, "get_meta", _big_meta)
    monkeypatch.setattr(chat_attach, "read_bytes", _must_not_read)
    monkeypatch.setattr(chat_attach, "_vision_enabled", lambda *a, **k: True)
    monkeypatch.setattr(chat_attach, "_video_enabled", lambda *a, **k: False)
    monkeypatch.setattr(chat_attach, "_audio_enabled", lambda *a, **k: False)
    monkeypatch.setattr(chat_attach, "_voice_recognition_enabled", lambda *a, **k: False)

    parts, _cards, images, media = await chat_attach.resolve_for_message(
        user_a.id, [meta["attach_id"]], "你好")
    assert images == [] and media == []
    assert "没法直接看" in parts
