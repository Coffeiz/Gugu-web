from types import SimpleNamespace

import json

from agent.gateway import feishu


def _feishu_event(message_id: str = "om_test", app_id: str = "cli_expected", age_ms: int = 0):
    now_ms = 1_800_000_000_000
    message = SimpleNamespace(
        message_id=message_id,
        message_type="text",
        content=json.dumps({"text": "普通消息"}, ensure_ascii=False),
        parent_id="",
        chat_id="oc_test",
        chat_type="p2p",
    )
    sender = SimpleNamespace(sender_id=SimpleNamespace(open_id="ou_test"))
    return SimpleNamespace(
        header=SimpleNamespace(app_id=app_id, create_time=str(now_ms - age_ms)),
        event=SimpleNamespace(message=message, sender=sender),
    )


def test_feishu_drops_misrouted_app_id():
    data = _feishu_event(app_id="cli_other")

    assert feishu._drop_misrouted_event(data, "cli_expected", "bot-1") is True
    assert feishu._drop_misrouted_event(data, "cli_other", "bot-1") is False


def test_feishu_drops_stale_retry():
    data = _feishu_event(age_ms=feishu._FEISHU_STALE_MSG_THRESHOLD_MS + 1)

    assert feishu._drop_stale_event(data, "bot-1", now_ms=1_800_000_000_000) is True


def test_feishu_keeps_fresh_retry_window():
    data = _feishu_event(age_ms=feishu._FEISHU_STALE_MSG_THRESHOLD_MS)

    assert feishu._drop_stale_event(data, "bot-1", now_ms=1_800_000_000_000) is False


def test_feishu_gateway_deduplicates_message_id(monkeypatch):
    produced: list[dict] = []
    _seen: set = set()

    def fake_produce_sync(stream, payload):
        # 模拟 R._dedup_check 的 Redis SETNX 行为：新架构下 feishu 入口不做去重，
        # 去重统一在 R 层（test_im_dedup.py 单测覆盖）。这里只测 feishu 入口透传 message_id。
        if payload["message_id"] in _seen:
            return None
        _seen.add(payload["message_id"])
        produced.append(payload)

    def fake_do_react(client, message_id, emoji_type):
        return True

    monkeypatch.setattr(feishu.R, "produce_sync", fake_produce_sync)
    monkeypatch.setattr(feishu, "_do_react", fake_do_react)

    from agent import router, runtime_state

    monkeypatch.setattr(router, "decide", lambda *args, **kwargs: {"action": "run"})
    monkeypatch.setattr(runtime_state, "get_state_sync", lambda *args, **kwargs: None)
    monkeypatch.setattr(runtime_state, "is_awaiting_sync", lambda *args, **kwargs: False)

    handler = feishu._make_on_message("bot-1", "user-1", object(), expected_app_id="cli_expected")
    data = _feishu_event(message_id="om_duplicate")

    handler(data)
    handler(data)

    assert len(produced) == 1
    assert produced[0]["message_id"] == "om_duplicate"


def test_feishu_message_still_reaches_stream_when_shortcut_redis_fails(monkeypatch):
    produced: list[dict] = []

    def fake_produce_sync(_stream, payload):
        produced.append(payload)

    def fail_state(*_args, **_kwargs):
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(feishu.R, "produce_sync", fake_produce_sync)
    monkeypatch.setattr(feishu, "_do_react", lambda *_args, **_kwargs: True)
    monkeypatch.setattr("agent.runtime_state.get_state_sync", fail_state)

    handler = feishu._make_on_message("bot-1", "user-1", object(), expected_app_id="cli_expected")
    handler(_feishu_event(message_id="om_shortcut_redis_failure"))

    assert len(produced) == 1
    assert produced[0]["platform"] == "feishu"
