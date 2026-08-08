"""scoped_store.read_scope_json 回归测试（PRD-IM-8 复审性能修复）。

覆盖：只读单个 JSON 文件，不像 read_scope() 那样把 scope.files 里的所有文件都读一遍。
"""
import pytest

from agent.memory.scopes import MemoryScope
from agent.memory.scoped_store import read_scope_json


class _FakeStorage:
    """记录每次 get() 调用的 key，方便断言只读了预期的那一个文件。"""

    def __init__(self, files: dict[str, bytes]):
        self._files = files
        self.get_calls: list[str] = []

    async def get(self, key):
        self.get_calls.append(key)
        if key not in self._files:
            raise FileNotFoundError(key)
        return self._files[key]


def _scope() -> MemoryScope:
    return MemoryScope("user-1", "qq", "bot-a", "group", "chat-1")


@pytest.mark.asyncio
async def test_read_scope_json_only_reads_requested_file(monkeypatch):
    scope = _scope()
    storage = _FakeStorage({
        scope.key("members.json"): b'{"updated_at": 1.0, "members": {"pid-1": {"name": "moon"}}}',
        scope.key("profile.json"): b'[{"type": "note", "text": "should not be read"}]',
    })
    monkeypatch.setattr("agent.memory.scoped_store.get_storage", lambda: storage)

    result = await read_scope_json(scope, "members.json")

    assert result["members"]["pid-1"]["name"] == "moon"
    # 只应该请求过 members.json 这一个 key，不该顺带读 profile.json/daily.md/... 等其他文件。
    assert storage.get_calls == [scope.key("members.json")]


@pytest.mark.asyncio
async def test_read_scope_json_returns_empty_dict_when_missing(monkeypatch):
    scope = _scope()
    storage = _FakeStorage({})
    monkeypatch.setattr("agent.memory.scoped_store.get_storage", lambda: storage)

    result = await read_scope_json(scope, "members.json")

    assert result == {}


@pytest.mark.asyncio
async def test_read_scope_json_returns_empty_dict_on_malformed_json(monkeypatch):
    scope = _scope()
    storage = _FakeStorage({scope.key("members.json"): b"not valid json"})
    monkeypatch.setattr("agent.memory.scoped_store.get_storage", lambda: storage)

    result = await read_scope_json(scope, "members.json")

    assert result == {}


def test_read_scope_json_rejects_non_json_filename():
    scope = _scope()
    with pytest.raises(ValueError):
        import asyncio
        asyncio.run(read_scope_json(scope, "daily.md"))
