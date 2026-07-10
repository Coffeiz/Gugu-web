"""agent context 的「今天」按用户时区算（Phase 3 收尾）——见 docs/backend/时区与时钟迁移方案.md。

build() 注入系统 prompt 的 {now}/{today} 现在走 user_tz；不传则回退服务器 LOCAL_TZ（向后兼容）。
"""
from datetime import datetime
from zoneinfo import ZoneInfo

from agent.context import builder
from app.core.tz import LOCAL_TZ


def test_build_today_uses_user_tz():
    sh = ZoneInfo("Asia/Shanghai")
    out = builder.build("default", "u", [], [], user_tz=sh)
    assert datetime.now(sh).strftime("%Y-%m-%d") in out   # 用户时区的今天出现在 prompt 里


def test_build_default_falls_back_to_server_tz():
    out = builder.build("default", "u", [], [])            # 不传 user_tz
    assert datetime.now(LOCAL_TZ).strftime("%Y-%m-%d") in out
