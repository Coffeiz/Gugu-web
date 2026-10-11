from agent.interactions.feishu import (
    build_card_payload,
    build_completed_card_payload,
    decode_action_value,
    encode_action_value,
)


def test_feishu_action_value_round_trip():
    value = encode_action_value(12, "token-abc")
    assert decode_action_value(value) == (12, "token-abc")


def test_feishu_action_value_rejects_untrusted_shapes():
    for value in (None, {}, {"prompt_id": 0, "token": "x"}, {"prompt_id": 1, "token": ""}):
        try:
            decode_action_value(value)
        except ValueError:
            continue
        raise AssertionError("无效的飞书动作数据未被拒绝")


def test_feishu_card_contains_only_action_tokens():
    card = build_card_payload({
        "prompt_id": 7,
        "title": "选择方式",
        "body": "请选择",
        "options": [{"id": "a", "label": "方案 A", "token": "secret-token"}],
    })
    action = card["elements"][1]["actions"][0]
    assert action["value"] == {"prompt_id": 7, "token": "secret-token"}
    assert "session_id" not in action["value"]


def test_feishu_completed_card_has_no_actions():
    card = build_completed_card_payload()
    assert all(element.get("tag") != "action" for element in card["elements"])
