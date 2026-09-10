"""compaction 模块单元测试"""
import asyncio
from types import SimpleNamespace

import pytest

from agent.context import compress_conv
import agent.context.compaction as compaction_module
from agent.context.compaction import (
    compact_context,
    validate_compacted_shape,
    _is_system_injection,
    _atomic_message_units,
    _drop_orphan_tool_results,
    _generate_append_summary,
    validate_compact_summary,
    resolve_compaction_limits,
)
from agent.context.tokens import estimate_tokens, message_text
from app.models import ConversationSession


def _make_msg(role: str, text: str) -> dict:
    return {"role": role, "content": text}


def _make_tool_result(text: str) -> dict:
    return {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": text}]}


def _model_cfg(context_tokens: int = 256_000, max_tokens: int = 8_000):
    return SimpleNamespace(context_tokens=context_tokens, max_tokens=max_tokens)


class _FakeBranch:
    """替换 ContextBranch：记录每次分支请求，返回固定摘要。"""

    def __init__(self, calls: list, output: str = "追加摘要", fail: bool = False):
        self._calls = calls
        self._output = output
        self._fail = fail

    async def run(self, branch_input, policy, settings):
        self._calls.append({
            "history": [dict(m) for m in branch_input.history_messages],
            "stable_system": branch_input.stable_system,
            "delta": branch_input.delta,
            "tools": branch_input.tools,
            "policy": policy,
        })
        if self._fail:
            raise RuntimeError("provider down")
        return SimpleNamespace(ok=True, output=self._output)


@pytest.fixture(autouse=True)
def _fake_summary(monkeypatch):
    """压缩单测只验证编排，不访问真实摘要模型。"""
    async def fake_summary(_history, _previous=None, **_kwargs):
        return "测试摘要"

    monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)


class TestCompactionBudget:
    def test_compaction_prompt_path_dependency_is_available(self):
        """90% 压缩触发时提示词路径解析不能因缺少标准库依赖而中断。"""
        assert compaction_module.Path("compress_conv.md").name == "compress_conv.md"

    def test_append_summary_uses_model_output_budget(self, monkeypatch):
        calls: list = []
        monkeypatch.setattr(
            "agent.context.branch.ContextBranch",
            lambda: _FakeBranch(calls),
        )
        monkeypatch.setattr("app.core.config.get_settings", lambda: object())
        result = asyncio.get_event_loop().run_until_complete(
            _generate_append_summary(
                [{"role": "user", "content": "测试压缩"}], model_cfg=_model_cfg(120_000, 8_000),
            )
        )

        assert result == "追加摘要"
        assert calls[0]["policy"].max_tokens == 8_000

    def test_append_summary_forwards_run_tools(self, monkeypatch):
        """分支必须带上主 run 的工具声明，否则 provider 算不出同一份可缓存前缀。"""
        calls: list = []
        monkeypatch.setattr(
            "agent.context.branch.ContextBranch",
            lambda: _FakeBranch(calls),
        )
        monkeypatch.setattr("app.core.config.get_settings", lambda: object())
        tools = [{"name": "read_file", "description": "读文件", "input_schema": {}}]
        asyncio.get_event_loop().run_until_complete(
            _generate_append_summary(
                [{"role": "user", "content": "测试压缩"}],
                model_cfg=_model_cfg(120_000, 8_000), tools=tools,
            )
        )

        assert calls[0]["tools"] == tuple(tools)
        # 带了工具就要在指令里明确不许调用，避免摘要变成一次工具调用。
        assert "不要调用" in calls[0]["delta"]

    def test_compact_context_forwards_branch_tools(self, monkeypatch):
        seen: dict = {}

        async def fake_summary(_history, _previous=None, **kwargs):
            seen.update(kwargs)
            return "测试摘要"

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
        msgs = (
            [_make_msg("system", "系统提示")]
            + [_make_msg("user", f"历史{i}" * 40) for i in range(6)]
            + [_make_msg("assistant", "最新回复")]
        )
        branch_tools = [{"name": "read_file"}]
        asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, fixed_prefix_size=1, model_cfg=_model_cfg(60),
                            branch_tools=branch_tools)
        )

        assert seen.get("tools") == branch_tools

    def test_compaction_limits_follow_model_config(self):
        limits = resolve_compaction_limits(
            model_cfg=SimpleNamespace(context_tokens=120_000, max_tokens=8_000)
        )

        assert limits.context_tokens == 120_000
        assert limits.output_tokens == 8_000
        assert limits.input_tokens == 112_000

    def test_wire_summary_is_not_compressed_as_normal_history(self, monkeypatch):
        captured = {}

        async def fake_summary(_history, previous=None, **_kwargs):
            captured["previous"] = previous
            return "新摘要"

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
        messages = [
            _make_msg("user", "<compacted-summary>\n旧摘要\n</compacted-summary>"),
            *[_make_msg("user", "旧历史" * 20) for _ in range(40)],
            _make_msg("user", "当前消息"),
        ]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(messages, model_cfg=_model_cfg(1000, 80))
        )

        assert result.changed
        assert captured["previous"] == "<compacted-summary>\n旧摘要\n</compacted-summary>"

    def test_summary_input_limit_chunks_canonical_history(self, monkeypatch):
        """超出单请求输入预算时，canonical 消息按预算分块滚动，不再摊平。"""
        calls: list = []
        monkeypatch.setattr(
            "agent.context.branch.ContextBranch",
            lambda: _FakeBranch(calls, output="分块摘要"),
        )
        monkeypatch.setattr("app.core.config.get_settings", lambda: object())
        history = [
            {"role": "user", "content": "用户：" + "内容" * 20} for _ in range(8)
        ]
        result = asyncio.get_event_loop().run_until_complete(
            _generate_append_summary(
                history, model_cfg=SimpleNamespace(context_tokens=100, max_tokens=20),
            )
        )

        assert result == "分块摘要"
        assert len(calls) > 1
        # 每块的 history 消息都来自 canonical 序列，按顺序切分
        flat = [m for call in calls for m in call["history"]]
        assert flat == history

class TestIsSystemInjection:
    def test_project(self):
        assert _is_system_injection("## 项目\n- test")

    def test_calendar(self):
        assert _is_system_injection("## 日历\n- 08-19")

    def test_files(self):
        assert _is_system_injection("## 文件\n共 5 个文件")

    def test_normal(self):
        assert not _is_system_injection("你好，我是咕咕")

    def test_empty(self):
        assert not _is_system_injection("")
        assert not _is_system_injection(None)


class TestCompactContext:
    def test_summary_candidate_respects_model_budget_and_shape_contract(self):
        assert validate_compact_summary("有效摘要", max_output_tokens=8_000)[0]
        assert validate_compact_summary(" ", max_output_tokens=8_000) == (False, "摘要为空")
        assert validate_compact_summary("x" * 40_000, max_output_tokens=8_000) == (
            False, "摘要超过模型输出预算"
        )
        assert validate_compact_summary(
            "<compacted-summary>摘要</compacted-summary>", max_output_tokens=8_000,
        ) == (
            False, "摘要包含外层包裹标记"
        )

    def test_invalid_summary_candidate_does_not_change_messages(self, monkeypatch):
        async def oversized_summary(_history, _previous=None, **_kwargs):
            return "x" * 40_000

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", oversized_summary)
        messages = [_make_msg("user", "旧消息" * 100) for _ in range(50)]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(
                messages, model_cfg=_model_cfg(1000),
            )
        )
        assert not result.changed
        assert result.return_reason == "summary_validation_failed"
        assert result.messages == messages

    def test_empty_provider_summary_uses_bounded_local_fallback(self, monkeypatch):
        async def empty_summary(_history, _previous=None, **_kwargs):
            return ""

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", empty_summary)
        messages = [_make_msg("user", "历史消息" * 100) for _ in range(50)]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(messages, model_cfg=_model_cfg(1000, 80))
        )
        assert result.changed
        assert result.return_reason == "compacted"
        summary = next(m["content"] for m in result.messages if m["role"] == "user" and "compacted-summary" in m["content"])
        assert estimate_tokens(summary) <= 80 + 10
        assert "历史片段" in summary

    def test_local_fallback_unwraps_previous_compacted_summary(self, monkeypatch):
        async def empty_summary(_history, _previous=None, **_kwargs):
            return ""

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", empty_summary)
        previous = "<compacted-summary>\n已有结论\n</compacted-summary>"
        messages = [_make_msg("user", "历史消息" * 100) for _ in range(50)]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(
                messages,
                model_cfg=_model_cfg(1000, 80),
            )
        )
        # 直接验证本地 fallback 的候选入口，避免依赖消息中是否已有 summary 行。
        candidate = compaction_module._deterministic_summary(
            ["用户：新历史"], previous, max_output_tokens=80,
        )
        assert result.changed
        assert "已有摘要：已有结论" in candidate
        assert "<compacted-summary>" not in candidate

    def test_local_fallback_removes_embedded_summary_markers_from_old_history(self):
        candidate = compaction_module._deterministic_summary(
            ["用户：前缀 <compacted-summary>旧片段</compacted-summary> 后缀"],
            "已有摘要：<compacted-summary>旧结论</compacted-summary>",
            max_output_tokens=80,
        )
        assert "<compacted-summary>" not in candidate
        assert "</compacted-summary>" not in candidate

    def test_small_history_uses_single_append_request(self, monkeypatch):
        calls: list = []
        monkeypatch.setattr(
            "agent.context.branch.ContextBranch",
            lambda: _FakeBranch(calls),
        )
        monkeypatch.setattr("app.core.config.get_settings", lambda: object())
        history = [
            {"role": "user", "content": "第一条"},
            {"role": "assistant", "content": "第二条"},
        ]
        result = asyncio.get_event_loop().run_until_complete(
            _generate_append_summary(
                history, prev_summary="旧摘要", model_cfg=_model_cfg(),
                append_system="主系统提示",
            )
        )
        assert result == "追加摘要"
        assert len(calls) == 1
        # canonical 消息原样透传，压缩指令只出现在追加的 delta 里
        assert calls[0]["history"] == history
        assert calls[0]["stable_system"] == "主系统提示"
        assert "任务切换" in calls[0]["delta"]
        assert "旧摘要" in calls[0]["delta"]
        assert "对话摘要" in calls[0]["delta"]

    def test_append_provider_failure_returns_empty_for_local_fallback(self, monkeypatch):
        calls: list = []
        monkeypatch.setattr(
            "agent.context.branch.ContextBranch",
            lambda: _FakeBranch(calls, fail=True),
        )
        monkeypatch.setattr("app.core.config.get_settings", lambda: object())
        result = asyncio.get_event_loop().run_until_complete(
            _generate_append_summary(
                [{"role": "user", "content": "你好"}], model_cfg=_model_cfg(),
            )
        )
        assert result == ""

    def test_above_threshold_triggers_compact(self, monkeypatch):
        """超过阈值应触发压缩"""
        # 构造一个足够长的消息列表来超过 90% 阈值
        # 256000 * 0.9 = 230400，每条约 50 tokens，需要约 4600 条
        # 简化测试：直接设置极小的 context_tokens
        msgs = [_make_msg("user", f"消息{i}" * 20) for i in range(100)]
        monkeypatch.setattr(
            "agent.context.compaction._generate_append_summary",
            lambda *_args, **_kwargs: asyncio.sleep(0, result="测试摘要"),
        )
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, model_cfg=_model_cfg(1000))
        )
        assert result.changed  # 应该触发压缩

    def test_preserves_system_injection(self, monkeypatch):
        """压缩时应保留系统上下文注入消息"""
        monkeypatch.setattr(
            "agent.context.compaction._generate_append_summary",
            lambda *_args, **_kwargs: asyncio.sleep(0, result="测试摘要"),
        )
        msgs = [
            _make_msg("user", "你好"),
            _make_msg("user", "## 项目\n- test"),
            _make_msg("user", "消息" * 50),
            _make_msg("assistant", "好的"),
        ]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, model_cfg=_model_cfg(1000))
        )
        # 检查系统上下文注入消息是否被保留
        contents = [m.get("content", "") for m in result.messages]
        has_injection = any(isinstance(c, str) and "项目" in c for c in contents)
        assert has_injection

    def test_preserves_compact_summary(self, monkeypatch):
        """压缩后应包含 compacted-summary"""
        monkeypatch.setattr(
            "agent.context.compaction._generate_append_summary",
            lambda *_args, **_kwargs: asyncio.sleep(0, result="测试摘要"),
        )
        msgs = [_make_msg("user", "消息" * 100) for _ in range(50)]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, model_cfg=_model_cfg(1000))
        )
        if result.changed:
            contents = [m.get("content", "") for m in result.messages]
            has_summary = any(
                isinstance(c, str) and "<compacted-summary>" in c
                for c in contents
            )
            assert has_summary

    def test_compaction_covers_all_messages_between_injection_and_kept(self, monkeypatch):
        captured = []

        async def fake_summary(items, previous=None, **_kwargs):
            captured.extend(message_text(m) for m in items)
            return "测试摘要"

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
        msgs = [
            _make_msg("user", "历史一" * 40),
            _make_msg("user", "## 项目\n- 当前项目"),
            _make_msg("assistant", "历史二" * 40),
            _make_msg("user", "历史三" * 40),
            _make_msg("assistant", "最新消息"),
        ]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, model_cfg=_model_cfg(120))
        )
        assert result.changed
        joined = "\n".join(captured)
        assert "历史一" in joined
        assert "历史二" in joined
        assert "历史三" in joined
        assert any("## 项目" in m.get("content", "") for m in result.messages)

    def test_tool_turn_is_atomic_at_compaction_boundary(self, monkeypatch):
        captured = []

        async def fake_summary(items, previous=None, **_kwargs):
            captured.extend(message_text(m) for m in items)
            return "测试摘要"

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
        tool_use = {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "call-1", "name": "calendar", "input": {}}],
        }
        tool_result = _make_tool_result("工具结果")
        current = _make_msg("user", "当前问题")
        # 预算故意只能容纳 current + tool_result，不能容纳完整 tool turn。
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(
                [_make_msg("user", "旧消息" * 20), tool_use, tool_result, current],
                model_cfg=_model_cfg(50),
            )
        )
        assert result.changed
        kept = result.messages[-1:]
        kept_text = "\n".join(message_text(item) for item in kept)
        # tool_use 与 tool_result 必须一起进入摘要，不能留下孤儿 result。
        assert "工具调用:calendar" in "\n".join(captured)
        assert "工具结果" in "\n".join(captured)
        assert "当前问题" in kept_text

    def test_protected_current_run_is_not_sent_to_summary(self, monkeypatch):
        """运行中压缩只整理本轮开始前的历史，当前 tool 链保持完整。"""
        captured = []

        async def fake_summary(items, previous=None, **_kwargs):
            captured.extend(message_text(m) for m in items)
            return "历史摘要"

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
        current = _make_msg("user", "本轮问题")
        tool_use = {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "call-1", "name": "search", "input": {}}],
        }
        tool_result = _make_tool_result("本轮工具结果")
        messages = [_make_msg("user", "旧历史" * 3000), current, tool_use, tool_result]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(
                messages,
                protected_from=1,
                model_cfg=_model_cfg(80),
            )
        )

        assert result.changed
        captured_text = "\n".join(captured)
        assert "旧历史" in captured_text
        assert "本轮问题" not in captured_text
        assert "本轮工具结果" not in captured_text
        result_text = "\n".join(message_text(item) for item in result.messages)
        assert "本轮问题" in result_text
        assert "本轮工具结果" in result_text

    def test_provider_threshold_is_the_single_automatic_trigger(self):
        """自动压缩阈值固定为 provider 实际上下文的 90%。"""
        assert compress_conv.AUTO_COMPACTION_RATIO == 0.90
        assert not hasattr(compress_conv, "schedule_baseline_update")
        assert not hasattr(compress_conv, "wait_for_baseline_update")

    def test_claim_session_run_rechecks_baseline_state_under_row_lock(self, db, user_a):
        """拿到会话锁后 baseline 才切换为 updating 时，不能认领新 run。"""
        session = ConversationSession(
            user_id=user_a.id,
            title="baseline 行锁测试",
            source="web",
            execution_state="baseline_updating",
        )
        db.add(session)
        asyncio.get_event_loop().run_until_complete(db.commit())
        asyncio.get_event_loop().run_until_complete(db.refresh(session))

        claimed = asyncio.get_event_loop().run_until_complete(
            compress_conv._claim_session_run(session.id, "run-test", False)
        )

        assert claimed is False
        asyncio.get_event_loop().run_until_complete(db.refresh(session))
        assert session.execution_state == "baseline_updating"
        assert session.active_run_id is None

    def test_session_run_lock_key_uses_canonical_session_id(self):
        from types import SimpleNamespace

        first = SimpleNamespace(
            user_id="u1", session_id=9, source="qq", chat_type="group", chat_id="g1",
            platform_bot_id="b1", platform_user_id="p1",
        )
        same = SimpleNamespace(**first.__dict__)
        other = SimpleNamespace(**{**first.__dict__, "chat_id": "g2", "session_id": 10})
        assert compress_conv._session_lock_key(first) == compress_conv._session_lock_key(same)
        assert compress_conv._session_lock_key(first) != compress_conv._session_lock_key(other)

    def test_baseline_cas_rejects_same_id_with_changed_hash(self):
        from types import SimpleNamespace

        session = SimpleNamespace(baseline_message_id=12, baseline_message_hash="new-hash")
        assert compress_conv._baseline_matches(session, 12, "new-hash")
        assert not compress_conv._baseline_matches(session, 12, "old-hash")
        assert not compress_conv._baseline_matches(session, 11, "old-hash")

    def test_atomic_units_pair_anthropic_and_openai_tool_messages(self):
        messages = [
            {"role": "user", "content": "旧消息"},
            {"role": "assistant", "tool_calls": [{"id": "call-1"}], "content": None},
            {"role": "tool", "tool_call_id": "call-1", "content": "结果"},
            {"role": "user", "content": "现在"},
        ]
        assert _atomic_message_units(messages) == [[0], [1, 2], [3]]

    def test_atomic_units_pair_canonical_tool_messages(self):
        messages = [
            {"role": "assistant", "content": [{
                "type": "tool_call", "id": "call-1", "name": "calendar", "arguments": {},
            }]},
            {"role": "tool", "content": [{
                "type": "tool_result", "tool_call_id": "call-1", "content": "结果",
            }]},
            {"role": "user", "content": "现在"},
        ]
        assert _atomic_message_units(messages) == [[0, 1], [2]]

    def test_atomic_units_keep_all_parallel_tool_results(self):
        messages = [
            {"role": "assistant", "tool_calls": [{"id": "call-a"}, {"id": "call-b"}], "content": None},
            {"role": "tool", "tool_call_id": "call-a", "content": "结果 A"},
            {"role": "tool", "tool_call_id": "call-b", "content": "结果 B"},
            _make_msg("user", "继续"),
        ]
        assert _atomic_message_units(messages) == [[0, 1, 2], [3]]

    def test_compaction_drops_orphan_result_before_selecting_recent_window(self):
        messages = [
            _make_msg("user", "旧历史"),
            {"role": "assistant", "tool_calls": [{"id": "call-a"}], "content": None},
            {"role": "tool", "tool_call_id": "call-b", "content": "孤儿结果"},
            _make_msg("user", "当前问题"),
        ]
        cleaned = _drop_orphan_tool_results(messages)
        assert cleaned == [messages[0], messages[1], messages[3]]

    def test_compaction_keeps_matching_openai_result(self):
        call = {"role": "assistant", "tool_calls": [{"id": "call-a"}], "content": None}
        result = {"role": "tool", "tool_call_id": "call-a", "content": "结果"}
        assert _drop_orphan_tool_results([call, result]) == [call, result]

    def test_compaction_keeps_all_parallel_matching_results(self):
        call = {"role": "assistant", "tool_calls": [{"id": "call-a"}, {"id": "call-b"}], "content": None}
        result_a = {"role": "tool", "tool_call_id": "call-a", "content": "结果 A"}
        result_b = {"role": "tool", "tool_call_id": "call-b", "content": "结果 B"}
        assert _drop_orphan_tool_results([call, result_a, result_b]) == [call, result_a, result_b]


class TestVerifyPrefixConsistency:
    def test_valid_compacted(self):
        """验证正常压缩后的消息结构"""
        old = [_make_msg("user", "消息1"), _make_msg("user", "消息2")]
        new = [
            {"role": "user", "content": "## 项目\n- test"},
            {"role": "user", "content": "<compacted-summary>\n摘要内容\n</compacted-summary>"},
            _make_msg("user", "消息2"),
        ]
        ok, reason = validate_compacted_shape(new)
        assert ok

    def test_empty_messages(self):
        """空消息列表应报错"""
        ok, reason = validate_compacted_shape([])
        assert not ok
        assert "空" in reason

    def test_no_summary_marker(self):
        """缺少摘要标记应报错"""
        old = [_make_msg("user", "消息1")]
        new = [_make_msg("user", "消息2")]
        ok, reason = validate_compacted_shape(new)
        assert not ok
        assert "compacted-summary" in reason

    def test_summary_at_wrong_position(self):
        """摘要在最后应报错（后面没有最近消息）"""
        old = [_make_msg("user", "消息1")]
        new = [{"role": "user", "content": "<compacted-summary>\n摘要\n</compacted-summary>"}]
        ok, reason = validate_compacted_shape(new)
        assert not ok
        assert "最近消息" in reason


class TestAppendModeCompaction:
    """追加式压缩：复用主会话 canonical 消息序列，压缩指令只在末尾追加。"""

    def test_append_summary_sends_history_with_trailing_instruction(self, monkeypatch):
        calls: list = []
        monkeypatch.setattr(
            "agent.context.branch.ContextBranch",
            lambda: _FakeBranch(calls),
        )
        monkeypatch.setattr("app.core.config.get_settings", lambda: object())
        history = [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "在的"},
        ]
        result = asyncio.get_event_loop().run_until_complete(
            _generate_append_summary(
                history, prev_summary="旧摘要", model_cfg=_model_cfg(),
                append_system="主系统提示",
            )
        )

        assert result == "追加摘要"
        # 历史消息原样透传，不允许被改写（前缀一致性是命中的前提）
        assert calls[0]["history"] == history
        assert calls[0]["stable_system"] == "主系统提示"
        # 压缩指令在追加的 delta 里，带任务切换前缀 + 旧摘要合并 + 排版要求
        assert "任务切换" in calls[0]["delta"]
        assert "旧摘要" in calls[0]["delta"]
        assert "对话摘要" in calls[0]["delta"]

    def test_append_provider_failure_returns_empty_for_local_fallback(self, monkeypatch):
        calls: list = []
        monkeypatch.setattr(
            "agent.context.branch.ContextBranch",
            lambda: _FakeBranch(calls, fail=True),
        )
        monkeypatch.setattr("app.core.config.get_settings", lambda: object())
        result = asyncio.get_event_loop().run_until_complete(
            _generate_append_summary(
                [{"role": "user", "content": "你好"}], model_cfg=_model_cfg(),
            )
        )

        # 失败不再回退摊平路径，交给调用方落到本地有界摘要
        assert result == ""

    def test_compact_context_always_wires_append_mode(self, monkeypatch):
        captured = {}

        async def fake_summary(history, _previous=None, **kwargs):
            captured["history_messages"] = history
            captured.update(kwargs)
            return "测试摘要"

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
        messages = [
            _make_msg("user", "旧历史" * 20) for _ in range(40)
        ] + [_make_msg("user", "当前消息")]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(messages, model_cfg=_model_cfg(1000, 80), system_text="主系统")
        )

        assert result.changed
        # 待压缩历史以 canonical 消息原样进入追加式分支
        assert captured["history_messages"]
        assert all(isinstance(m, dict) and m.get("role") for m in captured["history_messages"])
        # openai 协议路由（默认）不注入分支 system，run 的 system 已在 history 前缀里
        assert captured["append_system"] == ""


class TestCompleteMessagesShape:
    """complete_messages：追加式分支的消息形状与 system 缺省行为。"""

    def test_anthropic_path_appends_history_and_trailing_anchor(self, monkeypatch):
        import agent.context.provider_runner as pr

        captured = {}

        class _FakeResp:
            class content:  # noqa: N801
                text_blocks = [{"type": "text", "text": "ok"}]

            usage = None

        def _fake_client(ai, timeout):
            class _Messages:
                async def create(self, **kwargs):
                    captured.update(kwargs)

                    class _B:
                        type = "text"
                        text = "ok"

                    class _Resp:
                        content = [_B()]
                        usage = None

                    return _Resp()

            class _Client:
                messages = _Messages()

            return _Client()

        monkeypatch.setattr("agent.providers.build_anthropic_client", _fake_client)
        fake_ai = SimpleNamespace(model="MiniMax-M3", thinking=None,
                                  api_format="anthropic", base_url="")
        history = [
            {"role": "user", "content": "问题"},
            {"role": "assistant", "content": "回答"},
        ]
        settings = SimpleNamespace(ai=fake_ai)
        result = asyncio.get_event_loop().run_until_complete(
            pr.complete_messages("主系统", history, "压缩指令",
                                 settings, max_tokens=100)
        )

        assert result == "ok"
        msgs = captured["messages"]
        assert len(msgs) == 3 and msgs[-1]["content"] == "压缩指令"
        assert msgs[0]["content"] == "问题"
        # 末尾历史消息被打上会话内缓存断点
        tail = msgs[1]["content"]
        assert isinstance(tail, list) and tail[-1].get("cache_control")


class TestBranchPrefixHistory:
    """追加式压缩必须发「从对话头开始的连续前缀」，否则 provider 前缀缓存全 miss。"""

    def _run(self, monkeypatch, msgs, cfg):
        captured = []

        async def fake_summary(items, previous=None, **_kwargs):
            captured.extend(items)
            return "测试摘要"

        monkeypatch.setattr("agent.context.compaction._generate_append_summary", fake_summary)
        asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, fixed_prefix_size=1, model_cfg=cfg)
        )
        return captured

    def test_prefix_history_is_contiguous_from_head(self, monkeypatch):
        msgs = (
            [_make_msg("system", "系统提示")]
            + [_make_msg("user", f"历史{i}" * 40) for i in range(6)]
            + [_make_msg("assistant", "最新回复")]
        )
        captured = self._run(monkeypatch, msgs, _model_cfg(60))

        assert captured, "应把历史交给分支"
        # 第一条必须是 run 的系统消息（对话头），不能从中段开始
        assert message_text(captured[0]) == "系统提示"
        # 且与原始序列逐条同前缀
        assert [message_text(m) for m in captured] == [
            message_text(m) for m in msgs[:len(captured)]
        ]

    def test_prefix_history_excludes_kept_recent_tail(self, monkeypatch):
        """保留窗口里的近期消息不能进摘要请求：它要原样留在上下文里。"""
        msgs = (
            [_make_msg("system", "系统提示")]
            + [_make_msg("user", f"历史{i}" * 40) for i in range(6)]
            + [_make_msg("assistant", "最近的回复XYZ")]
        )
        captured = self._run(monkeypatch, msgs, _model_cfg(60))

        joined = "\n".join(message_text(m) for m in captured)
        assert "历史0" in joined
        assert "最近的回复XYZ" not in joined

    def test_prefix_history_projects_system_roles_for_anthropic_route(self, monkeypatch):
        """anthropic 路由的主 run 会把消息级 system 投影成 user，分支必须跟上。

        角色不投影时，前缀从那条 system 消息起整段失配（实测同一前缀只换角色：
        cache_read 3840 → 384），所以这里锁住投影；openai 路由保持原角色。
        """
        msgs = (
            [_make_msg("system", "系统提示")]
            + [_make_msg("user", "历史" * 40)]
            + [_make_msg("system", "[system-reminder] 快照")]
            + [_make_msg("user", "历史" * 40)]
            + [_make_msg("assistant", "最新回复")]
        )
        anthropic_cfg = SimpleNamespace(
            context_tokens=60, max_tokens=8000, api_format="anthropic",
        )
        anthropic_captured = self._run(monkeypatch, msgs, anthropic_cfg)
        assert [m.get("role") for m in anthropic_captured][2] == "user"

        openai_captured = self._run(monkeypatch, msgs, _model_cfg(60))
        assert [m.get("role") for m in openai_captured][2] == "system"

    def test_prefix_history_falls_back_when_messages_are_not_same_objects(self):
        """拿不到可定位的对象时退回旧行为，不猜切片。"""
        from agent.context.compaction import _branch_prefix_history

        history = [_make_msg("user", f"历史{i}") for i in range(6)]
        compressible = [dict(m) for m in history[:3]]   # 与 history 不同一批对象
        out = _branch_prefix_history(
            history, 0, history, compressible, _model_cfg(60),
        )
        assert [message_text(m) for m in out] == [message_text(m) for m in compressible]

    def test_prefix_history_is_head_anchored_for_copied_history(self):
        """生产形态：`_drop_orphan_tool_results` 会浅拷贝，前缀仍须从对话头开始。"""
        from agent.context.compaction import (
            _branch_prefix_history,
            _drop_orphan_tool_results,
        )

        msgs = [_make_msg("system", "系统提示")] + [
            _make_msg("user", f"历史{i}") for i in range(6)
        ]
        message_history = _drop_orphan_tool_results(list(msgs[1:]))
        assert message_history[0] is not msgs[1], "前提：清理会换对象"
        out = _branch_prefix_history(
            msgs, 1, message_history, message_history[:4], _model_cfg(60),
        )
        assert [message_text(m) for m in out] == [
            "系统提示", "历史0", "历史1", "历史2", "历史3",
        ]
