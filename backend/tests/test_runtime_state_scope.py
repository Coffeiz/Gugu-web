"""runtime_state 会话作用域隔离回归测试。

覆盖 PR #10 复审提出的 P1 跨群取消问题：
- A 群任务 + B 群发取消 → A 不受影响（取消标志按 scope 隔离）
- A 群任务 + A 群本人取消 → A 被取消
- 同 puid 不同 scope → cancel/clear_cancel 互不影响

以及 P2 agentactive TTL（mark_active 设置 EXPIRE、set_state 刷新 heartbeat）。
"""
import pytest

from agent import runtime_state as rt


class _FakeRedis:
    """内存版 Redis 客户端，覆盖 runtime_state 用到的命令。"""

    def __init__(self):
        self.values = {}      # key -> value
        self.sets = {}        # key -> set
        self.ttls = {}        # key -> ttl（仅记录，不真正倒计时）

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, ex=None):
        self.values[key] = value
        if ex is not None:
            self.ttls[key] = ex

    async def delete(self, key):
        self.values.pop(key, None)
        self.sets.pop(key, None)
        self.ttls.pop(key, None)

    async def sadd(self, key, member):
        self.sets.setdefault(key, set()).add(member)

    async def srem(self, key, member):
        if key in self.sets:
            self.sets[key].discard(member)

    async def smembers(self, key):
        return self.sets.get(key, set())

    async def expire(self, key, ttl):
        self.ttls[key] = ttl


@pytest.fixture
def fake_redis(monkeypatch):
    redis = _FakeRedis()
    monkeypatch.setattr(rt, "get_redis", lambda: redis)
    monkeypatch.setattr(rt, "get_redis_sync", lambda: redis)
    return redis


# ── P1：取消标志按会话作用域隔离 ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_cancel_in_other_scope_does_not_cancel_this_scope(fake_redis):
    """A 群任务 + B 群发取消 → A 不受影响。"""
    # A 群：用户 P 发起任务，进入 thinking
    await rt.set_state("qq", "bot-a", "group-a", "P", rt.THINKING)
    await rt.mark_active("qq", "bot-a", "group-a", "P")

    # B 群：用户 P 发「取消」→ 只写 B 群的取消标志
    await rt.request_cancel("qq", "bot-b", "group-b", "P")

    # A 群任务不应被取消
    assert not await rt.is_cancelled("qq", "bot-a", "group-a", "P")
    # B 群自己的取消标志已置上
    assert await rt.is_cancelled("qq", "bot-b", "group-b", "P")


@pytest.mark.asyncio
async def test_cancel_in_same_scope_cancels_this_scope(fake_redis):
    """A 群任务 + A 群本人取消 → A 被取消。"""
    await rt.set_state("qq", "bot-a", "group-a", "P", rt.THINKING)
    await rt.mark_active("qq", "bot-a", "group-a", "P")

    await rt.request_cancel("qq", "bot-a", "group-a", "P")

    assert await rt.is_cancelled("qq", "bot-a", "group-a", "P")


@pytest.mark.asyncio
async def test_cancel_clear_cancel_isolated_per_scope(fake_redis):
    """同 puid 不同 scope → cancel/clear_cancel 互不影响。"""
    await rt.request_cancel("qq", "bot-a", "group-a", "P")
    await rt.request_cancel("qq", "bot-b", "group-b", "P")

    # 清 A 群的取消，不影响 B 群
    await rt.clear_cancel("qq", "bot-a", "group-a", "P")
    assert not await rt.is_cancelled("qq", "bot-a", "group-a", "P")
    assert await rt.is_cancelled("qq", "bot-b", "group-b", "P")


@pytest.mark.asyncio
async def test_state_isolated_per_scope(fake_redis):
    """状态也按 scope 隔离：B 群读不到 A 群的 thinking。"""
    await rt.set_state("qq", "bot-a", "group-a", "P", rt.THINKING)
    # B 群（不同 scope）读状态应为 IDLE，不会误判 busy
    assert await rt.get_state("qq", "bot-b", "group-b", "P") == rt.IDLE
    assert await rt.get_state("qq", "bot-a", "group-a", "P") == rt.THINKING


# ── P2：agentactive TTL ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mark_active_sets_ttl(fake_redis):
    """mark_active 应给活跃集合设置 TTL 兜底（worker 崩溃后自动过期清空幽灵任务）。"""
    await rt.mark_active("qq", "bot-a", "group-a", "P")
    key = rt._active_key("qq", "bot-a", "group-a")
    assert key in fake_redis.ttls
    assert fake_redis.ttls[key] == rt.ACTIVE_TTL


@pytest.mark.asyncio
async def test_set_state_refreshes_active_ttl(fake_redis):
    """set_state 应刷新活跃集合 TTL（heartbeat），长任务不会跑超 TTL 被误判空闲。"""
    await rt.mark_active("qq", "bot-a", "group-a", "P")
    key = rt._active_key("qq", "bot-a", "group-a")
    fake_redis.ttls[key] = 1   # 模拟 TTL 快耗尽
    await rt.set_state("qq", "bot-a", "group-a", "P", rt.THINKING)
    assert fake_redis.ttls[key] == rt.ACTIVE_TTL
