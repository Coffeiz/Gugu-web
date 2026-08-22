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
    checkpoint_snapshot,
    initialize_snapshot,
)
from agent.context.message_assembly import PromptMessages, build_messages, reminder, newly_appended
from agent.loop_drivers import _with_history_cache
from agent.runtime.loopscope_trace.state import _ScopeRun, _scope_run, _now
import pytest


def test_session_info_hash_is_stable_for_mapping_order():
    assert session_info_hash({"projects": [1], "memory": {"a": 1}}) == session_info_hash(
        {"memory": {"a": 1}, "projects": [1]}
    )


def test_snapshot_hash_includes_each_prefix_component():
    base = snapshot_hash("system-a", "session-a", "messages-a")
    assert base != snapshot_hash("system-b", "session-a", "messages-a")
    assert base != snapshot_hash("system-a", "session-b", "messages-a")
    assert base != snapshot_hash("system-a", "session-a", "messages-b")


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


def test_checkpoint_hash_chains_new_messages_without_copying_snapshot_text():
    session = _Session()
    initialize_snapshot(session, system_prompt="system", snapshot_context="fixed",
                        session_info={"epoch": 1}, user_tz="Asia/Shanghai")
    first = checkpoint_snapshot(session, [{"role": "user", "content": "第一轮"}])
    second = checkpoint_snapshot(session, [{"role": "user", "content": "第二轮"}])
    assert first != second
    assert session.session_context["snapshot_context"] == "fixed"


def test_prompt_messages_keep_dynamic_tail_at_end_when_round_appends():
    messages = build_messages(
        fixed_parts=[{"role": "user", "content": "session"}],
        history=[{"role": "user", "content": "history"}],
        current_user={"role": "user", "content": "new"},
        dynamic_tail=[reminder("stance"), reminder("summary"), reminder("time")],
    )
    messages.append({"role": "assistant", "content": "tool call"})
    messages.append({"role": "user", "content": "tool result"})

    assert [item["content"] for item in messages.dynamic_tail] == [
        "[system-reminder]\nstance\n[/system-reminder]",
        "[system-reminder]\nsummary\n[/system-reminder]",
        "[system-reminder]\ntime\n[/system-reminder]",
    ]
    assert [item["content"] for item in messages.conversation][-2:] == ["tool call", "tool result"]
    assert messages[-3:] == messages.dynamic_tail
    assert messages.newly_appended(3)[-2:][0]["content"] == "tool call"


def test_snapshot_reminder_is_fixed_before_history_and_runtime_tail():
    snapshot = reminder("memory / projects / calendar / files")
    messages = build_messages(
        fixed_parts=[snapshot],
        history=[{"role": "user", "content": "history"}],
        current_user={"role": "user", "content": "new"},
        dynamic_tail=[reminder("stance"), reminder("time")],
    )

    assert messages[0] == snapshot
    assert [item["content"] for item in messages.conversation] == [
        snapshot["content"], "history", "new",
    ]
    assert [item["content"] for item in messages.dynamic_tail] == [
        "[system-reminder]\nstance\n[/system-reminder]",
        "[system-reminder]\ntime\n[/system-reminder]",
    ]


def test_prompt_messages_replace_conversation_preserves_tail():
    messages = PromptMessages([{"role": "user", "content": "old"}], [reminder("time")])
    messages.replace_conversation([{"role": "user", "content": "compacted"}])
    assert messages.conversation[0]["content"] == "compacted"
    assert messages.dynamic_tail[0]["content"].endswith("time\n[/system-reminder]")


def test_history_cache_boundary_excludes_dynamic_tail():
    messages = PromptMessages(
        [{"role": "user", "content": "fixed"}],
        [reminder("stance"), reminder("time")],
    )
    cached = _with_history_cache(messages)
    assert cached[0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in cached[-1]["content"]
    assert newly_appended([{"role": "user", "content": "old"}, {"role": "assistant", "content": "new"}], 1)[0]["content"] == "new"


def test_history_cache_keeps_previous_checkpoint_across_round_append():
    messages = PromptMessages(
        [{"role": "user", "content": "fixed"}, {"role": "user", "content": "round one"}],
        [reminder("time")],
    )

    first = _with_history_cache(messages)
    messages.append({"role": "assistant", "content": "tool call"})
    messages.append({"role": "user", "content": "tool result"})
    second = _with_history_cache(messages)

    assert second[1]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert second[3]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in second[-1]["content"]
    assert "cache_control" not in first[-1]["content"]


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
