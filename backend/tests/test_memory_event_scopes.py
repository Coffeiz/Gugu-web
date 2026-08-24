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
    entries = [("2026-08-20", f"记录 {index}") for index in range(501)]

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
            scope, [("2026-08-20", f"记录 {index}") for index in range(501)], "", object()
        )

    assert writes == []
