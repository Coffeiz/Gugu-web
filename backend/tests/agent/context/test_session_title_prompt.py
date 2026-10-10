from agent.conversation.session_metadata import build_title_prompt


def test_session_title_prompt_follows_english_conversation_language():
    prompt = build_title_prompt("Help me plan a trip to Kyoto", "Sure, let's compare a few options.")

    assert "使用与用户和咕咕交流相同的语言" in prompt
    assert "如果对话主要使用英文，就用英文输出" in prompt
    assert "不要因为本提示词使用中文而输出中文" in prompt
    assert "用户：Help me plan a trip to Kyoto" in prompt
    assert "咕咕：Sure, let's compare a few options." in prompt


def test_session_title_prompt_uses_selected_locale():
    prompt = build_title_prompt("帮我整理一下旅行计划", "可以，我先按目的地和预算整理。", "zh-CN")

    assert "用户当前选择的界面语言是「简体中文」（zh-CN）" in prompt
    assert "必须使用该语言输出" in prompt
    assert "不要根据本提示词或对话中的其他语言改用别的语言" in prompt


def test_session_title_prompt_keeps_input_limits():
    prompt = build_title_prompt("u" * 200, "a" * 400)

    assert f"用户：{'u' * 150}" in prompt
    assert f"咕咕：{'a' * 300}" in prompt
    assert "u" * 151 not in prompt
    assert "a" * 301 not in prompt
