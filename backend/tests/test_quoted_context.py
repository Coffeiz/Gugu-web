from agent.runner import _with_quoted_context


def test_with_quoted_context_passthrough_when_no_quote():
    assert _with_quoted_context("这条引用了什么", None) == "这条引用了什么"
    assert _with_quoted_context("这条引用了什么", "") == "这条引用了什么"


def test_with_quoted_context_wraps_quoted_text_for_model():
    result = _with_quoted_context("这条引用了什么", "上周银石站完整结果：| P | 车手 |")

    assert "上周银石站完整结果" in result
    assert result.endswith("这条引用了什么")
    assert "引用" in result
