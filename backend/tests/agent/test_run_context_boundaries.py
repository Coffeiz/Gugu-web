from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from agent.context import audit, dynamic_tail, run_context
from agent.context.assembly import reminder
from agent.context.provider_history import render_anthropic_message_roles
from agent.providers import adapter_for
from agent.providers.message_utils import render_openai_request_history
from agent.rag import context as rag_context


@pytest.mark.parametrize("use_anthropic,images,media,block_type", [
    (True, [{"media_type": "image/png", "b64": "AAAA"}], [], "image"),
    (False, [{"media_type": "image/png", "b64": "AAAA"}], [], "image_url"),
    (False, [], [{"type": "audio", "mime": "audio/flac", "b64": "AAAA"}], "input_audio"),
    (True, [], [{"type": "video", "mime": "video/mp4", "b64": "AAAA"}], "video"),
    (False, [], [{"type": "video", "mime": "video/mp4", "b64": "AAAA"}], "video_url"),
])
@pytest.mark.parametrize("reference_context", [None, "用户引用的资料"])
async def test_prepare_run_preserves_current_media_with_optional_reference(
    monkeypatch, use_anthropic, images, media, block_type, reference_context,
):
    """共享 IM/Web 组装路径必须接收媒体，混合引用时不丢媒体或重复持久化上传内容。"""
    from agent.chat.attachments import build_user_content

    async def fake_rag(*args, **kwargs):
        return {"tail": []}

    monkeypatch.setattr("agent.rag.injection.build_automatic_rag_context", fake_rag)
    monkeypatch.setattr(audit, "context_layout_audit", lambda **kwargs: None)
    prepared = await run_context.prepare_run(
        system_prompt="固定规则", snapshot_context="快照", history=[],
        req=SimpleNamespace(message="查看附件", reference_context=reference_context),
        user_tz=timezone.utc, strip_thinking=False, use_anthropic=use_anthropic,
        current_text="查看附件", images=images, media=media,
        model_cfg=SimpleNamespace(
            image_detail="auto", api_format="anthropic" if use_anthropic else "openai",
        ), stance_text=None,
        snapshot_injection=None,
        user_message=SimpleNamespace(id=11, sent_at=datetime(2026, 10, 3, tzinfo=timezone.utc)),
    )
    expected = next(block for block in build_user_content(
        "查看附件", images, use_anthropic, media=media,
    ) if block["type"] == block_type)
    blocks = [block for message in prepared.message_area.provider_projection()
              if isinstance(message.get("content"), list) for block in message["content"]]
    assert [block for block in blocks if block.get("type") == block_type] == [expected]
    assert any(block.get("text") == "查看附件" for block in blocks)
    if reference_context:
        assert any(reference_context in str(block.get("text", "")) for block in blocks)
    delta = prepared.message_area.persistence_delta(outcome="success")
    assert not any(expected == block for entry in delta.entries
                   for block in entry.canonical_message.get("content", [])
                   if isinstance(block, dict))


@pytest.mark.asyncio
async def test_prepare_run_reuses_rag_context_started_during_mcp_discovery(monkeypatch):
    """上游并发预取的 RAG 结果直接组装，不重复触发一次召回。"""
    precomputed = {"tail": [], "blocks": [], "injected": False}

    async def unexpected_rag(*_args, **_kwargs):
        raise AssertionError("不应重复调用自动 RAG")

    monkeypatch.setattr("agent.rag.injection.build_automatic_rag_context", unexpected_rag)
    monkeypatch.setattr(audit, "context_layout_audit", lambda **kwargs: None)

    prepared = await run_context.prepare_run(
        system_prompt="固定规则", snapshot_context="快照", history=[],
        req=SimpleNamespace(message="测试查询"), user_tz=timezone.utc,
        strip_thinking=False, use_anthropic=False, current_text="测试查询",
        images=[], media=[], model_cfg=SimpleNamespace(image_detail="auto"),
        stance_text=None, snapshot_injection=None,
        prepared_rag_context=precomputed,
    )

    assert prepared.rag_context is precomputed


@pytest.mark.asyncio
@pytest.mark.parametrize("use_anthropic", [True, False])
async def test_prepare_run_preserves_repeated_continue_turns_and_tool_outcomes(
    monkeypatch, use_anthropic,
):
    """跨 Run 回放不能合并相同用户文本、丢工具错误，或重复追加当前消息。"""
    monkeypatch.setattr(audit, "context_layout_audit", lambda **kwargs: None)

    def row(ident, role, blocks):
        return SimpleNamespace(
            id=ident, role=role, content="", content_json=blocks, sent_at=None,
            chat_type=None, platform_user_id=None, platform_user_name=None,
            files=None, quoted_text=None, references_json=None,
            canonical_batch_id=None, run_id=None, round_id=None,
        )

    fallback = "这轮没有接住请求，请换种说法。"
    history = [
        row(1, "user", [{"type": "text", "text": "创建日历事件并记一条笔记"}]),
        row(2, "assistant", [{
            "type": "tool_call", "id": "event-call", "name": "create_event",
            "arguments": {"title": "合成事件"},
        }]),
        row(3, "user", [{
            "type": "tool_result", "tool_call_id": "event-call",
            "tool_name": "create_event", "content": "{\"ok\":true}",
        }]),
        row(4, "assistant", [{
            "type": "tool_call", "id": "note-call", "name": "note_create",
            "arguments": {"title": "合成笔记"},
        }]),
        row(5, "user", [{
            "type": "tool_result", "tool_call_id": "note-call",
            "tool_name": "note_create", "content": "{\"error\":\"合成失败\"}",
            "is_error": True,
        }]),
        row(6, "assistant", [{"type": "text", "text": fallback}]),
        row(7, "user", [{"type": "text", "text": "继续"}]),
        row(8, "assistant", [{"type": "text", "text": fallback}]),
        row(9, "user", [{"type": "text", "text": "继续"}]),
        row(10, "assistant", [{"type": "text", "text": fallback}]),
        # 当前请求已先写入数据库；组装时必须按 ID 排除这一行，再追加完整本轮消息。
        row(11, "user", [{"type": "text", "text": "换句话说明后继续"}]),
    ]

    async def empty_rag(*_args, **_kwargs):
        return {"tail": []}

    monkeypatch.setattr("agent.rag.injection.build_automatic_rag_context", empty_rag)
    prepared = await run_context.prepare_run(
        system_prompt="固定规则", snapshot_context="快照", history=history,
        req=SimpleNamespace(
            message="换句话说明后继续", reference_context=None, chat_id=None,
        ),
        user_tz=timezone.utc, strip_thinking=False, use_anthropic=use_anthropic,
        current_text="换句话说明后继续", images=[], media=[],
        model_cfg=SimpleNamespace(
            image_detail="auto", api_format="anthropic" if use_anthropic else "openai",
        ),
        stance_text=None, snapshot_injection=None,
        user_message=SimpleNamespace(id=11, sent_at=None),
    )

    provider_messages = prepared.message_area.provider_projection().to_messages()
    serialized = str(provider_messages)
    from agent.context.tokens import message_text

    visible_text = [message_text(message) for message in provider_messages]
    assert visible_text.count("继续") == 2
    assert visible_text.count("换句话说明后继续") == 1
    assert visible_text.count(fallback) == 3
    assert "event-call" in serialized and "note-call" in serialized
    assert "合成失败" in serialized

    # 工具调用只作为已完成历史传给模型；上下文组装不会再次派发它们。
    block_call_ids = [
        block.get("id")
        for message in provider_messages
        for block in (message.get("content") if isinstance(message.get("content"), list) else [])
        if isinstance(block, dict) and block.get("type") in {"tool_use", "tool_call"}
    ]
    openai_call_ids = [
        call.get("id")
        for message in provider_messages
        for call in message.get("tool_calls", [])
    ]
    assert block_call_ids + openai_call_ids == ["event-call", "note-call"]

    block_result_ids = [
        block.get("tool_use_id") or block.get("tool_call_id")
        for message in provider_messages
        for block in (message.get("content") if isinstance(message.get("content"), list) else [])
        if isinstance(block, dict) and block.get("type") == "tool_result"
    ]
    openai_result_ids = [
        message.get("tool_call_id")
        for message in provider_messages
        if message.get("role") == "tool"
    ]
    assert block_result_ids + openai_result_ids == ["event-call", "note-call"]
    if use_anthropic:
        error_result = next(
            block
            for message in provider_messages
            for block in (message.get("content") if isinstance(message.get("content"), list) else [])
            if isinstance(block, dict)
            and block.get("type") == "tool_result"
            and block.get("tool_use_id") == "note-call"
        )
        assert error_result.get("is_error") is True


def test_message_time_reminder_uses_message_timestamp_and_user_timezone():
    from zoneinfo import ZoneInfo

    reminder_message = dynamic_tail.message_time_reminder(
        datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc),
        ZoneInfo("Asia/Shanghai"),
    )

    assert reminder_message == {
        "role": "user",
        "content": (
            "[system-reminder]\n"
            "消息时间：2026-08-29 18:00\n"
            "[/system-reminder]"
        ),
    }


def test_historical_message_time_reminder_keeps_historical_label():
    assert dynamic_tail.message_time_reminder(
        datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc), timezone.utc,
    ) == {
        "role": "user",
        "content": (
            "[system-reminder]\n"
            "消息时间：2026-08-29 10:00\n"
            "[/system-reminder]"
        ),
    }


def test_time_message_marks_timestamp_as_reference_not_user_content(monkeypatch):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 14, 13, 10, tzinfo=tz)

    monkeypatch.setattr(dynamic_tail, "datetime", FixedDatetime)

    assert dynamic_tail.time_message(timezone.utc) == {
        "role": "user",
        "content": (
            "[system-reminder]\n"
            "仅供时间参考，不属于用户正文，请勿复述。\n"
            "当前时间：2026-09-14（星期一）13:10\n"
            "[/system-reminder]"
        ),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("use_anthropic", [True, False])
async def test_prepare_run_binds_rag_watermark_and_uses_message_time(
    monkeypatch, use_anthropic,
):
    observed_watermarks = []

    async def fake_rag(_req, _query, *, history, snapshot_text):
        observed_watermarks.append(rag_context.get_conversation_before_message_id())
        assert history == []
        assert snapshot_text == "snapshot"
        return {"tail": []}

    audit_calls = []
    monkeypatch.setattr("agent.rag.injection.build_automatic_rag_context", fake_rag)
    monkeypatch.setattr(
        audit,
        "context_layout_audit",
        lambda **kwargs: audit_calls.append(kwargs),
    )

    legacy_time_context = SimpleNamespace(
        content_json=[{"type": "time-context", "text": "旧当前时间"}],
    )
    prepared = await run_context.prepare_run(
        system_prompt="stable system",
        snapshot_context="snapshot",
        history=[legacy_time_context],
        req=SimpleNamespace(message="旧文本"),
        user_tz=timezone.utc,
        strip_thinking=False,
        use_anthropic=use_anthropic,
        current_text="当前文本",
        images=[],
        media=[],
        model_cfg=SimpleNamespace(image_detail="auto"),
        stance_text=None,
        snapshot_injection=None,
        user_message=SimpleNamespace(
            id=11,
            sent_at=datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc),
        ),
    )

    messages = prepared.message_area
    assert observed_watermarks == [11]
    assert rag_context.get_conversation_before_message_id() is None
    assert messages.dynamic_tail == []
    conversation_text = str(messages.provider_projection().to_messages())
    current_time_text = "消息时间：2026-08-29 10:00"
    assert conversation_text.count(current_time_text) == 1
    assert conversation_text.index(current_time_text) < conversation_text.index("当前文本")
    assert "当前时间：" not in conversation_text
    assert "当前时间：" not in str(messages.batch_records())
    adapter = adapter_for(SimpleNamespace(
        provider="anthropic" if use_anthropic else "openai",
        api_format="anthropic" if use_anthropic else "openai",
        model="test-model",
    ))
    projection = messages.provider_projection()
    provider_messages = (
        render_anthropic_message_roles(projection, adapter)
        if use_anthropic else render_openai_request_history(projection, adapter)
    )
    assert provider_messages.dynamic_tail == []
    assert audit_calls[0]["history"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("use_anthropic", [True, False])
async def test_prepare_run_keeps_reference_context_before_current_text(
    monkeypatch, use_anthropic,
):
    async def fake_rag(_req, _query, *, history, snapshot_text):
        return {"tail": [], "blocks": []}

    monkeypatch.setattr("agent.rag.injection.build_automatic_rag_context", fake_rag)
    req = SimpleNamespace(
        message="更新下文档",
        reference_context="以下是用户明确引用的文件：文件 id：123",
    )
    prepared = await run_context.prepare_run(
        system_prompt="stable system",
        snapshot_context="snapshot",
        history=[],
        req=req,
        user_tz=timezone.utc,
        strip_thinking=False,
        use_anthropic=use_anthropic,
        current_text="更新下文档",
        images=[],
        media=[],
        model_cfg=SimpleNamespace(image_detail="auto"),
        stance_text=None,
        snapshot_injection=None,
        user_message=SimpleNamespace(
            id=12,
            sent_at=datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc),
        ),
    )
    messages = prepared.message_area
    canonical_messages = [entry.canonical_message for entry in messages.entries]
    assert any(
        isinstance(block, dict)
        and block.get("type") == "knowledge-context"
        and block.get("scope") == "explicit-reference"
        for item in canonical_messages
        for block in (item.get("content") if isinstance(item.get("content"), list) else [])
    )
    projection = messages.provider_projection()
    projected_text = str(projection.to_messages())
    assert projected_text.index("文件 id：123") < projected_text.index("更新下文档")
    assert prepared.message_area.entries[-1].source.value == "reference"
    assert prepared.message_area.entries[-1].persisted_message_id == 12
