from agent.models import AgentResponse

import worker

from agent.adapters import feishu


async def _empty_stream():
    if False:
        yield ("token", "")


def test_make_card_payload_defaults_to_thinking_title_and_streaming_on():
    import json as _json

    data = _json.loads(feishu._make_card_payload("正文"))

    assert data["header"]["title"]["content"] == "咕咕思考中"
    assert data["config"]["streaming_mode"] is True


def test_make_card_payload_supports_final_title_and_streaming_off():
    import json as _json

    data = _json.loads(feishu._make_card_payload("正文", title="咕咕", streaming_mode=False))

    assert data["header"]["title"]["content"] == "咕咕"
    assert data["config"]["streaming_mode"] is False


def test_stream_fallback_text_keeps_real_text():
    assert feishu._stream_fallback_text("这是正文", has_files=False) == "这是正文"
    assert feishu._stream_fallback_text("这是正文", has_files=True) == "这是正文"


def test_stream_fallback_text_when_model_only_calls_tool_with_files():
    # 模型光发文件不说话时 payload.text 是空串——这次踩坑：卡片正文之前会真的是空的
    assert feishu._stream_fallback_text("", has_files=True) == "给你～"


def test_stream_fallback_text_when_model_says_nothing_at_all():
    assert feishu._stream_fallback_text("  ", has_files=False) == "嗯~在的，你说～"


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


async def test_feishu_stream_finalizes_card_after_success(monkeypatch):
    finalized: list[dict] = []
    renamed: list[dict] = []

    async def fake_creds(channel_id):
        return "app_id", "app_secret"

    async def fake_create_card(app_id, app_secret, text):
        return "card_finalize"

    async def fake_send_card(app_id, app_secret, receive_id, card_id):
        return True

    async def fake_update_text(app_id, app_secret, card_id, content, sequence, uuid):
        return True

    async def fake_finalize(app_id, app_secret, card_id, summary_text, sequence, uuid):
        finalized.append({
            "card_id": card_id,
            "summary_text": summary_text,
            "sequence": sequence,
        })
        return True

    async def fake_update_card(app_id, app_secret, card_id, text, *, sequence,
                               title="咕咕思考中", streaming_mode=True):
        renamed.append({"card_id": card_id, "text": text, "sequence": sequence,
                        "title": title, "streaming_mode": streaming_mode})
        return True

    async def token_iter():
        yield ("final", AgentResponse(text="最终文本", session_id=123))

    monkeypatch.setattr(feishu, "_creds_by_id", fake_creds)
    monkeypatch.setattr(feishu, "_do_create_card", fake_create_card)
    monkeypatch.setattr(feishu, "_do_send_card_message", fake_send_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", fake_update_text)
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", fake_finalize)
    monkeypatch.setattr(feishu, "_do_update_card", fake_update_card)
    feishu._card_seq.pop("card_finalize:stream", None)

    ok, resp = await feishu.send_text_stream("oc_test", token_iter(), "bot-1")

    assert ok is True
    assert resp is not None
    assert finalized == [{
        "card_id": "card_finalize",
        "summary_text": "最终文本",
        "sequence": 2,
    }]
    assert renamed == [{
        "card_id": "card_finalize",
        "text": "最终文本",
        "sequence": 3,   # 必须严格大于上面 finalize 用的 sequence=2（同一张卡跨端点共享一套序列）
        "title": "咕咕",
        "streaming_mode": False,
    }]


async def test_feishu_stream_card_not_empty_when_model_only_sends_file(monkeypatch):
    """回归测试：模型调 send_file 工具没配文字说明时，final.text 是空串——之前会真的把
    空字符串 patch 进卡片，用户看到一张空卡片，得追问「发了吗」模型才在下一轮正常说话。"""
    patched: list[str] = []
    finalized: list[str] = []
    renamed: list[str] = []

    async def fake_creds(channel_id):
        return "app_id", "app_secret"

    async def fake_create_card(app_id, app_secret, text):
        return "card_file_only"

    async def fake_send_card(app_id, app_secret, receive_id, card_id):
        return True

    async def fake_update_text(app_id, app_secret, card_id, content, sequence, uuid):
        patched.append(content)
        return True

    async def fake_finalize(app_id, app_secret, card_id, summary_text, sequence, uuid):
        finalized.append(summary_text)
        return True

    async def fake_update_card(app_id, app_secret, card_id, text, *, sequence,
                               title="咕咕思考中", streaming_mode=True):
        renamed.append(text)
        return True

    async def token_iter():
        # 模型只调工具，没有任何 token 输出，final.text 也是空串，但带了文件
        yield ("final", AgentResponse(text="", session_id=123, files=[{"attach_id": "a1"}]))

    monkeypatch.setattr(feishu, "_creds_by_id", fake_creds)
    monkeypatch.setattr(feishu, "_do_create_card", fake_create_card)
    monkeypatch.setattr(feishu, "_do_send_card_message", fake_send_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", fake_update_text)
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", fake_finalize)
    monkeypatch.setattr(feishu, "_do_update_card", fake_update_card)
    feishu._card_seq.pop("card_file_only:stream", None)

    ok, resp = await feishu.send_text_stream("oc_test", token_iter(), "bot-1")

    assert ok is True
    assert patched == ["给你～"]
    assert finalized == ["给你～"]
    assert renamed == ["给你～"]


async def test_feishu_stream_keeps_ok_when_finalize_fails(monkeypatch):
    async def fake_creds(channel_id):
        return "app_id", "app_secret"

    async def fake_create_card(app_id, app_secret, text):
        return "card_finalize_fail"

    async def fake_send_card(app_id, app_secret, receive_id, card_id):
        return True

    async def fake_update_text(app_id, app_secret, card_id, content, sequence, uuid):
        return True

    async def fake_finalize(app_id, app_secret, card_id, summary_text, sequence, uuid):
        return False

    async def fake_update_card(app_id, app_secret, card_id, text, *, sequence,
                               title="咕咕思考中", streaming_mode=True):
        return True

    async def token_iter():
        yield ("final", AgentResponse(text="最终文本", session_id=123))

    monkeypatch.setattr(feishu, "_creds_by_id", fake_creds)
    monkeypatch.setattr(feishu, "_do_create_card", fake_create_card)
    monkeypatch.setattr(feishu, "_do_send_card_message", fake_send_card)
    monkeypatch.setattr(feishu, "_do_streaming_update_text", fake_update_text)
    monkeypatch.setattr(feishu, "_do_finalize_streaming_card", fake_finalize)
    monkeypatch.setattr(feishu, "_do_update_card", fake_update_card)
    feishu._card_seq.pop("card_finalize_fail:stream", None)

    ok, resp = await feishu.send_text_stream("oc_test", token_iter(), "bot-1")

    assert ok is True
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
