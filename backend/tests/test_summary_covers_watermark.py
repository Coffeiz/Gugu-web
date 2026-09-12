"""summary 行 covers_until_id 压缩水位回归测试。

断点2竞态：finalize 先提交 turns、压缩事务稍后才写 summary 行并推进
session.baseline。下一次装配若夹在两次提交之间，会读到「新摘要 + 旧
baseline」，把摘要已覆盖的原文重复拼进上下文（跨 run 前缀断裂 + 内容重复）。
修复：水位与摘要行同事务落库（covers_until_id），装载取
max(loader_baseline, summary.covers) 作有效水位。
"""
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from agent.context.session_history import consume_history_stats, load_session_history
from app.models import ConversationMessage, ConversationSession


class _FakeLock:
    async def acquire(self, blocking=False, blocking_timeout=None):
        return True

    async def release(self):
        return None


class _FakeRedis:
    def lock(self, *args, **kwargs):
        return _FakeLock()


async def _seed(db, user, *, message_count=5):
    session = ConversationSession(user_id=user.id, title="水位竞态", source="web")
    db.add(session)
    await db.flush()
    ids = []
    for index in range(message_count):
        row = ConversationMessage(
            session_id=session.id,
            role="user" if index % 2 == 0 else "assistant",
            content=f"历史消息{index}：" + "细节" * 6000,
        )
        db.add(row)
        await db.flush()
        ids.append(row.id)
    await db.commit()
    return session, ids


@pytest.mark.asyncio
async def test_compress_writes_covers_until_id_with_summary(db, user_a, monkeypatch):
    """压缩事务必须把水位写进 summary 行，与 baseline CAS 同一事务。"""
    from agent.context import compress_conv

    session, ids = await _seed(db, user_a)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: _FakeRedis())
    monkeypatch.setattr(
        "agent.context.compaction._generate_append_summary", lambda *a, **k: "不应调用")
    monkeypatch.setattr(compress_conv, "_RECENT_HISTORY_KEEP_CHARS", 15_000)

    ok = await compress_conv.compress_if_needed(
        session.id, user_a.id,
        SimpleNamespace(ai=SimpleNamespace(context_tokens=120_000, max_tokens=8_000)),
        reuse_summary="复用的 run 内摘要正文",
        reuse_before_message_id=ids[-1],
    )

    assert ok is True
    await db.refresh(session)
    summaries = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.session_id == session.id,
            ConversationMessage.role == "summary",
        ))).scalars().all()
    assert len(summaries) == 1
    assert summaries[0].covers_until_id == session.baseline_message_id == ids[2]


@pytest.mark.asyncio
async def test_loader_prefers_summary_covers_over_stale_baseline(db, user_a):
    """竞态主场景：loader 拿到旧 baseline，但新摘要已覆盖到更远 → 以 covers 过滤。"""
    session, ids = await _seed(db, user_a)
    db.add(ConversationMessage(
        session_id=session.id, role="summary",
        content="新摘要", covers_until_id=ids[3],
    ))
    # 模拟 compress 只推进了一半：session.baseline 仍停在旧水位。
    session.baseline_message_id = ids[1]
    await db.commit()

    result = await load_session_history(db, session.id, baseline_message_id=ids[1])
    stats = consume_history_stats()

    non_summary = [m for m in result if m.role != "summary"]
    # ids[2]、ids[3] 已被摘要覆盖，绝不能重复出现。
    assert [m.id for m in non_summary] == [ids[4]]
    assert result[0].role == "summary"
    assert stats["history_effective_baseline_id"] == ids[3]
    assert stats["history_summary_covers_until_id"] == ids[3]


@pytest.mark.asyncio
async def test_loader_legacy_summary_without_covers_falls_back_to_baseline(db, user_a):
    """迁移前的旧摘要行没有水位 → 行为与现状一致，退回传入 baseline。"""
    session, ids = await _seed(db, user_a)
    db.add(ConversationMessage(
        session_id=session.id, role="summary", content="旧摘要",
    ))
    await db.commit()

    result = await load_session_history(db, session.id, baseline_message_id=ids[1])
    stats = consume_history_stats()

    non_summary = [m for m in result if m.role != "summary"]
    assert [m.id for m in non_summary] == [ids[2], ids[3], ids[4]]
    assert stats["history_effective_baseline_id"] == ids[1]
    assert stats["history_summary_covers_until_id"] is None


@pytest.mark.asyncio
async def test_loader_baseline_still_ceilings_when_covers_is_older(db, user_a):
    """baseline 更新（如 trim/重压缩）越过旧 covers 时以 baseline 为准。"""
    session, ids = await _seed(db, user_a)
    db.add(ConversationMessage(
        session_id=session.id, role="summary",
        content="旧摘要", covers_until_id=ids[1],
    ))
    await db.commit()

    result = await load_session_history(db, session.id, baseline_message_id=ids[3])
    stats = consume_history_stats()

    non_summary = [m for m in result if m.role != "summary"]
    assert [m.id for m in non_summary] == [ids[4]]
    assert stats["history_effective_baseline_id"] == ids[3]
