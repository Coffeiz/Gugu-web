"""start_im_activity() 初始化回归测试。

Phase 1（reorder）：把 clear_cancel → mark_active → set_state 的顺序做对，堵住了
"网关落地忙态之后才误清用户随后发来的取消标志"这个最糟糕的假成功 ACK。

Phase 2（本文件覆盖，PR13 复审）：即使顺序正确，三条独立 Redis 命令之间仍有极小
窗口——用户恰好在 clear_cancel 执行完、set_state(THINKING) 还没落地前发"取消"，
网关读到的 state 还是上一轮的旧值（通常是 IDLE），会把这句话当普通消息排队而不是
识别成取消。修法是把三步合成一次 Redis 端原子操作（runtime_state.init_activity），
所以这里只需要验证 start_im_activity 确实委托给了 init_activity，且参数正确——
原子性本身的回归测试在 test_runtime_state_scope.py。
"""
import pytest

from agent.runtime import runtime_state
from agent.gateway import wechat
from agent.im import loop as im_loop


@pytest.mark.asyncio
async def test_start_im_activity_delegates_to_atomic_init(monkeypatch):
    calls = []

    async def fake_init_activity(platform, bot_id, scope_id, puid, state):
        calls.append((platform, bot_id, scope_id, puid, state))

    async def fake_start_typing(payload):
        return None

    monkeypatch.setattr(runtime_state, "init_activity", fake_init_activity, raising=False)
    monkeypatch.setattr(wechat, "start_typing", fake_start_typing, raising=False)

    await im_loop.start_im_activity({"channel_id": "bot-1", "chat_id": "chat-1"}, "qq", "puid-1")

    assert calls == [("qq", "bot-1", "chat-1", "puid-1", runtime_state.THINKING)]


@pytest.mark.asyncio
async def test_stop_im_typing_is_idempotent_for_waiting_interaction(monkeypatch):
    calls = []

    async def fake_stop_typing(indicator):
        calls.append(indicator)

    monkeypatch.setattr(wechat, "stop_typing", fake_stop_typing)
    activity = im_loop.ImActivity("wechat", "puid-1", "typing-1")

    await im_loop.stop_im_typing(activity)
    await im_loop.stop_im_typing(activity)

    assert calls == ["typing-1"]
    assert activity.typing_stopped is True
