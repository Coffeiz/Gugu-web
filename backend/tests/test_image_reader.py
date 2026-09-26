import pytest
from types import SimpleNamespace

from app.core import chat_attach
from agent.tools import media_reader


@pytest.mark.parametrize("ext", sorted(chat_attach.VISION_EXTS))
def test_shared_image_policy_accepts_every_vision_format(monkeypatch, ext):
    monkeypatch.setattr(chat_attach, "vision_ready", lambda: True)
    monkeypatch.setattr(chat_attach, "vision_block", lambda raw, actual_ext: {"ext": actual_ext})

    result = media_reader.build_image_block(b"image", ext)

    assert result == {"block": {"ext": ext}, "_source_size_bytes": 5}


def test_shared_image_policy_rejects_unsupported_format(monkeypatch):
    monkeypatch.setattr(chat_attach, "vision_ready", lambda: True)

    result = media_reader.build_image_block(b"image", "svg")

    assert "格式 svg" in result["error"]


@pytest.mark.asyncio
async def test_read_file_history_attachment_uses_shared_media_reader(monkeypatch):
    from agent.tools import media_reader
    from agent.tools.files import documents

    async def get_meta(user_id, attach_id):
        assert (user_id, attach_id) == ("user-1", "attach-1")
        return {
            "kind": "image",
            "ext": "webp",
            "storage_key": "user-1/.chat_staging/image.webp",
        }

    async def read_stored_image(key, ext, **kwargs):
        assert key == "user-1/.chat_staging/image.webp"
        assert ext == "webp"
        return {"block": {"type": "image", "test": True}, "_source_size_bytes": 5}

    monkeypatch.setattr(chat_attach, "get_meta", get_meta)
    monkeypatch.setattr(media_reader, "read_stored_image", read_stored_image)

    result = await documents._read_file(None, "user-1", {"attach_id": "attach-1"})

    assert result == {
        "_vision_image": {"type": "image", "test": True},
        "note": "已打开聊天附件图片《attach-1》，见随附图像。",
    }


def test_shared_image_policy_blocks_without_vision_capability(monkeypatch):
    monkeypatch.setattr(chat_attach, "vision_ready", lambda: False)

    assert media_reader.image_capability_error("png") == "当前模型/通道无法识别图像内容"


@pytest.mark.asyncio
async def test_read_file_mixed_batch_preserves_text_and_media_order(monkeypatch):
    from agent.tools.files import documents

    results = {
        1: {"content": "正文 A", "_source_size_bytes": 10},
        2: {"_vision_image": {"type": "image", "source": {"data": "B"}}, "_source_size_bytes": 20},
        3: {"_media_block": {"type": "input_audio", "input_audio": {"data": "C"}},
            "note": "音频", "_source_size_bytes": 30},
    }

    async def read_one(db, user_id, item, **kwargs):
        return dict(results[item["file_id"]])

    monkeypatch.setattr("agent.tools.files.read._read_file_single", read_one)
    result = await documents._read_file(None, "user-1", {"items": [
        {"file_id": 1, "title": "文本"},
        {"file_id": 2, "title": "图片"},
        {"file_id": 3, "title": "音频"},
    ]})

    blocks = result["_media_content"]
    assert [block["type"] for block in blocks] == ["text", "text", "text", "image", "text", "input_audio"]
    assert "成功 3 项" in blocks[0]["text"]
    assert "文本" in blocks[1]["text"] and "正文 A" in blocks[1]["text"]
    assert "图片" in blocks[2]["text"]
    assert "音频" in blocks[4]["text"]


@pytest.mark.asyncio
async def test_read_file_batch_caps_items_and_rejects_mixed_top_level_source():
    from agent.tools.files import documents

    mixed = await documents._read_file(None, "user-1", {"file_id": 9, "items": [{"file_id": 1}]})
    assert "不能同时提供单文件来源" in mixed

    too_many = await documents._read_file(None, "user-1", {"items": [{"file_id": n} for n in range(21)]})
    assert "最多读取 20 个" in too_many


@pytest.mark.asyncio
async def test_read_file_batch_passes_remaining_byte_budget_to_each_item(monkeypatch):
    from agent.tools.files import documents
    from agent.tools.media_reader import MEDIA_BATCH_MAX_BYTES
    budgets = []

    async def read_one(db, user_id, item, **kwargs):
        budgets.append(kwargs["max_source_bytes"])
        size = 40 * 1024 * 1024 if item["file_id"] == 1 else 0
        return {"content": "ok", "_source_size_bytes": size}

    monkeypatch.setattr("agent.tools.files.read._read_file_single", read_one)
    result = await documents._read_file(None, "user-1", {"items": [{"file_id": 1}, {"file_id": 2}]})

    assert budgets == [MEDIA_BATCH_MAX_BYTES, MEDIA_BATCH_MAX_BYTES - 40 * 1024 * 1024]
    assert "成功 2 项" in result["_media_content"][0]["text"]


@pytest.mark.asyncio
async def test_read_file_group_restriction_blocks_private_text(monkeypatch):
    from agent.im import imctx
    from agent.tools.files import documents

    monkeypatch.setattr(imctx, "get_im", lambda: {"im_role": "member"})
    assert documents._restricted_file_reader()
    monkeypatch.setattr(imctx, "get_im", lambda: {"platform": "qq"})
    assert documents._restricted_file_reader()  # 有 IM 上下文但身份不完整时失败关闭

    async def resolve(db, user_id, args):
        return SimpleNamespace(ext="md", display_name="private", id=1), None

    monkeypatch.setattr(documents, "_resolve_file", resolve)
    result = await documents._read_file_single(None, "owner-1", {"file_id": 1}, restricted=True)
    assert "只能读取图片文件" in result


@pytest.mark.asyncio
async def test_read_file_can_read_history_voice_attachment(monkeypatch):
    from agent.tools import media_reader
    from agent.tools.files import documents

    async def get_meta(user_id, attach_id):
        return {
            "kind": "voice", "ext": "amr", "name": "语音.amr",
            "storage_key": "user-1/.voice/voice.amr",
        }

    async def read_media(file, **kwargs):
        assert file.ext == "amr"
        assert file.display_name == "语音"
        return {"content": "已转写语音"}

    monkeypatch.setattr(chat_attach, "get_meta", get_meta)
    monkeypatch.setattr(media_reader, "read_media", read_media)

    assert await documents._read_file(None, "user-1", {"attach_id": "voice-1"}) == {
        "content": "已转写语音",
    }
