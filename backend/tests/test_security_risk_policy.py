"""Phase 2 Redis 短窗口计数与策略边界测试。"""
from __future__ import annotations

from types import SimpleNamespace

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

    async def get(self, key):
        return self.counts.get(key)


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
    assert decision.suspend_duration_seconds == 600


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


async def test_policy_enforces_configured_throttle(monkeypatch):
    redis = _Redis()
    monkeypatch.setattr(policy, "get_redis", lambda: redis)
    monkeypatch.setattr(policy, "_DISABLED", False)
    monkeypatch.setattr(policy, "security_fingerprint", lambda value: str(value))

    for _ in range(policy.THROTTLE_THRESHOLD):
        await policy.register_ownership_denial(user_id="user-a", force=True)

    assert await policy.is_user_throttled("user-a", force=True) is True

    try:
        await policy.enforce_user_throttle("user-a", force=True)
    except Exception as exc:
        assert exc.status_code == 429
    else:
        raise AssertionError("达到阈值后必须拒绝请求")


async def test_policy_fails_open_when_throttle_check_redis_is_unavailable(monkeypatch):
    class _Unavailable:
        async def get(self, _key):
            raise ConnectionError("redis unavailable")

    monkeypatch.setattr(policy, "get_redis", lambda: _Unavailable())
    monkeypatch.setattr(policy, "_DISABLED", False)
    assert await policy.is_user_throttled("user-a", force=True) is False


async def test_policy_uses_runtime_security_configuration(monkeypatch):
    redis = _Redis()
    monkeypatch.setattr(policy, "get_redis", lambda: redis)
    monkeypatch.setattr(policy, "_DISABLED", False)
    monkeypatch.setattr(policy, "security_fingerprint", lambda value: str(value))
    monkeypatch.setattr(
        policy,
        "get_settings",
        lambda: SimpleNamespace(
            security=SimpleNamespace(
                ownership_window_seconds=90,
                ownership_throttle_threshold=2,
                ownership_suspend_threshold=3,
                ownership_suspend_duration_seconds=1234,
                ownership_auto_response_enabled=False,
            )
        ),
    )

    decision = await policy.register_ownership_denial(user_id="user-a", force=True)
    assert decision.action == "logged"
    decision = await policy.register_ownership_denial(user_id="user-a", force=True)
    assert decision.action == "throttled"
    decision = await policy.register_ownership_denial(user_id="user-a", force=True)
    assert decision.action == "suspended"
    assert decision.suspend_duration_seconds == 1234


async def test_auto_suspend_uses_configured_duration(db, user_a, monkeypatch):
    monkeypatch.setattr(
        policy,
        "get_settings",
        lambda: SimpleNamespace(
            security=SimpleNamespace(
                ownership_window_seconds=300,
                ownership_throttle_threshold=5,
                ownership_suspend_threshold=10,
                ownership_suspend_duration_seconds=1234,
                ownership_auto_response_enabled=True,
            )
        ),
    )
    decision = policy.RiskDecision(10, None, None, "suspended", True, 1234)

    assert await policy.apply_risk_decision(user_a.id, decision) is True
    await db.refresh(user_a)
    assert user_a.account_status == "suspended"
    assert user_a.is_active is False
