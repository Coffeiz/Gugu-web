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
    _generate_compact_summary,
    validate_compact_summary,
    resolve_compaction_limits,
)
from agent.context.tokens import estimate_tokens, message_text


def _make_msg(role: str, text: str) -> dict:
    return {"role": role, "content": text}


def _make_tool_result(text: str) -> dict:
    return {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": text}]}


def _model_cfg(context_tokens: int = 256_000, max_tokens: int = 8_000):
    return SimpleNamespace(context_tokens=context_tokens, max_tokens=max_tokens)


@pytest.fixture(autouse=True)
def _fake_summary(monkeypatch):
    """压缩单测只验证编排，不访问真实摘要模型。"""
    async def fake_summary(_items, _previous=None, **_kwargs):
        return "测试摘要"

    monkeypatch.setattr("agent.context.compaction._generate_compact_summary", fake_summary)


class TestCompactionBudget:
    def test_compaction_prompt_path_dependency_is_available(self):
        """90% 压缩触发时提示词路径解析不能因缺少标准库依赖而中断。"""
        assert compaction_module.Path("compress_conv.md").name == "compress_conv.md"

    def test_compaction_summary_uses_model_output_budget(self, monkeypatch):
        captured = {}

        async def fake_complete_text(sys, user, settings, max_tokens):
            captured["system_prompt"] = sys
            captured["user_prompt"] = user
            captured["max_tokens"] = max_tokens
            return "压缩摘要"

        monkeypatch.setattr("app.core.config.get_settings", lambda: object())
        monkeypatch.setattr("agent.context.provider_runner.complete_text", fake_complete_text)
        result = asyncio.get_event_loop().run_until_complete(
            compaction_module._generate_compact_summary_once(
                ["用户：测试压缩"], model_cfg=_model_cfg(120_000, 8_000),
            )
        )

        assert result == "压缩摘要"
        assert "历史对话" in captured["system_prompt"]
        assert captured["user_prompt"] == "用户：测试压缩"
        assert captured["max_tokens"] == 8_000

    def test_compaction_limits_follow_model_config(self):
        limits = resolve_compaction_limits(
            model_cfg=SimpleNamespace(context_tokens=120_000, max_tokens=8_000)
        )

        assert limits.context_tokens == 120_000
        assert limits.output_tokens == 8_000
        assert limits.input_tokens == 112_000

    def test_summary_output_limit_follows_model_config(self, monkeypatch):
        captured = {}

        async def fake_complete_text(_sys, _user, _settings, max_tokens):
            captured["max_tokens"] = max_tokens
            return "压缩摘要"

        monkeypatch.setattr("app.core.config.get_settings", lambda: object())
        monkeypatch.setattr("agent.context.provider_runner.complete_text", fake_complete_text)
        result = asyncio.get_event_loop().run_until_complete(
            compaction_module._generate_compact_summary_once(
                ["用户：测试压缩"],
                model_cfg=SimpleNamespace(context_tokens=120_000, max_tokens=8_000),
            )
        )

        assert result == "压缩摘要"
        assert captured["max_tokens"] == 8_000

    def test_summary_input_limit_follows_model_config(self, monkeypatch):
        calls = []

        async def fake_once(items, _previous=None, **_kwargs):
            calls.append(items)
            return "分块摘要"

        monkeypatch.setattr("agent.context.compaction._generate_compact_summary_once", fake_once)
        items = ["用户：" + "内容" * 20 for _ in range(8)]
        result = asyncio.get_event_loop().run_until_complete(
            _generate_compact_summary(
                items,
                model_cfg=SimpleNamespace(context_tokens=100, max_tokens=20),
            )
        )

        assert result == "分块摘要"
        assert len(calls) > 1
        assert all(estimate_tokens("\n".join(chunk)) <= 80 for chunk in calls)

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
        async def oversized_summary(_items, _previous=None, **_kwargs):
            return "x" * 40_000

        monkeypatch.setattr("agent.context.compaction._generate_compact_summary", oversized_summary)
        messages = [_make_msg("user", "旧消息" * 100) for _ in range(50)]
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(
                messages, model_cfg=_model_cfg(1000),
            )
        )
        assert not result.changed
        assert result.return_reason == "summary_validation_failed"
        assert result.messages == messages

    def test_small_history_uses_single_branch_summary_request(self, monkeypatch):
        calls = []

        async def fake_once(items, previous=None, **_kwargs):
            calls.append((items, previous))
            return "分支摘要"

        monkeypatch.setattr("agent.context.compaction._generate_compact_summary_once", fake_once)
        result = asyncio.get_event_loop().run_until_complete(
            _generate_compact_summary(
                ["用户：第一条", "咕咕：第二条"], "旧摘要", model_cfg=_model_cfg(),
            )
        )
        assert result == "分支摘要"
        assert len(calls) == 1
        assert calls[0][1] == "旧摘要"

    def test_oversized_history_uses_rolling_fallback(self, monkeypatch):
        calls = []

        async def fake_once(items, previous=None, **_kwargs):
            calls.append((items, previous))
            return f"摘要{len(calls)}"

        monkeypatch.setattr("agent.context.compaction._generate_compact_summary_once", fake_once)
        items = ["用户：" + "内容" * 30_000, "咕咕：" + "内容" * 30_000,
                 "用户：" + "内容" * 30_000, "咕咕：" + "内容" * 30_000]
        result = asyncio.get_event_loop().run_until_complete(
            _generate_compact_summary(items, model_cfg=_model_cfg(100_000))
        )
        assert result == f"摘要{len(calls)}"
        assert len(calls) > 1

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
        result = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, model_cfg=_model_cfg(1000))
        )
        assert result.changed  # 应该触发压缩

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
            "agent.context.compaction._generate_compact_summary",
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

    def test_post_run_baseline_is_coalesced_and_uses_provider_usage(self, monkeypatch):
        """同一 session 的 run 收尾 baseline 只启动一次，并使用 provider usage。"""
        calls = []

        async def fake_compress(session_id, user_id, settings, *, force=False):
            calls.append((session_id, user_id, force))
            return False

        monkeypatch.setattr(compress_conv, "compress_if_needed", fake_compress)

        async def exercise():
            compress_conv._baseline_tasks.clear()
            compress_conv.schedule_baseline_update(88, "user", object(), 1000, actual_usage_tokens=950)
            compress_conv.schedule_baseline_update(88, "user", object(), 1000, actual_usage_tokens=950)
            await compress_conv.wait_for_baseline_update(88)

        asyncio.get_event_loop().run_until_complete(exercise())
        assert calls == [(88, "user", False)]

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
