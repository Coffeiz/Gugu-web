"""send_link_buttons 工具层契约（PRD-LLM-24 Phase 2）。"""
from __future__ import annotations

import json

import pytest

from agent.tools import meta as meta_tools
from agent.tools.base import registry


def _tool():
    tools = {tool.name: tool for tool in meta_tools.MetaSkill.tools}
    return tools["send_link_buttons"]


def test_tool_registered_with_schema_contract():
    """注册进 registry 且 Schema 与 PRD §6.2 一致。"""
    tool = _tool()
    assert tool.label == "发送链接按钮"
    schema = tool.input_schema
    assert schema["required"] == ["message", "buttons"]
    buttons = schema["properties"]["buttons"]
    assert buttons["minItems"] == 1 and buttons["maxItems"] == 5
    item = buttons["items"]
    assert item["required"] == ["id", "label", "url"]
    assert item["properties"]["url"]["maxLength"] == 2048
    assert item["properties"]["label"]["maxLength"] == 40
    # registry 快照可见（web/IM 权限过滤之后仍可被授权）
    from agent.tools.base import current_dispatch_tool_snapshot
    assert registry.snapshot().get("send_link_buttons") is not None


def test_tool_description_states_boundaries():
    """§6.1：描述必须写明不等待点击、不回传结果、https 校验、不做业务动作、有文本降级。"""
    description = _tool().description
    assert "不等待用户点击" in description
    assert "不会返回给咕咕" in description
    assert "https" in description
    assert "确认门" in description
    assert "文本链接" in description


@pytest.mark.asyncio
async def test_rejected_result_on_unsafe_url():
    result = await _tool().handler(None, "user-a", {
        "message": "入口：",
        "buttons": [{"id": "a", "label": "A", "url": "javascript:alert(1)"}],
    })
    assert result["status"] == "rejected"
    assert result["delivery"] == "none"
    assert result["button_count"] == 0
    # 拒绝原因脱敏：不回显完整 URL
    assert "javascript:alert(1)" not in json.dumps(result, ensure_ascii=False)


@pytest.mark.asyncio
async def test_web_context_returns_link_buttons_artifact(monkeypatch):
    """Web 对话：返回 _artifact（kind=link_buttons）供前端渲染，状态 sent/native。"""
    from agent.im import imctx
    monkeypatch.setattr(imctx, "to_send_payload", lambda: None)

    result = await _tool().handler(None, "user-a", {
        "message": "相关入口：",
        "buttons": [{"id": "open", "label": "打开", "url": "https://example.com"}],
    })
    assert result["status"] == "sent"
    assert result["platform"] == "web"
    assert result["delivery"] == "native"
    artifact = result["_artifact"]
    assert artifact["kind"] == "link_buttons"
    assert artifact["buttons"][0]["url"] == "https://example.com"


@pytest.mark.asyncio
async def test_im_context_routes_to_outbound_layer(monkeypatch):
    """IM 上下文：交给 im.replies 统一出站层，工具层不拼平台 payload。"""
    from agent.im import imctx
    captured = {}

    async def fake_send(payload, message, buttons):
        captured.update(payload=payload, message=message, buttons=buttons)
        return {"status": "sent", "platform": "qq", "delivery": "native", "button_count": 1}

    monkeypatch.setattr(imctx, "to_send_payload", lambda: {
        "platform": "qq", "chat_type": "c2c", "platform_user_id": "U1",
    })
    import agent.im.replies as replies_mod
    monkeypatch.setattr(replies_mod, "send_link_button_message", fake_send)

    result = await _tool().handler(None, "user-a", {
        "message": "入口：",
        "buttons": [{"id": "open", "label": "打开", "url": "https://example.com"}],
    })
    assert result["status"] == "sent"
    assert captured["payload"]["platform"] == "qq"
    assert "_artifact" not in result


@pytest.mark.asyncio
async def test_tool_never_creates_interaction_or_consumes_action():
    """§14.1：链接按钮不走 InteractionPrompt/Action 协议——结果不含 _interaction 标记。"""
    from agent.im import imctx
    monkeypatch = pytest.MonkeyPatch()
    try:
        monkeypatch.setattr(imctx, "to_send_payload", lambda: None)
        result = await _tool().handler(None, "user-a", {
            "message": "入口：",
            "buttons": [{"id": "open", "label": "打开", "url": "https://example.com"}],
        })
        assert "_interaction" not in result
        assert "token" not in json.dumps(result, ensure_ascii=False)
    finally:
        monkeypatch.undo()
