"""PRD-LLM-27 Phase 1：反思快照、provider 缓存能力门、append_reuse 状态边界。

只测机制本身；反思链路接入（Phase 2）另有测试。
"""
from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from agent.context import reflection_snapshot as rs
from agent.context.cache_capability import record_reuse_outcome, reuse_hit_rate
from agent.context.branch_types import BranchInput, BranchPolicy
from agent.context.reflection_snapshot import (
    capture_reflection_snapshot,
    discard_reflection_snapshot,
    peek_reflection_snapshot,
)


@pytest.fixture(autouse=True)
def _clean_snapshot_registry():
    rs._reset_for_tests()
    yield
    rs._reset_for_tests()


def _messages(*turns: str):
    """构造带 dynamic_tail 的 PromptMessages 形态容器（只用到被测接口）。"""
    from agent.context.assembly import PromptMessages

    messages = PromptMessages()
    for turn in turns:
        messages.append_batch([
            {"role": "user", "content": turn},
            {"role": "assistant", "content": f"回复：{turn}"},
        ])
    messages.set_dynamic_tail([{"role": "user", "content": "[time] 12:00"}])
    return messages


def _ai(provider="deepseek", model="deepseek-chat"):
    return SimpleNamespace(provider=provider, model=model, api_format="")


def test_capture_and_peek_roundtrip_excludes_dynamic_tail():
    messages = _messages("帮我看看这个 bug", "改好了")
    snapshot = capture_reflection_snapshot(
        user_id="u1", session_id=7, run_id="run-x", ai=_ai(),
        system_prompt="SYS", tools=({"name": "list_dir"},),
        messages=messages, reply_text="最终回复正文",
    )
    assert snapshot is not None
    seen = peek_reflection_snapshot("u1", 7)
    assert seen is snapshot
    # history = 两轮对话 + 末尾 assistant 最终回复；dynamic tail 不进快照
    assert len(snapshot.history) == 5
    assert snapshot.history[-1] == {"role": "assistant", "content": "最终回复正文"}
    assert all("[time]" not in str(msg.get("content", "")) for msg in snapshot.history)
    assert snapshot.system_prompt == "SYS"
    assert snapshot.run_id == "run-x"
    # revision 是 history 的 digest：同内容稳定、内容变化可感知
    assert snapshot.revision


def test_peek_requires_same_user_and_session():
    capture_reflection_snapshot(
        user_id="u1", session_id=7, run_id=None, ai=_ai(), system_prompt="S",
        tools=(), messages=_messages("hi"), reply_text="好",
    )
    assert peek_reflection_snapshot("u2", 7) is None
    assert peek_reflection_snapshot("u1", 8) is None
    assert peek_reflection_snapshot("u1", None) is None


def test_ttl_expiry_blocks_append_reuse():
    capture_reflection_snapshot(
        user_id="u1", session_id=7, run_id=None, ai=_ai(), system_prompt="S",
        tools=(), messages=_messages("hi"), reply_text="好",
    )
    snapshot = peek_reflection_snapshot("u1", 7)
    assert snapshot is not None
    # 手动把 created_at 拨到 TTL 之外，验证过期快照不再返回（§7 防污染）
    stale = rs.ReflectionSnapshot(
        user_id=snapshot.user_id, session_id=snapshot.session_id,
        run_id=snapshot.run_id, system_prompt=snapshot.system_prompt,
        ai=snapshot.ai, tools=snapshot.tools, history=snapshot.history,
        revision=snapshot.revision,
        created_at=time.monotonic() - 3600.0,
    )
    rs._snapshots[("u1", 7)] = stale
    assert peek_reflection_snapshot("u1", 7) is None


def test_lru_evicts_oldest_beyond_capacity():
    for index in range(rs._SNAPSHOT_MAX_ENTRIES + 4):
        capture_reflection_snapshot(
            user_id=f"u{index}", session_id=index, run_id=None, ai=_ai(),
            system_prompt="S", tools=(), messages=_messages("hi"), reply_text="好",
        )
    assert peek_reflection_snapshot("u0", 0) is None          # 最老的被逐出
    newest = rs._SNAPSHOT_MAX_ENTRIES + 3
    assert peek_reflection_snapshot(f"u{newest}", newest) is not None


def test_discard_removes_snapshot():
    capture_reflection_snapshot(
        user_id="u1", session_id=7, run_id=None, ai=_ai(), system_prompt="S",
        tools=(), messages=_messages("hi"), reply_text="好",
    )
    discard_reflection_snapshot("u1", 7)
    assert peek_reflection_snapshot("u1", 7) is None


def test_capture_rejects_missing_session_or_empty_reply():
    assert capture_reflection_snapshot(
        user_id="u1", session_id=None, run_id=None, ai=_ai(), system_prompt="S",
        tools=(), messages=_messages("hi"), reply_text="好",
    ) is None
    assert capture_reflection_snapshot(
        user_id="u1", session_id=7, run_id=None, ai=_ai(), system_prompt="S",
        tools=(), messages=_messages("hi"), reply_text="  ",
    ) is None


def test_capture_never_uses_redis_or_db():
    """拓扑钉死的回归锚点：快照模块不得引入 Redis/DB 依赖（§6.1 进程内边界）。"""
    import inspect
    source = inspect.getsource(rs)
    assert "get_redis" not in source
    assert "_SessionLocal" not in source


# ── provider 缓存能力白名单（§6.7 第一关）─────────────────────────────────


def test_prefix_cache_hit_rate_observation():
    """白名单已废止：cache_capability 只保留纯命中率观测，不驱动资格判定。"""
    from agent.context.cache_capability import record_reuse_outcome, reuse_hit_rate

    ai = _ai("deepseek")
    record_reuse_outcome(ai, cache_hit=True)
    record_reuse_outcome(ai, cache_hit=False)
    record_reuse_outcome(ai, cache_hit=True)
    assert reuse_hit_rate(ai) == (2, 3)
    # 不同模型键互不串扰
    assert reuse_hit_rate(_ai("deepseek", model="other")) == (0, 0)


# ── append_reuse 状态边界（§6.6）─────────────────────────────────────────


async def test_append_reuse_does_not_invalidate_reasoning_state(monkeypatch):
    """只读 sibling branch 不得失效主会话 reasoning continuation。"""
    from agent.context.branch import ContextBranch

    async def fake_complete(system, history, user, settings, **kwargs):
        return '{"ok": true}'

    monkeypatch.setattr(
        "agent.context.provider_runner.complete_messages", fake_complete)

    common = dict(
        stable_system="S", session_id=7, scope_owner_id="u1", run_id="r1",
        history_messages=({"role": "user", "content": "hi"},),
    )
    settings = SimpleNamespace()

    result = await ContextBranch().run(
        BranchInput(**common, delta="任务"),
        BranchPolicy(name="reflection"), settings,
    )
    assert result.ok
    assert result.metadata["branch_mode"] == "append_reuse"


# ── 共享前缀渲染 helper（§6.2 契约）─────────────────────────────────────


def test_render_branch_prefix_returns_plain_list_detached_from_canonical():
    from agent.context.prefix_history import render_branch_prefix

    prefix = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "好"}]
    rendered = render_branch_prefix(prefix, _ai("deepseek"))
    # 普通 list（脱离 canonical 簿记），内容与主 run 渲染口径一致
    assert type(rendered) is list
    assert len(rendered) == 2
    # 输入不被修改
    assert prefix[0] == {"role": "user", "content": "hi"}


def test_render_branch_prefix_failure_falls_back_to_input(monkeypatch):
    import agent.context.prefix_history as ph

    def boom(ai):
        raise RuntimeError("no adapter")

    monkeypatch.setattr("agent.providers.adapter_for", boom)
    prefix = [{"role": "user", "content": "hi"}]
    rendered = ph.render_branch_prefix(prefix, _ai("deepseek"))
    assert rendered == prefix
