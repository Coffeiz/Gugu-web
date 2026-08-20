"""流式输出泄漏标记必须在写入网页/历史前被截断。"""
from agent.security.sanitize import LeadingMessageTimeSanitizer, StreamSanitizer


def test_minimax_truncates_confirmed_e_tilde_leak_across_token_boundaries():
    sanitizer = StreamSanitizer(minimax=True)

    assert sanitizer.feed("正常回复\n```python\nprint(1)\n```[e") == "正常回复\n```python\nprint(1)\n```"
    assert sanitizer.feed("~[\n后续泄漏") == ""
    assert sanitizer.flush() == ""


def test_non_minimax_keeps_e_tilde_text_untouched():
    sanitizer = StreamSanitizer()

    assert sanitizer.feed("说明一下 [e~[ 这段文本") == "说明一下 [e~[ 这段文本"
    assert sanitizer.flush() == ""


def test_leading_message_time_is_removed_across_stream_chunks():
    sanitizer = LeadingMessageTimeSanitizer()
    assert sanitizer.feed("[消息时间：2026-08-20 ") == ""
    assert sanitizer.feed("21:57]\n") == ""
    assert sanitizer.feed("正常回复") == "正常回复"


def test_normal_reply_start_is_not_delayed_or_changed():
    sanitizer = LeadingMessageTimeSanitizer()
    assert sanitizer.feed("正常回复") == "正常回复"
    assert sanitizer.flush() == ""
