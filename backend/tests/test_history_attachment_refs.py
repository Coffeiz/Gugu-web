from types import SimpleNamespace

from agent.im.context_loader import format_attachment_refs, format_history_content


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


def test_history_keeps_non_image_file_reference_for_readback():
    # QQ 引用文件消息：文字附件正文只在到达轮注入一次，历史回放必须保留
    # attach_id + save_uploaded_file 指引，否则下一轮起模型彻底无法回读。
    message = SimpleNamespace(
        files=[{"attach_id": "md1234", "kind": "text", "name": "daily", "ext": "md"}],
    )

    refs = format_attachment_refs(message)

    assert "md1234" in refs
    assert "daily.md" in refs
    assert "save_uploaded_file" in refs


def test_history_skips_voice_attachment_reference():
    # 语音是对话内容，到达时已转写，不需要回读通道，避免语音刷屏历史上下文。
    message = SimpleNamespace(
        files=[{"attach_id": "voice1", "kind": "voice", "name": "语音", "ext": "mp3"}],
    )

    assert format_attachment_refs(message) == ""


def test_history_mixed_image_and_file_refs_split_channels():
    message = SimpleNamespace(
        files=[
            {"attach_id": "img1", "kind": "image", "name": "截图", "ext": "png"},
            {"attach_id": "bin1", "kind": "binary", "name": "数据", "ext": "xlsx"},
        ],
    )

    refs = format_attachment_refs(message)

    assert "inspect_images" in refs
    assert "img1" in refs
    assert "save_uploaded_file" in refs
    assert "bin1" in refs
    # 图片指引不能把二进制文件也归进 inspect_images 通道
    image_section = refs.split("save_uploaded_file")[0]
    assert "bin1" not in image_section
