from types import SimpleNamespace

from agent.im.context_loader import format_history_content


def test_history_keeps_lightweight_image_attachment_reference():
    message = SimpleNamespace(
        content="这是什么角色？",
        sent_at=None,
        role="user",
        chat_type=None,
        files=[{"attach_id": "abc123", "kind": "image", "name": "角色.jpeg"}],
    )
    request = SimpleNamespace(chat_id=None)

    content = format_history_content(message, request)

    assert "abc123" in content
    assert "inspect_images" in content
    assert "base64" not in content
