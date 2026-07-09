from agent.models import AgentResponse

import worker

from agent.adapters import feishu


async def _empty_stream():
    if False:
        yield ("token", "")


async def test_feishu_stream_returns_tuple_when_creds_missing(monkeypatch):
    async def fake_creds(channel_id):
        return "", ""

    monkeypatch.setattr(feishu, "_creds_by_id", fake_creds)

    result = await feishu.send_text_stream("oc_test", _empty_stream(), "bot-missing")

    assert result == (False, None)


async def test_feishu_stream_reports_patch_failure(monkeypatch):
    async def fake_creds(channel_id):
        return "app_id", "app_secret"

    async def fake_create_card(app_id, app_secret, text):
        return "card_1"

    async def fake_send_card(app_id, app_secret, receive_id, card_id):
        return True

    async def fake_update_text(app_id, app_secret, card_id, content, sequence, uuid):
        raise RuntimeError("patch failed")

    async def token_iter():
        yield ("token", "x" * 31)
        yield ("final", AgentResponse(text="最终文本", session_id=123))

    monkeypatch.setattr(feishu, "_creds_by_id", fake_creds)
    monkeypatch.setattr(feishu, "_do_create_card", fake_create_card)
    monkeypatch.setattr(feishu, "_do_send_card_message", fake_send_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", fake_update_text)

    ok, resp = await feishu.send_text_stream("oc_test", token_iter(), "bot-1")

    assert ok is False
    assert resp is not None
    assert resp.text == "最终文本"


async def test_worker_feishu_falls_back_to_text_when_stream_failed(monkeypatch):
    sent_texts: list[str] = []

    async def fake_resolve_user(payload):
        return 1, "测试用户"

    async def fake_get_session(platform, puid):
        return None

    async def fake_set_session(platform, puid, session_id):
        return None

    async def fake_send(payload, text):
        sent_texts.append(text)

    async def fake_send_files(payload, files):
        return None

    async def fake_run_stream(req):
        if False:
            yield ("token", "")

    async def fake_send_text_stream(receive_id, token_iter, channel_id=None):
        return False, AgentResponse(text="最终文本", session_id=456, tokens_in=1, tokens_out=2)

    async def fake_command(user_id, text):
        return None

    async def fake_start_typing(payload):
        return None

    async def fake_stop_typing(indicator):
        return None

    async def fake_async_noop(*args, **kwargs):
        return None

    monkeypatch.setattr(worker, "_resolve_user", fake_resolve_user)
    monkeypatch.setattr(worker, "_im_session_get", fake_get_session)
    monkeypatch.setattr(worker, "_im_session_set", fake_set_session)
    monkeypatch.setattr(worker, "_send", fake_send)
    monkeypatch.setattr(worker, "_send_files", fake_send_files)

    from agent import commands, runtime_state
    from agent.adapters import feishu as feishu_mod
    from agent.adapters import wechat
    from agent.runner import run_stream as real_run_stream
    import agent.runner as runner_mod
    import app.scheduled_tasks as schedtasks

    monkeypatch.setattr(commands, "handle", fake_command)
    monkeypatch.setattr(runtime_state, "set_state", fake_async_noop)
    monkeypatch.setattr(runtime_state, "clear_state", fake_async_noop)
    monkeypatch.setattr(runtime_state, "clear_cancel", fake_async_noop)
    monkeypatch.setattr(runtime_state, "set_awaiting", fake_async_noop)
    monkeypatch.setattr(wechat, "start_typing", fake_start_typing)
    monkeypatch.setattr(wechat, "stop_typing", fake_stop_typing)
    monkeypatch.setattr(schedtasks, "save_imreach", fake_async_noop)
    monkeypatch.setattr(runner_mod, "run_stream", fake_run_stream)
    monkeypatch.setattr(feishu_mod, "send_text_stream", fake_send_text_stream)

    payload = {
        "platform": "feishu",
        "platform_user_id": "ou_test",
        "chat_id": "oc_test",
        "channel_id": "bot-1",
        "message_id": "msg-1",
        "text": "你好",
    }
    resp = await worker.handle("1-0", payload)

    assert resp.text == "最终文本"
    assert sent_texts == ["最终文本"]
    assert real_run_stream is not fake_run_stream
