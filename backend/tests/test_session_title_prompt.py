from agent.gateway.web import _build_title_prompt


def test_session_title_prompt_follows_english_conversation_language():
    prompt = _build_title_prompt("Help me plan a trip to Kyoto", "Sure, let's compare a few options.")

    assert "使用与用户和咕咕交流相同的语言" in prompt
    assert "如果对话主要使用英文，就用英文输出" in prompt
    assert "不要因为本提示词使用中文而输出中文" in prompt
    assert "用户：Help me plan a trip to Kyoto" in prompt
    assert "咕咕：Sure, let's compare a few options." in prompt


def test_session_title_prompt_keeps_input_limits():
    prompt = _build_title_prompt("u" * 200, "a" * 400)

    assert f"用户：{'u' * 150}" in prompt
    assert f"咕咕：{'a' * 300}" in prompt
    assert "u" * 151 not in prompt
    assert "a" * 301 not in prompt
