from agent.core import _inject_pending_confirmation


def test_server_confirmation_token_overwrites_model_token():
    payload, consumed = _inject_pending_confirmation(
        {"to": "user@example.com", "confirm": True, "confirm_token": "模型带来的旧 token"},
        None,
        {"tool_name": "send_email", "confirm_token": "服务端刚签发的 token"},
    )

    assert consumed is True
    assert payload["confirm"] is True
    assert payload["confirm_token"] == "服务端刚签发的 token"
