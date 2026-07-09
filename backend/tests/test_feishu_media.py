import json
from types import SimpleNamespace

from agent.adapters import feishu


def _msg(message_type: str, content: dict, message_id: str = "om_1"):
    return SimpleNamespace(
        message_id=message_id,
        message_type=message_type,
        content=json.dumps(content, ensure_ascii=False),
    )


def test_extract_card_text_collects_markdown_and_text_nodes():
    content = {
        "elements": [
            [{"tag": "markdown", "content": "第一段"}],
            [{"tag": "text", "text": "第二段"}],
            [{"tag": "table", "columns": []}],   # 非叙述性组件，跳过
        ],
    }

    assert feishu._extract_card_text(content) == "第一段\n第二段"


def test_ingest_interactive_returns_card_text(monkeypatch):
    msg = _msg("interactive", {"elements": [[{"tag": "markdown", "content": "卡片正文"}]]})

    text = feishu._ingest_interactive(msg)

    assert text == "卡片正文"


def test_ingest_interactive_falls_back_when_empty():
    msg = _msg("interactive", {"elements": []})

    assert feishu._ingest_interactive(msg) == "[卡片消息]"


def test_ingest_post_joins_text_and_downloads_media(monkeypatch):
    msg = _msg("post", {
        "title": "标题",
        "content": [
            [{"tag": "text", "text": "你好"}, {"tag": "at", "user_name": "小明"}],
            [{"tag": "img", "image_key": "img_abc"}],
        ],
    })
    calls = []

    def fake_download(client, message_id, owner, key, rtype, fname, is_voice):
        calls.append((key, rtype, fname, is_voice))
        return ("", "att_1")

    monkeypatch.setattr(feishu, "_download_and_stage", fake_download)

    text, attachments = feishu._ingest_post(object(), msg, "owner-1")

    assert text == "标题\n你好@小明"
    assert attachments == ["att_1"]
    assert calls == [("img_abc", "image", "图片.jpg", False)]


def test_ingest_post_appends_fallback_text_when_download_fails(monkeypatch):
    msg = _msg("post", {
        "content": [[{"tag": "img", "image_key": "img_bad"}]],
    })

    def fake_download(client, message_id, owner, key, rtype, fname, is_voice):
        return (f"[用户发来文件《{fname}》，但下载失败]", "")

    monkeypatch.setattr(feishu, "_download_and_stage", fake_download)

    text, attachments = feishu._ingest_post(object(), msg, "owner-1")

    assert attachments == []
    assert "下载失败" in text


def test_ingest_media_handles_video_message(monkeypatch):
    msg = _msg("media", {"file_key": "file_xyz", "image_key": "thumb_1"})

    def fake_download(client, message_id, owner, key, rtype, fname, is_voice):
        assert key == "file_xyz"
        assert rtype == "file"
        assert fname == "视频.mp4"
        assert is_voice is False
        return ("", "att_video")

    monkeypatch.setattr(feishu, "_download_and_stage", fake_download)

    text, attachments = feishu._ingest_media(object(), msg, "owner-1")

    assert text == ""
    assert attachments == ["att_video"]
