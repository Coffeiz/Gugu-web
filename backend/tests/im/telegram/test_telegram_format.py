"""MarkdownV2 转换和超长消息边界属于 Telegram 用户可见行为。"""

from agent.im.telegram_format import escape_markdown_v2, markdown_v2, split_markdown_v2


def test_markdown_v2_preserves_basic_format_and_escapes_special_text():
    formatted = markdown_v2("**bold _inner_** and *italic!* [link](https://example.test/a?x=1&y=2)\n`a_b`")

    assert "*bold \\_inner\\_*" in formatted
    assert "_italic\\!_" in formatted
    assert "[link](https://example.test/a?x=1&y=2)" in formatted
    assert "`a_b`" in formatted
    assert "\\n" not in formatted


def test_untrusted_link_schemes_are_rendered_as_escaped_text():
    formatted = markdown_v2("[unsafe](javascript:alert(1))")
    assert "javascript:" not in formatted or "[unsafe]" not in formatted
    assert "\\(" in formatted


def test_long_message_falls_back_to_plain_escaped_chunks_without_cutting_codepoints():
    source = ("😀a_b " * 1000) + "尾"
    chunks = split_markdown_v2(source, limit=512)

    assert len(chunks) > 1
    assert all(len(chunk) <= 512 for chunk in chunks)
    assert "\\_" in "".join(chunks)
    assert "尾" in "".join(chunks)


def test_emoji_message_is_split_by_telegram_utf16_length_not_python_character_count():
    chunks = split_markdown_v2("😀" * 2100)

    assert len(chunks) == 2
    assert all(len(chunk.encode("utf-16-le")) // 2 <= 4096 for chunk in chunks)
    assert "".join(chunks) == "😀" * 2100


def test_escape_is_idempotent_for_plain_telegram_specials():
    assert escape_markdown_v2("_[]()~`>#+-=|{}.!\\") == "\\_\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\"
