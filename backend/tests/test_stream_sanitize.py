"""流式输出泄漏标记必须在写入网页/历史前被截断。"""
from agent.security.sanitize import StreamSanitizer


def test_minimax_truncates_confirmed_e_tilde_leak_across_token_boundaries():
    sanitizer = StreamSanitizer(minimax=True)

    assert sanitizer.feed("正常回复\n```python\nprint(1)\n```[e") == "正常回复\n```python\nprint(1)\n```"
    assert sanitizer.feed("~[\n后续泄漏") == ""
    assert sanitizer.flush() == ""


def test_non_minimax_keeps_e_tilde_text_untouched():
    sanitizer = StreamSanitizer()

    assert sanitizer.feed("说明一下 [e~[ 这段文本") == "说明一下 [e~[ 这段文本"
    assert sanitizer.flush() == ""
