"""Session baseline 历史读取回归测试。"""

import asyncio

from agent.context.session_history import load_session_history


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
        self.last_query = ""

    async def execute(self, query):
        self.last_query = str(query)
        rows = self.rows
        if self.baseline > 0:
            rows = [item for item in rows if item.id > self.baseline or item.role == "summary"]
        return _Result(rows)


class _Message:
    def __init__(self, ident, role="user"):
        self.id = ident
        self.role = role


def test_load_session_history_returns_database_order():
    rows = [_Message(1), _Message(2), _Message(3)]
    result = asyncio.run(load_session_history(_Db(rows), 10))
    assert [item.id for item in result] == [1, 2, 3]


def test_load_session_history_uses_baseline_watermark_and_keeps_summary():
    rows = [_Message(1), _Message(2), _Message(3), _Message(4, "summary")]
    db = _Db(rows, baseline=2)
    result = asyncio.run(load_session_history(db, 10, baseline_message_id=2))
    assert [item.id for item in result] == [3, 4]
    assert "conversation_messages.id >" in db.last_query
