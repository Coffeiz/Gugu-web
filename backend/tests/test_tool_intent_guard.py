from agent.security.core_guards import (
    _could_be_tool_progress,
    _is_tool_progress_only,
    _looks_like_narration,
)
from agent.loop_drivers import RoundResult


def test_tool_progress_placeholder_is_guarded():
    text = "正在为你查询最新信息。"

    assert _could_be_tool_progress("正在为你查")
    assert _is_tool_progress_only(text)


def test_normal_sentence_is_not_treated_as_tool_progress():
    assert not _is_tool_progress_only("我正在查询最新信息，稍后把三支车队的升级整理给你。")


def test_requires_tools_is_runtime_only_round_metadata():
    result = RoundResult(text="", requires_tools=True)
    messages = [{"role": "user", "content": "查一下最新信息"}]

    assert result.requires_tools is True
    assert "requires_tools" not in messages[0]


def test_narration_guard_ignores_normal_conversation_looked_at_phrase():
    assert not _looks_like_narration("收到，测试的事我看到了，你之前做过类似验证。")


def test_narration_guard_keeps_object_context_for_read_claims():
    assert _looks_like_narration("我看到了文件内容，正文已经整理好了。")
