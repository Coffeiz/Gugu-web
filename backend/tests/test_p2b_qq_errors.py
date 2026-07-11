"""P2-b qq.py 错误分类/重试测试：4xx 不重试、5xx/429/超时/401 才重试（§1/§4-A/§6）。

不打真实 QQ 服务器；在 _qq_request / _post 边界 mock。
"""
import asyncio

import pytest

from agent.adapters import qq


async def _fake_next_seq(msg_id):
    return 1


# ── _qq_is_transient 分类 ──────────────────────────────────────────────────

def test_transient_classifies_5xx_and_429_as_retryable():
    assert qq._qq_is_transient(qq.QQAPIError("POST", "/x", 500, {"message": "boom"}))
    assert qq._qq_is_transient(qq.QQAPIError("POST", "/x", 502, {}))
    assert qq._qq_is_transient(qq.QQAPIError("POST", "/x", 429, {}))


def test_transient_classifies_401_as_retryable():
    assert qq._qq_is_transient(qq.QQAPIError("POST", "/x", 401, {}))


def test_transient_classifies_permanent_4xx_as_not_retryable():
    assert not qq._qq_is_transient(qq.QQAPIError("POST", "/x", 400, {"message": "bad param"}))
    assert not qq._qq_is_transient(qq.QQAPIError("POST", "/x", 403, {"message": "forbidden"}))


def test_transient_classifies_network_errors_as_retryable():
    assert qq._qq_is_transient(asyncio.TimeoutError())


def test_transient_classifies_generic_exception_as_not_retryable():
    assert not qq._qq_is_transient(RuntimeError("some programming error, e.g. KeyError-like"))


# ── QQAPIError 不把原始响应体拼进 str()（P2-b §5）──────────────────────────

def test_qq_api_error_str_does_not_leak_raw_body():
    exc = qq.QQAPIError("POST", "/v2/users/ou_1/messages", 400,
                         {"code": 11292, "message": "token=super-secret-leaked-value"})
    s = str(exc)
    assert "super-secret-leaked-value" not in s
    assert "status=400" in s


# ── send_c2c：永久错误（4xx，非 401）不重试；瞬时错误重试一次 ─────────────

async def test_send_c2c_does_not_retry_permanent_4xx(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_post(channel_id, openid, text, msg_id):
        calls.append(1)
        raise qq.QQAPIError("POST", "/v2/users/ou_1/messages", 400, {"message": "bad request"})

    monkeypatch.setattr(qq, "_post", fake_post)

    ok = await qq.send_c2c("ou_1", "hi", "msg-1", "bot-perm")

    assert ok is False
    assert len(calls) == 1   # 永久错误只应尝试一次，不做第二次重复发送


async def test_send_c2c_retries_transient_5xx(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_post(channel_id, openid, text, msg_id):
        calls.append(1)
        if len(calls) == 1:
            raise qq.QQAPIError("POST", "/v2/users/ou_1/messages", 503, {"message": "upstream busy"})
        return None

    monkeypatch.setattr(qq, "_post", fake_post)
    monkeypatch.setattr(asyncio, "sleep", _fake_sleep := (lambda *a, **kw: _noop()))

    ok = await qq.send_c2c("ou_1", "hi", "msg-1", "bot-transient")

    assert ok is True
    assert len(calls) == 2


async def _noop():
    return None


# ── send_group：同 send_c2c 的分类逻辑 ──────────────────────────────────────

async def test_send_group_does_not_retry_permanent_4xx(monkeypatch):
    monkeypatch.setattr(qq, "_next_seq", _fake_next_seq)
    calls = []

    async def fake_post_group(channel_id, group_openid, text, msg_id):
        calls.append(1)
        raise qq.QQAPIError("POST", "/v2/groups/g1/messages", 403, {"message": "forbidden"})

    monkeypatch.setattr(qq, "_post_group", fake_post_group)

    ok = await qq.send_group("g1", "hi", "msg-1", "bot-perm")

    assert ok is False
    assert len(calls) == 1


# ── _qq_request：非 2xx 抛 QQAPIError，不把响应体拼进异常字符串 ────────────

async def test_qq_request_raises_qq_api_error_without_raw_body_in_message(monkeypatch):
    class _FakeResp:
        status = 400

        async def json(self, content_type=None):
            return {"code": 11292, "message": "invalid access_token=leaked-secret-token"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class _FakeSession:
        def request(self, method, url, json=None, headers=None, timeout=None):
            return _FakeResp()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(qq, "_send_token", _fake_send_token)
    monkeypatch.setattr(qq.aiohttp, "ClientSession", lambda *a, **kw: _FakeSession())

    with pytest.raises(qq.QQAPIError) as ei:
        await qq._qq_request("bot-1", "POST", "/v2/users/ou_1/messages", json_body={"a": 1})

    assert ei.value.status == 400
    assert "leaked-secret-token" not in str(ei.value)
    assert ei.value.body["message"] == "invalid access_token=leaked-secret-token"   # 原始体仍可供内部判定用


async def _fake_send_token(channel_id):
    return "tok", "https://api.sgroup.qq.com"
