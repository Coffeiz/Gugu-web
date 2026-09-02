from agent.security.core_guards import (
    _could_be_tool_progress,
    _is_tool_progress_only,
    _looks_like_narration,
    _announces_intent,
)
from agent.security.guard_patterns import get_guard_locale
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


def test_colon_ended_file_action_is_guarded_in_chinese_and_english():
    assert _announces_intent("先把文件移动到目标文件夹：")
    assert _announces_intent("Let me move the file to the target folder:")


def test_colon_ended_explanation_is_not_treated_as_action_intent():
    assert not _announces_intent("下面是本次测试的说明：")
    assert not _announces_intent("Here is the explanation:")


def test_guard_locale_selects_japanese_and_english_rules():
    assert _looks_like_narration("ファイルを確認しました。", "ja-JP")
    assert _announces_intent("Let me move the file to the target folder.", "en-US")
    assert not _announces_intent("ファイルを確認しますか？", "ja-JP")
    assert get_guard_locale("en-US").intent_nudge.startswith("[System reminder")


def test_unknown_guard_locale_falls_back_to_chinese():
    assert get_guard_locale("fr-FR") is get_guard_locale("zh-CN")
