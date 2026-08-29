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

    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete_json)
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

    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete_json)
    monkeypatch.setattr(im_reflection, "write_scope_file", fake_write)
    scope = MemoryScope("owner", "qq", "bot", "group", "group-1")

    with pytest.raises(RuntimeError):
        await im_reflection._compact_group_daily(
            scope, [("2026-08-20", f"记录 {index}") for index in range(301)], "", object()
        )

    assert writes == []


@pytest.mark.asyncio
async def test_member_batch_reflection_updates_each_real_member(monkeypatch):
    from agent.memory import im_reflection
    from agent.memory.scopes import MemoryScope

    member_writes = []

    async def fake_read_scope_json(_scope, _filename):
        return {"members": {"member-1": {}, "member-2": {}}}

    async def fake_read_scope(_scope):
        return {"profile": [], "pattern": [], "summary": "", "memory": ""}

    async def fake_merge(scope, text, **_kwargs):
        member_writes.append((scope.scope_id, text))
        return text

    async def fake_documents(*_args, **_kwargs):
        return []

    async def fake_sync(*_args, **_kwargs):
        return 1

    async def fake_write(*_args, **_kwargs):
        return None

    monkeypatch.setattr(im_reflection, "read_scope_json", fake_read_scope_json)
    monkeypatch.setattr(im_reflection, "read_scope", fake_read_scope)
    monkeypatch.setattr(im_reflection, "write_scope_file", fake_write)
    monkeypatch.setattr(im_reflection, "merge_scope_event_memory", fake_merge)
    monkeypatch.setattr("agent.rag.adapters.memory.MemoryAdapter.build_documents", fake_documents)
    monkeypatch.setattr("agent.rag.vector_cache.sync_memory_index_vectors", fake_sync)

    scope = MemoryScope("00000000-0000-0000-0000-000000000001", "qq", "bot", "group", "group-1")
    await im_reflection._apply_member_batch_output(
        scope,
        {"members": [
            {"platform_user_id": "member-1", "profile": [{"type": "preference", "text": "喜欢爵士"}], "pattern": [], "summary": "参与排查", "memory": "确认参与部署排查。"},
            {"platform_user_id": "member-2", "profile": [], "pattern": [{"text": "先验证再执行", "kind": "observed", "importance": 3}], "summary": "", "memory": ""},
            {"platform_user_id": "not-in-batch", "profile": [{"type": "note", "text": "不应写入"}], "pattern": [], "summary": "", "memory": ""},
        ]},
        [type("Message", (), {"platform_user_id": "member-1"})(), type("Message", (), {"platform_user_id": "member-2"})()],
    )

    assert member_writes == [("group-1:member-1", "确认参与部署排查。")]
