"""长期 profile/pattern 整理器的输出边界测试。"""

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
