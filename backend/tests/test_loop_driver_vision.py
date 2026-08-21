from types import SimpleNamespace

from agent.loop_drivers import OpenAIDriver, RoundResult, _OpenAIRaw


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
