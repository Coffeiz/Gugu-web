"""compaction 模块单元测试"""
import asyncio
import pytest
from agent.context.compaction import (
    estimate_context_length,
    compact_context,
    verify_prefix_consistency,
    _is_system_injection,
    COMPACTION_THRESHOLD_RATIO,
    COMPACTION_TARGET_RATIO,
)
from agent.context.tokens import content_text, estimate_tokens, message_text


def _make_msg(role: str, text: str) -> dict:
    return {"role": role, "content": text}


def _make_tool_result(text: str) -> dict:
    return {"role": "user", "content": [{"type": "tool_result", "content": text}]}


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
    def test_below_threshold_no_compact(self):
        """上下文未达到阈值时不应压缩"""
        msgs = [_make_msg("user", "你好")]
        result, compacted = asyncio.get_event_loop().run_until_complete(
            compact_context(msgs, "你是咕咕", context_tokens=256000)
        )
        assert not compacted
        assert result == msgs

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

    def test_preserves_system_injection(self):
        """压缩时应保留系统上下文注入消息"""
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

    def test_preserves_compact_summary(self):
        """压缩后应包含 compacted-summary"""
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


class TestVerifyPrefixConsistency:
    def test_valid_compacted(self):
        """验证正常压缩后的消息结构"""
        old = [_make_msg("user", "消息1"), _make_msg("user", "消息2")]
        new = [
            {"role": "user", "content": "## 项目\n- test"},
            {"role": "user", "content": "<compacted-summary>\n摘要内容\n</compacted-summary>"},
            _make_msg("user", "消息2"),
        ]
        ok, reason = verify_prefix_consistency(old, new)
        assert ok

    def test_empty_messages(self):
        """空消息列表应报错"""
        ok, reason = verify_prefix_consistency([], [])
        assert not ok
        assert "空" in reason

    def test_no_summary_marker(self):
        """缺少摘要标记应报错"""
        old = [_make_msg("user", "消息1")]
        new = [_make_msg("user", "消息2")]
        ok, reason = verify_prefix_consistency(old, new)
        assert not ok
        assert "compacted-summary" in reason

    def test_summary_at_wrong_position(self):
        """摘要在最后应报错（后面没有最近消息）"""
        old = [_make_msg("user", "消息1")]
        new = [{"role": "user", "content": "<compacted-summary>\n摘要\n</compacted-summary>"}]
        ok, reason = verify_prefix_consistency(old, new)
        assert not ok
        assert "最近消息" in reason
