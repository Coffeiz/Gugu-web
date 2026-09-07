"""长期 profile/pattern 整理器的输出边界测试。"""
from pathlib import Path

import pytest

from app.services.storage import LocalStorageBackend
from agent.memory import longterm_compaction, store
from agent.memory.longterm_compaction import _valid_pattern, _valid_profile


def test_profile_compaction_accepts_storage_shape_without_ids():
    result = _valid_profile([{"type": "preference", "text": "偏好简洁回复"}])

    assert result == [{"type": "preference", "text": "偏好简洁回复", "ts": None}]


def test_pattern_compaction_rejects_unknown_or_duplicate_ids():
    source = [{"id": "p1", "text": "原始模式"}]

    assert _valid_pattern(
        [{"id": "invented", "text": "整理后的模式", "kind": "observed"}], source
    ) is None
    assert _valid_pattern(
        [
            {"id": "p1", "text": "模式一", "kind": "observed"},
            {"id": "p1", "text": "模式二", "kind": "observed"},
        ],
        source,
    ) is None


def test_compaction_rejects_an_empty_result_for_a_large_snapshot():
    source_profile = [{"type": "note", "text": f"画像 {index}"} for index in range(100)]
    source_pattern = [{"id": str(index), "text": f"模式 {index}"} for index in range(100)]

    assert _valid_profile([], source_profile) is None
    assert _valid_pattern([], source_pattern) is None


@pytest.mark.asyncio
async def test_profile_cas_does_not_overwrite_a_newer_snapshot(tmp_path: Path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr(store, "get_storage", lambda: backend)
    user_id = "u1"
    original = [{"type": "note", "text": f"画像 {index}"} for index in range(100)]
    await store.write_profile_list(user_id, original)
    expected_digest = store.profile_list_digest(await store.read_profile_list(user_id))
    newer = original + [{"type": "note", "text": "刚产生的新画像"}]
    await store.write_profile_list(user_id, newer)

    committed = await store.write_profile_list_if_unchanged(
        user_id, expected_digest, original[:70],
    )

    assert committed is False
    assert len(await store.read_profile_list(user_id)) == 101


@pytest.mark.asyncio
async def test_compaction_aborts_when_snapshot_changes_during_llm(monkeypatch):
    original = [{"type": "note", "text": f"画像 {index}"} for index in range(100)]
    monkeypatch.setattr(longterm_compaction.store, "read_profile_list", lambda _user: _read(original))
    monkeypatch.setattr(
        longterm_compaction,
        "complete_json",
        lambda *_args, **_kwargs: _json({"profile": original[:70]}),
    )
    calls = []

    async def reject_stale_write(*args):
        calls.append(args)
        return False

    monkeypatch.setattr(longterm_compaction.store, "write_profile_list_if_unchanged", reject_stale_write)

    assert await longterm_compaction.compact_profile("u1", None) is False
    assert calls


async def _read(value):
    return value


async def _json(value):
    return value
