"""链接按钮出站链路（PRD-LLM-24）：校验、part 结构、能力声明与降级分支。"""
from __future__ import annotations

import pytest

from agent.im import link_buttons as lb
from agent.im.models import PlatformReply, supported_reply_capabilities, link_button_part


GOOD_BUTTONS = [
    {"id": "open_project", "label": "打开项目", "url": "https://example.com/projects/123"},
    {"id": "docs", "label": "文档", "url": "https://example.com/docs/guide"},
]


# ── URL / 输入校验 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("url", [
    "https://example.com/projects/123",
    "HTTPS://Example.COM/Path",
    "https://example.com:443/ok",
])
def test_validate_url_accepts_https(url):
    assert lb.validate_link_button_url(url) is None


@pytest.mark.parametrize("url", [
    "http://example.com",                                # 默认拒绝 http
    "javascript:alert(1)",
    "data:text/html;base64,xxx",
    "file:///etc/passwd",
    "blob:https://example.com/x",
    "myapp://open",
    "intent://example.com",
    "tel:+123456",
    "mailto:a@example.com",
    "https://user:pass@example.com/",                    # 凭据 URL
    "https://example.com:8080/x",                        # 非法端口
    "https://127.0.0.1/x",                               # 环回
    "https://169.254.169.254/latest/meta-data",          # 云元数据
    "https://192.168.1.10/admin",                        # 内网
    "",
])
def test_validate_url_rejects_unsafe(url):
    assert lb.validate_link_button_url(url) is not None


def test_validate_url_domain_allowlist(monkeypatch):
    monkeypatch.setenv("GUGU_LINK_BUTTON_DOMAIN_ALLOWLIST", "example.com, gugu.example.org")
    assert lb.validate_link_button_url("https://example.com/ok") is None
    assert lb.validate_link_button_url("https://www.example.com/ok") is None  # 子域放行（www 可解析）
    assert lb.validate_link_button_url("https://notexample.com/") is not None
    assert lb.validate_link_button_url("https://evil.example.org.evil.com/") is not None
    assert "白名单" in lb.validate_link_button_url("https://random.net/x")


def test_validate_url_allows_http_only_when_configured(monkeypatch):
    monkeypatch.setenv("GUGU_LINK_BUTTON_ALLOW_HTTP", "on")
    assert lb.validate_link_button_url("http://example.com/ok") is None
    assert lb.validate_link_button_url("ftp://example.com") is not None


def test_validate_payload_whole_group_reject():
    # 部分失败 = 整组拒绝（PRD §11）
    buttons = [
        *GOOD_BUTTONS,
        {"id": "bad", "label": "坏按钮", "url": "javascript:void(0)"},
    ]
    normalized, error = lb.validate_link_buttons_payload("相关入口：", buttons)
    assert normalized is None
    assert "坏按钮" in error

    normalized, error = lb.validate_link_buttons_payload("相关入口：", GOOD_BUTTONS)
    assert error == ""
    assert [b["id"] for b in normalized] == ["open_project", "docs"]


@pytest.mark.parametrize("message,buttons", [
    ("", GOOD_BUTTONS),                                   # 空 message
    ("x" * 2001, GOOD_BUTTONS),                           # 超长 message
    ("ok", []),                                           # 空按钮
    ("ok", [{"id": "a", "label": "A", "url": "https://example.com"} for _ in range(6)]),  # 超 5 个
    ("ok", [{"id": "a", "label": "A", "url": "https://example.com"},
            {"id": "a", "label": "B", "url": "https://example.com/b"}]),                     # 重复 id
    ("ok", [{"id": "a", "label": "x" * 41, "url": "https://example.com"}]),                  # 超长 label
    ("ok\x07", GOOD_BUTTONS),                             # 控制字符
    ("ok", [{"id": "a", "label": "A\x1b", "url": "https://example.com"}]),                   # label 控制字符
])
def test_validate_payload_schema_rejects(message, buttons):
    normalized, error = lb.validate_link_buttons_payload(message, buttons)
    assert normalized is None
    assert error


# ── part 结构与能力声明 ───────────────────────────────────────────────────────

def test_link_button_part_shape():
    part = link_button_part("相关入口：", GOOD_BUTTONS)
    assert part["type"] == "link_button"
    assert part["message"] == "相关入口："
    assert part["buttons"] == GOOD_BUTTONS
    reply = PlatformReply.from_parts({}, [part])
    assert "link_button" in reply.required_capabilities


def test_qq_declares_keyboard_and_link_button_now():
    """QQ 原生键盘实际在用，能力声明必须与真实发送路径一致（PRD §8.2）。"""
    caps = supported_reply_capabilities("qq")
    assert {"keyboard", "link_button"} <= set(caps)
    assert "link_button" in supported_reply_capabilities("feishu")
    # 微信无原生链接按钮：必须走文本降级
    assert "link_button" not in supported_reply_capabilities("wechat")


# ── 出站降级分支 ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_send_qq_native_success(monkeypatch):
    sent = {}

    async def fake_send_link_keyboard(target_id, text, buttons, **kwargs):
        sent["target"] = target_id
        return True

    async def fail_send_text(payload, text):
        raise AssertionError("原生成功时不得发送文本降级")

    monkeypatch.setattr("agent.gateway.qq.send_link_keyboard", fake_send_link_keyboard)
    monkeypatch.setattr("agent.im.replies.send_text", fail_send_text)

    from agent.im.replies import send_link_button_message
    result = await send_link_button_message(
        {"platform": "qq", "chat_type": "group", "chat_id": "G1", "channel_id": "c1"},
        "相关入口：", GOOD_BUTTONS,
    )
    assert result == {"status": "sent", "platform": "qq", "delivery": "native", "button_count": 2}
    assert sent["target"] == "G1"


@pytest.mark.asyncio
async def test_send_qq_native_failure_falls_back_to_text_once(monkeypatch):
    text_calls = []

    async def fail_keyboard(*args, **kwargs):
        return False

    async def fake_send_text(payload, text):
        text_calls.append(text)
        return True

    monkeypatch.setattr("agent.gateway.qq.send_link_keyboard", fail_keyboard)
    monkeypatch.setattr("agent.im.replies.send_text", fake_send_text)

    from agent.im.replies import send_link_button_message, _link_buttons_text
    result = await send_link_button_message(
        {"platform": "qq", "chat_type": "c2c", "platform_user_id": "U1"},
        "相关入口：", GOOD_BUTTONS,
    )
    assert result["status"] == "sent_with_fallback"
    assert result["delivery"] == "text"
    assert len(text_calls) == 1  # 文本降级只发一次
    assert "https://example.com/projects/123" in text_calls[0]
    assert _link_buttons_text("相关入口：", GOOD_BUTTONS).startswith("相关入口：")


@pytest.mark.asyncio
async def test_send_feishu_uses_link_card(monkeypatch):
    card_args = {}

    async def fake_send_link_card(receive_id, message, buttons, channel_id=None):
        card_args.update(receive_id=receive_id, message=message, buttons=buttons)
        return True

    monkeypatch.setattr("agent.gateway.feishu.send_link_card", fake_send_link_card)

    from agent.im.replies import send_link_button_message
    result = await send_link_button_message(
        {"platform": "feishu", "chat_id": "oc1", "channel_id": "ch1"},
        "相关入口：", GOOD_BUTTONS,
    )
    assert result["status"] == "sent"
    assert result["delivery"] == "native"
    assert card_args["receive_id"] == "oc1"
    assert card_args["buttons"] == GOOD_BUTTONS


@pytest.mark.asyncio
async def test_send_wechat_text_fallback_only(monkeypatch):
    text_calls = []

    async def fake_send_text(payload, text):
        text_calls.append(text)
        return True

    monkeypatch.setattr("agent.im.replies.send_text", fake_send_text)

    from agent.im.replies import send_link_button_message
    result = await send_link_button_message(
        {"platform": "wechat", "platform_user_id": "W1"}, "相关入口：", GOOD_BUTTONS,
    )
    # 微信没有原生按钮：如实标记 sent_with_fallback，不得谎报 native（PRD §5.4）
    assert result["status"] == "sent_with_fallback"
    assert result["delivery"] == "text"
    assert "example.com/docs/guide" in text_calls[0]


@pytest.mark.asyncio
async def test_send_without_target_is_unsupported(monkeypatch):
    async def fail_text(payload, text):
        raise AssertionError("无出站目标时不得发送")

    monkeypatch.setattr("agent.im.replies.send_text", fail_text)

    from agent.im.replies import send_link_button_message
    result = await send_link_button_message({"platform": "qq"}, "相关入口：", GOOD_BUTTONS)
    assert result["status"] == "unsupported"
    assert result["delivery"] == "none"


@pytest.mark.asyncio
async def test_send_double_failure_is_failed(monkeypatch):
    async def fail_keyboard(*args, **kwargs):
        return False

    async def fail_text(payload, text):
        return False

    monkeypatch.setattr("agent.gateway.qq.send_link_keyboard", fail_keyboard)
    monkeypatch.setattr("agent.im.replies.send_text", fail_text)

    from agent.im.replies import send_link_button_message
    result = await send_link_button_message(
        {"platform": "qq", "chat_type": "c2c", "platform_user_id": "U1"},
        "相关入口：", GOOD_BUTTONS,
    )
    assert result["status"] == "failed"
    assert result["delivery"] == "none"
