import pytest
from starlette.requests import Request
from starlette.responses import Response

from app.core.security import (
    USER_ACCESS_COOKIE,
    USER_CSRF_COOKIE,
    clear_auth_cookies,
    request_auth_token,
    set_auth_cookies,
)


def make_request(method="GET", cookie="", headers=None):
    request_headers = []
    if cookie:
        request_headers.append((b"cookie", cookie.encode()))
    for key, value in (headers or {}).items():
        request_headers.append((key.lower().encode(), value.encode()))
    return Request({
        "type": "http",
        "method": method,
        "path": "/api/v1/test",
        "raw_path": b"/api/v1/test",
        "query_string": b"",
        "headers": request_headers,
        "scheme": "http",
        "server": ("testserver", 80),
        "client": ("testclient", 1234),
    })


def test_auth_cookies_have_browser_safe_defaults():
    response = Response()
    set_auth_cookies(response, "access-token", USER_ACCESS_COOKIE, USER_CSRF_COOKIE, make_request())

    cookies = response.headers.getlist("set-cookie")
    access = next(cookie for cookie in cookies if USER_ACCESS_COOKIE in cookie)
    csrf = next(cookie for cookie in cookies if USER_CSRF_COOKIE in cookie)
    assert "HttpOnly" in access
    assert "HttpOnly" not in csrf
    assert "SameSite=lax" in access
    assert "SameSite=lax" in csrf
    assert "Secure" not in access


def test_cookie_auth_requires_matching_csrf_for_write():
    request = make_request(
        "POST",
        f"{USER_ACCESS_COOKIE}=access-token; {USER_CSRF_COOKIE}=csrf-token",
        {"X-CSRF-Token": "csrf-token"},
    )
    assert request_auth_token(
        request,
        None,
        access_cookie=USER_ACCESS_COOKIE,
        csrf_cookie=USER_CSRF_COOKIE,
    ) == "access-token"

    with pytest.raises(Exception) as exc_info:
        request_auth_token(
            make_request("POST", f"{USER_ACCESS_COOKIE}=access-token; {USER_CSRF_COOKIE}=csrf-token"),
            None,
            access_cookie=USER_ACCESS_COOKIE,
            csrf_cookie=USER_CSRF_COOKIE,
        )
    assert exc_info.value.status_code == 403


def test_bearer_auth_does_not_require_csrf():
    from fastapi.security import HTTPAuthorizationCredentials

    request = make_request("POST")
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="legacy-token")
    assert request_auth_token(
        request,
        credentials,
        access_cookie=USER_ACCESS_COOKIE,
        csrf_cookie=USER_CSRF_COOKIE,
    ) == "legacy-token"


def test_clear_auth_cookies_expires_both_values():
    response = Response()
    clear_auth_cookies(response, USER_ACCESS_COOKIE, USER_CSRF_COOKIE)
    cookies = response.headers.getlist("set-cookie")
    assert any(cookie.startswith(f"{USER_ACCESS_COOKIE}=") and "Max-Age=0" in cookie for cookie in cookies)
    assert any(cookie.startswith(f"{USER_CSRF_COOKIE}=") and "Max-Age=0" in cookie for cookie in cookies)
