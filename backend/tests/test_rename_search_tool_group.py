import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from rename_search_tool_group import _renamed_groups


def test_renamed_groups_returns_none_when_no_legacy_name():
    assert _renamed_groups(["files", "web_search"]) is None
    assert _renamed_groups([]) is None


def test_renamed_groups_replaces_legacy_name():
    assert _renamed_groups(["files", "search"]) == ["files", "web_search"]


def test_renamed_groups_dedupes_when_both_names_present():
    # 万一旧数据本来就同时存了 search 和 web_search，改名后不能出现重复
    assert _renamed_groups(["search", "web_search", "files"]) == ["web_search", "files"]
