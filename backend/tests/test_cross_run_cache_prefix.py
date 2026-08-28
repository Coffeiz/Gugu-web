from datetime import datetime, timezone
from types import SimpleNamespace

from agent.context.assembly import NewMessageBatch, PromptMessages, assemble_turn, reminder
from agent.context.canonical_tool_history import render_events_for_provider
from agent.context.history import build_history_parts
from agent.context.provider_history import render_anthropic_message_roles
from agent.context.run_context import _is_legacy_persisted_time_context
from agent.security import sanitize


def _provider_wire(messages):
    clean = sanitize.sanitize_messages(list(messages))
    rendered = render_events_for_provider(clean)
    return render_anthropic_message_roles(rendered, None)


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

    rendered = render_events_for_provider(messages)

    assert rendered[0]["content"] == [
        {"type": "text", "text": time_text},
        {"type": "text", "text": "查查天气吧"},
        {"type": "text", "text": runtime_text},
    ]


def test_dynamic_tail_is_provider_only_and_always_stays_last():
    batch, _ = assemble_turn(
        current_user={"role": "user", "content": "测试"},
    )
    prompt = PromptMessages()
    prompt.set_dynamic_tail([
        reminder("当前时间：2026-08-27（星期四）"),
    ])
    prompt.append_batch(batch)
    prompt.append_batch(NewMessageBatch.from_provider_messages([
        {"role": "assistant", "content": "工具前说明"},
        {"role": "user", "content": "工具结果"},
    ]))

    assert prompt.dynamic_tail == [
        reminder("当前时间：2026-08-27（星期四）"),
    ]
    assert list(prompt)[-1] == reminder("当前时间：2026-08-27（星期四）")
    assert prompt.conversation == [
        {"role": "user", "content": "测试"},
        {"role": "assistant", "content": "工具前说明"},
        {"role": "user", "content": "工具结果"},
    ]
    assert batch.canonical_messages == ()
    assert prompt.canonical_batches == ()

    prompt.replace_conversation([
        {"role": "user", "content": "压缩后的稳定 conversation"},
    ])
    assert prompt.conversation == [
        {"role": "user", "content": "压缩后的稳定 conversation"},
    ]
    assert list(prompt)[-1] == reminder("当前时间：2026-08-27（星期四）")


def test_message_time_with_empty_canonical_projection_stays_provider_only_after_seal():
    batch, _ = assemble_turn(
        message_time=reminder("08-27 18:27"),
        current_user={"role": "user", "content": "所以已经有一些信息了？"},
    )
    assert batch.canonical_messages == ()

    prompt = PromptMessages()
    prompt.append_batch(batch)

    assert prompt.conversation == [
        {
            "role": "user",
            "content": [{
                "type": "time-context",
                "text": "[system-reminder]\n08-27 18:27\n[/system-reminder]",
            }],
        },
        {"role": "user", "content": "所以已经有一些信息了？"},
    ]
    assert batch.canonical_messages == ()
    assert prompt.canonical_batches == ()


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


def test_last_round_conversation_replays_as_next_run_prefix_without_dynamic_tail():
    sent_at = datetime(2026, 8, 27, 17, 8, tzinfo=timezone.utc)
    message_time = reminder("08-27 17:08")
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
    tool_batch = NewMessageBatch.from_provider_messages([
        {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "call-weather",
                "name": "use_skill",
                "input": {"name": "weather"},
            }],
        },
        {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "call-weather",
                "content": "weather skill loaded",
            }],
        },
    ])

    previous_round = PromptMessages()
    previous_round.set_dynamic_tail([
        reminder(f"当前时间：{now_text}"),
    ])
    previous_round.append_batch(turn_batch)
    previous_round.append_batch(tool_batch)
    previous_conversation_wire = _provider_wire(previous_round.conversation)

    # dynamic tail 发给 provider，但不属于可重放 conversation；Anthropic 清洗可能
    # 把相邻 user 块合并，所以这里只锁定语义存在，不假定它一定独占一条 message。
    full_wire = _provider_wire(previous_round)
    assert "当前时间：2026-08-27（星期四）" in str(full_wire)
    assert "当前时间：2026-08-27（星期四）" not in str(previous_conversation_wire)

    # 当前用户正文已经在进入 LLM 前单独落库；turn batch 只应保存那些
    # 必须跨 run 原位置 replay 的附属上下文。
    assert [
        block["type"]
        for message in turn_batch.canonical_messages
        for block in message["content"]
    ] == ["runtime-context"]

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
    for message in (*turn_batch.canonical_messages, *tool_batch.canonical_messages):
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

    assert next_run_prefix == previous_conversation_wire
