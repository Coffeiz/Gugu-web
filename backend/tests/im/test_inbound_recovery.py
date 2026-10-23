"""Worker 崩溃重领不重跑副作用，已展示轮次可从数据库恢复。"""
import asyncio
import json
from types import SimpleNamespace

import fakeredis.aioredis
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent.im.inbound_recovery import receipt_key, recover_started, register_batch, user_run_key
from agent.context.display_checkpoint import display_run_key, save_checkpoint
from agent.run.execution import CollectSink, RunOutcome, consume_agent_events
from app.models import ConversationMessage, ConversationSession


async def prepare_receipt(db, user):
    session = ConversationSession(user_id=user.id, title="合成重启恢复")
    db.add(session)
    await db.flush()
    row = ConversationMessage(session_id=session.id, role="user", content="整理合成视频",
                              run_id=user_run_key("synthetic-batch"))
    db.add(row)
    await db.commit()
    return session, row, async_sessionmaker(db.bind, expire_on_commit=False)


@pytest.mark.asyncio
async def test_reclaimed_started_message_is_acknowledged_without_dispatch(db, user_a, monkeypatch):
    """原消息租约丢失后重领，不和后来发送的“继续”合并或再调模型。"""
    import worker
    import app.db.session as db_session

    session, user, factory = await prepare_receipt(db, user_a)
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    await redis.set(receipt_key("synthetic-original"), "synthetic-batch")
    acks = []

    async def ack(_stream, _group, mid):
        acks.append(mid)

    monkeypatch.setattr(worker.R, "get_redis", lambda: redis)
    monkeypatch.setattr(worker.R, "ack", ack)
    monkeypatch.setattr(db_session, "ensure_engine", lambda: None)
    monkeypatch.setattr(db_session, "_SessionLocal", factory)
    monkeypatch.setattr(worker, "handle", lambda *_: pytest.fail("不应再次执行已开始的任务"))
    try:
        await worker._dispatch("synthetic-original", {"text": "整理合成视频"})
        assert acks == ["synthetic-original"]
        async with factory() as loaded:
            rows = (await loaded.scalars(select(ConversationMessage))).all()
            assert len(rows) == 1
            assert rows[0].content == "整理合成视频"
            assert rows[0].run_outcome["status"] == "interrupted"
    finally:
        worker._stop_message_lease("synthetic-original")
        await redis.aclose()


@pytest.mark.asyncio
async def test_round_is_persisted_before_delivery_and_survives_new_execution(db, user_a):
    session, user, factory = await prepare_receipt(db, user_a)
    outcome = RunOutcome()

    async def checkpoint(items):
        await save_checkpoint(factory, session.id, items, user.id)

    async def delivered(text):
        # 出站回调已经能从独立 Session 查回正文；不是仅存在消费器内存里。
        async with factory() as loaded:
            row = (await loaded.scalars(select(ConversationMessage).where(
                ConversationMessage.run_id == display_run_key(user.id)))).one()
            assert row.display_timeline[0]["text"] == text
            assert row.content_json == []

    async def source():
        for event in [
            {"type": "token", "content": "两段视频已下载，开始读取。"},
            {"type": "_new_round"},
            {"type": "tool_call", "name": "read_file", "tool_call_id": "synthetic-call"},
        ]:
            yield "data: " + json.dumps(event)
        raise RuntimeError("合成进程退出")

    with pytest.raises(RuntimeError, match="合成进程退出"):
        async for _ in consume_agent_events(source(), model_cfg=None, outcome=outcome,
                sink=CollectSink(on_round=delivered, on_checkpoint=checkpoint)):
            pass
    assert await recover_started(factory, "synthetic-batch") is True
    assert await recover_started(factory, "synthetic-batch") is True
    async with factory() as loaded:
        rows = (await loaded.scalars(select(ConversationMessage).where(
            ConversationMessage.role == "assistant"))).all()
        assert len(rows) == 1
        assert rows[0].display_timeline[0]["text"] == "两段视频已下载，开始读取。"
        assert rows[0].display_timeline[1]["toolStatus"] == "stopped"


@pytest.mark.asyncio
async def test_batch_receipts_keep_all_source_ids_and_unstarted_can_retry(db):
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    key = await register_batch(redis, ["synthetic-a", "synthetic-b"])
    assert await redis.get(receipt_key("synthetic-a")) == key
    assert await redis.get(receipt_key("synthetic-b")) == key
    assert await recover_started(async_sessionmaker(db.bind), key) is False
    await redis.aclose()


@pytest.mark.asyncio
async def test_lost_lease_does_not_silently_keep_renewing(monkeypatch, capsys):
    """续期没有所有权时终止心跳并留诊断，不能假装成功或抢占新所有者。"""
    import worker

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(worker.R, "get_redis", lambda: redis)
    monkeypatch.setattr(worker, "_MESSAGE_LEASE_HEARTBEAT_SECONDS", 0)
    await redis.set(worker._message_state_key("synthetic-lost"), "new-owner")
    try:
        await asyncio.wait_for(worker._renew_message_lease("synthetic-lost", "old-owner"), timeout=1)
        assert await redis.get(worker._message_state_key("synthetic-lost")) == "new-owner"
        assert "已失去所有权" in capsys.readouterr().out
    finally:
        await redis.aclose()


@pytest.mark.asyncio
async def test_completed_run_reuses_checkpoint_and_ack_recovery_keeps_success(db, user_a, monkeypatch):
    """收尾更新同一展示行；提交后 ACK 前重启，不重复回复也不误报中断。"""
    from agent.context.assembly import MessageArea
    from agent.context.run_finalize import finalize_run
    from agent.usage import UsageResult

    session, user, factory = await prepare_receipt(db, user_a)
    items = [{"kind": "assistant", "text": "正在读取合成视频。"}]
    from agent.context.display_timeline import stamp_display_item
    stamp_display_item(items[0], sequence=1, user_message_id=user.id)
    await save_checkpoint(factory, session.id, items, user.id)
    async with factory() as loaded:
        checkpoint_id = (await loaded.scalars(select(ConversationMessage).where(
            ConversationMessage.role == "assistant"))).one().id

    async def usage(*args, **kwargs):
        return UsageResult(tokens_in=3, tokens_out=2)

    async def trim(*args):
        pass

    monkeypatch.setattr("agent.usage.record_usage", usage)
    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", trim)
    final_item = stamp_display_item({"kind": "assistant", "text": "合成最终回复"}, sequence=2, user_message_id=user.id)
    await finalize_run(session_factory=factory, session_id=session.id, user_id=user_a.id,
        settings=SimpleNamespace(), model_cfg=SimpleNamespace(model="synthetic", provider="synthetic"),
        message_area=MessageArea(), user_message_id=user.id, inbound_batch_key="synthetic-batch",
        text="合成最终回复", display_timeline=items + [final_item],
        files=[], tokens_in=3, tokens_out=2)
    assert await recover_started(factory, "synthetic-batch") is True
    async with factory() as loaded:
        rows = (await loaded.scalars(select(ConversationMessage).where(
            ConversationMessage.role == "assistant"))).all()
        assert len(rows) == 1
        assert rows[0].id == checkpoint_id
        assert rows[0].content == "合成最终回复"
        assert rows[0].content_json is None
        assert [x["text"] for x in rows[0].display_timeline] == ["正在读取合成视频。", "合成最终回复"]
        stored_user = await loaded.get(ConversationMessage, user.id)
        assert stored_user.run_outcome is None

    # 完成提交后原租约消失，PEL 再次分发同一来源：不能生成第二轮回复。
    import worker
    import app.db.session as db_session

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    await redis.set(receipt_key("synthetic-completed"), "synthetic-batch")
    acks = []

    async def ack(_stream, _group, mid):
        acks.append(mid)

    monkeypatch.setattr(worker.R, "get_redis", lambda: redis)
    monkeypatch.setattr(worker.R, "ack", ack)
    monkeypatch.setattr(db_session, "ensure_engine", lambda: None)
    monkeypatch.setattr(db_session, "_SessionLocal", factory)
    monkeypatch.setattr(worker, "handle", lambda *_: pytest.fail("完成后重领不得再次生成"))
    try:
        await worker._dispatch("synthetic-completed", {"text": "整理合成视频"})
        assert acks == ["synthetic-completed"]
        async with factory() as loaded:
            assert len((await loaded.scalars(select(ConversationMessage))).all()) == 2
            assert (await loaded.get(ConversationMessage, user.id)).run_outcome is None
    finally:
        worker._stop_message_lease("synthetic-completed")
        await redis.aclose()


@pytest.mark.asyncio
async def test_shutdown_does_not_ack_incomplete_batch(monkeypatch):
    """Worker 优雅停止不能把正在执行的请求当作已完成确认。"""
    import worker
    from agent.im.session import ImConversationKey

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    key = ImConversationKey("qq", "synthetic-bot", "c2c", "synthetic-user")
    entered = asyncio.Event()
    acks = []

    async def handle(*_args):
        entered.set()
        await asyncio.Future()

    async def ack(*args):
        acks.append(args)

    monkeypatch.setattr(worker.R, "get_redis", lambda: redis)
    monkeypatch.setattr(worker, "handle", handle)
    monkeypatch.setattr(worker, "_ack_inbound", ack)
    monkeypatch.setattr(worker, "_user_buffers", {key: [("synthetic-source", {"text": "合成操作"})]})
    monkeypatch.setattr(worker, "_user_deadline", {})
    monkeypatch.setattr(worker, "_user_flush", {})
    monkeypatch.setattr(worker, "_user_locks", {})
    monkeypatch.setattr(worker, "_run_active", 0)
    monkeypatch.setattr(worker, "_run_condition", asyncio.Condition())
    task = asyncio.create_task(worker._flush_loop(key))
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert acks == []
        assert await redis.get(receipt_key("synthetic-source"))
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await redis.aclose()
