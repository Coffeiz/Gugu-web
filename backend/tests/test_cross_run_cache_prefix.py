from datetime import datetime, timezone
from types import SimpleNamespace

from agent.context.assembly import MessageBatch, MessageArea, assemble_turn, reminder
from agent.context.canonical_tool_history import render_events_for_provider
from agent.context.history import build_history_parts
from agent.context.provider_history import render_anthropic_message_roles
from agent.context.run_context import (
    _effective_history,
    _is_legacy_persisted_time_context,
)
from agent.security import sanitize
from agent.context.provider_conversation import ProviderConversation


def _provider_wire(messages):
    if isinstance(messages, MessageArea):
        projection = messages.provider_projection()
    elif isinstance(messages, ProviderConversation):
        projection = messages
    else:
        projection = ProviderConversation(messages)
    return render_anthropic_message_roles(
        render_events_for_provider(projection), None,
    )


def _history_row(*, role, content="", content_json=None, sent_at=None, row_id=1):
    return SimpleNamespace(
        id=row_id,
        role=role,
        content=content,
        content_json=content_json,
        sent_at=sent_at,
        created_at=sent_at,
        files=None,
        quoted_text=None,
        chat_type=None,
        platform_user_id=None,
        platform_user_name=None,
    )


def test_rag_context_precedes_user_in_anthropic_and_openai_projections():
    rag = {
        "role": "user",
        "content": [{
            "type": "knowledge-context",
            "scope": "owner-rag",
            "text": "[owner-rag]\n参考资料\n[/owner-rag]",
        }],
    }
    batch, _ = assemble_turn(
        current_user={"role": "user", "content": "当前问题"},
        conversation_tail=[rag],
    )
    prompt = MessageArea.from_canonical_messages()
    prompt.append_batch(batch)

    # Anthropic/MiniMax 路径先清洗，再在 provider 边界渲染 canonical event。
    prompt.configure_request(fixed_prefix=(), render_options={"api_format": "anthropic"})
    anthropic = prompt.provider_projection().to_messages()
    # OpenAI 兼容路径保留独立消息边界，canonical event 也在 provider 边界渲染。
    prompt.configure_request(fixed_prefix=(), render_options={"api_format": "openai"})
    openai = prompt.provider_projection().to_messages()

    for projected in (anthropic, openai):
        assert [message["role"] for message in projected] == ["user", "user"]
        assert "参考资料" in str(projected[0]["content"])
        assert projected[1]["content"] in ("当前问题", [{"type": "text", "text": "当前问题"}])


def test_provider_render_keeps_canonical_blocks_in_original_position():
    time_text = "[system-reminder]\n08-27 17:08\n[/system-reminder]"
    runtime_text = "[system-reminder]\n身份事实\n[/system-reminder]"
    messages = [{
        "role": "user",
        "content": [
            {"type": "time-context", "text": time_text},
            {"type": "text", "text": "查查天气吧"},
            {"type": "runtime-context", "text": runtime_text},
        ],
    }]

    rendered = render_events_for_provider(ProviderConversation(messages))

    assert rendered[0]["content"] == [
        {"type": "text", "text": time_text},
        {"type": "text", "text": "查查天气吧"},
        {"type": "text", "text": runtime_text},
    ]


def test_dynamic_tail_is_provider_only_and_always_stays_last():
    batch, _ = assemble_turn(
        current_user={"role": "user", "content": "测试"},
    )
    prompt = MessageArea.from_canonical_messages()
    prompt.set_dynamic_tail([
        reminder("当前时间：2026-08-27（星期四）"),
    ])
    prompt.append_batch(batch)
    prompt.append_batch(MessageBatch.from_canonical_messages([
        {"role": "assistant", "content": "工具前说明"},
        {"role": "user", "content": "工具结果"},
    ]))

    assert prompt.dynamic_tail == [
        reminder("当前时间：2026-08-27（星期四）"),
    ]
    assert prompt.provider_projection().to_messages()[-1] == reminder("当前时间：2026-08-27（星期四）")
    assert prompt.provider_projection().conversation == [
        {"role": "user", "content": "测试"},
        {"role": "assistant", "content": "工具前说明"},
        {"role": "user", "content": "工具结果"},
    ]
    assert batch.canonical_messages == ({"role": "user", "content": "测试"},)
    assert prompt.batch_records() == ()
    assert prompt.persistence_delta(outcome="success").entries == ()

    prompt.replace_request_baseline(
        [{"role": "user", "content": "压缩后的稳定 conversation"}],
        expected_revision=prompt.revision,
    )
    assert prompt.provider_projection().conversation == [
        {"role": "user", "content": "压缩后的稳定 conversation"},
    ]
    assert prompt.provider_projection().to_messages()[-1] == reminder("当前时间：2026-08-27（星期四）")


def test_message_time_is_canonical_but_reconstructed_and_user_is_already_persisted():
    batch, _ = assemble_turn(
        message_time=reminder("08-27 18:27"),
        current_user={"role": "user", "content": "所以已经有一些信息了？"},
    )
    assert [
        message["content"][0]["type"] if isinstance(message["content"], list) else "text"
        for message in batch.canonical_messages
    ] == ["time-context", "text"]

    prompt = MessageArea.from_canonical_messages()
    prompt.append_batch(batch)

    assert prompt.entries[0].canonical_message["content"][0]["type"] == "time-context"
    assert prompt.provider_projection().to_messages() == [
        {"role": "user", "content": [{
            "type": "text",
            "text": "[system-reminder]\n08-27 18:27\n[/system-reminder]",
        }]},
        {"role": "user", "content": "所以已经有一些信息了？"},
    ]
    assert [entry.persistence_policy.value for entry in prompt.entries] == [
        "reconstruct_on_restore", "already_persisted",
    ]
    assert prompt.persistence_delta(outcome="success").entries == ()
    assert prompt.batch_records() == ()


def test_legacy_persisted_time_context_rows_are_filtered():
    dynamic_now = _history_row(
        role="user",
        content_json=[{
            "type": "time-context",
            "text": "[system-reminder]\n当前时间：2026-08-27（星期四）\n[/system-reminder]",
        }],
    )
    message_time = _history_row(
        role="user",
        content_json=[{
            "type": "time-context",
            "text": "[system-reminder]\n08-27 18:27\n[/system-reminder]",
        }],
    )
    mixed_context = _history_row(
        role="user",
        content_json=[
            {
                "type": "time-context",
                "text": "[system-reminder]\n08-27 18:27\n[/system-reminder]",
            },
            {
                "type": "runtime-context",
                "text": "[system-reminder]\n身份事实\n[/system-reminder]",
            },
        ],
    )

    assert _is_legacy_persisted_time_context(dynamic_now) is True
    assert _is_legacy_persisted_time_context(message_time) is True
    assert _is_legacy_persisted_time_context(mixed_context) is False


def test_current_persisted_user_row_is_not_replayed_before_current_projection():
    """后台重读 history 后，当前用户正文只能出现一次。

    Web 会先提交用户行再启动后台任务；带图片时 history 中的行是纯文本持久化
    版本，而 current_user 是完整 provider 投影。若两者都发送，会破坏跨轮缓存。
    """
    current = _history_row(
        row_id=42, role="user", content="看这张图",
        content_json=[{"type": "text", "text": "看这张图"}],
    )
    previous = _history_row(
        row_id=41, role="user", content="上一条",
        content_json=[{"type": "text", "text": "上一条"}],
    )
    filtered = _effective_history([previous, current], user_message=current)

    assert [message.id for message in filtered] == [41]


def test_last_round_conversation_replays_as_next_run_prefix_without_dynamic_tail():
    sent_at = datetime(2026, 8, 27, 17, 8, tzinfo=timezone.utc)
    message_time = reminder("消息时间：2026-08-27 17:08")
    runtime_context = "## 当前 IM 身份事实（只供内部核对）\n- 平台：qq\n- 会话类型：私聊"
    now_text = "2026-08-27（星期四）"

    turn_batch, _ = assemble_turn(
        message_time=message_time,
        current_user={
            "role": "user",
            "content": [{"type": "text", "text": "查查天气吧"}],
        },
        extra_reminder=runtime_context,
    )
    tool_batch = MessageBatch.from_canonical_messages([
        {
            "role": "assistant",
            "content": [{
                "type": "tool_call",
                "id": "call-weather",
                "name": "use_skill",
                "arguments": {"name": "weather"},
            }],
        },
        {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_call_id": "call-weather",
                "content": "weather skill loaded",
            }],
        },
    ], metadata={"round_id": "round-1"})

    previous_round = MessageArea.from_canonical_messages()
    previous_round.configure_request(
        fixed_prefix=(), render_options={"api_format": "anthropic"},
    )
    previous_round.set_dynamic_tail([
        reminder(f"当前时间：{now_text}"),
    ])
    previous_round.append_batch(turn_batch)
    previous_round.append_batch(tool_batch)
    previous_conversation_wire = _provider_wire(
        ProviderConversation(previous_round.provider_projection().conversation)
    )

    # dynamic tail 发给 provider，但不属于可重放 conversation；Anthropic 清洗可能
    # 把相邻 user 块合并，所以这里只锁定语义存在，不假定它一定独占一条 message。
    full_wire = _provider_wire(previous_round)
    assert "当前时间：2026-08-27（星期四）" in str(full_wire.to_messages())
    assert "当前时间：2026-08-27（星期四）" not in str(previous_conversation_wire)

    # Batch 只暴露 canonical Area 内容；是否提交由 entry policy 决定。
    assert [
        block["type"]
        for message in turn_batch.canonical_messages
        for block in message["content"]
    ] == ["time-context", "text"]

    history = [
        _history_row(
            row_id=1,
            role="user",
            content="查查天气吧",
            content_json=[{"type": "text", "text": "查查天气吧"}],
            sent_at=sent_at,
        ),
    ]
    row_id = 2
    durable_entries = previous_round.persistence_delta(outcome="success").entries
    for entry in durable_entries:
        message = entry.canonical_message
        history.append(_history_row(
            row_id=row_id,
            role=message["role"],
            content_json=list(message["content"]),
            sent_at=sent_at,
        ))
        row_id += 1

    restored = build_history_parts(
        history,
        SimpleNamespace(source="qq", chat_id=None),
        use_anthropic=True,
        user_tz=timezone.utc,
    )
    next_run_prefix = _provider_wire(restored)

    assert next_run_prefix.to_messages() == previous_conversation_wire.to_messages()


def test_temporary_runtime_context_is_request_tail_not_persisted_history():
    """环境提醒只属于本轮动态尾部，持久化仍保留 RAG 而不保存过期环境。"""
    runtime_text = "## 当前会话工作区\n当前绑定：QQ；规范落点 space=personal"
    turn_batch, _ = assemble_turn(
        current_user={"role": "user", "content": "测试"},
        conversation_tail=[{
            "role": "user",
            "content": [{"type": "knowledge-context", "text": "RAG"}],
        }],
        extra_reminder=runtime_text,
    )
    messages = MessageArea.from_canonical_messages()
    messages.append_batch(turn_batch)

    delta = messages.persistence_delta(outcome="success")
    runtime_entries = [
        entry for entry in delta.entries if entry.source.value == "runtime"
    ]

    assert runtime_entries == []
    assert runtime_text in messages.dynamic_tail[-1]["content"]
    assert runtime_text not in str(messages.provider_projection().conversation)
    assert any(entry.source.value == "rag" for entry in delta.entries)


def test_replayed_knowledge_context_keeps_message_boundary_across_runs():
    """回放的 RAG canonical event 必须保持独立消息边界。

    回归背景：_anthropic_history_blocks 曾把 knowledge-context 提前摊平成
    text block，sanitize 认不出 canonical boundary，把它合并进相邻 user
    消息；注入时是独立消息、下一轮回放变成合并消息，跨 run 字节前缀在该
    消息处断裂，缓存命中从 2 万+ token 跌到几十 token。
    """
    sent_at = datetime(2026, 8, 27, 17, 8, tzinfo=timezone.utc)
    rag_block = {
        "type": "knowledge-context",
        "scope": "owner-rag",
        "text": "[owner-rag]\n以下是已检索知识片段。\n[/owner-rag]",
    }
    history = [
        _history_row(
            row_id=1, role="user", content_json=[dict(rag_block)],
            sent_at=sent_at,
        ),
        _history_row(
            row_id=2, role="user", content="上一条问题",
            content_json=[{"type": "text", "text": "上一条问题"}],
            sent_at=sent_at,
        ),
        _history_row(
            row_id=3, role="assistant",
            content_json=[{"type": "text", "text": "上一轮的回答"}],
            sent_at=sent_at,
        ),
    ]

    restored = build_history_parts(
        history,
        SimpleNamespace(source="web", chat_id=None),
        use_anthropic=True,
        user_tz=timezone.utc,
    )
    clean = sanitize.sanitize_messages(restored)

    # RAG、时间 reminder、用户正文、回答都保持独立边界，连续 user 没有被合并
    assert len(clean) == 4
    assert clean[0]["content"] == [rag_block]

    # provider wire 上与注入形状一致：canonical event 原位渲染成独立 user 消息
    wire = _provider_wire(restored)
    assert len(wire) == 4
    assert wire[0] == {
        "role": "user",
        "content": [{"type": "text", "text": rag_block["text"]}],
    }
