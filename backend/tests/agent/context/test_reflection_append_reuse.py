"""PRD-LLM-27 Phase 2：owner Memory 反思接入 append_reuse 追加分支。

覆盖：资格门枚举、append 提取器的 BranchInput 组装（delta 划范围 + 共享
提示词 + branch_mode）、reflect 的模式分流、drain 路径的快照窥视传递。
LLM 与 Redis 一律打桩；快照登记表逐用例清空。
"""
from __future__ import annotations

import json
import time
from dataclasses import replace
from types import SimpleNamespace

import pytest

from agent.context.assembly import MessageArea
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
        messages=MessageArea.from_canonical_messages([
            {"role": "user", "content": "问题"},
            {"role": "assistant", "content": "回答"},
        ]),
        reply_text="最终回复",
    )


# ── 资格门（§6.3/§6.7）─────────────────────────────────────────────────


def _turns(*sids):
    return [{"user_msg": f"m{i}", "assistant_reply": f"a{i}", "session_id": sid}
            for i, sid in enumerate(sids)]


def test_decision_requires_snapshot():
    assert reflection._append_reuse_decision(None, _turns(7), None) == \
        (False, "no_snapshot")


def test_decision_rejects_session_mismatch():
    _capture(session_id=7)
    snapshot = peek_reflection_snapshot("u1", 7)
    assert reflection._append_reuse_decision(snapshot, _turns(8), None) == \
        (False, "session_mismatch")
    assert reflection._append_reuse_decision(snapshot, _turns(None), None) == \
        (False, "session_mismatch")


def test_decision_rejects_cross_session_buffer():
    _capture(session_id=7)
    snapshot = peek_reflection_snapshot("u1", 7)
    assert reflection._append_reuse_decision(snapshot, _turns(7, 8, 7), None) == \
        (False, "buffer_spans_sessions")


def test_decision_eligible_ignores_provider_capability():
    """白名单已废止：provider 能力不再参与资格判定（观测只记录不拦截）。"""
    _capture(session_id=7, provider="unknown-llm")
    snapshot = peek_reflection_snapshot("u1", 7)
    assert reflection._append_reuse_decision(snapshot, _turns(7), None) == \
        (True, "eligible")


def test_decision_rejects_provider_switch():
    _capture(session_id=7, provider="deepseek")
    snapshot = peek_reflection_snapshot("u1", 7)
    switched = _ai(provider="openai", model="gpt-x")
    assert reflection._append_reuse_decision(snapshot, _turns(7), switched) == \
        (False, "provider_switched")


def test_decision_eligible_on_aligned_inputs():
    _capture(session_id=7, provider="deepseek")
    snapshot = peek_reflection_snapshot("u1", 7)
    same = _ai(provider="deepseek", model="deepseek-chat")
    assert reflection._append_reuse_decision(snapshot, _turns(7), same) == \
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


@pytest.mark.asyncio
async def test_owner_probe_context_survives_reflection_await(monkeypatch):
    captured = {}

    async def fake_reflect(*args, **kwargs):
        captured.update(kwargs)
        captured["probe_context"] = reflection._reflection_probe_context_var.get()
        return True

    monkeypatch.setattr(reflection, "reflect", fake_reflect)
    with reflection._reflection_probe_context(None, "idle"):
        await reflection._reflect_buffer_rows(
            "synthetic-owner", SimpleNamespace(),
            [{"user_name": "小北", "user_msg": "问题", "assistant_reply": "回答"}],
            7, None,
        )

    assert captured["probe_context"]["trigger_source"] == "idle"
    assert captured["probe_context"]["origin_run_id"] == ""
    assert captured["probe_context"]["origin_gap_seconds"] is None
    assert captured["rebuild_from_history"] is True


async def test_extract_append_builds_reuse_input(monkeypatch):
    _capture(session_id=7, run_id="run-x")
    snapshot = peek_reflection_snapshot("u1", 7)
    captured = _CaptureBranch(output={"profile_add": []})
    async def capture_branch(branch_input, settings, **kwargs):
        from agent.context.branch_types import BranchPolicy
        policy = BranchPolicy(
            name="reflection", output_mode="json", max_tokens=kwargs["max_tokens"],
            max_retries=kwargs.get("max_retries", 0), thinking=kwargs.get("thinking"),
        )
        return await captured.run(branch_input, policy, settings)

    monkeypatch.setattr(reflection, "run_reflection_branch", capture_branch)
    # 渲染桩：恒等映射，验证 history 原样进入 BranchInput
    import agent.context.prefix_history as ph
    monkeypatch.setattr(ph, "render_branch_prefix", lambda prefix, ai: list(prefix))

    turns = [{"user_name": "小北", "user_msg": "我最喜欢骑自行车",
              "assistant_reply": "好呀，记下了", "session_id": 7}]
    snapshot = replace(snapshot, created_at=time.monotonic() - 180.0)
    with reflection._reflection_probe_context(snapshot, "idle"):
        out = await reflection._extract_append(snapshot, "小北", turns,
                                               "画像P", "模式Q", "摘要R",
                                               SimpleNamespace(), prev_turn=None)
    assert out == {"profile_add": []}
    assert len(captured.calls) == 1
    branch_input, policy = captured.calls[0]
    assert branch_input.branch_mode == "append_reuse"
    assert branch_input.stable_system == "主会话SYS"
    assert branch_input.run_id == "run-x"
    assert branch_input.session_id == 7
    assert branch_input.cache_probe_context == {
        "reflection_scope": "owner",
        "trigger_source": "idle",
        "origin_run_id": "run-x",
        "origin_gap_seconds": pytest.approx(180.0, abs=0.01),
    }
    assert tuple(branch_input.tools) == ({"name": "list_dir"},)
    # history = 快照 history（快照已含末尾 assistant 最终回复）
    assert list(branch_input.history_messages) == list(snapshot.history)
    # delta：只放专用规则、待反思回合范围和共享任务要求；回合正文已在 history 中，不能复制
    assert "内部记忆反思任务" in branch_input.delta
    assert reflection._load_sys()[:20] in branch_input.delta
    assert "待反思回合" in branch_input.delta
    assert "我最喜欢骑自行车" not in branch_input.delta
    assert "好呀，记下了" not in branch_input.delta
    assert "不要为历史内容新建 profile/pattern/daily/knowledge_candidate" in branch_input.delta
    # 完整历史边界指令：append 必含（矛盾检测开放给历史），且声明 remove 锚定存量原文
    assert reflection._APPEND_HISTORY_DIRECTIVE in branch_input.delta
    assert "照抄上面存量记忆里的原文字符串" in branch_input.delta
    assert reflection._TASK_REQUIREMENTS in branch_input.delta
    assert policy.name == "reflection"
    assert policy.output_mode == "json"


# ── reflect 模式分流（§6.3）──────────────────────────────────────────


async def test_reflect_uses_append_when_eligible(monkeypatch):
    _capture(session_id=7)
    snapshot = peek_reflection_snapshot("u1", 7)
    used = {"append": 0}

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

    async def fake_append(
        snapshot, user_name, turns, profile, pattern, summary, settings,
        prev_turn=None,
    ):
        used["append"] += 1
        return {}

    monkeypatch.setattr(reflection, "_extract_append", fake_append)

    turns = [{"user_msg": "m", "assistant_reply": "a", "user_name": "小北", "session_id": 7}]
    ok = await reflection.reflect("u1", "小北", "m", "a", SimpleNamespace(),
                                  session_id=7, turns=turns, snapshot=snapshot)
    assert ok is False            # 提取返回空 → 无记忆增量可写，短路返回
    assert used == {"append": 1}


@pytest.mark.asyncio
async def test_reflect_reloads_persisted_history_after_compaction(monkeypatch):
    _capture(session_id=7)
    original = peek_reflection_snapshot("u1", 7)
    refreshed = replace(original, history=({"role": "user", "content": "压缩后"},))
    calls = []

    async def fake_bind(user_id, settings, session_id=None):
        return _ai("deepseek")

    async def fake_rebuild(*args, **kwargs):
        calls.append(True)
        return refreshed

    async def fake_read_memory(uid):
        return {"profile": "P", "pattern": "Q", "summary": "S"}

    async def fake_read_last_turn(uid, sid):
        return None

    async def fake_write_last_turn(*args, **kwargs):
        return None

    async def fake_compact(*args, **kwargs):
        return "compacted"

    used = []

    async def fake_append(snapshot, *args, **kwargs):
        used.append(snapshot)
        return {}

    monkeypatch.setattr(reflection, "_bind_user_model", fake_bind)
    monkeypatch.setattr(reflection, "_rebuild_owner_reflection_snapshot", fake_rebuild)
    monkeypatch.setattr(reflection.store, "read_memory", fake_read_memory)
    monkeypatch.setattr(reflection, "_read_last_turn", fake_read_last_turn)
    monkeypatch.setattr(reflection, "_write_last_turn", fake_write_last_turn)
    monkeypatch.setattr(reflection, "_extract_append", fake_append)
    monkeypatch.setattr(
        "agent.context.compress_conv.compact_for_reflection", fake_compact,
    )

    turns = [{"user_msg": "m", "assistant_reply": "a", "session_id": 7}]
    assert await reflection.reflect(
        "u1", "小北", "m", "a", SimpleNamespace(), session_id=7,
        turns=turns, snapshot=original,
    ) is False
    assert calls == [True]
    assert used == [refreshed]


async def test_reflect_defers_owner_without_snapshot(monkeypatch):
    used = {"append": 0}

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

    monkeypatch.setattr(reflection, "_extract_append", fake_append)

    turns = [{"user_msg": "m", "assistant_reply": "a", "user_name": "小北", "session_id": 7}]
    await reflection.reflect("u1", "小北", "m", "a", SimpleNamespace(),
                             session_id=7, turns=turns, snapshot=None)
    assert used == {"append": 0}


@pytest.mark.asyncio
async def test_idle_rebuild_uses_owned_idle_session_and_persisted_history(db, user_a, user_b, monkeypatch):
    from app.models import ConversationMessage, ConversationSession

    idle_session = ConversationSession(user_id=user_a.id, execution_state="idle")
    db.add(idle_session)
    await db.flush()
    db.add(ConversationMessage(session_id=idle_session.id, role="user", content="持久历史"))
    await db.commit()
    monkeypatch.setattr("agent.context.session_system.build_static_prompt", lambda *a, **k: "stable-system")
    rebuilt = await reflection._rebuild_owner_reflection_snapshot(
        user_a.id, idle_session.id, "小北", _ai(),
    )
    assert rebuilt.source == "persisted_history"
    assert rebuilt.session_id == idle_session.id
    assert rebuilt.system_prompt == "stable-system"
    assert rebuilt.tools == ()
    # 数据库重建结果经过投影后保留 wire 边界，供后续分支直接复用。
    assert "持久历史" in str(rebuilt.history.to_messages())
    assert await reflection._rebuild_owner_reflection_snapshot(user_b.id, idle_session.id, "小北", _ai()) is None
    for state, pending in [("running", 0), ("idle", 1)]:
        idle_session.execution_state = state
        idle_session.pending_message_count = pending
        await db.commit()
        assert await reflection._rebuild_owner_reflection_snapshot(user_a.id, idle_session.id, "小北", _ai()) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("event_type", ["stance-context", "knowledge-context"])
async def test_idle_rebuild_projects_persisted_context_before_minimax_request(
    db, user_a, monkeypatch, event_type,
):
    """数据库重建保留上下文语义，MiniMax 请求只收到合法 text 块。"""
    from agent import providers
    from agent.context import provider_runner
    from agent.context.prefix_history import render_branch_prefix
    from agent.context.provider_conversation import ProviderConversation
    from app.models import ConversationMessage, ConversationSession

    session = ConversationSession(user_id=user_a.id, execution_state="idle")
    db.add(session)
    await db.flush()
    context_text = "合成姿态：简洁回答" if event_type == "stance-context" else "合成知识：每周整理"
    event = {"type": event_type, "text": context_text}
    row = ConversationMessage(session_id=session.id, role="user", content_json=[event])
    db.add_all([
        ConversationMessage(session_id=session.id, role="user", content="请整理安排"),
        row,
        ConversationMessage(session_id=session.id, role="assistant", content="已整理"),
    ])
    await db.commit()
    monkeypatch.setattr(
        "agent.context.session_system.build_static_prompt", lambda *a, **k: "合成系统",
    )
    ai = SimpleNamespace(provider="minimax", model="MiniMax-M3", api_format="anthropic")
    captured = {}

    async def create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text="完成")], usage=None)

    monkeypatch.setattr(providers, "build_anthropic_client", lambda *a: SimpleNamespace(
        messages=SimpleNamespace(create=create),
    ))
    monkeypatch.setattr("agent.llm.modelctx.effective_ai", lambda _settings: ai)
    snapshot = await reflection._rebuild_owner_reflection_snapshot(
        user_a.id, session.id, "小北", ai,
    )
    assert isinstance(snapshot.history, ProviderConversation)
    original_prefix = snapshot.history.to_messages()
    assert any(
        block == {"type": "text", "text": context_text}
        for message in original_prefix if isinstance(message["content"], list)
        for block in message["content"]
    )

    def reject_reprojection(*args, **kwargs):
        raise AssertionError("已投影的历史不能再次经过 Canonical renderer")

    monkeypatch.setattr("agent.context.history.render_canonical_area_snapshot", reject_reprojection)
    result = await provider_runner.complete_messages(
        snapshot.system_prompt, render_branch_prefix(snapshot.history, ai), "反思本轮",
        settings=SimpleNamespace(ai=ai),
    )
    assert result == "完成"
    blocks = [block for message in captured["messages"]
              if isinstance(message["content"], list) for block in message["content"]]
    assert all(block["type"] == "text" for block in blocks)
    assert context_text in [block["text"] for block in blocks]
    assert snapshot.history.to_messages() == original_prefix
    await db.refresh(row)
    assert row.content_json == [event]


@pytest.mark.asyncio
async def test_reflect_routes_idle_rebuilt_history_through_append(monkeypatch):
    model = _ai()
    rebuilt = SimpleNamespace(
        session_id=7, run_id="idle", system_prompt="system", ai=model,
        tools=(), history=(), source="persisted_history",
    )
    calls = []

    async def fake_bind(*_args, **_kwargs):
        return model

    async def fake_rebuild(*_args, **_kwargs):
        return rebuilt

    async def fake_memory(_user_id):
        return {"profile": "P", "pattern": "Q", "summary": "S"}

    async def fake_extract(snapshot, *_args, **_kwargs):
        calls.append(snapshot)
        return {}

    monkeypatch.setattr(reflection, "_bind_user_model", fake_bind)
    monkeypatch.setattr(reflection, "_rebuild_owner_reflection_snapshot", fake_rebuild)
    monkeypatch.setattr(reflection.store, "read_memory", fake_memory)
    monkeypatch.setattr(reflection, "_read_last_turn", lambda *_args: _async_value(None))
    monkeypatch.setattr(reflection, "_write_last_turn", lambda *_args, **_kwargs: _async_value(None))
    monkeypatch.setattr(reflection, "_extract_append", fake_extract)

    turns = [{"user_msg": "m", "assistant_reply": "a", "user_name": "小北", "session_id": 7}]
    assert await reflection.reflect(
        "u1", "小北", "m", "a", SimpleNamespace(), session_id=7,
        turns=turns, snapshot=None, rebuild_from_history=True,
    ) is False
    assert calls == [rebuilt]


async def _async_value(value):
    return value


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

    async def zadd(self, key, values):
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
                        lambda: _FakeRedis(_owner_reflection_buffer_key("u1", 7), payload))

    await _drain_owner_reflection_buffer("u1", SimpleNamespace(), 7)
    assert seen["snapshot"] is not None
    assert seen["snapshot"].session_id == 7
    assert seen["turns"] == rows


async def test_group_drain_without_snapshot_keeps_buffer(monkeypatch):
    """群主 worker 查无快照时延迟，不创建没有主前缀的反思调用。"""
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
    assert seen == {}
    assert fake.store[_owner_group_buffer_key("u1")] == [payload]
    assert fake.deleted and _GROUP_OWNER_IDLE_KEY not in fake.deleted
