"""start_im_activity() 初始化顺序回归测试。

覆盖 code review 发现的竞态：旧顺序 set_state → clear_cancel → mark_active，
网关从 set_state 落地那一刻起就认为会话"正在忙"；如果用户恰好在 set_state 之后、
clear_cancel 之前发"取消"，网关会写入取消标志并回复"取消了"，紧接着 clear_cancel
又把这个刚写入的标志删掉，任务却继续跑——ACK 说取消成功，实际没取消。

正确顺序应该是 clear_cancel → mark_active → set_state：state 只有在清残留、
注册活跃者都做完后才落地为 THINKING，避免"网关已经认为在忙、但我们自己的
清理还没做完"这段窗口。
"""
import pytest

from agent import runtime_state
from agent.gateway import wechat
from agent.im import loop as im_loop


@pytest.mark.asyncio
async def test_start_im_activity_clears_cancel_before_marking_thinking(monkeypatch):
    calls = []

    async def fake_set_state(platform, bot_id, scope_id, puid, state):
        calls.append(("set_state", state))

    async def fake_clear_cancel(platform, bot_id, scope_id, puid):
        calls.append(("clear_cancel",))

    async def fake_mark_active(platform, bot_id, scope_id, puid):
        calls.append(("mark_active",))

    async def fake_start_typing(payload):
        return None

    monkeypatch.setattr(runtime_state, "set_state", fake_set_state, raising=False)
    monkeypatch.setattr(runtime_state, "clear_cancel", fake_clear_cancel, raising=False)
    monkeypatch.setattr(runtime_state, "mark_active", fake_mark_active, raising=False)
    monkeypatch.setattr(wechat, "start_typing", fake_start_typing, raising=False)

    await im_loop.start_im_activity({"channel_id": "bot-1", "chat_id": "chat-1"}, "qq", "puid-1")

    # clear_cancel 必须在 set_state(THINKING) 之前完成——网关最早也要等 set_state
    # 落地才会认为"在忙"，此时残留取消标志早就清干净了，不会被之后误清掉。
    assert [c[0] for c in calls] == ["clear_cancel", "mark_active", "set_state"]
    assert calls[-1] == ("set_state", runtime_state.THINKING)
