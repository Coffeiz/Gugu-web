import pytest


@pytest.mark.asyncio
async def test_group_compaction_normalizes_and_deduplicates_memory(monkeypatch):
    from agent.memory import im_reflection
    from agent.memory.scopes import MemoryScope

    writes = {}

    async def fake_complete_json(*_args, **_kwargs):
        return {
            "memory": (
                "## 2026-08-20\n\n2026-08-20 已确认群规。\n\n"
                "## 2026-08-20\n\n2026-08-20 已确认群规。\n2026-08-21 新增补充。"
            )
        }

    async def fake_write(scope, filename, text):
        writes[filename] = text

    monkeypatch.setattr(im_reflection, "complete_json", fake_complete_json)
    monkeypatch.setattr(im_reflection, "write_scope_file", fake_write)
    scope = MemoryScope("owner", "qq", "bot", "group", "group-1")
    entries = [("2026-08-20", f"记录 {index}") for index in range(301)]

    await im_reflection._compact_group_daily(scope, entries, "", object())

    assert "记录长期记忆：2026-08-20" in writes["memory.md"]
    assert writes["memory.md"].count("2026-08-20 已确认群规") == 1
    assert "2026-08-21 新增补充" in writes["memory.md"]


@pytest.mark.asyncio
async def test_group_compaction_failure_does_not_write_or_trim_daily(monkeypatch):
    from agent.memory import im_reflection
    from agent.memory.scopes import MemoryScope

    writes = []

    async def fake_complete_json(*_args, **_kwargs):
        raise RuntimeError("provider unavailable")

    async def fake_write(*args, **_kwargs):
        writes.append(args)

    monkeypatch.setattr(im_reflection, "complete_json", fake_complete_json)
    monkeypatch.setattr(im_reflection, "write_scope_file", fake_write)
    scope = MemoryScope("owner", "qq", "bot", "group", "group-1")

    with pytest.raises(RuntimeError):
        await im_reflection._compact_group_daily(
            scope, [("2026-08-20", f"记录 {index}") for index in range(301)], "", object()
        )

    assert writes == []


@pytest.mark.asyncio
async def test_group_compaction_derives_only_batch_member_events(monkeypatch):
    from agent.memory import im_reflection
    from agent.memory.scopes import MemoryScope

    writes = []
    member_writes = []
    vector_syncs = []

    async def fake_complete_json(*_args, **_kwargs):
        return {
            "memory": "## 2026-08-20\n\n群内已确认事项。",
            "member_memory_add": [
                {"platform_user_id": "member-1", "text": "2026-08-20 确认负责测试。"},
                {"platform_user_id": "not-in-batch", "text": "不应写入。"},
            ],
        }

    async def fake_write(scope, filename, text):
        writes.append((scope.scope_type, scope.scope_id, filename, text))

    async def fake_merge(scope, text, **_kwargs):
        member_writes.append((scope.scope_type, scope.scope_id, text))
        return text

    async def fake_sync(*_args, **_kwargs):
        vector_syncs.append(_kwargs)
        return 1

    async def fake_documents(*_args, **_kwargs):
        return []

    monkeypatch.setattr(im_reflection, "complete_json", fake_complete_json)
    monkeypatch.setattr(im_reflection, "write_scope_file", fake_write)
    monkeypatch.setattr(im_reflection, "merge_scope_event_memory", fake_merge)
    monkeypatch.setattr("agent.rag.adapters.memory.MemoryAdapter.build_documents", fake_documents)
    monkeypatch.setattr("agent.rag.vector_cache.sync_memory_index_vectors", fake_sync)

    scope = MemoryScope("owner", "qq", "bot", "group", "group-1")
    await im_reflection._compact_group_daily(
        scope,
        [("2026-08-20", f"记录 {index}") for index in range(301)],
        "",
        object(),
        member_ids={"member-1"},
    )

    assert any(item[2] == "memory.md" and item[0] == "group" for item in writes)
    assert member_writes == [("platform-user", "group-1:member-1", "2026-08-20 确认负责测试。")]
    assert vector_syncs == [{"prune": False}]


@pytest.mark.asyncio
async def test_member_event_failure_does_not_block_other_members(monkeypatch):
    from agent.memory import im_reflection
    from agent.memory.scopes import MemoryScope

    member_attempts = []

    async def fake_complete_json(*_args, **_kwargs):
        return {
            "memory": "## 2026-08-20\n\n群内事项。",
            "member_memory_add": [
                {"platform_user_id": "member-1", "text": "成员一事件"},
                {"platform_user_id": "member-2", "text": "成员二事件"},
            ],
        }

    async def fake_write(*_args, **_kwargs):
        return None

    async def fake_members(*_args, **_kwargs):
        return {"members": {"member-1": {}, "member-2": {}}}

    async def fake_merge(scope, text, **_kwargs):
        member_attempts.append(scope.scope_id)
        if scope.scope_id.endswith("member-1"):
            raise RuntimeError("member write failed")
        return text

    async def fake_documents(*_args, **_kwargs):
        return []

    async def fake_sync(*_args, **_kwargs):
        return 0

    monkeypatch.setattr(im_reflection, "complete_json", fake_complete_json)
    monkeypatch.setattr(im_reflection, "write_scope_file", fake_write)
    monkeypatch.setattr(im_reflection, "read_scope_json", fake_members)
    monkeypatch.setattr(im_reflection, "merge_scope_event_memory", fake_merge)
    monkeypatch.setattr("agent.rag.adapters.memory.MemoryAdapter.build_documents", fake_documents)
    monkeypatch.setattr("agent.rag.vector_cache.sync_memory_index_vectors", fake_sync)

    await im_reflection._compact_group_daily(
        MemoryScope("owner", "qq", "bot", "group", "group-1"),
        [("2026-08-20", f"记录 {index}") for index in range(301)],
        "",
        object(),
        member_ids={"member-1", "member-2"},
    )

    assert member_attempts == ["group-1:member-1", "group-1:member-2"]
