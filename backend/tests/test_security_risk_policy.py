"""Phase 2 Redis 短窗口计数与策略边界测试。"""
from __future__ import annotations

import app.security.risk_policy as policy


class _Pipeline:
    def __init__(self, redis):
        self.redis = redis
        self.commands = []

    def incr(self, key):
        self.commands.append(("incr", key))
        return self

    def expire(self, key, seconds, nx=False):
        self.commands.append(("expire", key, seconds, nx))
        return self

    async def execute(self):
        result = []
        for command in self.commands:
            if command[0] == "incr":
                self.redis.counts[command[1]] = self.redis.counts.get(command[1], 0) + 1
                result.append(self.redis.counts[command[1]])
            else:
                result.append(True)
        return result


class _Redis:
    def __init__(self):
        self.counts = {}

    def pipeline(self, transaction=True):
        return _Pipeline(self)


async def test_policy_thresholds_and_first_write_ttl(monkeypatch, user_a):
    redis = _Redis()
    monkeypatch.setattr(policy, "get_redis", lambda: redis)
    monkeypatch.setattr(policy, "_DISABLED", False)
    monkeypatch.setattr(policy, "security_fingerprint", lambda value: str(value))

    decision = None
    for _ in range(policy.THROTTLE_THRESHOLD):
        decision = await policy.register_ownership_denial(user_id=user_a.id, force=True)
    assert decision is not None
    assert decision.user_count == 5
    assert decision.action == "throttled"
    assert decision.applied is False

    for _ in range(policy.SUSPEND_THRESHOLD - policy.THROTTLE_THRESHOLD):
        decision = await policy.register_ownership_denial(user_id=user_a.id, force=True)
    assert decision.user_count == 10
    assert decision.action == "suspended"
    assert decision.applied is False


async def test_policy_counts_client_and_ip_separately(monkeypatch):
    redis = _Redis()
    monkeypatch.setattr(policy, "get_redis", lambda: redis)
    monkeypatch.setattr(policy, "_DISABLED", False)
    monkeypatch.setattr(policy, "security_fingerprint", lambda value: str(value))

    decision = await policy.register_ownership_denial(
        user_id="user-a", client_id="client-a", ip_address="192.0.2.1", force=True,
    )
    assert decision == policy.RiskDecision(1, 1, 1, "logged", False)
    assert redis.counts["security:ownership-denied:user:user-a"] == 1
    assert redis.counts["security:ownership-denied:client:client-a"] == 1
    assert redis.counts["security:ownership-denied:ip:192.0.2.1"] == 1


async def test_policy_fails_open_when_redis_is_unavailable(monkeypatch):
    async def fail(_key):
        raise ConnectionError("redis unavailable")

    monkeypatch.setattr(policy, "_increment", fail)
    monkeypatch.setattr(policy, "_DISABLED", False)
    assert await policy.register_ownership_denial(user_id="user-a", force=True) is None
