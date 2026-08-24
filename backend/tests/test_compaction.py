"""compaction 模块单元测试"""
import asyncio
import pytest
from agent.context import compress_conv
from agent.context.compaction import (
    estimate_context_length,
    compact_context,
    validate_compacted_shape,
    _is_system_injection,
    _atomic_message_units,
    _generate_compact_summary,
)
from agent.context.tokens import content_text, estimate_tokens, message_text


def _make_msg(role: str, text: str) -> dict:
    return {"role": role, "content": text}


def _make_tool_result(text: str) -> dict:
    return {"role": "user", "content": [{"type": "tool_result", "content": text}]}


@pytest.fixture(autouse=True)
def _fake_summary(monkeypatch):
    """压缩单测只验证编排，不访问真实摘要模型。"""
    async def fake_summary(_items, _previous=None):
        return "测试摘要"

    monkeypatch.setattr("agent.context.compaction._generate_compact_summary", fake_summary)


class TestEstimateContextLength:
    def test_empty(self):
        assert 0 == asyncio.get_event_loop().run_until_complete(
            estimate_context_length([], "")
        )

    def test_system_only(self):
        result = asyncio.get_event_loop().run_until_complete(
            estimate_context_length([], "你是咕咕，一个AI助手。" * 50)
        )
        assert result > 0

    def test_messages_only(self):
        msgs = [_make_msg("user", "你好") for _ in range(10)]
        result = asyncio.get_event_loop().run_until_complete(
            estimate_context_length(msgs, "")
        )
        assert result > 0

    def test_system_plus_messages(self):
        sys_text = "你是咕咕" * 10
        msgs = [_make_msg("user", "你好") for _ in range(5)]
        result = asyncio.get_event_loop().run_until_complete(
            estimate_context_length(msgs, sys_text)
        )
        assert result > 0

    def test_counts_tool_use_and_result_blocks(self):
        content = [
            {"type": "tool_use", "name": "calendar", "input": {"date": "2026-08-21"}},
            {"type": "tool_result", "tool_use_id": "tool-1", "content": "结果正文"},
            {"type": "reasoning", "text": "内部推理"},
        ]
        assert "calendar" in content_text(content)
        assert "结果正文" in content_text(content)
        assert asyncio.get_event_loop().run_until_complete(
            estimate_context_length([{"role": "assistant", "content": content}], "")
        ) > 10

    def test_counts_openai_tool_calls_field(self):
        msg = {"role": "assistant", "content": "查询中", "tool_calls": [
            {"id": "call-1", "type": "function", "function": {
                "name": "calendar", "arguments": '{"date":"2026-08-21"}'
            }}
        ]}
        assert "tool_calls" in message_text(msg)
        assert asyncio.get_event_loop().run_until_complete(
            estimate_context_length([msg], "")
        ) > estimate_tokens("查询中")


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
    def test_small_history_uses_single_branch_summary_request(self, monkeypatch):
        calls = []

        async def fake_once(items, previous=None):
            calls.append((items, previous))
            return "分支摘要"

        monkeypatch.setattr("agent.context.compaction._generate_compact_summary_once", fake_once)
        result = asyncio.get_event_loop().run_until_complete(
            _generate_compact_summary(["用户：第一条", "咕咕：第二条"], "旧摘要")
        )
        assert result == "分支摘要"
        assert len(calls) == 1
        assert calls[0][1] == "旧摘要"

    def test_oversized_history_uses_rolling_fallback(self, monkeypatch):
        calls = []

        async def fake_once(items, previous=None):
            calls.append((items, previous))
            return f"摘要{len(calls)}"

        monkeypatch.setattr("agent.context.compaction._generate_compact_summary_once", fake_once)
        items = ["用户：" + "内容" * 30_000, "咕咕：" + "内容" * 30_000,
                 "用户：" + "内容" * 30_000, "咕咕：" + "内容" * 30_000]
        result = asyncio.get_event_loop().run_until_complete(
            _generate_compact_summary(items)
        )
        assert result == f"摘要{len(calls)}"
        assert len(calls) > 1

    def test_force_compaction_does_not_use_local_token_estimate(self, monkeypatch):
        """正常压缩由 provider usage 触发，不得再用本地 token 估算决定是否执行。"""
        def fail_estimate(*_args, **_kwargs):
            raise AssertionError("正常压缩路径不应调用本地 token 估算")

        monkeypatch.setattr("agent.context.compaction.estimate_tokens", fail_estimate)
        messages = [_make_msg("user", f"历史消息 {index} " + "内容" * 40) for index in range(8)]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(messages, "你是咕咕", context_tokens=80, force=True)
        )

        assert result.changed
        assert result.return_reason == "compacted"

    def test_below_threshold_no_compact(self):
        """上下文未达到阈值时不应压缩"""
        msgs = [_make_msg("user", "你好")]
        result, compacted = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, "你是咕咕", context_tokens=256000)
        )
        assert not compacted
        assert result == msgs

    def test_compaction_result_exposes_return_reason(self):
        msgs = [_make_msg("user", "你好")]
        result, compacted = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, "你是咕咕", context_tokens=256000)
        )
        assert not compacted
        # 二元组解包保持兼容，同时暴露结构化原因给 core 诊断。
        detailed = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, "你是咕咕", context_tokens=256000)
        )
        assert detailed.return_reason == "below_threshold"
        assert detailed.before_tokens == detailed.after_tokens

    def test_above_threshold_triggers_compact(self, monkeypatch):
        """超过阈值应触发压缩"""
        # 构造一个足够长的消息列表来超过 90% 阈值
        # 256000 * 0.9 = 230400，每条约 50 tokens，需要约 4600 条
        # 简化测试：直接设置极小的 context_tokens
        msgs = [_make_msg("user", f"消息{i}" * 20) for i in range(100)]
        monkeypatch.setattr(
            "agent.context.compaction._generate_compact_summary",
            lambda *_args, **_kwargs: asyncio.sleep(0, result="测试摘要"),
        )
        result, compacted = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, "你是咕咕", context_tokens=1000)
        )
        assert compacted  # 应该触发压缩

    def test_preserves_system_injection(self, monkeypatch):
        """压缩时应保留系统上下文注入消息"""
        monkeypatch.setattr(
            "agent.context.compaction._generate_compact_summary",
            lambda *_args, **_kwargs: asyncio.sleep(0, result="测试摘要"),
        )
        msgs = [
            _make_msg("user", "你好"),
            _make_msg("user", "## 项目\n- test"),
            _make_msg("user", "消息" * 50),
            _make_msg("assistant", "好的"),
        ]
        result, compacted = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, "你是咕咕", context_tokens=1000)
        )
        # 检查系统上下文注入消息是否被保留
        contents = [m.get("content", "") for m in result]
        has_injection = any(isinstance(c, str) and "项目" in c for c in contents)
        assert has_injection

    def test_preserves_compact_summary(self, monkeypatch):
        """压缩后应包含 compacted-summary"""
        monkeypatch.setattr(
            "agent.context.compaction._generate_compact_summary",
            lambda *_args, **_kwargs: asyncio.sleep(0, result="测试摘要"),
        )
        msgs = [_make_msg("user", "消息" * 100) for _ in range(50)]
        result, compacted = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, "你是咕咕", context_tokens=1000)
        )
        if compacted:
            contents = [m.get("content", "") for m in result]
            has_summary = any(
                isinstance(c, str) and "<compacted-summary>" in c
                for c in contents
            )
            assert has_summary

    def test_compaction_covers_all_messages_between_injection_and_kept(self, monkeypatch):
        captured = []

        async def fake_summary(items, previous=None):
            captured.extend(items)
            return "测试摘要"

        monkeypatch.setattr("agent.context.compaction._generate_compact_summary", fake_summary)
        msgs = [
            _make_msg("user", "历史一" * 40),
            _make_msg("user", "## 项目\n- 当前项目"),
            _make_msg("assistant", "历史二" * 40),
            _make_msg("user", "历史三" * 40),
            _make_msg("assistant", "最新消息"),
        ]
        result, compacted = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, "系统", context_tokens=120)
        )
        assert compacted
        joined = "\n".join(captured)
        assert "历史一" in joined
        assert "历史二" in joined
        assert "历史三" in joined
        assert any("## 项目" in m.get("content", "") for m in result)

    def test_tool_turn_is_atomic_at_compaction_boundary(self, monkeypatch):
        captured = []

        async def fake_summary(items, previous=None):
            captured.extend(items)
            return "测试摘要"

        monkeypatch.setattr("agent.context.compaction._generate_compact_summary", fake_summary)
        tool_use = {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "call-1", "name": "calendar", "input": {}}],
        }
        tool_result = _make_tool_result("工具结果")
        current = _make_msg("user", "当前问题")
        # 预算故意只能容纳 current + tool_result，不能容纳完整 tool turn。
        result, compacted = asyncio.get_event_loop().run_until_complete(
            compact_context([_make_msg("user", "旧消息" * 20), tool_use, tool_result, current], "系统", context_tokens=50)
        )
        assert compacted
        kept = result[-1:]
        kept_text = "\n".join(message_text(item) for item in kept)
        # tool_use 与 tool_result 必须一起进入摘要，不能留下孤儿 result。
        assert "工具调用:calendar" in "\n".join(captured)
        assert "工具结果" in "\n".join(captured)
        assert "当前问题" in kept_text

    def test_protected_current_run_is_not_sent_to_summary(self, monkeypatch):
        """运行中压缩只整理本轮开始前的历史，当前 tool 链保持完整。"""
        captured = []

        async def fake_summary(items, previous=None):
            captured.extend(items)
            return "历史摘要"

        monkeypatch.setattr("agent.context.compaction._generate_compact_summary", fake_summary)
        current = _make_msg("user", "本轮问题")
        tool_use = {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "call-1", "name": "search", "input": {}}],
        }
        tool_result = _make_tool_result("本轮工具结果")
        messages = [_make_msg("user", "旧历史" * 3000), current, tool_use, tool_result]
        result, compacted = asyncio.get_event_loop().run_until_complete(
            compact_context(
                messages,
                "系统",
                context_tokens=80,
                protected_from=1,
            )
        )

        assert compacted
        captured_text = "\n".join(captured)
        assert "旧历史" in captured_text
        assert "本轮问题" not in captured_text
        assert "本轮工具结果" not in captured_text
        result_text = "\n".join(message_text(item) for item in result)
        assert "本轮问题" in result_text
        assert "本轮工具结果" in result_text

    def test_post_run_baseline_is_coalesced_and_uses_provider_usage(self, monkeypatch):
        """同一 session 的 run 收尾 baseline 只启动一次，并使用 provider usage。"""
        calls = []

        async def fake_compress(session_id, user_id, settings, token_budget, *, force=False):
            calls.append((session_id, user_id, token_budget, force))
            return False

        monkeypatch.setattr(compress_conv, "compress_if_needed", fake_compress)

        async def exercise():
            compress_conv._baseline_tasks.clear()
            compress_conv.schedule_baseline_update(88, "user", object(), 1000, actual_usage_tokens=950)
            compress_conv.schedule_baseline_update(88, "user", object(), 1000, actual_usage_tokens=950)
            await compress_conv.wait_for_baseline_update(88)

        asyncio.get_event_loop().run_until_complete(exercise())
        assert calls == [(88, "user", 1000, False)]

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
