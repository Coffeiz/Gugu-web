"""Session baseline 历史读取回归测试。"""

import asyncio

from agent.context.budget import ContextBudget
from agent.context.session_history import consume_history_stats, load_session_history


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

    async def execute(self, query):
        self.last_queries.append(str(query))
        query_text = str(query)
        if len(self.last_queries) == 1:
            rows = [item for item in self.rows if item.role == "summary"][:1]
        else:
            rows = [item for item in self.rows if item.role != "summary"]
            if self.baseline > 0:
                rows = [item for item in rows if item.id > self.baseline]
            rows = list(reversed(rows))
        return _Result(rows)


class _Message:
    def __init__(self, ident, role="user", content="消息", content_json=None):
        self.id = ident
        self.role = role
        self.content = content
        self.content_json = content_json


async def _load_history_and_stats(rows):
    result = await load_session_history(_Db(rows), 10)
    return result, consume_history_stats()


def test_load_session_history_returns_database_order():
    rows = [_Message(1), _Message(2), _Message(3)]
    result, stats = asyncio.run(_load_history_and_stats(rows))
    assert [item.id for item in result] == [1, 2, 3]
    assert stats["history_loaded_count"] == 3
    assert stats["history_selected_count"] == 3
    assert stats["history_oldest_selected_id"] == 1
    assert stats["history_newest_selected_id"] == 3


def test_load_session_history_uses_baseline_watermark_and_keeps_summary():
    rows = [_Message(1), _Message(2), _Message(3), _Message(4, "summary")]
    db = _Db(rows, baseline=2)
    result = asyncio.run(load_session_history(db, 10, baseline_message_id=2))
    assert [item.id for item in result] == [4, 3]
    assert any("conversation_messages.id >" in query for query in db.last_queries)


def test_context_budget_reserves_fixed_context_and_turn_batch():
    full = ContextBudget.for_history(120_000)
    reserved = ContextBudget.for_history(
        120_000,
        fixed_prefix_text="系统提示" * 1000 + "群记忆" * 1000,
        turn_batch_tokens=800,
    )
    assert reserved.history_capacity_tokens < full.history_capacity_tokens
    assert reserved.history_capacity_tokens > 1
