"""流式输出泄漏标记必须在写入网页/历史前被截断。"""
from agent.security.sanitize import StreamSanitizer, strip_think_blocks
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


def test_think_tags_are_removed_without_matching_normal_thinking_words():
    sanitizer = StreamSanitizer()

    assert sanitizer.feed("我来说明 thinking 和思考的区别。<think>内部判断</think>答案") == (
        "我来说明 thinking 和思考的区别。答案"
    )
    assert sanitizer.flush() == ""


def test_think_tags_can_be_split_across_stream_deltas():
    sanitizer = StreamSanitizer()

    assert sanitizer.feed("前文<thi") == "前文"
    assert sanitizer.feed("nk>内部") == ""
    assert sanitizer.feed("判断</thi") == ""
    assert sanitizer.feed("nk>后文") == "后文"
    assert sanitizer.flush() == ""


def test_unclosed_think_block_is_not_released_at_stream_end():
    sanitizer = StreamSanitizer()

    assert sanitizer.feed("<think>内部判断") == ""
    assert sanitizer.flush() == ""


def test_non_stream_think_cleaner_removes_only_exact_tags():
    assert strip_think_blocks("thinking 不是标签，<think>隐藏</think>保留") == "thinking 不是标签，保留"
    assert strip_think_blocks("<think>隐藏且未闭合") == ""


def test_plain_less_than_at_end_is_not_lost():
    sanitizer = StreamSanitizer()

    assert sanitizer.feed("比较：1 <") == "比较：1 "
    assert sanitizer.flush() == "<"


def test_salvage_tool_name_removes_provider_marker_before_history_persistence():
    """通用工具名清洗必须处理 provider 尾标记，避免污染名进入下一轮历史。"""
    assert salvage_tool_name("list_dir]<]minimax[") == "list_dir"
    assert salvage_tool_name('create_file"><target>') == "create_file"
