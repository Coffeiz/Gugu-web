"""Phase 5-7 交互协议的无数据库回归测试。"""
from __future__ import annotations

import pytest

from agent.interactions.qq import (
    build_keyboard_payload,
    decode_action_data,
    encode_action_data,
    parse_interaction_event,
)


def test_qq_action_payload_only_contains_opaque_action_data():
    payload = build_keyboard_payload({
        "prompt_id": 17,
        "options": [{"id": "confirm", "label": "确认", "token": "opaque-token"}],
    })
    assert payload["buttons"][0]["action_data"] == "17:opaque-token"
    assert "user_id" not in repr(payload)
    assert "session_id" not in repr(payload)


def test_qq_action_data_round_trip_and_rejects_malformed_value():
    assert decode_action_data(encode_action_data(17, "opaque-token")) == (17, "opaque-token")
    with pytest.raises(ValueError):
        decode_action_data("not-an-action")


def test_qq_interaction_parser_accepts_nested_event_without_logging_secrets():
    event = parse_interaction_event({
        "id": "evt-1",
        "data": {
            "user": {"user_openid": "platform-user"},
            "action": {"data": "17:opaque-token"},
        },
    })
    assert event == {
        "prompt_id": 17,
        "token": "opaque-token",
        "event_id": "evt-1",
        "platform_user_id": "platform-user",
        "channel_id": None,
        "chat_type": "c2c",
        "chat_id": None,
    }


def test_qq_interaction_parser_accepts_official_resolved_button_data():
    event = parse_interaction_event({
        "id": "evt-official",
        "data": {
            "user": {"user_openid": "platform-user"},
            "resolved": {"button_data": "17:opaque-token"},
        },
    })
    assert event["prompt_id"] == 17
    assert event["token"] == "opaque-token"
    assert event["platform_user_id"] == "platform-user"


def test_qq_interaction_parser_accepts_official_top_level_user_openid():
    event = parse_interaction_event({
        "id": "evt-top-level",
        "data": {
            "user_openid": "platform-user",
            "resolved": {"button_data": "17:opaque-token"},
        },
    })
    assert event["prompt_id"] == 17
    assert event["token"] == "opaque-token"
    assert event["platform_user_id"] == "platform-user"
