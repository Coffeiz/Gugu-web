"""PRD-LLM-27 Phase 2：owner Memory 反思接入 append_reuse 追加分支。

覆盖：资格门枚举、append 提取器的 BranchInput 组装（delta 划范围 + 共享
提示词 + branch_mode）、reflect 的模式分流、drain 路径的快照窥视传递。
LLM 与 Redis 一律打桩；快照登记表逐用例清空。
"""
from __future__ import annotations

import inspect
import json
from types import SimpleNamespace

import pytest

from agent.context import reflection_snapshot as rs
from agent.context.reflection_snapshot import (
    capture_reflection_snapshot,
    peek_reflection_snapshot,
)
from agent.memory import reflection


@pytest.fixture(autouse=True)
def _clean_snapshot_registry():
    rs._reset_for_tests()
    yield
    rs._reset_for_tests()


def _ai(provider="deepseek", model="deepseek-chat"):
    return SimpleNamespace(provider=provider, model=model, api_format="")


def _capture(session_id=7, provider="deepseek", run_id="run-x") -> None:
    capture_reflection_snapshot(
        user_id="u1", session_id=session_id, run_id=run_id, ai=_ai(provider),
        system_prompt="主会话SYS", tools=({"name": "list_dir"},),
        messages=[{"role": "user", "content": "问题"}, {"role": "assistant", "content": "回答"}],
        reply_text="最终回复",
    )


# ── 资格门（§6.3/§6.7）─────────────────────────────────────────────────


def _turns(*sids):
    return [{"user_msg": f"m{i}", "assistant_reply": f"a{i}", "session_id": sid}
            for i, sid in enumerate(sids)]


def test_decision_requires_snapshot():
    assert reflection._append_reuse_decision(None, _turns(7), SimpleNamespace(), None) == \
        (False, "no_snapshot")


def test_decision_rejects_session_mismatch():
    _capture(session_id=7)
    snapshot = peek_reflection_snapshot("u1", 7)
    assert reflection._append_reuse_decision(snapshot, _turns(8), SimpleNamespace(), None) == \
        (False, "session_mismatch")
    assert reflection._append_reuse_decision(snapshot, _turns(None), SimpleNamespace(), None) == \
        (False, "session_mismatch")


def test_decision_rejects_cross_session_buffer():
    _capture(session_id=7)
    snapshot = peek_reflection_snapshot("u1", 7)
    assert reflection._append_reuse_decision(snapshot, _turns(7, 8, 7), SimpleNamespace(), None) == \
        (False, "buffer_spans_sessions")


def test_decision_rejects_uncapable_provider():
    _capture(session_id=7, provider="minimax")
    snapshot = peek_reflection_snapshot("u1", 7)
    assert reflection._append_reuse_decision(snapshot, _turns(7), SimpleNamespace(), None) == \
        (False, "provider_not_capable")


def test_decision_rejects_provider_switch():
    _capture(session_id=7, provider="deepseek")
    snapshot = peek_reflection_snapshot("u1", 7)
    switched = _ai(provider="openai", model="gpt-x")
    assert reflection._append_reuse_decision(snapshot, _turns(7), SimpleNamespace(), switched) == \
        (False, "provider_switched")


def test_decision_eligible_on_aligned_inputs():
    _capture(session_id=7, provider="deepseek")
    snapshot = peek_reflection_snapshot("u1", 7)
    same = _ai(provider="deepseek", model="deepseek-chat")
    assert reflection._append_reuse_decision(snapshot, _turns(7), SimpleNamespace(), same) == \
        (True, "eligible")


# ── append 提取器组装（§6.2）──────────────────────────────────────────


class _CaptureBranch:
    """替换 ContextBranch：捕获 BranchInput/Policy，返回固定输出。"""

    def __init__(self, output):
        self.output = output
        self.calls = []

    async def run(self, branch_input, policy, settings, *, runner=None):
        self.calls.append((branch_input, policy))
        from agent.context.branch_types import BranchResult

        return BranchResult(ok=True, output=self.output,
                            metadata={"branch_mode": branch_input.branch_mode})


async def test_extract_append_builds_reuse_input(monkeypatch):
    _capture(session_id=7, run_id="run-x")
    snapshot = peek_reflection_snapshot("u1", 7)
    captured = _CaptureBranch(output={"profile_add": []})
    monkeypatch.setattr(reflection, "ContextBranch", lambda: captured)
    # 渲染桩：恒等映射，验证 history 原样进入 BranchInput
    import agent.context.prefix_history as ph
    monkeypatch.setattr(ph, "render_branch_prefix", lambda prefix, ai: list(prefix))

    turns = [{"user_name": "小北", "user_msg": "我最喜欢骑自行车",
              "assistant_reply": "好呀，记下了", "session_id": 7}]
    out = await reflection._extract_append(snapshot, "小北", turns,
                                           "画像P", "模式Q", "摘要R",
                                           SimpleNamespace(), prev_turn=None)
    assert out == {"profile_add": []}
    assert len(captured.calls) == 1
    branch_input, policy = captured.calls[0]
    assert branch_input.branch_mode == "append_reuse"
    assert branch_input.stable_system == "主会话SYS"
    assert branch_input.run_id == "run-x"
    assert tuple(branch_input.tools) == ({"name": "list_dir"},)
    # history = 快照 history（快照已含末尾 assistant 最终回复）
    assert list(branch_input.history_messages) == list(snapshot.history)
    # delta：专用规则进末尾 + 待反思回合划范围 + 共享任务要求（无副本漂移）
    assert "内部记忆反思任务" in branch_input.delta
    assert reflection._load_sys()[:20] in branch_input.delta
    assert "待反思回合" in branch_input.delta
    assert "我最喜欢骑自行车" in branch_input.delta
    assert "不要为历史内容新建记忆" in branch_input.delta
    assert reflection._TASK_REQUIREMENTS in branch_input.delta
    assert policy.name == "reflection"
    assert policy.output_mode == "json"


def test_task_requirements_single_source():
    """standalone 与 append 两条提取路径必须引用同一份任务要求常量。"""
    source = inspect.getsource(reflection)
    assert source.count("_TASK_REQUIREMENTS") >= 3   # 定义 + 两条路径各引用一次


# ── reflect 模式分流（§6.3）──────────────────────────────────────────


async def test_reflect_uses_append_when_eligible(monkeypatch):
    _capture(session_id=7)
    snapshot = peek_reflection_snapshot("u1", 7)
    used = {"append": 0, "standalone": 0}

    async def fake_bind(user_id, settings, session_id=None):
        return _ai("deepseek")

    async def fake_read_last_turn(uid, sid):
        return None

    async def fake_write_last_turn(*a, **k):
        return None

    async def fake_read_memory(uid):
        return {"profile": "P", "pattern": "Q", "summary": "S"}

    monkeypatch.setattr(reflection, "_bind_user_model", fake_bind)
    monkeypatch.setattr(reflection.store, "read_memory", fake_read_memory)
    monkeypatch.setattr(reflection, "_read_last_turn", fake_read_last_turn)
    monkeypatch.setattr(reflection, "_write_last_turn", fake_write_last_turn)

    async def fake_append(snapshot, user_name, turns, profile, pattern, summary, settings, prev_turn=None):
        used["append"] += 1
        return {}

    async def fake_standalone(*a, **k):
        used["standalone"] += 1
        return {}

    monkeypatch.setattr(reflection, "_extract_append", fake_append)
    monkeypatch.setattr(reflection, "_extract", fake_standalone)

    turns = [{"user_msg": "m", "assistant_reply": "a", "user_name": "小北", "session_id": 7}]
    ok = await reflection.reflect("u1", "小北", "m", "a", SimpleNamespace(),
                                  session_id=7, turns=turns, snapshot=snapshot)
    assert ok is False            # 提取返回空 → 无记忆增量可写，短路返回
    assert used == {"append": 1, "standalone": 0}


async def test_reflect_falls_back_to_standalone_without_snapshot(monkeypatch):
    used = {"append": 0, "standalone": 0}

    async def fake_bind(user_id, settings, session_id=None):
        return _ai("deepseek")

    async def fake_read_last_turn(uid, sid):
        return None

    async def fake_write_last_turn(*a, **k):
        return None

    async def fake_read_memory(uid):
        return {"profile": "", "pattern": "", "summary": ""}

    monkeypatch.setattr(reflection, "_bind_user_model", fake_bind)
    monkeypatch.setattr(reflection.store, "read_memory", fake_read_memory)
    monkeypatch.setattr(reflection, "_read_last_turn", fake_read_last_turn)
    monkeypatch.setattr(reflection, "_write_last_turn", fake_write_last_turn)

    async def fake_append(*a, **k):
        used["append"] += 1
        return {}

    async def fake_standalone(*a, **k):
        used["standalone"] += 1
        return {}

    monkeypatch.setattr(reflection, "_extract_append", fake_append)
    monkeypatch.setattr(reflection, "_extract", fake_standalone)

    turns = [{"user_msg": "m", "assistant_reply": "a", "user_name": "小北", "session_id": 7}]
    await reflection.reflect("u1", "小北", "m", "a", SimpleNamespace(),
                             session_id=7, turns=turns, snapshot=None)
    assert used == {"append": 0, "standalone": 1}


# ── drain 路径传递快照（§6.1 拓扑）───────────────────────────────────


class _FakeLock:
    async def acquire(self, blocking=False):
        return True

    async def release(self):
        return None


class _FakeRedis:
    """结构化 fake：覆盖 owner/group buffer 的 lrange/delete/rpush/lock 口径。"""

    def __init__(self, key: str, payload: str):
        self.store = {key: [payload]}
        self.deleted = []

    def lock(self, _key, timeout=None):
        return _FakeLock()

    async def lrange(self, key, start, end):
        data = self.store.get(key, [])
        return data[start:] if end == -1 else data[start:end + 1]

    async def delete(self, *keys):
        for key in keys:
            self.deleted.append(key)
            self.store.pop(key, None)
        return len(keys)

    async def rpush(self, key, *values):
        self.store.setdefault(key, []).extend(values)
        return len(values)

    async def zrem(self, key, member):
        return 1


async def test_owner_drain_peeks_snapshot_and_passes_to_reflect(monkeypatch):
    _capture(session_id=7)
    seen = {}

    async def fake_reflect(user_id, user_name, user_msg, assistant_reply, settings, **kwargs):
        seen["snapshot"] = kwargs.get("snapshot")
        seen["turns"] = kwargs.get("turns")
        return True

    monkeypatch.setattr(reflection, "reflect", fake_reflect)

    from agent.memory.reflection import _drain_owner_reflection_buffer, _owner_reflection_buffer_key

    rows = [{"user_name": "小北", "user_msg": "m1", "assistant_reply": "a1", "session_id": 7}]
    payload = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    monkeypatch.setattr("app.core.redis.get_redis",
                        lambda: _FakeRedis(_owner_reflection_buffer_key("u1"), payload))

    await _drain_owner_reflection_buffer("u1", SimpleNamespace())
    assert seen["snapshot"] is not None
    assert seen["snapshot"].session_id == 7
    assert seen["turns"] == rows


async def test_group_drain_without_snapshot_passes_none(monkeypatch):
    """worker 扫描进程查无快照：snapshot=None 传入 reflect → standalone。"""
    seen = {}

    async def fake_reflect(user_id, user_name, user_msg, assistant_reply, settings, **kwargs):
        seen["snapshot"] = kwargs.get("snapshot")
        seen["turns"] = kwargs.get("turns")
        return True

    monkeypatch.setattr(reflection, "reflect", fake_reflect)

    from agent.memory.reflection import (
        _drain_group_owner_buffer,
        _owner_group_buffer_key,
        _GROUP_OWNER_IDLE_KEY,
    )

    rows = [{"user_name": "小北", "user_msg": "m1", "assistant_reply": "a1", "session_id": 9}]
    payload = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    fake = _FakeRedis(_owner_group_buffer_key("u1"), payload)
    monkeypatch.setattr("app.core.redis.get_redis", lambda: fake)

    await _drain_group_owner_buffer("u1", SimpleNamespace())
    assert seen["snapshot"] is None          # 本进程从未捕获过 session 9 的快照
    assert seen["turns"] == rows
    assert (_owner_group_buffer_key("u1")) not in fake.store
    assert fake.deleted and _GROUP_OWNER_IDLE_KEY not in fake.deleted
