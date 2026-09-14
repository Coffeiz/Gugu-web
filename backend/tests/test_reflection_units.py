"""agent/memory/reflection.py 单元补测（CRAP 治理 P1）。

覆盖：错读记录归一（_misperc_llm）、上一轮缓存读写闸门、感知遥测双通道落盘（_emit_perc）、
群主/owner 反思缓冲的原子取走与失败回滚、schedule 的入口分流。
Redis 走 conftest fakeredis 或结构化 fake（lock 语义），reflect/LLM 一律打桩。
"""
import asyncio
import json
from types import SimpleNamespace

import pytest


class _FakeLock:
    def __init__(self, acquirable=True):
        self._acquirable = acquirable
        self.released = False

    async def acquire(self, blocking=False):
        return self._acquirable

    async def release(self):
        self.released = True


class _FakeRedis:
    """结构化 fake：覆盖 buffer/lock/zset 口径（与 test_reflection_threshold 同款）。"""

    def __init__(self, *, acquirable=True):
        self.lists = {}
        self.zsets = {}
        self.lock_obj = _FakeLock(acquirable=acquirable)

    def lock(self, _key, timeout=None):
        return self.lock_obj

    async def rpush(self, key, *values):
        self.lists.setdefault(key, []).extend(values)
        return len(self.lists[key])

    async def lrange(self, key, start, end):
        values = self.lists.get(key, [])
        return values[start:] if end == -1 else values[start:end + 1]

    async def llen(self, key):
        return len(self.lists.get(key, []))

    async def delete(self, key):
        self.lists.pop(key, None)

    async def zadd(self, key, values):
        self.zsets.setdefault(key, {}).update(values)

    async def zrem(self, key, *members):
        z = self.zsets.get(key, {})
        for m in members:
            z.pop(m, None)


def _seed_rows(redis, key, rows):
    redis.lists[key] = [json.dumps(r, ensure_ascii=False) for r in rows]


# ── _misperc_llm：纠正 → 脱敏错读记录 ──────────────────────────────────────

def test_misperc_llm_guards_and_enum_sanitization():
    from agent.memory.reflection import _misperc_llm

    assert _misperc_llm("u1", None) is None
    assert _misperc_llm("u1", "不是 dict") is None
    assert _misperc_llm("u1", {"is_correction": False}) is None

    rec = _misperc_llm("user-12345678", {"is_correction": True, "kind": "不认识的类型"})
    assert rec["kind"] == "未判" and rec["via"] == "llm" and rec["u"] == "user-123"
    assert "miss" not in rec

    rec = _misperc_llm("u1", {"is_correction": True, "kind": "感知误读", "miss": {
        "read_as": "执行", "actual": "不认识的", "pattern": "情绪当任务"}})
    assert rec["miss"] == {"read_as": "执行", "actual": "其他", "pattern": "情绪当任务"}

    rec = _misperc_llm("u1", {"is_correction": True, "kind": "数据或执行错",
                              "miss": {"read_as": "x", "actual": "y", "pattern": "z"}})
    assert "miss" not in rec                    # 全枚举外 → 无信息不记

    rec = _misperc_llm("u1", {"is_correction": True, "kind": "感知误读",
                              "miss": "不是 dict"})
    assert "miss" not in rec


# ── 上一轮缓存（session 闸）────────────────────────────────────────────────

async def test_read_write_last_turn_session_gate_and_guards():
    from agent.memory import reflection
    from app.core import redis as R

    assert await reflection._read_last_turn("u1", "s1") is None      # 无缓存

    await reflection._write_last_turn("u1", "用户的话", "咕咕的话", session_id="s1")
    assert await reflection._read_last_turn("u1", "s1") == {"u": "用户的话", "a": "咕咕的话"}
    assert await reflection._read_last_turn("u1", "s2") is None      # 换会话不延续
    assert await reflection._read_last_turn("u1") == {"u": "用户的话", "a": "咕咕的话"}  # 无闸

    await reflection._write_last_turn("u1", "长" * 300, "回" * 400, session_id=None)
    raw = json.loads(await R.get_redis().get("lastturn:u1"))
    assert len(raw["u"]) == 200 and len(raw["a"]) == 300 and raw["sid"] == ""

    await R.get_redis().set("lastturn:u1", "{broken")
    assert await reflection._read_last_turn("u1") is None            # 坏 JSON
    await R.get_redis().set("lastturn:u1", json.dumps([1]))
    assert await reflection._read_last_turn("u1") is None            # 非 dict


async def test_write_last_turn_swallows_redis_failure(monkeypatch):
    from agent.memory import reflection

    class Boom:
        async def set(self, *a, **k):
            raise RuntimeError("down")

    monkeypatch.setattr("app.core.redis.get_redis", lambda: Boom())
    await reflection._write_last_turn("u1", "a", "b", session_id="s")   # 不抛


# ── _emit_perc：日志 + capped list + 错读 md 三通道 ────────────────────────

async def test_emit_perc_pushes_and_caps_and_persists_misread(monkeypatch):
    from agent.memory import reflection

    assert await reflection._emit_perc(None) is None                 # 空记录 no-op

    saved = []

    async def fake_append(entry_md):
        saved.append(entry_md)

    monkeypatch.setattr(reflection, "store", SimpleNamespace(append_misread=fake_append))
    monkeypatch.setattr(reflection, "_PERC_CAP", 2)
    monkeypatch.setattr(reflection, "_MISREAD_CAP", 1)

    rec = {"t": "perc", "u": "u1", "intent": "闲聊", "ts": 1757830000.0}
    await reflection._emit_perc(rec)
    await reflection._emit_perc(rec)
    await reflection._emit_perc(rec)
    from app.core import redis as R
    events = await R.get_redis().lrange(reflection._PERC_KEY, 0, -1)
    assert len(events) == 2                                          # capped list 裁到 2

    misperc = {"t": "misperc", "u": "u1", "kind": "感知误读", "via": "llm",
               "ts": 1757830000.0,
               "miss": {"read_as": "执行", "actual": "闲聊", "pattern": "答非所问"}}
    await reflection._emit_perc(misperc)
    cases = await R.get_redis().lrange(reflection._MISREAD_KEY, 0, -1)
    assert len(cases) == 1 and "感知误读" in cases[0]
    assert len(saved) == 1 and "读成：执行" in saved[0] and "实际：闲聊" in saved[0]

    # Redis 打点失败不影响反思，md 追加失败也不影响
    class Boom:
        async def lpush(self, *a, **k):
            raise RuntimeError("down")

        async def ltrim(self, *a, **k):
            raise RuntimeError("down")

    monkeypatch.setattr("app.core.redis.get_redis", lambda: Boom())

    async def boom_append(_md):
        raise RuntimeError("down")

    monkeypatch.setattr(reflection, "store", SimpleNamespace(append_misread=boom_append))
    await reflection._emit_perc(misperc)                             # 全通道失败也不抛


# ── 群主缓冲的原子取走与失败回滚 ───────────────────────────────────────────

async def test_drain_group_owner_buffer_happy_and_rollback(monkeypatch):
    from agent.memory import reflection

    rows = [
        {"user_name": "小北", "user_msg": "帮我看下", "assistant_reply": "在看", "session_id": "s1"},
        {"user_name": "小北", "user_msg": "好了没", "assistant_reply": "好了", "session_id": "s1"},
    ]
    reflected = []

    async def fake_reflect(user_id, user_name, user_msg, assistant_reply, settings, **kw):
        reflected.append((user_id, user_name, user_msg, assistant_reply, kw["turns"]))
        return True

    monkeypatch.setattr(reflection, "reflect", fake_reflect)
    settings = SimpleNamespace(agent=SimpleNamespace(reflection_threshold=10))

    # 锁被占 → 直接放弃本轮
    busy_redis = _FakeRedis(acquirable=False)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: busy_redis)
    await reflection._drain_group_owner_buffer("u1", settings)
    assert reflected == []

    redis = _FakeRedis()
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    key = reflection._owner_group_buffer_key("u1")
    _seed_rows(redis, key, rows)
    redis.zsets[reflection._GROUP_OWNER_IDLE_KEY] = {"u1": 1.0}

    await reflection._drain_group_owner_buffer("u1", settings)
    assert reflected[0][2] == "帮我看下\n好了没"
    assert reflected[0][4] == rows
    assert key not in redis.lists                                    # 缓冲被原子取走
    assert "u1" not in redis.zsets.get(reflection._GROUP_OWNER_IDLE_KEY, {})
    assert redis.lock_obj.released

    # reflect 失败 → 行放回 + 重新登记 idle
    async def failing_reflect(*a, **k):
        return False

    monkeypatch.setattr(reflection, "reflect", failing_reflect)
    _seed_rows(redis, key, rows)                                    # 首次 drain 已消费空，重新播种
    await reflection._drain_group_owner_buffer("u1", settings)
    assert len(redis.lists[key]) == 2                                # 原样放回
    assert redis.zsets[reflection._GROUP_OWNER_IDLE_KEY]["u1"] > 0

    # 空缓冲 → 只清 idle 登记
    redis.lists.pop(key, None)
    await reflection._drain_group_owner_buffer("u1", settings)
    assert "u1" not in redis.zsets.get(reflection._GROUP_OWNER_IDLE_KEY, {})


async def test_drain_owner_reflection_buffer_rollback_keeps_turns(monkeypatch):
    from agent.memory import reflection

    rows = [{"user_name": "小北", "user_msg": "m1", "assistant_reply": "r1", "session_id": "s1"},
            {"user_name": "小北", "user_msg": "m2", "assistant_reply": "r2", "session_id": "s2"}]
    reflected = []

    async def fake_reflect(user_id, user_name, user_msg, assistant_reply, settings, **kw):
        reflected.append((user_id, user_msg, assistant_reply, kw["session_id"], kw["turns"]))
        return True

    monkeypatch.setattr(reflection, "reflect", fake_reflect)
    redis = _FakeRedis()
    monkeypatch.setattr("app.core.redis.get_redis", lambda: redis)
    key = reflection._owner_reflection_buffer_key("u1")
    _seed_rows(redis, key, rows)
    settings = SimpleNamespace(agent=SimpleNamespace(reflection_threshold=10))

    await reflection._drain_owner_reflection_buffer("u1", settings)
    assert reflected[0][1] == "m1\nm2"
    assert reflected[0][3] == "s2"                                   # 取最后一行的 session
    assert reflected[0][4] == rows

    async def failing_reflect(*a, **k):
        return False

    monkeypatch.setattr(reflection, "reflect", failing_reflect)
    _seed_rows(redis, key, rows)                                    # 首次 drain 已消费空，重新播种
    await reflection._drain_owner_reflection_buffer("u1", settings)
    assert len(redis.lists[key]) == 2                                # 失败放回不丢回合
    assert redis.lock_obj.released


# ── schedule 入口分流 ──────────────────────────────────────────────────────

async def test_schedule_routes_trivial_tools_and_group(monkeypatch):
    from agent.memory import reflection

    queued, grouped = [], []

    async def fake_queue(*args):
        queued.append(args)

    async def fake_group(*args):
        grouped.append(args)

    monkeypatch.setattr(reflection, "_queue_owner_reflection", fake_queue)
    monkeypatch.setattr(reflection, "_schedule_group_owner", fake_group)
    settings = SimpleNamespace(agent=SimpleNamespace(reflection_threshold=10))

    # 纯应答 + 无工具 → 完全跳过
    reflection.schedule("u1", "小北", "嗯", "好的", settings)
    assert queued == [] and grouped == []

    # 纯应答但用了工具 → 反思
    reflection.schedule("u1", "小北", "嗯", "已建项目", settings, used_tools=["create_project"])
    reflection.schedule("u1", "小北", "嗯", "已建项目", settings, used_tools=True)   # bool 形态
    # 正常消息 → 反思
    reflection.schedule("u1", "小北", "帮我写周报", "好的", settings)
    # 群主模式 → 群缓冲
    reflection.schedule("u1", "小北", "嗯嗯", "嗯", settings, used_tools=None,
                        session_id="s1", group_mode=True)
    await asyncio.gather(*list(reflection._bg_tasks))                # 后台任务落地

    assert len(queued) == 3
    assert queued[0][5] is True and queued[1][5] is True and queued[2][5] is False
    assert len(grouped) == 1 and grouped[0][5] is False and grouped[0][6] == "s1"
