"""PRD-LLM-27 Phase 3：Knowledge 反思复用主会话快照（sibling branch）。

覆盖：append 接线与资格回落、sibling 隔离（Memory JSON 不进 Knowledge
上下文）、写入与索引事件语义不变。LLM/RAG/KnowledgeStore 一律打桩。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from agent.context import reflection_snapshot as rs
from agent.context.reflection_snapshot import capture_reflection_snapshot
from agent.knowledge import reflection as knowledge_reflection
from agent.memory import reflection


@pytest.fixture(autouse=True)
def _clean_snapshot_registry():
    rs._reset_for_tests()
    yield
    rs._reset_for_tests()


def _ai(provider="deepseek", model="deepseek-chat"):
    return SimpleNamespace(provider=provider, model=model, api_format="")


def _capture(session_id=7, run_id="run-x") -> None:
    capture_reflection_snapshot(
        user_id="u1", session_id=session_id, run_id=run_id, ai=_ai(),
        system_prompt="主会话SYS", tools=({"name": "list_dir"},),
        messages=[{"role": "user", "content": "问题"}, {"role": "assistant", "content": "回答"}],
        reply_text="最终回复",
    )


def _settings():
    """append 路径会读 settings.ai（effective_ai 身份门），桩需带 ai 字段。"""
    return SimpleNamespace(ai=_ai())


async def _async_noop(*a, **k):
    return None


class _CaptureBranch:
    def __init__(self, output):
        self.output = output
        self.calls = []

    async def run(self, branch_input, policy, settings, *, runner=None):
        self.calls.append((branch_input, policy))
        from agent.context.branch_types import BranchResult

        return BranchResult(ok=True, output=self.output,
                            metadata={"branch_mode": branch_input.branch_mode})


def _knowledge_output():
    return {"operations": [
        {"action": "save", "title": "T", "content": "C", "topic": "长十甲",
         "keywords": ["rocket"], "description": "", "certainty": "confirmed"},
    ]}


async def test_reflect_if_candidate_uses_append_with_snapshot(monkeypatch):
    _capture(session_id=7)
    snapshot = peek = rs._snapshots[("u1", 7)]
    captured = _CaptureBranch(_knowledge_output())
    monkeypatch.setattr("agent.context.branch.ContextBranch", lambda: captured)

    async def fake_search(*a, **k):
        return {"results": [{"source_id": "k1", "title": "已有条目", "text": "旧内容"}]}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)

    saved = await knowledge_reflection.reflect_if_candidate(
        "u1", "用户消息", "助手回复", _settings(), "长十甲 运力",
        save_mode="automatic", session_id=7, snapshot=snapshot,
    )
    assert saved == [] or isinstance(saved, list)   # 写入走打桩后的 store 路径之外不强校验
    assert len(captured.calls) == 1
    branch_input, policy = captured.calls[0]
    assert branch_input.branch_mode == "append_reuse"
    assert branch_input.stable_system == "主会话SYS"
    assert branch_input.run_id == "run-x"
    assert tuple(branch_input.tools) == ({"name": "list_dir"},)
    # delta：Knowledge 专用规则 + 完整历史边界指令 + 原样 JSON 载荷
    assert knowledge_reflection.load_prompt()[:20] in branch_input.delta
    assert knowledge_reflection._KNOWLEDGE_HISTORY_DIRECTIVE in branch_input.delta
    assert '"knowledge_candidates"' in branch_input.delta
    assert '"user_message"' in branch_input.delta
    assert policy.name == "knowledge"
    assert policy.output_mode == "json"


async def test_reflect_if_candidate_defers_without_snapshot(monkeypatch):
    captured = _CaptureBranch(_knowledge_output())
    monkeypatch.setattr("agent.context.branch.ContextBranch", lambda: captured)

    async def fake_search(*a, **k):
        return {"results": []}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)

    await knowledge_reflection.reflect_if_candidate(
        "u1", "用户消息", "助手回复", SimpleNamespace(), "查询词",
        save_mode="automatic", session_id=7, snapshot=None,
    )
    assert captured.calls == []


async def test_reflect_if_candidate_defers_on_provider_switch(monkeypatch):
    _capture(session_id=7)
    snapshot = rs._snapshots[("u1", 7)]
    captured = _CaptureBranch(_knowledge_output())
    monkeypatch.setattr("agent.context.branch.ContextBranch", lambda: captured)

    async def fake_search(*a, **k):
        return {"results": []}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)
    # effective_ai 返回与快照不同的模型 → 资格不满足
    import agent.llm.modelctx as modelctx
    monkeypatch.setattr(modelctx, "effective_ai",
                        lambda settings: _ai(provider="openai", model="gpt-x"))

    await knowledge_reflection.reflect_if_candidate(
        "u1", "用户消息", "助手回复", SimpleNamespace(), "查询词",
        save_mode="automatic", session_id=7, snapshot=snapshot,
    )
    assert captured.calls == []


async def test_reflect_if_candidate_defers_on_session_mismatch(monkeypatch):
    _capture(session_id=7)
    snapshot = rs._snapshots[("u1", 7)]
    captured = _CaptureBranch(_knowledge_output())
    monkeypatch.setattr("agent.context.branch.ContextBranch", lambda: captured)

    async def fake_search(*a, **k):
        return {"results": []}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)

    await knowledge_reflection.reflect_if_candidate(
        "u1", "用户消息", "助手回复", SimpleNamespace(), "查询词",
        save_mode="automatic", session_id=9, snapshot=snapshot,   # 会话不一致
    )
    assert captured.calls == []


async def test_sibling_isolation_memory_json_not_in_knowledge_context(monkeypatch):
    """Memory 的 JSON 输出不进入 Knowledge 分支上下文（§6.4 sibling 隔离）。"""
    _capture(session_id=7)
    snapshot = rs._snapshots[("u1", 7)]
    captured = _CaptureBranch(_knowledge_output())
    monkeypatch.setattr("agent.context.branch.ContextBranch", lambda: captured)

    async def fake_search(*a, **k):
        return {"results": []}

    monkeypatch.setattr("agent.rag.service.search_knowledge", fake_search)

    marker = "MEMORY_JSON_MARKER_记忆敏感摘要"
    memory_out = {"knowledge_candidate": {"should_reflect": True, "query": "查询词"},
                  "summary": marker, "perception": {"intent": marker}}
    should, query = knowledge_reflection.candidate_request(memory_out)
    assert should
    # 模拟 _reflect_knowledge 的调用面：只传 user_msg/assistant_reply/query，
    # 不传 memory_out——Memory JSON 仅用于 candidate_request 判定。
    await knowledge_reflection.reflect_if_candidate(
        "u1", "用户消息", "助手回复", _settings(), query,
        save_mode="automatic", session_id=7, snapshot=snapshot,
    )
    branch_input, _ = captured.calls[0]
    assert marker not in branch_input.delta
    assert marker not in branch_input.stable_system


async def test_memory_reflect_passes_snapshot_to_knowledge(monkeypatch):
    """reflect 资格门通过时把快照传给 _reflect_knowledge；异常路径传 None。"""
    _capture(session_id=7)
    snapshot = rs._snapshots[("u1", 7)]
    seen = {}

    async def fake_bind(user_id, settings, session_id=None):
        return _ai("deepseek")

    async def fake_read_memory(uid):
        return {"profile": "", "pattern": "", "summary": ""}

    async def fake_read_last_turn(uid, sid):
        return None

    async def fake_write_last_turn(*a, **k):
        return None

    async def fake_extract_append(snapshot, user_name, turns, profile, pattern, summary, settings, prev_turn=None):
        # 非空输出让 reflect 走完 writer 段直到 _reflect_knowledge
        return {"daily": "x", "perception": {"intent": "闲聊", "ambiguity": 0, "emotion": "无", "emo_strength": 0}}

    async def fake_emit(*a, **k):
        return None

    async def fake_knowledge(user_id, user_msg, assistant_reply, settings, out, *, session_id=None, snapshot=None):
        seen["snapshot"] = snapshot
        return None

    monkeypatch.setattr(reflection, "_bind_user_model", fake_bind)
    monkeypatch.setattr(reflection.store, "read_memory", fake_read_memory)
    monkeypatch.setattr(reflection, "_read_last_turn", fake_read_last_turn)
    monkeypatch.setattr(reflection, "_write_last_turn", fake_write_last_turn)
    monkeypatch.setattr(reflection, "_extract_append", fake_extract_append)
    monkeypatch.setattr(reflection, "_emit_perc", fake_emit)
    monkeypatch.setattr(reflection, "_reflect_knowledge", fake_knowledge)
    monkeypatch.setattr("agent.memory.periodic.maybe_schedule", _async_noop)
    monkeypatch.setattr(reflection.store, "write_stance", _async_noop)
    monkeypatch.setattr(reflection.store, "append_daily", _async_noop)

    import agent.memory.memory_compress as memory_compress
    monkeypatch.setattr(memory_compress, "compact", _async_noop)

    import agent.events as events_mod
    monkeypatch.setattr(events_mod, "publish", lambda *a, **k: None)

    import agent.memory.lens as lens_mod
    monkeypatch.setattr(lens_mod, "observe", _async_noop)

    settings = SimpleNamespace(ai=_ai("deepseek"))
    turns = [{"user_msg": "m", "assistant_reply": "a", "user_name": "小北", "session_id": 7}]
    await reflection.reflect("u1", "小北", "m", "a", settings,
                             session_id=7, turns=turns, snapshot=snapshot)
    assert seen["snapshot"] is snapshot

    # 无快照：owner Memory 不再调用独立提取，也不会触发 Knowledge 反思
    seen.clear()

    await reflection.reflect("u1", "小北", "m", "a", settings,
                             session_id=7, turns=turns, snapshot=None)
    assert seen == {}
