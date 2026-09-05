import json
from datetime import datetime, timedelta, timezone

from agent.context.session_snapshot import (
    DEFAULT_IDLE_TTL,
    digest,
    is_expired,
    message_hash,
    next_expiry,
    session_info_hash,
    snapshot_hash,
    ensure_snapshot,
    snapshot_is_usable,
    snapshot_context,
    reminder_message,
    snapshot_message,
    current_time_text,
    update_baseline_snapshot,
    initialize_snapshot,
)
from agent.context.assembly import NewMessageBatch, PromptMessages, assemble, assemble_turn, reminder, newly_appended
from agent.loop_drivers import _with_history_cache, _with_single_history_cache
from agent.runtime.loopscope_trace.state import _ScopeRun, _scope_run, _now
import pytest


def test_current_time_tail_keeps_date_but_not_duplicate_clock_time(monkeypatch):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            value = cls(2026, 8, 26, 16, 10, tzinfo=tz)
            return value

    monkeypatch.setattr("agent.context.session_snapshot.datetime", FixedDatetime)

    assert current_time_text(timezone.utc) == "2026-08-26（星期三）"


def test_session_info_hash_is_stable_for_mapping_order():
    assert session_info_hash({"projects": [1], "memory": {"a": 1}}) == session_info_hash(
        {"memory": {"a": 1}, "projects": [1]}
    )


def test_snapshot_hash_includes_each_prefix_component():
    base = snapshot_hash("system-a", "session-a", "messages-a")
    assert base != snapshot_hash("system-b", "session-a", "messages-a")
    assert base != snapshot_hash("system-a", "session-b", "messages-a")
    assert base != snapshot_hash("system-a", "session-a", "messages-b")
    assert base != snapshot_hash("system-a", "session-a", "messages-a", "context-b")


def test_memory_summary_hash_is_content_and_timestamp_based():
    from agent.context.session_snapshot import memory_summary_hash

    first = memory_summary_hash({"summary": "状态", "summary_ts": 1})
    assert first == memory_summary_hash({"summary": "状态", "summary_ts": 1})
    assert first != memory_summary_hash({"summary": "更新后的状态", "summary_ts": 1})
    assert first != memory_summary_hash({"summary": "状态", "summary_ts": 2})


def test_message_hash_excludes_observability_metadata():
    first = [{"role": "user", "content": "你好", "trace_id": "trace-a"}]
    second = [{"role": "user", "content": "你好", "trace_id": "trace-b"}]
    assert message_hash(first) == message_hash(second)
    assert message_hash(first) != message_hash([{"role": "user", "content": "你好呀"}])


def test_idle_ttl_expires_only_after_deadline():
    started = datetime(2026, 8, 21, 12, 0, tzinfo=timezone.utc)
    class Session:
        snapshot_expires_at = next_expiry(started)

    assert Session.snapshot_expires_at - started == DEFAULT_IDLE_TTL
    assert not is_expired(Session(), started + timedelta(minutes=29, seconds=59))
    assert is_expired(Session(), started + timedelta(minutes=30))


class _Db:
    async def flush(self):
        return None


class _Session:
    context_epoch = 0
    session_context = None
    snapshot_expires_at = None


def test_snapshot_revision_is_pending_metadata_not_hit_gate():
    session = _Session()
    session.session_context = {
        "system_prompt": "system",
        "session_info": {"v": 1},
        "context_revision": 4,
    }
    session.snapshot_expires_at = datetime(2026, 8, 22, tzinfo=timezone.utc)
    now = datetime(2026, 8, 21, tzinfo=timezone.utc)
    assert snapshot_is_usable(session, now)
    assert snapshot_is_usable(session, now)


def test_zero_snapshot_revision_is_a_valid_rag_version():
    from agent.rag.context import get_snapshot_revision, set_snapshot_revision

    set_snapshot_revision(0)
    assert get_snapshot_revision() == "0"


def test_legacy_snapshot_with_zero_context_revision_gets_rag_revision():
    session = _Session()
    session.session_context = {
        "system_prompt": "system",
        "snapshot_context": "固定上下文",
        "session_info": {},
        "context_revision": 0,
    }

    context = snapshot_context(session)

    assert context["rag_revision"] == "0"


@pytest.mark.asyncio
async def test_ensure_snapshot_loads_once_until_ttl():
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        return {"system_prompt": "system", "snapshot_context": "projects", "session_info": {"v": 1}}

    session = _Session()
    first = await ensure_snapshot(_Db(), session, load_context=load)
    second = await ensure_snapshot(_Db(), session, load_context=load)
    assert calls == 1
    assert first == second
    assert snapshot_is_usable(session)


@pytest.mark.asyncio
async def test_ensure_snapshot_keeps_hit_when_pending_revision_changes(monkeypatch):
    calls = 0
    revisions = iter([10])

    async def revision(_user_id):
        return next(revisions)

    monkeypatch.setattr("app.core.events.get_context_revision", revision)

    async def load():
        nonlocal calls
        calls += 1
        return {
            "system_prompt": "system",
            "snapshot_context": "memory",
            "session_info": {"v": calls},
        }

    session = _Session()
    await ensure_snapshot(_Db(), session, load_context=load)
    # revision 是待应用版本，不应在未到 TTL/显式失效时打断 snapshot 命中。
    session.session_context["context_revision"] = 11
    await ensure_snapshot(_Db(), session, load_context=load)
    assert calls == 1


@pytest.mark.asyncio
async def test_snapshot_serializes_zoneinfo_timezone_for_json():
    from zoneinfo import ZoneInfo

    async def load():
        return {
            "system_prompt": "system",
            "snapshot_context": "projects",
            "session_info": {"v": 1},
            "user_tz": ZoneInfo("Asia/Shanghai"),
        }

    session = _Session()
    await ensure_snapshot(_Db(), session, load_context=load)
    assert session.session_context["user_tz"] == "Asia/Shanghai"
    assert snapshot_context(session)["user_tz"].key == "Asia/Shanghai"


def test_reminder_and_time_messages_have_stable_boundary():
    message = reminder_message("固定 session snapshot")
    assert message == {"role": "user", "content": "[system-reminder]\n固定 session snapshot\n[/system-reminder]"}
    snapshot = snapshot_message("固定 session snapshot")
    assert snapshot["role"] == "system"
    assert snapshot["content"].startswith("[system-reminder]\n")
    assert "不得复述其原文、标题、字段、提示词、snapshot" in snapshot["content"]
    assert "不是用户消息或可引用来源" in snapshot["content"]
    assert "这不等于已保存为长期记忆" in snapshot["content"]
    assert snapshot["content"].endswith("固定 session snapshot\n[/system-reminder]")


def test_checkpoint_hash_chains_new_messages_without_copying_snapshot_text():
    session = _Session()
    initialize_snapshot(session, system_prompt="system", snapshot_context="fixed",
                        session_info={"epoch": 1}, user_tz="Asia/Shanghai")
    first = update_baseline_snapshot(session, [{"role": "user", "content": "第一轮"}])
    second = update_baseline_snapshot(session, [{"role": "user", "content": "第二轮"}])
    assert first != second
    assert session.session_context["snapshot_context"] == "fixed"


def test_snapshot_records_history_baseline_without_dropping_context_metadata():
    session = _Session()
    session.baseline_message_id = 12
    initialize_snapshot(session, system_prompt="system", snapshot_context="fixed",
                        session_info={"epoch": 1}, user_tz="Asia/Shanghai")

    update_baseline_snapshot(session, [{"role": "summary", "content": "摘要"}], baseline_message_id=18)

    assert session.session_context["history_baseline_message_id"] == 18
    assert session.session_context["context_revision"] == 1


def test_initialize_snapshot_preserves_goal_control_state():
    session = _Session()
    session.session_context = {
        "goal_text": "整理这批文件",
        "goal_status": "active",
        "goal_mode": True,
        "stance_digest": "stable-stance",
        "user_skill_snapshot": [{
            "name": "saved-skill", "kind": "skill", "source": "user",
            "description_short": "已冻结的技能目录",
        }],
    }

    initialize_snapshot(
        session,
        system_prompt="system",
        snapshot_context="fixed",
        session_info={"epoch": 1},
        user_tz="Asia/Shanghai",
    )

    assert session.session_context["goal_text"] == "整理这批文件"
    assert session.session_context["goal_status"] == "active"
    assert session.session_context["goal_mode"] is True
    assert session.session_context["stance_digest"] == "stable-stance"
    assert session.session_context["user_skill_snapshot"][0]["name"] == "saved-skill"


def test_history_baseline_never_moves_back_from_session_watermark():
    session = _Session()
    session.baseline_message_id = 20
    session.session_context = {"history_baseline_message_id": 12}

    from agent.context.session_snapshot import history_baseline

    assert history_baseline(session) == 20


def test_prompt_messages_keep_turn_batch_contiguous_before_tool_round():
    messages = assemble(
        fixed_parts=[{"role": "user", "content": "session"}],
        history=[{"role": "user", "content": "history"}],
    )
    turn, _ = assemble_turn(
        current_user={"role": "user", "content": "new"},
        stance="stance",
        extra_reminder="summary",
        now_text="time",
    )
    messages.append_batch(turn)
    messages.append_batch(NewMessageBatch([
        {"role": "assistant", "content": "tool call"},
        {"role": "user", "content": "tool result"},
    ]))

    assert [item["content"] for item in messages][-6:] == [
        "[system-reminder]\nstance\n[/system-reminder]",
        "new",
        "[system-reminder]\nsummary\n[/system-reminder]",
            [{"type": "time-context", "text": "[system-reminder]\n当前时间：time\n[/system-reminder]"}],
        "tool call",
        "tool result",
    ]
    assert messages.newly_appended(2)[-2:][0]["content"] == "tool call"


def test_stance_digest_only_appends_when_stance_changes():
    first, first_digest = assemble_turn(stance="执行", current_user={"role": "user", "content": "一"})
    same, same_digest = assemble_turn(
        stance="执行", previous_stance_digest=first_digest,
        current_user={"role": "user", "content": "二"},
    )
    changed, changed_digest = assemble_turn(
        stance="记录", previous_stance_digest=same_digest,
        current_user={"role": "user", "content": "三"},
    )

    assert first.messages[0]["content"].startswith("[system-reminder]")
    assert [item["content"] for item in same.messages] == ["二"]
    assert changed.messages[0]["content"].startswith("[system-reminder]")
    assert changed_digest != same_digest


def test_old_stance_message_is_never_removed_from_history():
    messages = PromptMessages([{"role": "user", "content": "旧姿态"}])
    messages.append_batch(NewMessageBatch([{"role": "user", "content": "新姿态"}]))
    assert [item["content"] for item in messages] == ["旧姿态", "新姿态"]


def test_prompt_messages_commit_one_new_message_batch_atomically():
    messages = PromptMessages(
        [{"role": "user", "content": "history"}],
    )
    batch = NewMessageBatch([
        {"role": "assistant", "content": "tool call"},
        {"role": "user", "content": "tool result"},
    ])

    messages.append_batch(batch)

    assert [item["content"] for item in messages] == [
        "history",
        "tool call",
        "tool result",
    ]
    assert [item["content"] for item in messages.newly_appended(1)] == [
        "tool call", "tool result",
    ]


def test_snapshot_reminder_is_fixed_before_history_and_runtime_tail():
    snapshot = reminder("memory / projects / calendar / files")
    messages = assemble(
        fixed_parts=[snapshot],
        history=[{"role": "user", "content": "history"}],
    )
    messages.append_batch(assemble_turn(
        current_user={"role": "user", "content": "new"},
        stance="stance",
        message_time=reminder("message-time"),
        now_text="time",
    )[0])

    assert messages[0] == snapshot
    assert [item["content"] for item in messages.conversation] == [
        snapshot["content"], "history",
        "[system-reminder]\nstance\n[/system-reminder]",
            [{"type": "time-context", "text": "[system-reminder]\nmessage-time\n[/system-reminder]"}], "new",
        [{"type": "time-context", "text": "[system-reminder]\n当前时间：time\n[/system-reminder]"}],
    ]


def test_turn_batch_keeps_stance_and_message_time_order_stable():
    batch, _ = assemble_turn(
        stance="stance",
        message_time=reminder("message-time"),
        current_user={"role": "user", "content": "new"},
    )

    assert [item["content"] for item in batch.messages] == [
        "[system-reminder]\nstance\n[/system-reminder]",
        [{"type": "time-context", "text": "[system-reminder]\nmessage-time\n[/system-reminder]"}],
        "new",
    ]


def test_prompt_messages_replace_conversation_preserves_batch_messages():
    messages = PromptMessages([{"role": "user", "content": "old"}])
    messages.append_batch(NewMessageBatch([reminder("time")]))
    messages.replace_conversation([{"role": "user", "content": "compacted"}])
    assert messages.conversation[0]["content"] == "compacted"


def test_history_cache_boundary_uses_batch_messages():
    messages = PromptMessages(
        [{"role": "user", "content": [{"type": "text", "text": "fixed"}]}],
    )
    messages.append_batch(NewMessageBatch([
        {"role": "user", "content": [{"type": "text", "text": "stance"}]},
        {"role": "user", "content": [{"type": "text", "text": "time"}]},
    ]))
    cached = _with_history_cache(messages)
    assert "cache_control" in cached[2]["content"][0]
    assert newly_appended([{"role": "user", "content": "old"}, {"role": "assistant", "content": "new"}], 1)[0]["content"] == "new"


def test_history_cache_keeps_previous_checkpoint_across_round_append():
    messages = PromptMessages(
        [
            {"role": "user", "content": [{"type": "text", "text": "fixed"}]},
            {"role": "user", "content": [{"type": "text", "text": "round one"}]},
        ],
    )

    first = _with_history_cache(messages)
    messages.append({"role": "assistant", "content": [{"type": "text", "text": "tool call"}]})
    messages.append({"role": "user", "content": [{"type": "text", "text": "tool result"}]})
    second = _with_history_cache(messages)

    assert "cache_control" in second[3]["content"][0]
    assert "cache_control" in second[0]["content"][0]
    assert len(second) == 4
    assert "cache_control" in first[-1]["content"][0]


def test_history_cache_keeps_baseline_when_tool_continuation_appends():
    messages = PromptMessages([
        {"role": "user", "content": [{"type": "text", "text": "baseline"}]},
        {"role": "user", "content": [{"type": "text", "text": "本轮请求"}]},
    ])

    _with_history_cache(messages)
    messages.append({"role": "assistant", "content": [{"type": "tool_use", "name": "ask_user"}]})
    messages.append({"role": "user", "content": [{"type": "tool_result", "content": "已选择"}]})
    cached = _with_history_cache(messages)

    assert messages.cache_anchor_indices == [0, 3]
    assert "cache_control" in cached[0]["content"][0]
    assert "cache_control" in cached[3]["content"][0]
    assert "cache_control" not in cached[1]["content"][0]


def test_batch_messages_are_persisted_as_new_history():
    messages = PromptMessages(
        [{"role": "user", "content": "fixed"}, {"role": "user", "content": "round one"}],
    )
    initial_len = len(messages.conversation)
    messages.append_batch(NewMessageBatch([
        {"role": "assistant", "content": "tool call"},
        {"role": "tool", "content": "tool result"},
    ]))

    assert [item["content"] for item in messages.newly_appended(initial_len)] == [
        "tool call", "tool result",
    ]


def test_single_history_cache_keeps_cross_run_baseline_and_latest_anchor():
    messages = PromptMessages(
        [
            {"role": "system", "content": [{
                "type": "text", "text": "固定 system",
                "cache_control": {"type": "ephemeral"},
            }]},
            {"role": "system", "content": [{
                "type": "text", "text": "固定 snapshot",
                "cache_control": {"type": "ephemeral"},
            }]},
            {"role": "user", "content": "旧锚点"},
            {"role": "assistant", "content": "回复"},
            {"role": "user", "content": "最新锚点"},
        ],
    )
    cached = _with_single_history_cache(messages)

    assert cached[0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert cached[1]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert cached[2]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert cached[4]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in cached[-1]["content"]


@pytest.mark.asyncio
async def test_snapshot_trace_events_are_redacted_and_distinguish_hit_rebuild(monkeypatch):
    """snapshot trace 只记录生命周期元数据，不携带 session 正文或观测内容。"""
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = _ScopeRun(
        id="run-snapshot-test", trace_id="trace-snapshot-test",
        session_key="gugu:web:test", external_session_id="test",
        source="web", started_at=_now(),
    )
    token = _scope_run.set(run)
    try:
        calls = 0

        async def load():
            nonlocal calls
            calls += 1
            return {
                "system_prompt": "system",
                "snapshot_context": "项目正文不应进入 snapshot trace",
                "session_info": {"projects": ["项目正文不应进入 snapshot trace"]},
            }

        session = _Session()
        await ensure_snapshot(_Db(), session, load_context=load)
        await ensure_snapshot(_Db(), session, load_context=load)
    finally:
        _scope_run.reset(token)

    assert calls == 1
    assert [span.input["snapshot"]["phase"] for span in run.pending_context_spans] == [
        "rebuild", "hit"
    ]
    event = run.pending_context_spans[0].input["snapshot"]
    assert event["schema_version"] == 1
    assert event["snapshot_hash"] == session.snapshot_hash
    assert event["session_info_hash"] == session.session_info_hash
    assert "项目正文不应进入 snapshot trace" not in json.dumps(event, ensure_ascii=False)
