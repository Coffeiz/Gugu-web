import pytest

from agent.tools.line_edit import apply_line_edits, numbered_lines


def test_line_edit_accepts_single_dash_and_bash_comma_ranges():
    text = "一\n二\n三\n四\n"
    assert apply_line_edits(text, [{"target_lines": "2-3", "expected": "二\n三", "content": "新二\n新三"}])[0] == "一\n新二\n新三\n四\n"
    assert apply_line_edits(text, [{"target_lines": "2,3", "expected": "二\n三", "content": ""}])[0] == "一\n四\n"


def test_line_edit_applies_multiple_ranges_from_bottom():
    text = "一\n二\n三\n四\n"
    result, count = apply_line_edits(text, [
        {"target_lines": "4", "expected": "四", "content": "新四"},
        {"target_lines": "2", "expected": "二", "content": "新二"},
    ])
    assert result == "一\n新二\n三\n新四\n"
    assert count == 2


@pytest.mark.parametrize("edit", [
    {"target_lines": "0", "content": "x"},
    {"target_lines": "2-8", "content": "x"},
    {"target_lines": "2，3", "content": "x"},
])
def test_line_edit_rejects_invalid_ranges(edit):
    with pytest.raises(ValueError):
        apply_line_edits("一\n二\n三\n", [edit])


def test_line_edit_rejects_overlapping_ranges():
    with pytest.raises(ValueError, match="不能重叠"):
        apply_line_edits("一\n二\n三\n", [
            {"target_lines": "1-2", "expected": "一\n二", "content": "x"},
            {"target_lines": "2-3", "expected": "二\n三", "content": "y"},
        ])


def test_line_edit_rejects_missing_or_stale_expected_text():
    with pytest.raises(ValueError, match="必须提供 expected"):
        apply_line_edits("一\n二\n", [{"target_lines": "2", "content": "x"}])
    with pytest.raises(ValueError, match="原文校验失败"):
        apply_line_edits("一\n二\n", [{"target_lines": "2", "expected": "旧二", "content": "x"}])


def test_numbered_lines_describes_raw_physical_lines():
    assert numbered_lines("# 标题\n\n- 一项\n") == "1: # 标题\n2: \n3: - 一项"
