from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.datastructures import Headers, URL

from app.api.v1.terminals import _websocket_token
from app.core.security import USER_ACCESS_COOKIE


def _websocket(origin: str, host: str = "example.test:9595"):
    return SimpleNamespace(
        headers=Headers({"origin": origin, "host": host}),
        cookies={USER_ACCESS_COOKIE: "session-token"},
        url=URL(f"http://{host}/api/v1/terminals/example/ws"),
    )


def test_cookie_websocket_accepts_same_origin_with_nonstandard_port():
    websocket = _websocket("http://example.test:9595")

    assert _websocket_token(websocket) == "session-token"


@pytest.mark.parametrize(
    "origin",
    ["http://example.test", "https://example.test:9595", "http://attacker.test:9595"],
)
def test_cookie_websocket_rejects_origin_with_different_authority(origin: str):
    with pytest.raises(HTTPException) as exc_info:
        _websocket_token(_websocket(origin))

    assert exc_info.value.status_code == 403
