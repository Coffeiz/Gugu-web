"""统一 run 收尾契约的回归测试。"""
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent.context import run_finalize
from agent.context.assembly import PromptMessages, assemble_turn
from agent.context.canonical_tool_history import persistable_canonical_batch_records
from app.models import ConversationBatch, ConversationMessage, ConversationSession


class _Db:
    def __init__(self):
        self.items = []

    def add(self, item):
        self.items.append(item)

    async def commit(self):
        return None


class _DbContext:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        return self.db

    async def __aexit__(self, *exc):
        return False


@pytest.mark.asyncio
async def test_insert_or_get_batch_reuses_existing_unique_row(db, user_a):
    """canonical batch 重复收尾必须复用已有行，不得把唯一键冲突抛到 IM 出口。"""
    from agent.context.run_finalize import _insert_or_get_batch
    from app.models import ConversationBatch, ConversationSession
    from sqlalchemy import select

    session = ConversationSession(user_id=user_a.id)
    db.add(session)
    await db.commit()
    await db.refresh(session)

    values = {
        "session_id": session.id,
        "version": "v1",
        "run_id": None,
        "round_id": None,
        "digest": "runtime-batch-digest",
    }
    first, first_created = await _insert_or_get_batch(db, ConversationBatch, values)
    await db.commit()
    second, second_created = await _insert_or_get_batch(db, ConversationBatch, values)

    assert first_created is True
    assert second_created is False
    assert second.id == first.id
    rows = (await db.execute(
        select(ConversationBatch).where(ConversationBatch.session_id == session.id)
    )).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_finalize_run_uses_one_canonical_persistence_contract(monkeypatch):
    db = _Db()
    trim_calls = []

    async def cap_usage(*args):
        return 12, 3

    async def trim(session_id):
        trim_calls.append(session_id)

    monkeypatch.setattr("agent.quota.cap_usage", cap_usage)
    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", trim)
    monkeypatch.setattr("agent.context.compress_conv.schedule_baseline_update", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "agent.context.assembly.newly_appended",
        lambda messages, initial_len: messages[initial_len:],
    )
    monkeypatch.setattr(
        "agent.context.history.canonicalize_tool_messages",
        lambda messages: [{"role": "assistant", "content": [{"type": "text", "text": "tool"}]}],
    )

    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(model="test-model", provider="test", context_tokens=80000)
    result = await run_finalize.finalize_run(
        session_factory=lambda: _DbContext(db),
        session_id=7,
        user_id="user-test",
        settings=settings,
        model_cfg=model,
        rag_context={"blocks": [{"type": "text", "text": "rag"}]},
        messages=[{"role": "assistant", "content": "new"}],
        initial_len=0,
        text="reply",
        files=[],
        tokens_in=100,
        tokens_out=20,
        cache_read=4,
        cache_write=5,
        tools_used=["test_tool"],
    )

    assert result.tokens_in == 12
    assert result.tokens_out == 3
    assert len(db.items) == 4  # RAG、tool turn、assistant、usage
    assert trim_calls == [7]


@pytest.mark.asyncio
async def test_finalize_run_records_byok_usage_without_platform_capping(monkeypatch):
    db = _Db()

    async def cap_usage(*args):
        return 100, 20

    monkeypatch.setattr("agent.quota.cap_usage", cap_usage)
    async def trim(_):
        return None

    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", trim)
    monkeypatch.setattr("agent.context.compress_conv.schedule_baseline_update", lambda *args, **kwargs: None)

    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(model="user-model", provider="user-provider", is_byok=True, context_tokens=80000)
    result = await run_finalize.finalize_run(
        session_factory=lambda: _DbContext(db),
        session_id=7,
        user_id="user-test",
        settings=settings,
        model_cfg=model,
        rag_context=None,
        messages=[],
        initial_len=0,
        text="reply",
        files=[],
        tokens_in=100,
        tokens_out=20,
    )

    assert result.tokens_in == 100
    assert result.tokens_out == 20
    usage = next(item for item in db.items if item.__class__.__name__ == "AgentUsage")
    assert usage.is_byok is True
    assert usage.tokens_in == 100
    assert usage.tokens_out == 20


@pytest.mark.asyncio
async def test_finalize_run_keeps_byok_flag_from_real_pydantic_model(monkeypatch):
    """回归：resolve_run_config_for_user 注入的 is_byok 在真实 pydantic 模型上不能丢。

    历史 bug：ModelRunConfig.is_byok 挂在 run_config 上，finalize 拿到的是内层模型
    对象，getattr 永远取 False → BYOK 用量全部记成平台用量（前端今日 token 恒为 0）。
    """
    from app.core.config import AIPresetItem

    db = _Db()

    async def cap_usage(*args):
        return 50, 10

    monkeypatch.setattr("agent.quota.cap_usage", cap_usage)
    async def _trim(_):
        return None

    monkeypatch.setattr(
        "app.services.conversation_retention.trim_session_messages", _trim)
    monkeypatch.setattr(
        "agent.context.compress_conv.schedule_baseline_update", lambda *args, **kwargs: None)
    # 模拟 resolve_run_config_for_user：model_copy(update=...) 注入 is_byok（llm_select.py）
    base = AIPresetItem(model="MiniMax-M3", provider="minimax", context_tokens=80000)
    model = base.model_copy(update={"api_key": "sk-test", "is_byok": True})
    assert model.is_byok is True

    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    await run_finalize.finalize_run(
        session_factory=lambda: _DbContext(db),
        session_id=7,
        user_id="user-test",
        settings=settings,
        model_cfg=model,
        rag_context=None,
        messages=[],
        initial_len=0,
        text="reply",
        files=[],
        tokens_in=50,
        tokens_out=10,
    )

    usage = next(item for item in db.items if item.__class__.__name__ == "AgentUsage")
    assert usage.is_byok is True

    # is_byok 是内部字段：不能泄漏进配置序列化
    assert "is_byok" not in base.model_dump()


@pytest.mark.asyncio
async def test_finalize_run_deduplicates_runtime_context_across_runs(db, user_a, monkeypatch):
    """相同首轮 runtime-context 在连续 run 中只能落一个 canonical batch。"""
    session = ConversationSession(user_id=user_a.id, title="runtime 去重", source="web")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    turn, _ = assemble_turn(
        current_user={"role": "user", "content": "测试"},
        extra_reminder="## 当前工作区\nworkspace=project",
    )
    prompt = PromptMessages()
    prompt.append_batch(turn)
    canonical_batches = persistable_canonical_batch_records(prompt)

    async def fake_record_usage(*args, **kwargs):
        from agent.usage import UsageResult

        return UsageResult()

    monkeypatch.setattr("agent.usage.record_usage", fake_record_usage)
    monkeypatch.setattr(
        "app.services.conversation_retention.trim_session_messages",
        lambda *_args, **_kwargs: _async_none(),
    )
    monkeypatch.setattr(
        "agent.context.compress_conv.schedule_baseline_update",
        lambda *_args, **_kwargs: None,
    )

    import app.db.session as db_session

    session_factory = async_sessionmaker(
        db_session._engine, class_=AsyncSession, expire_on_commit=False,
    )
    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(model="test-model", provider="test", context_tokens=80000)
    for _ in range(2):
        await run_finalize.finalize_run(
            session_factory=session_factory,
            session_id=session.id,
            user_id=str(user_a.id),
            settings=settings,
            model_cfg=model,
            rag_context=None,
            messages=[],
            initial_len=0,
            text="",
            files=[],
            tokens_in=0,
            tokens_out=0,
            canonical_batches=canonical_batches,
        )

    async with session_factory() as check_db:
        batches = (await check_db.scalars(select(ConversationBatch).where(
            ConversationBatch.session_id == session.id,
        ))).all()
        messages = (await check_db.scalars(select(ConversationMessage).where(
            ConversationMessage.session_id == session.id,
        ))).all()
    assert len(batches) == 1
    assert len(messages) == 1
    assert messages[0].canonical_batch_id == batches[0].id


async def _async_none():
    return None
