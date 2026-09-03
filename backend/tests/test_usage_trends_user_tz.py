"""/auth/usage/trends 按用户时区归日回归测试。

服务器时区（LOCAL_TZ）与用户时区不同时，「某天」的边界必须按 User.timezone
（user_tz）算。用东京（UTC+9）用户与 UTC+8 服务器的差异行构造判别用例：
2026-09-01T15:30Z 在东京已是 09-02 00:30（计入 09/02），在 UTC+8 还是 09-01
（旧实现会把它落到窗口外的 09-01 而丢失）。
"""
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.api.v1 import auth as auth_api


async def _fake_detail(db, user_id, since):
    return [
        # 东京 09-02 00:30 / UTC+8 09-01 23:30 —— 判别行；(tin, cache_read, cache_write, tout)
        (datetime(2026, 9, 1, 15, 30, tzinfo=timezone.utc), 100, 40, 3, 5),
        # 东京 09-03 12:00 —— 常规行
        (datetime(2026, 9, 3, 3, 0, tzinfo=timezone.utc), 10, 0, 0, 2),
    ]


@pytest.mark.asyncio
async def test_usage_trends_groups_days_by_user_timezone(monkeypatch):
    fixed_now = datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(auth_api, "now_utc", lambda: fixed_now)
    monkeypatch.setattr("app.services.account_queries.byok_usage_detail", _fake_detail)

    user = SimpleNamespace(id="u1", timezone="Asia/Tokyo")
    result = await auth_api.get_usage_trends(days=3, current_user=user, db=None)

    assert result["labels"] == ["09/01", "09/02", "09/03"]
    # 判别行计入用户时区的 09/02，而不是被服务器时区判成窗口外丢弃
    assert result["tokens_in"] == [0, 100, 10]
    assert result["cache_read"] == [0, 40, 0]
    assert result["tokens_out"] == [0, 5, 2]
    assert result["today"] == 12
    # cache_write 计入 total 但不单独成序列
    assert result["total"] == 160
