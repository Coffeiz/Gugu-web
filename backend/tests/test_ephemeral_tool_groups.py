from agent.runner import _resolve_ephemeral_tool_names
from agent.tools import registry


def test_known_skill_names_includes_registered_groups():
    known = registry.known_skill_names()

    assert "web_search" in known
    assert "global_search" in known
    assert "files" in known
    # 改名前的旧组名不该再被认识——这正是要防的那类"悄悄失效"
    assert "search" not in known


def test_resolve_ephemeral_tool_names_falls_back_when_empty():
    full = ["files", "projects", "meta"]

    assert _resolve_ephemeral_tool_names(None, full) == full
    assert _resolve_ephemeral_tool_names([], full) == full


def test_resolve_ephemeral_tool_names_expands_known_groups():
    full = ["files", "projects", "meta", "web_search"]

    result = _resolve_ephemeral_tool_names(["files"], full)

    # 只精简到 files 组的工具，但 meta（use_skill）恒带上
    assert set(result) == set(registry.tools_of(["files", "meta"]))


def test_resolve_ephemeral_tool_names_falls_back_on_unknown_group(capsys):
    full = ["files", "projects", "meta", "web_search"]

    # "search" 是改名前的旧组名，registry 现在不认识——不该悄悄裁成只剩 meta 的工具，
    # 必须整体退回全量 full。这正是这次要防的那类"存量数据组名对不上、任务悄悄半残"。
    result = _resolve_ephemeral_tool_names(["search"], full)

    assert result == full
    assert "未知组名" in capsys.readouterr().out


def test_resolve_ephemeral_tool_names_falls_back_if_any_group_unknown():
    full = ["files", "projects", "meta", "web_search"]

    # 混合已知和未知组名——只要有一个不认识，整体都不可信，不能"部分裁剪"
    result = _resolve_ephemeral_tool_names(["files", "search"], full)

    assert result == full
