"""流式输出泄漏标记必须在写入网页/历史前被截断。"""
from agent.security.sanitize import StreamSanitizer
from agent.providers import adapter_for
from agent.tools.base import salvage_tool_name
from types import SimpleNamespace


def test_minimax_truncates_confirmed_e_tilde_leak_across_token_boundaries():
    sanitizer = StreamSanitizer(adapter=adapter_for(SimpleNamespace(provider="minimax")))

    assert sanitizer.feed("正常回复\n```python\nprint(1)\n```[e") == "正常回复\n```python\nprint(1)\n```"
    assert sanitizer.feed("~[\n后续泄漏") == ""
    assert sanitizer.flush() == ""


def test_non_minimax_keeps_e_tilde_text_untouched():
    sanitizer = StreamSanitizer()

    assert sanitizer.feed("说明一下 [e~[ 这段文本") == "说明一下 [e~[ 这段文本"
    assert sanitizer.flush() == ""


def test_normal_reply_start_is_not_delayed_or_changed():
    sanitizer = StreamSanitizer()
    assert sanitizer.feed("正常回复") == "正常回复"
    assert sanitizer.flush() == ""


def test_salvage_tool_name_removes_provider_marker_before_history_persistence():
    """通用工具名清洗必须处理 provider 尾标记，避免污染名进入下一轮历史。"""
    assert salvage_tool_name("list_files]<]minimax[") == "list_files"
    assert salvage_tool_name('create_file"><target>') == "create_file"
