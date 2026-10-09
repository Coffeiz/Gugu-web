"""群聊身份不能以 Owner 的文件 ID 探测或读取私人图片。"""

import importlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_restricted_group_identity_cannot_read_owner_file_by_id(monkeypatch):
    file_operations = importlib.import_module("agent.tools.files.file_operations")
    resolve_file = AsyncMock(side_effect=AssertionError("不应解析 Owner 文件 ID"))
    monkeypatch.setattr(file_operations, "_resolve_file", resolve_file)
    read = importlib.import_module("agent.tools.files.read")

    result = await read._read_file_single(
        None, "synthetic-owner", {"file_id": 123}, restricted=True,
    )

    assert "当前会话明确提供" in json.loads(result)["error"]
    resolve_file.assert_not_awaited()


@pytest.mark.asyncio
async def test_restricted_group_identity_cannot_read_arbitrary_owner_attachment(monkeypatch):
    chat_attach = importlib.import_module("app.core.chat_attach")
    get_meta = AsyncMock(side_effect=AssertionError("不应探测非当前消息附件"))
    monkeypatch.setattr(chat_attach, "get_meta", get_meta)
    loop = importlib.import_module("agent.im.loop")
    loop.bind_im_context(SimpleNamespace(
        source="telegram", chat_id="group-1", platform_user_id="member-1",
        allowed_tool_names=None, im_role="member", attachments=["current-image"],
    ), {"message_id": "message-1", "channel_id": "bot-1", "chat_type": "group"})
    read = importlib.import_module("agent.tools.files.read")

    result = await read._read_file_single(
        None, "synthetic-owner", {"attach_id": "older-owner-image"}, restricted=True,
    )

    assert "当前消息提供" in json.loads(result)["error"]
    get_meta.assert_not_awaited()


@pytest.mark.asyncio
async def test_restricted_group_identity_can_read_current_message_image(monkeypatch):
    chat_attach = importlib.import_module("app.core.chat_attach")
    get_meta = AsyncMock(return_value={
        "kind": "image", "ext": "png", "name": "image.png", "storage_key": "safe-key",
    })
    monkeypatch.setattr(chat_attach, "get_meta", get_meta)
    media_reader = importlib.import_module("agent.tools.media_reader")
    read_image = AsyncMock(return_value={"block": {"type": "image"}, "_source_size_bytes": 5})
    monkeypatch.setattr(media_reader, "read_stored_image", read_image)
    loop = importlib.import_module("agent.im.loop")
    loop.bind_im_context(SimpleNamespace(
        source="telegram", chat_id="group-1", platform_user_id="member-1",
        allowed_tool_names=None, im_role="member", attachments=["current-image"],
    ), {"message_id": "message-1", "channel_id": "bot-1", "chat_type": "group"})
    read = importlib.import_module("agent.tools.files.read")

    result = await read._read_file_single(
        None, "synthetic-owner", {"attach_id": "current-image"}, restricted=True,
    )

    assert result["_image_block"] == {"type": "image"}
    get_meta.assert_awaited_once_with("synthetic-owner", "current-image")
