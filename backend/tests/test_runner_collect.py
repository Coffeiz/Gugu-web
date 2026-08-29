import json

from agent.runner import _collect


async def _error_stream(field: str):
    yield "data: " + json.dumps({"type": "error", field: "上游暂时繁忙"}, ensure_ascii=False) + "\n\n"


async def test_collect_reads_core_error_detail():
    text, _, _, errored, files, cancelled = await _collect(_error_stream("detail"))
    assert text == "上游暂时繁忙"
    assert errored is True
    assert files == []
    assert cancelled is False


async def test_collect_keeps_legacy_error_message():
    text, _, _, errored, _, _ = await _collect(_error_stream("message"))
    assert text == "上游暂时繁忙"
    assert errored is True


async def _tool_call_stream(tool_name: str):
    yield "data: " + json.dumps({"type": "tool_call", "name": tool_name}, ensure_ascii=False) + "\n\n"
    yield "data: " + json.dumps({"type": "token", "content": "完成了"}, ensure_ascii=False) + "\n\n"


async def test_collect_marks_mutated_for_tools_missed_by_old_prefix_matching():
    """回归：mutated 曾经靠工具名前缀猜（create_/update_/delete_/...），remember（写长期
    记忆）和 undo_last_gugu_note（删笔记）都不在那张词表里，会被漏判成"没有副作用"，
    定时任务失败重试时可能把已经生效的写操作重放一遍。现在改成读工具注册时显式声明的
    mutates，这两个工具都必须被正确识别为有副作用。"""
    for tool_name in ("remember", "undo_last_gugu_note"):
        _, _, _, _, _, _, meta = await _collect(
            _tool_call_stream(tool_name), include_meta=True,
        )
        assert meta["mutated"] is True, f"{tool_name} 应该被判为有副作用"


async def test_collect_does_not_mark_mutated_for_read_only_tools():
    _, _, _, _, _, _, meta = await _collect(
        _tool_call_stream("web_search"), include_meta=True,
    )
    assert meta["mutated"] is False


async def test_collect_marks_mutated_for_prefix_matched_write_tool():
    """既有前缀命中的写工具（如 create_project）仍要保持正确——不是靠前缀了，
    是靠 Tool(mutates=True) 的显式声明，行为应该等价。"""
    _, _, _, _, _, _, meta = await _collect(
        _tool_call_stream("create_project"), include_meta=True,
    )
    assert meta["mutated"] is True
