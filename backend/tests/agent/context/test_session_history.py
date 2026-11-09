"""Session baseline 历史读取回归测试。"""

import asyncio
import re

import pytest

from agent.context.budget import ContextBudget
from agent.context.session_history import consume_history_stats, load_session_history
from agent.context.tokens import estimate_tokens
from app.models import ConversationMessage, ConversationSession


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _Db:
    def __init__(self, rows, baseline=0):
        self.rows = rows
        self.baseline = baseline
        self.last_queries = []
        self.query_limits = []

    async def execute(self, query):
        self.last_queries.append(str(query))
        sql = str(query.compile(compile_kwargs={"literal_binds": True}))
        if "length(" in sql.lower() or "octet_length(" in sql.lower():
            return _Result([])
        match = re.search(r"\bLIMIT\s+(\d+)\b", sql, re.IGNORECASE)
        limit = int(match.group(1)) if match else None
        self.query_limits.append(limit)
        if len(self.last_queries) == 1:
            rows = [item for item in self.rows if item.role == "summary"][:1]
        else:
            rows = [item for item in self.rows if item.role != "summary"]
            if self.baseline > 0:
                rows = [
                    item for item in rows
                    if (item.history_anchor_seq or item.conversation_seq) > self.baseline
                ]
            rows = list(reversed(rows))
            if limit is not None:
                rows = rows[:limit]
        return _Result(rows)


class _Message:
    def __init__(self, ident, role="user", content="消息", content_json=None):
        self.id = ident
        self.conversation_seq = ident
        self.history_anchor_seq = None
        self.role = role
        self.content = content
        self.content_json = content_json


async def _load_history_and_stats(rows):
    result = await load_session_history(_Db(rows), 10)
    return result, consume_history_stats()


def test_load_session_history_returns_stable_chronological_order():
    rows = [_Message(1), _Message(2), _Message(3)]
    result, stats = asyncio.run(_load_history_and_stats(rows))
    assert [item.id for item in result] == [1, 2, 3]
    assert stats["history_loaded_count"] == 3
    assert stats["history_selected_count"] == 3
    assert stats["history_oldest_selected_seq"] == 1
    assert stats["history_newest_selected_seq"] == 3


def test_load_session_history_uses_baseline_watermark_and_keeps_summary():
    rows = [_Message(1), _Message(2), _Message(3), _Message(4, "summary")]
    db = _Db(rows, baseline=2)
    result = asyncio.run(load_session_history(db, 10, baseline_message_seq=2))
    assert [item.id for item in result] == [4, 3]
    assert [item.conversation_seq for item in result[1:]] == [3]


def test_unbaselined_history_keeps_all_rows_and_stable_prefix():
    rows = [_Message(ident) for ident in range(1, 151)]
    db = _Db(rows)

    result = asyncio.run(load_session_history(db, 10))

    assert [item.id for item in result] == list(range(1, 151))
    assert db.query_limits == [1, None]
    db.rows.append(_Message(151))
    next_result = asyncio.run(load_session_history(_Db(db.rows), 10))
    assert [item.id for item in next_result[:-1]] == [item.id for item in result]


def test_baselined_history_keeps_all_rows_after_watermark():
    rows = [_Message(ident) for ident in range(1, 701)]
    db = _Db(rows, baseline=100)

    result = asyncio.run(load_session_history(db, 10, baseline_message_seq=100))

    assert [item.id for item in result] == list(range(101, 701))
    assert db.query_limits == [1, None]


def test_explicit_diagnostic_limit_remains_available():
    rows = [_Message(ident) for ident in range(1, 151)]
    db = _Db(rows)

    result = asyncio.run(load_session_history(db, 10, max_messages=20))

    assert [item.id for item in result] == list(range(131, 151))


def test_unbaselined_summary_keeps_all_history():
    summary = _Message(151, role="summary")
    rows = [_Message(ident) for ident in range(1, 151)] + [summary]
    db = _Db(rows)

    result = asyncio.run(load_session_history(db, 10))

    assert len(result) == 151
    assert result[0] is summary
    assert [item.id for item in result[1:]] == list(range(1, 151))
    assert db.query_limits == [1, None]


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["web", "qq"])
async def test_history_reload_preserves_prefix_beyond_old_window(db, user_a, source):
    """超过旧条数窗口后，新消息不能挤掉未摘要的历史前缀。"""
    session = ConversationSession(user_id=user_a.id, title="连续历史", source=source)
    db.add(session)
    await db.flush()
    db.add_all([
        ConversationMessage(session_id=session.id, role="user", content=f"消息 {index}")
        for index in range(125)
    ])
    await db.commit()

    before = await load_session_history(db, session.id)
    db.add(ConversationMessage(session_id=session.id, role="user", content="新消息"))
    await db.commit()
    after = await load_session_history(db, session.id)

    assert len(before) == 125
    assert [item.id for item in after[:-1]] == [item.id for item in before]
    assert after[-1].content == "新消息"


@pytest.mark.asyncio
async def test_history_hydrates_only_recent_bounded_image_snapshots(db, user_a):
    """历史正文保持完整，但图片快照只回读最近预算内的有限条目。"""
    session = ConversationSession(user_id=user_a.id, title="图片历史", source="web")
    db.add(session)
    await db.flush()
    db.add_all([
        ConversationMessage(
            session_id=session.id,
            role="user",
            content=f"图片消息 {index}",
            content_json=[{"type": "text", "text": f"图片消息 {index}"}],
            provider_image_content=[
                {"type": "text", "text": f"图片消息 {index}"},
                {"type": "image", "source": {
                    "type": "base64", "media_type": "image/png", "data": "x" * 128}},
            ],
        )
        for index in range(20)
    ])
    await db.commit()

    history = await load_session_history(db, session.id)
    stats = consume_history_stats()
    loaded_images = [
        item for item in history
        if "provider_image_content" in vars(item)
    ]

    assert len(history) == 20
    assert len(loaded_images) == 12
    assert [item.content for item in loaded_images] == [
        f"图片消息 {index}" for index in range(8, 20)
    ]
    assert stats["history_image_snapshots_loaded"] == 12
    assert stats["history_image_snapshot_bytes"] <= 8 * 1024 * 1024


@pytest.mark.asyncio
async def test_history_image_snapshot_hydration_obeys_byte_budget(db, user_a, monkeypatch):
    """单条快照超过剩余预算时不读取 payload，避免少数大图打穿总量限制。"""
    import agent.context.session_history as session_history

    monkeypatch.setattr(session_history, "_MAX_HISTORY_IMAGE_BYTES", 400)
    session = ConversationSession(user_id=user_a.id, title="大图历史", source="web")
    db.add(session)
    await db.flush()
    db.add_all([
        ConversationMessage(
            session_id=session.id,
            role="user",
            content=f"大图 {index}",
            provider_image_content=[{"type": "image", "source": {
                "type": "base64", "media_type": "image/png", "data": "x" * 256}}],
        )
        for index in range(3)
    ])
    await db.commit()

    history = await load_session_history(db, session.id)
    stats = consume_history_stats()

    assert len(history) == 3
    assert sum("provider_image_content" in vars(item) for item in history) == 1
    assert stats["history_image_snapshot_bytes"] <= 400


def test_context_budget_reserves_fixed_context_and_turn_batch():
    full = ContextBudget.from_parts(120_000)
    reserved = ContextBudget.from_parts(
        120_000,
        system_prompt_tokens=estimate_tokens("系统提示" * 1000 + "群记忆" * 1000),
        turn_batch_tokens=800,
    )
    assert reserved.history_capacity_tokens < full.history_capacity_tokens
    assert reserved.history_capacity_tokens > 1
