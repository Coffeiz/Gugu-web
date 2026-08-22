from types import SimpleNamespace

from agent.loop_drivers import (
    OpenAIDriver,
    RoundResult,
    _OpenAIRaw,
    _collapse_volatile_messages,
    _contains_volatile_image,
    _with_history_cache,
)
from agent.runtime.loopscope_trace.utils import _cache_diagnostics


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
        "image_url": {"url": "data:image/png;base64,AAAA", "detail": "auto"},
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


def test_initial_image_collapses_to_stable_text_after_first_round():
    messages = [{"role": "user", "content": [
        {"type": "text", "text": "[消息时间：2026-08-22 06:00]\\n查查这个角色"},
        {"type": "image_url", "image_url": {
            "url": "data:image/jpeg;base64,AAAA",
        }},
    ]}]

    _collapse_volatile_messages(messages, {0})

    assert messages[0]["content"] == "[消息时间：2026-08-22 06:00]\\n查查这个角色"


def test_cache_checkpoint_recovers_after_image_round():
    messages = [
        {"role": "user", "content": "下一轮稳定消息"},
        {"role": "assistant", "content": "下一轮稳定回复"},
    ]

    cached = _with_history_cache(messages)

    assert cached[-1]["content"][0]["cache_control"] == {"type": "ephemeral"}


def test_cache_diagnostics_only_exposes_sizes_and_digests():
    class Messages(list):
        conversation = [
            {"role": "user", "content": "稳定正文"},
            {"role": "user", "content": [{
                "type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"},
            }]},
        ]
        cache_anchor_indices = [0]

    class Context:
        tools = [{"name": "secret_tool", "description": "私有工具定义"}]
        supports_active_cache = True

    diagnostics = _cache_diagnostics(Messages(), Context())

    assert diagnostics["cache_supported"] is True
    assert diagnostics["conversation_messages"] == 2
    assert diagnostics["cache_anchor_last_index"] == 0
    assert diagnostics["volatile_image_present"] is True
    assert diagnostics["volatile_image_first_index"] == 1
    assert diagnostics["tool_count"] == 1
    assert diagnostics["tool_schema_bytes"] > 0
    assert len(diagnostics["tool_schema_digest"]) == 16
    assert "secret_tool" not in diagnostics
    assert "私有工具定义" not in diagnostics
    assert "AAAA" not in str(diagnostics)
