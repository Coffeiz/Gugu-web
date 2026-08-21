from types import SimpleNamespace

from agent.loop_drivers import (
    OpenAIDriver,
    RoundResult,
    _OpenAIRaw,
    _contains_volatile_image,
    _with_history_cache,
)


def _result():
    return RoundResult(
        text="",
        raw=_OpenAIRaw(content="", reasoning="", tool_calls_payload=[
            {"id": "call-1", "name": "inspect_images", "args": "{}"},
        ]),
    )


def test_openai_tool_round_converts_anthropic_image_block():
    messages = []
    dispatched = [(
        SimpleNamespace(id="call-1"),
        [
            {"type": "text", "text": "已读取候选图片。"},
            {"type": "image", "source": {
                "type": "base64", "media_type": "image/png", "data": "AAAA",
            }},
        ],
    )]

    OpenAIDriver().append_tool_round(messages, _result(), dispatched)

    assert messages[1] == {
        "role": "tool",
        "tool_call_id": "call-1",
        "content": "已读取候选图片。",
    }
    assert messages[2]["role"] == "user"
    assert messages[2]["content"][1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,AAAA"},
    }


def test_openai_tool_round_keeps_text_result_shape():
    messages = []
    dispatched = [(SimpleNamespace(id="call-1"), '{"count": 0}')]

    OpenAIDriver().append_tool_round(messages, _result(), dispatched)

    assert len(messages) == 2
    assert messages[1]["role"] == "tool"
    assert messages[1]["content"] == '{"count": 0}'


def test_inline_image_stops_cache_checkpoint_before_image():
    messages = [
        {"role": "user", "content": "稳定消息一"},
        {"role": "assistant", "content": "稳定消息二"},
        {"role": "user", "content": [
            {"type": "text", "text": "请看看这张图"},
            {"type": "image_url", "image_url": {
                "url": "data:image/png;base64,AAAA",
            }},
        ]},
        {"role": "assistant", "content": "图片之后的临时回复"},
    ]

    assert _contains_volatile_image(messages[2])
    cached = _with_history_cache(messages)

    assert cached[1]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in cached[2]["content"][0]
    assert cached[3]["content"] == "图片之后的临时回复"


def test_anthropic_base64_image_is_volatile():
    message = {"role": "user", "content": [{
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"},
    }]}

    assert _contains_volatile_image(message)


def test_cache_checkpoint_recovers_after_image_round():
    messages = [
        {"role": "user", "content": "下一轮稳定消息"},
        {"role": "assistant", "content": "下一轮稳定回复"},
    ]

    cached = _with_history_cache(messages)

    assert cached[-1]["content"][0]["cache_control"] == {"type": "ephemeral"}
