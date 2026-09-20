"""PRD-LLM-18 LLM18-003：collect/stream 准备等价（preparation parity）回归。

两条入口必须经同一个 `prepare_agent_run`，且对相同输入产出等价的
`PreparedExecution`（FR-RUN-03）；允许差异仅限 `non_streaming` 组装参数。
测试比较实际准备结果（含 prepare_run 实收参数），不读取 runner 源码计数。
"""
from __future__ import annotations

import dataclasses

import pytest

from agent.models import AgentRequest
from agent.context import run_context
from agent.context.session_system import NON_STREAMING_BLOCK


@pytest.mark.asyncio
async def test_both_entries_route_through_shared_preparation(monkeypatch):
    """run_collect/run_stream 都只调 prepare_agent_run；EarlyExit 按各自形态转换。"""
    from agent import runner
    from agent.run.contract import EarlyExit

    calls = []
    canned_response = runner.AgentResponse(text="早退", session_id=42)

    async def fake_prepare(req, *, non_streaming):
        calls.append({"req": req, "non_streaming": non_streaming})
        return EarlyExit(reason="quota_exhausted", response=canned_response)

    monkeypatch.setattr(runner, "prepare_agent_run", fake_prepare)

    req = AgentRequest(message="你好", user_id="u1", user_name="coffeiz", origin="tab-1")
    collected = await runner._run_collect_unlocked(req)
    assert collected is canned_response

    streamed = [item async for item in runner._run_stream_unlocked(req)]
    assert len(streamed) == 1
    kind, payload = streamed[0]
    assert kind == "final" and payload is canned_response

    assert len(calls) == 2
    assert calls[0]["req"] is req and calls[1]["req"] is req
    assert {call["non_streaming"] for call in calls} == {True, False}


def _normalize_snapshot(text: str | None) -> str:
    """抹掉 non_streaming 组装差异（NON_STREAMING_BLOCK 及其拼接分隔符），只比对业务内容。"""
    normalized = text or ""
    if NON_STREAMING_BLOCK not in normalized:
        return normalized.strip()
    for token in (f"\n\n---\n\n{NON_STREAMING_BLOCK}", NON_STREAMING_BLOCK):
        normalized = normalized.replace(token, "")
    return normalized.strip()


def _normalize_value(value):
    """递归归一化：任何嵌了 snapshot 文本的字符串都抹掉 non_streaming 差异。"""
    if isinstance(value, str):
        return _normalize_snapshot(value)
    if isinstance(value, dict):
        return {key: _normalize_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_normalize_value(item) for item in value)
    return value


@pytest.mark.asyncio
async def test_preparation_parity_between_collect_and_stream_modes(db, user_a, user_b, monkeypatch):
    """同一输入按 collect/stream 两种组装模式各跑一次真实准备，产出等价快照。

    LLM/能力边界打桩（parity 关注第一段生命周期，不关注模型与工具目录内容）；
    会话/snapshot/history/附件/配额全部走真实内存库实现。
    """
    from agent.run import preparation as run_preparation
    from agent.run.preparation import prepare_agent_run
    from agent.run.contract import PreparedExecution

    captured_prepare_run_kwargs: list[dict] = []

    async def fake_mcp(user_id, settings, allowed=None):
        return []

    async def fake_capability(tool_names, settings, *, db=None, owner_id=None, query="",
                              user_skill_metadata=None, dynamic_tools=()):
        return None

    @dataclasses.dataclass
    class _StubPrepared:
        anthr_messages: list
        anthr_initial_len: int
        oa_messages: list
        oa_initial_len: int
        rag_context: dict
        stance_to_persist: str | None

    async def fake_prepare_run(**kwargs):
        captured_prepare_run_kwargs.append(kwargs)
        return _StubPrepared(
            anthr_messages=[], anthr_initial_len=0,
            oa_messages=[], oa_initial_len=0,
            rag_context={}, stance_to_persist=None,
        )

    class _StubRunner:
        def __init__(self, tool_names, settings, **kwargs):
            self.tool_names = tool_names
            self.kwargs = kwargs

    monkeypatch.setattr(run_preparation, "_load_mcp_tools", fake_mcp)
    monkeypatch.setattr(run_preparation, "_capability_context", fake_capability)
    monkeypatch.setattr(run_preparation, "_pin_session_user_skill_metadata", lambda *a, **k: False)
    monkeypatch.setattr(run_preparation, "LLMRunner", _StubRunner)
    monkeypatch.setattr(run_context, "prepare_run", fake_prepare_run)

    def _fingerprint(exec_: PreparedExecution) -> dict:
        """规范化指纹：身份字段（session_id）与允许差异（NON_STREAMING_BLOCK）抹平。"""
        return {
            "is_new_session": exec_.is_new_session,
            "system_prompt": exec_.system_prompt,
            "use_anthropic": exec_.use_anthropic,
            "model": repr(exec_.model_cfg),
            "tool_names": list(exec_.runner.tool_names),
            "runner_kwargs": {k: repr(v) for k, v in exec_.runner.kwargs.items()},
            "snapshot_context": _normalize_snapshot(exec_.snapshot.get("snapshot_context")),
            "snapshot_system_prompt": exec_.snapshot.get("system_prompt"),
            "user_message_role": exec_.user_message.role,
            "user_message_content": exec_.user_message.content,
        }

    # 两个全新用户各跑一次：collect 组装模式（non_streaming=True）与 stream 模式
    exec_collect = await prepare_agent_run(
        AgentRequest(message="同一段输入", user_id=user_a.id, user_name=user_a.username),
        non_streaming=True,
    )
    exec_stream = await prepare_agent_run(
        AgentRequest(message="同一段输入", user_id=user_b.id, user_name=user_b.username),
        non_streaming=False,
    )
    assert isinstance(exec_collect, PreparedExecution)
    assert isinstance(exec_stream, PreparedExecution)

    fp_collect = _fingerprint(exec_collect)
    fp_stream = _fingerprint(exec_stream)
    assert fp_collect.keys() == fp_stream.keys()
    for key in fp_collect:
        assert fp_collect[key] == fp_stream[key], f"parity 差异在 {key}"

    # prepare_run 实收参数等价（抹掉 non_streaming 差异与逐次会话对象）
    assert len(captured_prepare_run_kwargs) == 2
    def _norm(kwargs: dict) -> dict:
        return {
            key: _normalize_value(value)
            for key, value in kwargs.items()
            if key not in {"req", "user_message", "session", "snapshot", "history_stats", "model_cfg"}
        }
    assert _norm(captured_prepare_run_kwargs[0]) == _norm(captured_prepare_run_kwargs[1])

    # 会话身份字段逐项核对（两次运行属于不同用户会话，只比较结构）
    assert exec_collect.session_id != exec_stream.session_id
    assert exec_collect.is_new_session is True and exec_stream.is_new_session is True
    assert exec_collect.user_message.content == exec_stream.user_message.content == "同一段输入"
