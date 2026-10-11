"""官方 Bot API 请求只可经固定 HTTPS 主机，且异常不得携带授权 URL。"""

from types import SimpleNamespace

import httpx
import pytest

from app.core.config import SafeEgressSettings
from app.services import telegram_bot_api

TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789"


@pytest.fixture(autouse=True)
def isolate_admin_proxy_settings(monkeypatch):
    monkeypatch.setattr(
        telegram_bot_api,
        "get_settings",
        lambda: SimpleNamespace(safe_egress=SafeEgressSettings()),
    )


@pytest.mark.asyncio
async def test_call_uses_fixed_https_host_and_disables_redirects(monkeypatch):
    observed = {}

    class Response:
        status_code = 200
        is_redirect = False
        is_success = True

        def json(self):
            return {"ok": True, "result": {"id": 9001}}

    class Client:
        def __init__(self, **kwargs):
            observed["client"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def post(self, path, **kwargs):
            observed.update(path=path, request=kwargs)
            return Response()

    monkeypatch.setattr(telegram_bot_api.httpx, "AsyncClient", Client)
    result = await telegram_bot_api.call(TOKEN, "getMe")

    assert result == {"id": 9001}
    assert str(observed["client"]["base_url"]) == "https://api.telegram.org"
    assert observed["client"]["follow_redirects"] is False
    assert observed["client"]["trust_env"] is True
    assert "proxy" not in observed["client"]
    assert observed["path"] == f"/bot{TOKEN}/getMe"
    assert observed["request"]["json"] == {}


@pytest.mark.asyncio
async def test_call_upload_uses_multipart_instead_of_json(monkeypatch):
    observed = {}

    class Response:
        status_code = 200
        is_redirect = False
        is_success = True

        def json(self):
            return {"ok": True, "result": {"message_id": 33}}

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def post(self, path, **kwargs):
            observed.update(path=path, request=kwargs)
            return Response()

    monkeypatch.setattr(telegram_bot_api.httpx, "AsyncClient", Client)
    result = await telegram_bot_api.call(
        TOKEN, "sendPhoto", payload={"chat_id": "-1007002", "disable_notification": False},
        files={"photo": ("sample.png", b"image", "image/png")},
    )

    assert result == {"message_id": 33}
    assert observed["request"]["data"] == {"chat_id": "-1007002", "disable_notification": "false"}
    assert observed["request"]["files"] == {"photo": ("sample.png", b"image", "image/png")}
    assert "json" not in observed["request"]


@pytest.mark.asyncio
async def test_download_file_streams_from_fixed_host_and_enforces_path_boundary(monkeypatch):
    observed = {}

    class Response:
        status_code = 200
        is_redirect = False
        is_success = True
        headers = {"Content-Length": "4"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def aiter_bytes(self, _size):
            yield b"da"
            yield b"ta"

    class Client:
        def __init__(self, **kwargs):
            observed["client"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        def stream(self, method, path):
            observed.update(method=method, path=path)
            return Response()

    monkeypatch.setattr(telegram_bot_api.httpx, "AsyncClient", Client)
    data = await telegram_bot_api.download_file(TOKEN, "documents/file.txt", max_bytes=4)

    assert data == b"data"
    assert observed["method"] == "GET"
    assert observed["path"] == f"/file/bot{TOKEN}/documents/file.txt"
    assert observed["client"]["follow_redirects"] is False


@pytest.mark.asyncio
async def test_download_file_rejects_path_traversal_before_request(monkeypatch):
    class UnexpectedClient:
        def __init__(self, **_kwargs):
            raise AssertionError("unsafe path must not create an HTTP client")

    monkeypatch.setattr(telegram_bot_api.httpx, "AsyncClient", UnexpectedClient)
    with pytest.raises(telegram_bot_api.TelegramBotApiError):
        await telegram_bot_api.download_file(TOKEN, "../private/file", max_bytes=1024)


@pytest.mark.asyncio
async def test_call_uses_admin_proxy_without_environment_fallback_when_enabled(monkeypatch):
    observed = {}
    proxy = object()

    class Response:
        status_code = 200
        is_redirect = False
        is_success = True

        def json(self):
            return {"ok": True, "result": {"id": 9001}}

    class Client:
        def __init__(self, **kwargs):
            observed["client"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(
        telegram_bot_api,
        "get_settings",
        lambda: SimpleNamespace(safe_egress=SafeEgressSettings(
            enabled=True, proxy_url="http://proxy.example:3128",
        )),
    )
    monkeypatch.setattr(telegram_bot_api, "build_httpx_proxy", lambda _settings: proxy)
    monkeypatch.setattr(telegram_bot_api.httpx, "AsyncClient", Client)

    await telegram_bot_api.call(TOKEN, "getMe")

    assert observed["client"]["proxy"] is proxy
    assert observed["client"]["trust_env"] is False
    assert observed["client"]["follow_redirects"] is False


@pytest.mark.asyncio
async def test_invalid_enabled_proxy_fails_closed_without_direct_request(monkeypatch):
    monkeypatch.setattr(
        telegram_bot_api,
        "get_settings",
        lambda: SimpleNamespace(safe_egress=SafeEgressSettings(
            enabled=True, proxy_url="invalid",
        )),
    )
    def invalid_proxy(_settings):
        raise ValueError("invalid proxy")

    monkeypatch.setattr(telegram_bot_api, "build_httpx_proxy", invalid_proxy)

    class UnexpectedClient:
        def __init__(self, **_kwargs):
            raise AssertionError("an invalid enabled proxy must not fall back to direct access")

    monkeypatch.setattr(telegram_bot_api.httpx, "AsyncClient", UnexpectedClient)
    with pytest.raises(telegram_bot_api.TelegramBotApiError) as raised:
        await telegram_bot_api.call(TOKEN, "getMe")

    assert TOKEN not in str(raised.value)


@pytest.mark.asyncio
async def test_network_exception_does_not_retain_token_or_request_url(monkeypatch):
    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def post(self, path, **_kwargs):
            raise httpx.ConnectError(f"failed: https://api.telegram.org{path}")

    monkeypatch.setattr(telegram_bot_api.httpx, "AsyncClient", Client)
    with pytest.raises(telegram_bot_api.TelegramBotApiError) as raised:
        await telegram_bot_api.call(TOKEN, "getMe")

    assert TOKEN not in str(raised.value)
    assert "api.telegram.org" not in str(raised.value)


@pytest.mark.asyncio
async def test_redirect_response_is_rejected_without_following_or_echoing_location(monkeypatch):
    class Response:
        status_code = 302
        is_redirect = True
        is_success = False

    class Client:
        def __init__(self, **kwargs):
            assert kwargs["follow_redirects"] is False

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def post(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(telegram_bot_api.httpx, "AsyncClient", Client)
    with pytest.raises(telegram_bot_api.TelegramBotApiError) as raised:
        await telegram_bot_api.call(TOKEN, "getMe")

    assert TOKEN not in str(raised.value)
    assert raised.value.status_code == 302
