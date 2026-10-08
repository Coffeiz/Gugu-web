from agent.im.message_format import (
    compatibility_prompt,
    default_message_format,
    message_type,
)


def test_default_message_format_keeps_groups_compatible_and_private_smart():
    assert default_message_format("group") == "compat"
    assert default_message_format("c2c") == "smart"


def test_compatibility_mode_always_uses_plain_text():
    assert message_type("# 标题\n**正文**", "compat") == 0


def test_markdown_mode_always_uses_markdown():
    assert message_type("普通文本", "markdown") == 2


def test_smart_mode_only_uses_markdown_for_clear_signals():
    assert message_type("普通文本", "smart") == 0
    assert message_type("**重点**", "smart") == 2
    assert message_type("- 第一项\n- 第二项", "smart") == 2
    assert message_type("[链接](https://example.com)", "smart") == 2


def test_missing_mode_preserves_legacy_markdown_behavior():
    assert message_type("普通文本", None) == 2


def test_compatibility_prompt_forbids_markdown_without_changing_content_rules():
    prompt = compatibility_prompt()
    assert "普通纯文本" in prompt
    assert "不要使用 Markdown 标记" in prompt
    assert "工具调用" not in prompt
