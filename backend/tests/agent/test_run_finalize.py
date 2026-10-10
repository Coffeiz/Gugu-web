"""统一 run 收尾契约的回归测试。"""
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent.context import run_finalize
from agent.context.assembly import (
    MessageArea, MessageSource, MessageBatch, PersistencePolicy,
    assemble_turn,
)
from agent.context.canonical_tool_history import canonical_tool_round
from agent.context.history import build_history_parts
from agent.context.session_history import load_session_history
from app.models import ConversationBatch, ConversationMessage, ConversationSession


class _Db:
    def __init__(self):
        self.items = []

    def add(self, item):
        self.items.append(item)

    async def get(self, *args, **kwargs):
        return None

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
async def test_finalize_is_atomic_and_idempotent_including_reasoning_and_usage(db, user_a, monkeypatch):
    """提交失败不留下私有状态或回复；重试成功后重复收尾不重复记账。"""
    from agent.context.reasoning_runtime import ReasoningStateCoordinator
    from agent.context.reasoning_state import ReasoningPersistencePolicy
    from app.models import ProviderReasoningState
    from agent.usage import UsageResult

    monkeypatch.setattr("app.byok.crypto._master_key", lambda version=1: b"r" * 32)
    session = ConversationSession(user_id=user_a.id, title="合成原子收尾")
    db.add(session)
    await db.commit()
    normal_factory = async_sessionmaker(db.bind, expire_on_commit=False)

    class FailCommitSession(AsyncSession):
        async def commit(self):
            raise RuntimeError("合成提交失败")

    failed_factory = async_sessionmaker(db.bind, class_=FailCommitSession, expire_on_commit=False)
    model = SimpleNamespace(model="synthetic", provider="anthropic")
    coordinator = ReasoningStateCoordinator(
        user_id=user_a.id, session_id=session.id, model_cfg=model,
        policy=ReasoningPersistencePolicy("continuation"), session_factory=normal_factory,
    )
    coordinator.provider = "anthropic"
    coordinator.api_format = "anthropic"
    coordinator.config_digest = "synthetic-config"
    coordinator.reasoning_config_digest = "synthetic-reasoning"
    driver = SimpleNamespace(extract_provider_state=lambda result, ctx: {
        "state_kind": "anthropic_thinking_blocks", "payload": {"tail_blocks": []},
        "summary": {"state_block_count": 0},
    })
    await coordinator.round_finished(driver, None, None, "round-1")
    await coordinator.completed()
    assert (await db.scalars(select(ProviderReasoningState))).all() == []
    area = MessageArea()
    area.reasoning_state = coordinator
    calls = []

    async def usage(*args, **kwargs):
        calls.append(1)
        return UsageResult(tokens_in=3, tokens_out=2)

    monkeypatch.setattr("agent.usage.record_usage", usage)
    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages",
                        lambda *_args: _async_none())
    args = dict(session_id=session.id, user_id=user_a.id, settings=SimpleNamespace(),
                model_cfg=model, message_area=area, text="合成最终回复", files=[],
                tokens_in=3, tokens_out=2, run_id="synthetic-atomic-run")
    with pytest.raises(RuntimeError, match="合成提交失败"):
        await run_finalize.finalize_run(session_factory=failed_factory, **args)
    async with normal_factory() as check:
        assert (await check.scalars(select(ProviderReasoningState))).all() == []
        assert (await check.scalars(select(ConversationMessage))).all() == []
        assert (await check.scalars(select(ConversationBatch))).all() == []
    # 事务失败不推进 CAS 版本，同一 Run 可安全重试。
    assert coordinator.expected_version == 0
    await run_finalize.finalize_run(session_factory=normal_factory, **args)
    before_duplicate = len(calls)
    await run_finalize.finalize_run(session_factory=normal_factory, **args)
    assert len(calls) == before_duplicate
    async with normal_factory() as check:
        rows = (await check.scalars(select(ConversationMessage))).all()
        assert len(rows) == 1
        state = (await check.scalars(select(ProviderReasoningState))).one()
        assert state.source_run_id == "synthetic-atomic-run"


@pytest.mark.asyncio
async def test_finalize_run_requires_canonical_message_area():
    """收尾不能再从 provider wire 临时推导并补写 canonical history。"""
    with pytest.raises(ValueError, match="必须接收 MessageArea"):
        await run_finalize.finalize_run(
            session_factory=lambda: None,
            session_id=1,
            user_id="user-test",
            settings=SimpleNamespace(ai=SimpleNamespace(context_tokens=80000)),
            model_cfg=SimpleNamespace(model="test", provider="test"),
            message_area=None,
            text="reply",
            files=[],
            tokens_in=0,
            tokens_out=0,
        )


@pytest.mark.asyncio
async def test_message_area_delta_commit_is_ordered_and_idempotent(db, user_a):
    """Area delta 重复 finalize 不重复写入，且附属上下文仍排在已落库 user 前。"""
    session = ConversationSession(user_id=user_a.id, title="delta 测试")
    db.add(session)
    await db.commit()
    await db.refresh(session)
    sent_at = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
    user_message = ConversationMessage(
        session_id=session.id,
        role="user",
        content="当前问题",
        content_json=[{"type": "text", "text": "当前问题"}],
        sent_at=sent_at,
        created_at=sent_at,
    )
    db.add(user_message)
    await db.commit()
    await db.refresh(user_message)

    area = MessageArea()
    area.append(
        {"role": "user", "content": [{"type": "knowledge-context", "text": "RAG"}]},
        source=MessageSource.RAG,
        persistence_policy=PersistencePolicy.COMMIT_ON_SUCCESS,
    )
    area.append(
        {"role": "user", "content": "当前问题"},
        source=MessageSource.USER,
        persistence_policy=PersistencePolicy.ALREADY_PERSISTED,
        persisted_message_id=user_message.id,
    )
    area.append_batch(MessageBatch.from_canonical_messages([
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-delta", "name": "lookup", "arguments": "{}",
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-delta", "content": "完成",
        }]},
    ], metadata={"round_id": "round-1"}))
    delta = area.persistence_delta(outcome="success")
    assert delta.user_anchor_sequence == 1

    from agent.context.message_area_repository import commit_delta
    for _ in range(2):
        await commit_delta(
            db,
            session_id=session.id,
            delta=delta,
            run_id="run-delta-test",
            default_round_id="round-1",
            user_message=user_message,
            interrupted=False,
        )
        await db.commit()

    rows = (await db.scalars(select(ConversationMessage).where(
        ConversationMessage.session_id == session.id,
        ConversationMessage.id != user_message.id,
    ).order_by(ConversationMessage.created_at, ConversationMessage.id))).all()
    batches = (await db.scalars(select(ConversationBatch).where(
        ConversationBatch.session_id == session.id,
    ))).all()
    assert [row.content_json for row in rows[:1]] == [[
        {"type": "knowledge-context", "text": "RAG"},
    ]]
    assert [row.role for row in rows] == ["user", "assistant", "user"]
    assert rows[0].created_at < user_message.created_at
    assert len(batches) == 2


@pytest.mark.asyncio
async def test_twenty_isolated_tool_runs_keep_area_restore_and_provider_wire_aligned(db, user_a):
    """连续工具 run 每轮 reload 后，新 Area 投影必须与旧 history renderer 等价。"""
    from agent.context.context_diagnostics import first_diff_index
    from agent.context.assembly import MessageSource, PersistencePolicy
    from agent.context.history import render_canonical_area_snapshot
    from agent.context.message_area_repository import commit_delta, restore_entries
    from agent.context.assembly import MessageArea

    session = ConversationSession(user_id=user_a.id, title="合成连续工具 run")
    db.add(session)
    await db.commit()
    await db.refresh(session)
    observed = []
    expected_restored_wire = None

    for run_number in range(20):
        history = await load_session_history(db, session.id, max_messages=200)
        area = restore_entries(history)

        area.configure_request(fixed_prefix=(), render_options={
            "api_format": "openai", "user_tz": timezone.utc,
        })
        area_wire = area.provider_projection().to_messages()
        if expected_restored_wire is not None:
            assert first_diff_index(expected_restored_wire, area_wire) is None

        user_message = ConversationMessage(
            session_id=session.id,
            role="user",
            content=f"合成请求 {run_number}",
        )
        db.add(user_message)
        await db.commit()
        await db.refresh(user_message)
        area.append(
            {"role": "user", "content": user_message.content},
            source=MessageSource.USER,
            persistence_policy=PersistencePolicy.ALREADY_PERSISTED,
            persisted_message_id=user_message.id,
        )
        area.append_batch(MessageBatch.from_canonical_messages([
            {"role": "assistant", "content": [{
                "type": "tool_call", "id": f"synthetic-call-{run_number}",
                "name": "lookup", "arguments": {"sequence": run_number},
            }]},
            {"role": "user", "content": [{
                "type": "tool_result", "tool_call_id": f"synthetic-call-{run_number}",
                "content": f"结果 {run_number}",
            }]},
        ], metadata={"round_id": f"synthetic-round-{run_number}"}), source=MessageSource.TOOL_ROUND,
            persistence_policy=PersistencePolicy.COMMIT_ON_SUCCESS)
        area.append(
            {"role": "assistant", "content": f"完成 {run_number}"},
            source=MessageSource.AGENT_FOLLOWUP,
            persistence_policy=PersistencePolicy.COMMIT_ON_SUCCESS,
        )
        delta = area.persistence_delta(outcome="success")
        await commit_delta(
            db, session_id=session.id, delta=delta,
            run_id=f"synthetic-run-{run_number}",
            default_round_id=f"synthetic-round-{run_number}",
            user_message=user_message, interrupted=False,
        )
        await db.commit()
        observed.append((area.revision, area.digest(), delta.digest))
        expected_restored_area = restore_entries(
            await load_session_history(db, session.id, max_messages=200),
        )
        expected_restored_area.configure_request(fixed_prefix=(), render_options={
            "api_format": "openai", "user_tz": timezone.utc,
        })
        expected_restored_wire = expected_restored_area.provider_projection().to_messages()

    restored = restore_entries(await load_session_history(db, session.id, max_messages=200))
    assert len(observed) == 20
    assert len(restored.entries) == 20 * 4
    assert restored.entries[-1].canonical_message["content"] == "完成 19"


@pytest.mark.asyncio
async def test_finalize_run_uses_one_canonical_persistence_contract(monkeypatch):
    db = _Db()
    trim_calls = []
    baseline_calls = []
    committed_deltas = []

    async def cap_usage(*args):
        return 12, 3

    async def trim(session_id):
        trim_calls.append(session_id)

    async def persist_baseline(*args, **kwargs):
        baseline_calls.append((args, kwargs))
        return True

    async def commit_delta(_db, **kwargs):
        committed_deltas.append(kwargs["delta"])

    monkeypatch.setattr("agent.quota.cap_usage", cap_usage)
    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", trim)
    monkeypatch.setattr("agent.context.compress_conv.compress_if_needed", persist_baseline)
    monkeypatch.setattr("agent.context.message_area_repository.commit_delta", commit_delta)
    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(model="test-model", provider="test", context_tokens=80000)
    area = MessageArea()
    area.append(
        {"role": "user", "content": [{"type": "text", "text": "rag"}]},
        source=MessageSource.RAG,
        persistence_policy=PersistencePolicy.COMMIT_ON_SUCCESS,
    )
    area.append(
        {"role": "assistant", "content": [{"type": "text", "text": "tool"}]},
        source=MessageSource.TOOL_ROUND,
        persistence_policy=PersistencePolicy.COMMIT_ON_SUCCESS,
    )
    result = await run_finalize.finalize_run(
        session_factory=lambda: _DbContext(db),
        session_id=7,
        user_id="user-test",
        settings=settings,
        model_cfg=model,
        message_area=area,
        text="reply",
        display_timeline=[
            {"kind": "tool", "toolCallId": "call-1", "toolName": "project_details"},
            {"kind": "assistant", "text": "已查到项目详情"},
        ],
        files=[],
        tokens_in=100,
        tokens_out=20,
        cache_read=4,
        cache_write=5,
        tools_used=["test_tool"],
        compaction_applied=True,
        user_message_id=321,
    )

    assert result.tokens_in == 12
    assert result.tokens_out == 3
    assert len(db.items) == 2  # assistant 与 usage；canonical 消息只交给 Area repository
    assert len(committed_deltas) == 1
    assert [entry.canonical_message for entry in committed_deltas[0].entries] == [
        {"role": "user", "content": [{"type": "text", "text": "rag"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "tool"}]},
    ]
    assistant_row = next(
        item for item in db.items
        if isinstance(item, ConversationMessage) and item.role == "assistant" and item.display_timeline
    )
    assert [item["timelineOrder"] for item in assistant_row.display_timeline] == [321001, 321002]
    assert trim_calls == [7]
    assert baseline_calls == [(
        (7, "user-test", settings),
        {"force": False, "reuse_summary": None, "reuse_before_message_id": None},
    )]


@pytest.mark.asyncio
async def test_finalize_run_reuses_run_summary_for_baseline(monkeypatch):
    """run 内压缩的摘要要在 baseline 收尾时复用，不再触发摊平文本重放。"""
    from agent.context.summary_format import format_compacted_summary

    db = _Db()
    baseline_calls = []

    async def cap_usage(*args):
        return 0, 0

    async def trim(session_id):
        return None

    async def persist_baseline(*args, **kwargs):
        baseline_calls.append(kwargs)
        return True

    monkeypatch.setattr("agent.quota.cap_usage", cap_usage)
    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", trim)
    monkeypatch.setattr("agent.context.compress_conv.compress_if_needed", persist_baseline)
    wrapped = format_compacted_summary("run 内摘要正文")
    area = MessageArea.from_restored([
        {"role": "user", "content": wrapped},
        {"role": "assistant", "content": "new"},
    ])
    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(
        model="test-model", provider="test", context_tokens=80000, max_tokens=4000,
    )
    await run_finalize.finalize_run(
        session_factory=lambda: _DbContext(db),
        session_id=9,
        user_id="user-test",
        settings=settings,
        model_cfg=model,
        message_area=area,
        text="reply",
        files=[],
        tokens_in=10,
        tokens_out=2,
        compaction_applied=True,
        user_message_id=321,
    )

    assert baseline_calls == [{
        "force": False,
        "reuse_summary": "run 内摘要正文",
        "reuse_before_message_id": 321,
    }]


def _summary_model(**overrides):
    values = {"model": "test-model", "provider": "test", "context_tokens": 80000, "max_tokens": 4000}
    values.update(overrides)
    return SimpleNamespace(**values)


def test_run_summary_reuse_excludes_merged_current_user_block():
    """摘要与当前用户请求合并为文本块时，只复用摘要正文。"""
    from agent.context.run_finalize import _run_compaction_summary
    from agent.context.summary_format import format_compacted_summary

    messages = [{"role": "user", "content": [
        {"type": "text", "text": format_compacted_summary("已完成设计")},
        {"type": "text", "text": "现在开始开发"},
    ]}]
    assert _run_compaction_summary(messages, _summary_model(), 321) == "已完成设计"


def test_run_compaction_summary_requires_summary_shaped_candidate():
    """正文里恰好出现标记的用户消息不能被当成摘要复用。"""
    from agent.context.run_finalize import _run_compaction_summary
    from agent.context.summary_format import format_compacted_summary

    model = _summary_model()
    assert _run_compaction_summary(
        [{"role": "user", "content": "帮我看下 <compacted-summary> 是什么格式"}],
        model, 321,
    ) is None
    assert _run_compaction_summary(
        [{"role": "user", "content": format_compacted_summary("正文")}],
        model, 321,
    ) == "正文"
    # 多次压缩取最后一条（最新一版已把上一版滚动合并进去）。
    assert _run_compaction_summary(
        [
            {"role": "user", "content": format_compacted_summary("旧版")},
            {"role": "assistant", "content": "…"},
            {"role": "user", "content": format_compacted_summary("新版")},
        ],
        model, 321,
    ) == "新版"


def test_run_compaction_summary_falls_back_without_reusable_candidate():
    """缺少摘要、缺少本轮消息 id、或预算不可解析时都必须退回旧路径。"""
    from agent.context.run_finalize import _run_compaction_summary
    from agent.context.summary_format import format_compacted_summary

    wrapped = format_compacted_summary("正文")
    assert _run_compaction_summary([{"role": "user", "content": wrapped}], _summary_model(), None) is None
    assert _run_compaction_summary([{"role": "assistant", "content": "无摘要"}], _summary_model(), 321) is None
    assert _run_compaction_summary([{"role": "user", "content": wrapped}], SimpleNamespace(), 321) is None
    # 摘要超过输出预算时同样不复用，避免把超限文本写进持久 baseline。
    assert _run_compaction_summary(
        [{"role": "user", "content": format_compacted_summary("细节" * 5000)}],
        _summary_model(max_tokens=16), 321,
    ) is None


@pytest.mark.asyncio
async def test_finalize_run_records_byok_usage_without_platform_capping(monkeypatch):
    db = _Db()

    async def cap_usage(*args):
        return 100, 20

    monkeypatch.setattr("agent.quota.cap_usage", cap_usage)
    async def trim(_):
        return None

    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", trim)

    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(model="user-model", provider="user-provider", is_byok=True, context_tokens=80000)
    result = await run_finalize.finalize_run(
        session_factory=lambda: _DbContext(db),
        session_id=7,
        user_id="user-test",
        settings=settings,
        model_cfg=model,
        message_area=MessageArea(),
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
        message_area=MessageArea(),
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
async def test_finalize_run_never_persists_temporary_runtime_context(db, user_a, monkeypatch):
    """本轮环境提醒可发送，但连续收尾不能把过期环境说明写入数据库。"""
    session = ConversationSession(user_id=user_a.id, title="runtime 去重", source="web")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    turn, _ = assemble_turn(
        current_user={"role": "user", "content": "测试"},
        extra_reminder="## 当前工作区\nworkspace=project",
    )
    prompt = MessageArea.from_canonical_messages()
    prompt.append_batch(turn)

    async def fake_record_usage(*args, **kwargs):
        from agent.usage import UsageResult

        return UsageResult()

    monkeypatch.setattr("agent.usage.record_usage", fake_record_usage)
    monkeypatch.setattr(
        "app.services.conversation_retention.trim_session_messages",
        lambda *_args, **_kwargs: _async_none(),
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
            message_area=prompt,
            text="",
            files=[],
            tokens_in=0,
            tokens_out=0,
        )

    async with session_factory() as check_db:
        batches = (await check_db.scalars(select(ConversationBatch).where(
            ConversationBatch.session_id == session.id,
        ))).all()
        messages = (await check_db.scalars(select(ConversationMessage).where(
            ConversationMessage.session_id == session.id,
        ))).all()
    assert batches == []
    assert messages == []


@pytest.mark.asyncio
async def test_finalize_run_persists_provider_cache_anchor_in_session_metadata(
    db, user_a, monkeypatch,
):
    session = ConversationSession(
        user_id=user_a.id,
        title="缓存锚点测试",
        source="web",
        session_context={"stance_digest": "keep-this"},
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    async def fake_record_usage(*args, **kwargs):
        from agent.usage import UsageResult

        return UsageResult()

    async def no_trim(*_args, **_kwargs):
        return None

    monkeypatch.setattr("agent.usage.record_usage", fake_record_usage)
    monkeypatch.setattr("app.services.conversation_retention.trim_session_messages", no_trim)
    import app.db.session as db_session

    session_factory = async_sessionmaker(
        db_session._engine, class_=AsyncSession, expire_on_commit=False,
    )
    anchor = {
        "provider": "minimax",
        "api_format": "anthropic",
        "model": "MiniMax-M3.1-Flash-Preview",
        "strategy": "multi",
        "baseline_digest": "message-fingerprint",
    }
    area = MessageArea()
    area.remember_provider_cache_anchor(anchor)

    await run_finalize.finalize_run(
        session_factory=session_factory,
        session_id=session.id,
        user_id=str(user_a.id),
        settings=SimpleNamespace(ai=SimpleNamespace(context_tokens=80000)),
        model_cfg=SimpleNamespace(model="test-model", provider="test", context_tokens=80000),
        message_area=area,
        text="",
        files=[],
        tokens_in=0,
        tokens_out=0,
    )

    async with session_factory() as check_db:
        restored = await check_db.get(ConversationSession, session.id)
    assert restored.session_context["stance_digest"] == "keep-this"
    assert restored.session_context["provider_cache_anchor"] == anchor


@pytest.mark.asyncio
async def test_finalize_run_persists_rag_before_user_and_restores_provider_history(
    db, user_a, monkeypatch,
):
    """RAG 落库顺序必须让下一轮恢复与本轮 provider 投影完全一致。"""
    session = ConversationSession(user_id=user_a.id, title="RAG 顺序")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    sent_at = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)
    older_message = ConversationMessage(
        session_id=session.id,
        role="user",
        content="上一轮问题",
        content_json=[{"type": "text", "text": "上一轮问题"}],
        sent_at=sent_at - timedelta(days=1),
        created_at=sent_at - timedelta(days=1),
    )
    user_message = ConversationMessage(
        session_id=session.id,
        role="user",
        content="当前问题",
        content_json=[{"type": "text", "text": "当前问题"}],
        sent_at=sent_at,
        created_at=sent_at,
    )
    db.add_all([older_message, user_message])
    await db.commit()
    await db.refresh(older_message)
    await db.refresh(user_message)

    async def fake_record_usage(*args, **kwargs):
        from agent.usage import UsageResult

        return UsageResult()

    monkeypatch.setattr("agent.usage.record_usage", fake_record_usage)
    monkeypatch.setattr(
        "app.services.conversation_retention.trim_session_messages",
        lambda *_args, **_kwargs: _async_none(),
    )

    session_factory = async_sessionmaker(
        db.bind, class_=AsyncSession, expire_on_commit=False,
    )
    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(model="test-model", provider="test", context_tokens=80000)
    rag_block = {
        "type": "knowledge-context",
        "scope": "owner-rag",
        "text": "[owner-rag]\n参考资料\n[/owner-rag]",
    }
    from agent.context.message_area_repository import restore_entries

    area = restore_entries([older_message])
    area.append(
        {"role": "user", "content": [rag_block]},
        source=MessageSource.RAG,
        persistence_policy=PersistencePolicy.COMMIT_ON_SUCCESS,
    )
    area.append(
        {"role": "user", "content": [{"type": "text", "text": "当前问题"}]},
        source=MessageSource.USER,
        persistence_policy=PersistencePolicy.ALREADY_PERSISTED,
        persisted_message_id=user_message.id,
    )

    await run_finalize.finalize_run(
        session_factory=session_factory,
        session_id=session.id,
        user_id=str(user_a.id),
        settings=settings,
        model_cfg=model,
        message_area=area,
        text="",
        files=[],
        tokens_in=0,
        tokens_out=0,
        user_message_id=user_message.id,
    )

    async with session_factory() as check_db:
        rows = await load_session_history(check_db, session.id, max_messages=20)

    # 数据库按 created_at/id 倒序取窗口后反转；RAG 仍应出现在问题之前。
    assert [row.content_json for row in rows[-3:]] == [
        [{"type": "text", "text": "上一轮问题"}],
        [rag_block],
        [{"type": "text", "text": "当前问题"}],
    ]

    for use_anthropic in (True, False):
        restored = build_history_parts(
            rows,
            SimpleNamespace(source="web", chat_id=None),
            use_anthropic=use_anthropic,
            user_tz=timezone.utc,
        )
        assert restored[2]["content"] == [
            {"type": "knowledge-context", "scope": "owner-rag", "text": rag_block["text"]},
        ]
        assert restored[3]["content"][0]["type"] == "time-context"
        assert restored[4]["role"] == "user"
        if use_anthropic:
            assert restored[4]["content"] == [{"type": "text", "text": "当前问题"}]
        else:
            assert restored[4]["content"] == "当前问题"


@pytest.mark.asyncio
async def test_synthetic_tool_round_survives_canonical_persistence_and_restore(
    db, user_a, monkeypatch,
):
    """旧链基线：工具轮从 live 请求到落库、下一 run 恢复保持内容和顺序。"""
    from agent.loop_drivers import AnthropicDriver, NormalizedToolCall, RoundResult

    session = ConversationSession(user_id=user_a.id, title="合成工具轮往返")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    arguments = {"max_results": 3, "query": "合成查询", "options": {"z": 1, "a": 2}}
    call = NormalizedToolCall(
        id="call-synthetic-order",
        name="web_search",
        input=arguments,
        raw_arguments=json.dumps(arguments, ensure_ascii=False, separators=(",", ":")),
    )
    result = RoundResult(
        text="", tool_calls=[call], requires_tools=True,
        raw=[{"type": "tool_use", "id": call.id, "name": call.name, "input": arguments}],
    )
    dispatched = [(call, "合成工具结果")]
    live_wire = AnthropicDriver().build_tool_round(result, dispatched)
    canonical = canonical_tool_round(result, dispatched)
    prompt_messages = MessageArea.from_canonical_messages()
    prompt_messages.append_batch(MessageBatch.from_canonical_messages(
        canonical,
        metadata={"round_id": "round-1"},
    ))

    async def fake_record_usage(*args, **kwargs):
        from agent.usage import UsageResult

        return UsageResult()

    monkeypatch.setattr("agent.usage.record_usage", fake_record_usage)
    monkeypatch.setattr(
        "app.services.conversation_retention.trim_session_messages",
        lambda *_args, **_kwargs: _async_none(),
    )
    session_factory = async_sessionmaker(
        db.bind, class_=AsyncSession, expire_on_commit=False,
    )

    await run_finalize.finalize_run(
        session_factory=session_factory,
        session_id=session.id,
        user_id=str(user_a.id),
        settings=SimpleNamespace(ai=SimpleNamespace(context_tokens=80000)),
        model_cfg=SimpleNamespace(model="synthetic", provider="test", context_tokens=80000),
        message_area=prompt_messages,
        text="",
        files=[],
        tokens_in=0,
        tokens_out=0,
    )

    async with session_factory() as check_db:
        rows = await load_session_history(check_db, session.id, max_messages=20)

    restored_wire = build_history_parts(
        rows,
        SimpleNamespace(source="web", chat_id=None),
        use_anthropic=True,
        user_tz=timezone.utc,
    )
    assert restored_wire == live_wire


@pytest.mark.asyncio
async def test_interrupted_run_persists_completed_history_before_followup(
    db, user_a, monkeypatch,
):
    """取消收尾晚到时，部分 assistant 与已完成工具轮仍排在后续用户消息之前。"""
    session = ConversationSession(user_id=user_a.id, title="中止历史顺序")
    db.add(session)
    await db.commit()
    await db.refresh(session)

    started_at = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
    current_user = ConversationMessage(
        session_id=session.id,
        role="user",
        content="先检查文件",
        created_at=started_at,
    )
    followup_user = ConversationMessage(
        session_id=session.id,
        role="user",
        content="继续",
        created_at=started_at + timedelta(seconds=1),
    )
    db.add_all([current_user, followup_user])
    await db.commit()
    await db.refresh(current_user)

    async def fake_record_usage(*args, **kwargs):
        from agent.usage import UsageResult

        return UsageResult()

    monkeypatch.setattr("agent.usage.record_usage", fake_record_usage)
    monkeypatch.setattr(
        "app.services.conversation_retention.trim_session_messages",
        lambda *_args, **_kwargs: _async_none(),
    )

    session_factory = async_sessionmaker(
        db.bind, class_=AsyncSession, expire_on_commit=False,
    )
    settings = SimpleNamespace(ai=SimpleNamespace(context_tokens=80000))
    model = SimpleNamespace(model="test-model", provider="test", context_tokens=80000)
    area = MessageArea()
    area.append(
        {"role": "user", "content": "先检查文件"},
        source=MessageSource.USER,
        persistence_policy=PersistencePolicy.ALREADY_PERSISTED,
        persisted_message_id=current_user.id,
    )
    area.append_batch(MessageBatch.from_canonical_messages([
        {"role": "assistant", "content": [{
            "type": "tool_call", "id": "call-complete", "name": "read_file",
            "arguments": {"path": "notes.txt"},
        }]},
        {"role": "user", "content": [{
            "type": "tool_result", "tool_call_id": "call-complete", "content": "已读取",
        }]},
    ], metadata={"round_id": "round-1"}))

    await run_finalize.finalize_run(
        session_factory=session_factory,
        session_id=session.id,
        user_id=str(user_a.id),
        settings=settings,
        model_cfg=model,
        message_area=area,
        text="已经读到文件开头，后续检查被中止。",
        display_timeline=[{"kind": "tool", "toolCallId": "call-complete"}],
        files=[],
        tokens_in=20,
        tokens_out=8,
        user_message_id=current_user.id,
        run_id="run-test-interrupted",
        round_id="round-2",
        interrupted=True,
    )

    async with session_factory() as check_db:
        rows = await load_session_history(check_db, session.id, max_messages=20)

    assert [row.content for row in rows] == [
        "先检查文件", "", "", "已经读到文件开头，后续检查被中止。\n\n[本轮已中止，以上内容未完成]", "继续",
    ]
    assert [row.role for row in rows] == ["user", "assistant", "user", "assistant", "user"]
    assert rows[1].created_at < rows[2].created_at < rows[3].created_at < rows[4].created_at
    assert rows[1].content_json[0]["type"] == "tool_call"
    assert rows[2].content_json[0]["type"] == "tool_result"
    assert [row.run_id for row in rows[2:4]] == ["run-test-interrupted"] * 2
    assert [row.round_id for row in rows[2:4]] == ["round-1", "round-2"]
    assert rows[0].run_id == "run-test-interrupted"
    assert rows[0].round_id == "round-1"


async def _async_none():
    return None
