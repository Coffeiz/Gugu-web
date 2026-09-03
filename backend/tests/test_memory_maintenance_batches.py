"""Admin 记忆维护切批契约测试。"""

import pytest

from app.services.storage import LocalStorageBackend
from agent.memory.maintenance_batches import (
    MAINTENANCE_MAX_INPUT_TOKENS,
    estimate_tokens,
    pattern_batches,
    split_batches,
)


def test_split_batches_keeps_complete_items_and_budget():
    items = [{"id": str(index), "text": "x" * 8000} for index in range(3)]

    batches = pattern_batches(items)

    assert len(batches) == 2
    assert [item["id"] for batch in batches for item in batch.items] == ["0", "1", "2"]
    assert all(batch.estimated_input_tokens <= MAINTENANCE_MAX_INPUT_TOKENS for batch in batches)
    assert all(not batch.has_oversized_item for batch in batches)


def test_split_batches_marks_oversized_item_without_silent_truncation():
    item = {"id": "long", "text": "x" * 16000}

    batches = pattern_batches([item])

    assert len(batches) == 1
    assert batches[0].items == (item,)
    assert batches[0].source_ids == ("long",)
    assert batches[0].has_oversized_item is True
    assert batches[0].estimated_input_tokens > 3500


@pytest.fixture
def isolated_storage(tmp_path, monkeypatch):
    isolated = LocalStorageBackend(tmp_path)
    from agent.memory import store as memory_store

    monkeypatch.setattr(memory_store, "get_storage", lambda: isolated)
    return isolated


@pytest.mark.asyncio
async def test_review_patterns_maps_each_batch_back_to_stable_pattern_id(isolated_storage, monkeypatch):
    """不同批次都返回局部索引时，必须删除各批自己的第一个 ID。"""
    from agent.memory import store as memory_store
    import scripts.refresh_memory as refresh_memory

    user_id = "019fc2e0-5d71-7b35-8e86-09109553b064"
    patterns = [
        {"id": "first", "text": "a" * 8000, "kind": "inferred", "conf": 0.6, "imp": 3, "ts": 1.0},
        {"id": "second", "text": "b" * 8000, "kind": "inferred", "conf": 0.6, "imp": 3, "ts": 1.0},
        {"id": "third", "text": "c" * 8000, "kind": "inferred", "conf": 0.6, "imp": 3, "ts": 1.0},
    ]
    await memory_store.write_pattern_list(user_id, patterns)

    async def fake_complete_json(*_args, **_kwargs):
        return {"remove": [0], "merge": []}

    monkeypatch.setattr("agent.context.provider_runner.complete_json", fake_complete_json)
    result = await refresh_memory._review_patterns(
        user_id, settings=object(), dry_run=False, trials=1,
    )

    assert result["batch_count"] == 2
    assert result["removed_ids"] == ["first", "third"]
    remaining = await memory_store.read_pattern_list(user_id)
    assert [item["id"] for item in remaining] == ["second"]
