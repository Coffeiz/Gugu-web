"""Phase 4 账户状态检查测试。"""
from __future__ import annotations

from types import SimpleNamespace

from app.core.security import account_is_active


def test_account_status_requires_active_compatibility_state():
    assert account_is_active(SimpleNamespace(is_active=True, account_status="active"))
    assert not account_is_active(SimpleNamespace(is_active=False, account_status="active"))
    assert not account_is_active(SimpleNamespace(is_active=True, account_status="suspended"))
    assert account_is_active(SimpleNamespace(is_active=True))
