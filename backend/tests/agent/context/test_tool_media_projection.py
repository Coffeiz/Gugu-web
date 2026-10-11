from agent.context.assembly import MessageArea, MessageBatch
from agent.context.tokens import content_text, estimate_tokens


def _tool_area(*, allow_tool_images: bool) -> MessageArea:
    area = MessageArea(render_options={
        "api_format": "responses",
        "allow_tool_images": allow_tool_images,
    })
    area.append_batch(MessageBatch.from_canonical_messages([
        {
            "role": "assistant",
            "content": [{
                "type": "tool_call", "id": "call-image", "name": "read_file",
                "arguments": {"file_id": 7},
            }],
        },
        {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_call_id": "call-image",
                "content": [
                    {"type": "text", "text": "已打开图片，见随附图像。"},
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": "AQID",
                    }},
                ],
            }],
        },
    ], metadata={"round_id": "round-1"}))
    return area


def test_live_tool_image_is_projected_as_media_not_tool_text():
    messages = _tool_area(allow_tool_images=True).provider_projection().to_messages()

    tool_result = next(message for message in messages if message.get("role") == "tool")
    assert tool_result["content"] == "已打开图片，见随附图像。"
    assert "AQID" not in tool_result["content"]

    image_message = next(
        message for message in messages
        if message.get("role") == "user" and isinstance(message.get("content"), list)
    )
    assert image_message["content"][1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,AQID", "detail": "auto"},
    }


def test_non_visual_tool_history_never_serializes_image_payload_as_text():
    messages = _tool_area(allow_tool_images=False).provider_projection().to_messages()

    assert "AQID" not in repr(messages)
    assert not any(
        isinstance(message.get("content"), list)
        and any(block.get("type") == "image_url" for block in message["content"])
        for message in messages
    )


def test_media_payloads_do_not_inflate_text_token_estimates():
    image = {"type": "image", "source": {"type": "base64", "data": "AQID" * 100_000}}

    assert content_text(image) == "[图片]"
    assert estimate_tokens(content_text(image)) < 10
