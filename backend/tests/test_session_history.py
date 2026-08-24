"""Session baseline 历史读取回归测试。"""

import asyncio

from agent.context.session_history import (
    history_budget_for_context,
    load_session_history,
    select_history_window,
)


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


def test_load_session_history_returns_database_order():
    rows = [_Message(1), _Message(2), _Message(3)]
    result = asyncio.run(load_session_history(_Db(rows), 10, token_budget=10_000))
    assert [item.id for item in result] == [1, 2, 3]


def test_load_session_history_uses_baseline_watermark_and_keeps_summary():
    rows = [_Message(1), _Message(2), _Message(3), _Message(4, "summary")]
    db = _Db(rows, baseline=2)
    result = asyncio.run(load_session_history(db, 10, baseline_message_id=2, token_budget=10_000))
    assert [item.id for item in result] == [4, 3]
    assert any("conversation_messages.id >" in query for query in db.last_queries)


def test_history_budget_reserves_fixed_context_and_dynamic_tail():
    full = history_budget_for_context(120_000)
    reserved = history_budget_for_context(
        120_000,
        system_prompt="系统提示" * 1000,
        snapshot_context="群记忆" * 1000,
    )
    assert reserved < full
    assert reserved > 1


def test_history_window_keeps_tool_call_and_result_together():
    call = _Message(
        2,
        "assistant",
        "",
        [{"type": "tool_call", "id": "call-1", "name": "search", "arguments": {}}],
    )
    result = _Message(
        3,
        "tool",
        "",
        [{"type": "tool_result", "tool_call_id": "call-1", "content": "结果"}],
    )
    old = _Message(1, content="旧消息" * 100)
    newest = _Message(4, content="最新消息")

    selected = select_history_window(
        [newest, result, call, old],
        token_budget=100,
        max_messages=10,
    )

    assert [item.id for item in selected] == [2, 3, 4]


def test_history_window_caps_uncompressed_session():
    messages = [_Message(index, content=f"消息 {index}") for index in range(1, 20)]
    selected = select_history_window(messages[::-1], token_budget=10_000, max_messages=5)
    assert [item.id for item in selected] == [15, 16, 17, 18, 19]
