"""baseline 复用 run 内压缩摘要的回归测试。

run 收尾的 baseline 更新不再用摊平文本重放一遍历史（那条路结构上不可能与
主对话共享前缀，每次都是全冷的大输入调用），而是复用 run 内压缩刚生成的
摘要并只重算水位；可压缩范围必须限制在本轮用户消息之前——run 内压缩把本轮
消息整体保护、不写进摘要，水位若推进到它们之上会丢上下文。
"""
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models import ConversationMessage, ConversationSession


class _FakeLock:
    async def acquire(self, blocking=False, blocking_timeout=None):
        return True

    async def release(self):
        return None


class _FakeRedis:
    def lock(self, *args, **kwargs):
        return _FakeLock()


@pytest.mark.asyncio
async def test_compress_if_needed_reuses_run_summary_without_llm(db, user_a, monkeypatch):
    """复用路径不得再调用摘要 LLM，水位停在保留窗口边界且不越过本轮消息。"""
    from agent.context import compress_conv

    session = ConversationSession(user_id=user_a.id, title="复用摘要", source="web")
    db.add(session)
    await db.flush()
    pre_ids = []
    for index in range(4):
        row = ConversationMessage(
            session_id=session.id,
            role="user" if index % 2 == 0 else "assistant",
            content=f"历史消息{index}：" + "细节" * 6000,   # 每条约 1.2 万字符
        )
        db.add(row)
        await db.flush()
        pre_ids.append(row.id)
    current_row = ConversationMessage(session_id=session.id, role="user", content="本轮消息")
    db.add(current_row)
    await db.commit()

    llm_calls = []

    async def no_llm(*args, **kwargs):
        llm_calls.append(1)
        return "不应调用"

    monkeypatch.setattr("app.core.redis.get_redis", lambda: _FakeRedis())
    monkeypatch.setattr("agent.context.compaction._generate_append_summary", no_llm)
    monkeypatch.setattr(compress_conv, "_RECENT_HISTORY_KEEP_CHARS", 15_000)

    ok = await compress_conv.compress_if_needed(
        session.id, user_a.id,
        SimpleNamespace(ai=SimpleNamespace(context_tokens=120_000, max_tokens=8_000)),
        reuse_summary="复用的 run 内摘要正文",
        reuse_before_message_id=current_row.id,
    )

    assert ok is True
    assert llm_calls == []
    await db.refresh(session)
    # 保留窗口 1.5 万字符：最新 1 条（1.2 万字符）保留，前 3 条进入摘要，
    # 水位停在它们的最后一条上，绝不越过本轮用户消息。
    assert session.baseline_message_id == pre_ids[2]
    assert session.baseline_message_id < current_row.id
    summaries = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.session_id == session.id,
            ConversationMessage.role == "summary",
        ))).scalars().all()
    assert [s.content for s in summaries] == ["复用的 run 内摘要正文"]


@pytest.mark.asyncio
async def test_compress_if_needed_reuse_replaces_previous_summary_and_advances(db, user_a, monkeypatch):
    """已有 baseline 与旧摘要时，复用只覆盖水位之后的历史并覆盖式替换摘要行。"""
    from agent.context import compress_conv

    session = ConversationSession(user_id=user_a.id, title="滚动复用", source="web")
    db.add(session)
    await db.flush()
    ids = []
    for index in range(6):
        row = ConversationMessage(
            session_id=session.id,
            role="user" if index % 2 == 0 else "assistant",
            content=f"历史消息{index}：" + "细节" * 6000,
        )
        db.add(row)
        await db.flush()
        ids.append(row.id)
    # 本轮消息比保留窗口还大：没有 id 过滤时水位会直接越过它并把它压进摘要。
    current_row = ConversationMessage(
        session_id=session.id, role="user", content="本轮消息" + "正文" * 10_000,
    )
    db.add(current_row)
    db.add(ConversationMessage(session_id=session.id, role="summary", content="旧摘要"))
    await db.flush()
    session.baseline_message_id = ids[1]
    await db.commit()

    monkeypatch.setattr("app.core.redis.get_redis", lambda: _FakeRedis())
    monkeypatch.setattr(
        "agent.context.compaction._generate_append_summary", lambda *a, **k: "不应调用")
    monkeypatch.setattr(compress_conv, "_RECENT_HISTORY_KEEP_CHARS", 15_000)

    ok = await compress_conv.compress_if_needed(
        session.id, user_a.id,
        SimpleNamespace(ai=SimpleNamespace(context_tokens=120_000, max_tokens=8_000)),
        reuse_summary="复用的 run 内摘要正文",
        reuse_before_message_id=current_row.id,
    )

    assert ok is True
    await db.refresh(session)
    # 压缩只从旧水位之后开始：新水位必须晚于它，且不越过本轮用户消息。
    assert ids[1] < session.baseline_message_id < current_row.id
    summaries = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.session_id == session.id,
            ConversationMessage.role == "summary",
        ))).scalars().all()
    assert [s.content for s in summaries] == ["复用的 run 内摘要正文"]


@pytest.mark.asyncio
async def test_compress_if_needed_reuse_without_compressible_history_is_noop(db, user_a, monkeypatch):
    """水位之后没有可压缩历史时不得写摘要，也不得调用 LLM。"""
    from agent.context import compress_conv

    session = ConversationSession(user_id=user_a.id, title="无可压缩", source="web")
    db.add(session)
    await db.flush()
    current_row = ConversationMessage(session_id=session.id, role="user", content="只有本轮")
    db.add(current_row)
    await db.commit()

    llm_calls = []

    async def no_llm(*args, **kwargs):
        llm_calls.append(1)
        return "不应调用"

    monkeypatch.setattr("app.core.redis.get_redis", lambda: _FakeRedis())
    monkeypatch.setattr("agent.context.compaction._generate_append_summary", no_llm)

    ok = await compress_conv.compress_if_needed(
        session.id, user_a.id, SimpleNamespace(),
        reuse_summary="复用的摘要",
        reuse_before_message_id=current_row.id,
    )

    assert ok is False
    assert llm_calls == []
    await db.refresh(session)
    assert int(session.baseline_message_id or 0) == 0


@pytest.mark.asyncio
async def test_compress_if_needed_force_replays_history_through_append_summary(db, user_a, monkeypatch):
    """/compact（force、无 run 摘要可复用）从 DB 行重建角色序列走追加式摘要。"""
    from agent.context import compress_conv

    session = ConversationSession(user_id=user_a.id, title="手动压缩", source="web")
    db.add(session)
    await db.flush()
    for index in range(3):
        db.add(ConversationMessage(
            session_id=session.id,
            role="user" if index % 2 == 0 else "assistant",
            content=f"历史消息{index}：" + "细节" * 6000,
        ))
    await db.commit()

    captured: dict = {}

    async def fake_summary(history, previous, *, model_cfg):
        captured["history"] = [dict(m) for m in history]
        captured["previous"] = previous
        return "追加式生成的摘要"

    monkeypatch.setattr("app.core.redis.get_redis", lambda: _FakeRedis())
    monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
    monkeypatch.setattr(compress_conv, "_RECENT_HISTORY_KEEP_CHARS", 15_000)

    ok = await compress_conv.compress_if_needed(
        session.id, user_a.id,
        SimpleNamespace(ai=SimpleNamespace(context_tokens=120_000, max_tokens=8_000)),
        force=True,
    )

    assert ok is True
    # 保留窗口（1.5 万字符）之外的历史按角色重建进追加式请求：
    # 最新 1 条保留，前 2 条以 user/assistant 序列进入摘要请求。
    roles = [m["role"] for m in captured["history"]]
    assert roles == ["user", "assistant"]
    assert captured["history"][0]["content"].startswith("历史消息0")
    assert captured["history"][1]["content"].startswith("历史消息1")
    assert captured["previous"] is None
    await db.refresh(session)
    assert int(session.baseline_message_id or 0) > 0
    summaries = (await db.execute(
        select(ConversationMessage).where(
            ConversationMessage.session_id == session.id,
            ConversationMessage.role == "summary",
        ))).scalars().all()
    assert [s.content for s in summaries] == ["追加式生成的摘要"]
