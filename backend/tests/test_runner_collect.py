import json

from agent.runner import _collect
from agent.im.replies import format_tool_event


async def _error_stream(field: str):
    yield "data: " + json.dumps({"type": "error", field: "上游暂时繁忙"}, ensure_ascii=False) + "\n\n"


async def test_collect_reads_core_error_detail():
    text, _, _, _, _, errored, files, cancelled = await _collect(_error_stream("detail"))
    assert text == "上游暂时繁忙"
    assert errored is True
    assert files == []
    assert cancelled is False


async def test_collect_keeps_legacy_error_message():
    text, _, _, _, _, errored, _, _ = await _collect(_error_stream("message"))
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
        _, _, _, _, _, _, _, _, meta = await _collect(
            _tool_call_stream(tool_name), include_meta=True,
        )
        assert meta["mutated"] is True, f"{tool_name} 应该被判为有副作用"


async def test_collect_does_not_mark_mutated_for_read_only_tools():
    _, _, _, _, _, _, _, _, meta = await _collect(
        _tool_call_stream("web_search"), include_meta=True,
    )
    assert meta["mutated"] is False


async def test_collect_marks_mutated_for_prefix_matched_write_tool():
    """既有前缀命中的写工具（如 create_project）仍要保持正确——不是靠前缀了，
    是靠 Tool(mutates=True) 的显式声明，行为应该等价。"""
    _, _, _, _, _, _, _, _, meta = await _collect(
        _tool_call_stream("create_project"), include_meta=True,
    )
    assert meta["mutated"] is True


async def test_collect_preserves_and_emits_tool_events_in_order():
    """回归：IM 出站需要按 tool_call → tool_done 的原始顺序发送独立状态。"""
    async def stream():
        for event in (
            {"type": "tool_call", "run_id": "run-1", "seq": 3, "round_id": 1,
             "name": "web_search", "label": "搜索资料", "status": "running"},
            {"type": "tool_done", "run_id": "run-1", "seq": 4, "round_id": 1,
             "name": "web_search", "label": "搜索资料", "status": "success",
             "result": {"count": 2}},
            {"type": "token", "content": "完成"},
        ):
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

    emitted = []

    async def capture(event):
        emitted.append(event)

    result = await _collect(stream(), include_meta=True, on_tool_event=capture)
    assert [event["type"] for event in emitted] == ["tool_call", "tool_done"]
    assert [event["seq"] for event in result[-1]["tool_events"]] == [3, 4]


def test_tool_event_text_does_not_expose_input_schema():
    event = {
        "type": "tool_done", "name": "web_search", "label": "搜索资料",
        "status": "success", "input": {"query": "不应展示"}, "result": "找到 2 条",
    }
    text = format_tool_event(event)
    assert "搜索资料" in text and "已完成" in text
    assert "不应展示" not in text


def test_tool_event_markdown_separates_input_and_output_blocks():
    call = format_tool_event({
        "type": "tool_call", "label": "联网搜索", "input": {"query": "天气"},
    })
    done = format_tool_event({
        "type": "tool_done", "label": "联网搜索", "status": "success",
        "result": {"items": ["结果一"]},
    })
    assert "### 🔧 联网搜索" in call
    assert "**输入**" in call and "```json" in call
    assert "天气" in call
    assert "**输出**" in done and "结果一" in done


def test_tool_event_plain_qq_only_keeps_result_status():
    call = format_tool_event({
        "type": "tool_call", "label": "联网搜索", "input": {"query": "天气"},
    }, markdown=False)
    done = format_tool_event({
        "type": "tool_done", "label": "联网搜索", "status": "success",
        "result": {"items": ["不应出现在 QQ 纯文本"]},
    }, markdown=False)
    assert call == ""
    assert done == "✅ 联网搜索完成"
