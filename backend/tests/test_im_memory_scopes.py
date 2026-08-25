"""Phase 1：IM 记忆作用域、key 隔离和只读上下文边界。"""
from datetime import timedelta
from types import SimpleNamespace

from sqlalchemy import select
import pytest

from app.core.tz import now_utc


def test_memory_scope_separates_bot_group_and_user():
    from agent.memory.scopes import MemoryScope

    group_a = MemoryScope(7, "qq", "bot-a", "group", "group one")
    group_b = MemoryScope(7, "qq", "bot-b", "group", "group one")
    user = MemoryScope(7, "qq", "bot-a", "platform-user", "user-1")

    assert group_a.prefix != group_b.prefix
    assert group_a.prefix != user.prefix
    assert "%20" in group_a.prefix
    assert group_a.key("summary.json").endswith("/summary.json")


def test_memory_scope_rejects_path_traversal():
    from agent.memory.scopes import MemoryScope

    with pytest.raises(ValueError):
        MemoryScope(7, "qq", "bot", "group", "../other")
    with pytest.raises(ValueError):
        MemoryScope(7, "qq", "bot", "unknown", "x")
    with pytest.raises(ValueError):
        MemoryScope(7, "qq", "bot", "group", "x").key("pattern.json")


def test_platform_user_scope_includes_event_memory_file():
    from agent.memory.scopes import MemoryScope

    scope = MemoryScope("owner", "qq", "bot", "platform-user", "member-1")
    assert scope.files == ("profile.json", "pattern.json", "summary.json", "memory.md")
    assert scope.key("memory.md").endswith("/platform-users/member-1/memory.md")


def test_format_im_memory_keeps_member_scope_separate():
    from agent.im.context_loader import format_im_memory

    data = {
        "group": {"profile": "本群是设计讨论群", "summary": "决定使用冷色方案"},
        "platform_user": {"profile": "成员自述做插画", "pattern": "偏好短回复", "summary": "近期在做角色设计"},
    }
    text = format_im_memory(data, "member")
    assert "本群是设计讨论群" in text
    assert "成员自述做插画" in text
    assert "当前发言人的平台记忆" in text


def test_format_im_memory_does_not_inject_platform_user_for_unknown():
    from agent.im.context_loader import format_im_memory

    text = format_im_memory({"group": {}, "platform_user": {"profile": "不应出现"}}, "unknown")
    assert text == ""


def test_group_and_platform_user_memory_can_be_rendered_independently():
    from agent.im.context_loader import format_group_memory, format_platform_user_memory

    data = {
        "group": {"summary": "群内决定", "profile": "产品讨论群"},
        "platform_user": {"profile": "成员自述做插画"},
    }
    group = format_group_memory(data)
    member = format_platform_user_memory(data)
    assert "群内决定" in group
    assert "成员自述做插画" not in group
    assert "成员自述做插画" in member
    assert "群内决定" not in member


def test_format_im_memory_uses_owner_injection_budget():
    from agent.im.context_loader import format_im_memory
    from agent.memory.store import MEMORY_INJECT_CHARS

    text = format_im_memory({
        "group": {"summary": "群摘要", "profile": "群画像"},
        "platform_user": {
            "summary": "成员摘要",
            "profile": [{"text": "画像一"}],
            "pattern": [{"text": "模式" + "很长" * MEMORY_INJECT_CHARS}],
        },
    }, "member")
    personal = text.split("### 当前发言人的平台记忆", 1)[1]
    assert len(personal) <= MEMORY_INJECT_CHARS + 120
    assert "成员摘要" in personal


def test_im_memory_caps_each_list_source_at_fifty_entries():
    from agent.im.context_loader import format_platform_user_memory

    data = {
        "platform_user": {
            "profile": [{"text": f"画像{i}"} for i in range(60)],
            "pattern": [{"text": f"模式{i}"} for i in range(60)],
        },
    }
    rendered = format_platform_user_memory(data)
    assert "画像0" in rendered and "画像49" in rendered
    assert "画像50" not in rendered
    assert "模式0" in rendered and "模式49" in rendered
    assert "模式50" not in rendered


def test_group_daily_policy_and_markdown_roundtrip():
    from agent.memory.im_reflection import (
        GROUP_DAILY_COMPACT_AT,
        GROUP_DAILY_HARD_CAP,
        GROUP_DAILY_KEEP_RECENT,
        _daily_entries,
        _render_daily,
    )

    text = "## 2026-08-04\n- 新决定\n\n## 2026-08-03\n- 旧记录\n"
    entries = _daily_entries(text)
    assert entries == [("2026-08-04", "新决定"), ("2026-08-03", "旧记录")]
    assert _daily_entries(_render_daily(entries)) == entries
    assert GROUP_DAILY_COMPACT_AT == 500
    assert GROUP_DAILY_KEEP_RECENT == 300
    assert GROUP_DAILY_HARD_CAP == 600
    assert GROUP_DAILY_KEEP_RECENT < GROUP_DAILY_COMPACT_AT < GROUP_DAILY_HARD_CAP


def test_group_memory_compaction_preserves_dates_and_has_large_budget():
    from agent.memory.im_reflection import (
        GROUP_MEMORY_MAX_TOKENS,
        _preserves_group_dates,
    )

    entries = [("2026-08-04", "新决定"), ("2026-07-31", "旧决定")]
    assert GROUP_MEMORY_MAX_TOKENS == 15000
    assert _preserves_group_dates(entries, "## 决定\n- 2026-08-04 新决定\n- 2026-07-31 旧决定")
    assert not _preserves_group_dates(entries, "## 决定\n- 新决定")


def test_group_profile_accepts_public_types_and_rejects_member_identity():
    from agent.memory.im_reflection import _merge_group_profile

    profile = _merge_group_profile(
        [],
        [
            {"type": "nature", "text": "这是产品开发讨论群"},
            {"type": "role", "text": "Coffeiz负责最终确认"},
            {"type": "member", "text": "platform_user_id=secret"},
        ],
        [],
    )
    assert [item["type"] for item in profile] == ["nature", "role"]
    assert all("platform_user_id" not in item["text"] for item in profile)

    updated = _merge_group_profile(
        profile,
        [{"type": "rule", "text": "删除操作需要先确认"}],
        ["这是产品开发讨论群"],
    )
    assert [item["text"] for item in updated] == ["Coffeiz负责最终确认", "删除操作需要先确认"]


@pytest.mark.asyncio
async def test_idle_scope_is_enqueued_once_and_settled(db, user_a, monkeypatch):
    from app.models import MemoryReflectionCursor
    from agent.memory import reflection_jobs
    from agent.memory.scopes import MemoryScope

    now = now_utc()
    cursor = MemoryReflectionCursor(
        owner_user_id=user_a.id,
        platform="qq",
        bot_id="bot-a",
        scope_type="group",
        scope_id="group-1",
        last_message_id=42,
        last_reflected_message_id=40,
        last_message_at=now - timedelta(minutes=16),
        active_started_at=now - timedelta(minutes=20),
        settled_at=None,
        scope_version=3,
        created_at=now,
        updated_at=now,
    )
    db.add(cursor)
    await db.commit()

    calls = []

    async def fake_enqueue(scope, first, last, reason, *, now=None):
        calls.append((scope, first, last, reason))
        return 99

    monkeypatch.setattr(reflection_jobs, "enqueue_scope", fake_enqueue)

    assert await reflection_jobs.settle_idle_scopes(now=now) == 1
    assert len(calls) == 1
    scope, first, last, reason = calls[0]
    assert scope == MemoryScope(user_a.id, "qq", "bot-a", "group", "group-1")
    assert (first, last, reason) == (41, 42, "idle")

    await db.refresh(cursor)
    assert cursor.settled_at is not None


@pytest.mark.asyncio
async def test_settled_scope_reopens_on_next_message(db, user_a, monkeypatch):
    from app.models import MemoryReflectionCursor
    from agent.memory import reflection_jobs
    from agent.memory.scopes import MemoryScope

    now = now_utc()
    cursor = MemoryReflectionCursor(
        owner_user_id=user_a.id,
        platform="qq",
        bot_id="bot-a",
        scope_type="group",
        scope_id="group-1",
        last_message_id=42,
        last_reflected_message_id=42,
        last_message_at=now - timedelta(minutes=20),
        active_started_at=now - timedelta(minutes=30),
        settled_at=now - timedelta(minutes=15),
        scope_version=3,
        created_at=now,
        updated_at=now,
    )
    db.add(cursor)
    await db.commit()

    calls = []

    async def fake_enqueue(scope, first, last, reason, *, now=None):
        calls.append((scope, first, last, reason))
        return 100

    monkeypatch.setattr(reflection_jobs, "enqueue_scope", fake_enqueue)
    scope = MemoryScope(user_a.id, "qq", "bot-a", "group", "group-1")

    assert await reflection_jobs.observe_group_message(scope, 43, now, now=now) is None
    await db.refresh(cursor)
    assert cursor.settled_at is None
    assert cursor.active_started_at == now
    assert cursor.last_message_id == 43
    assert calls == []


@pytest.mark.asyncio
async def test_member_agent_reflection_threshold_is_five(db, user_a, monkeypatch):
    from agent.memory import reflection_jobs
    from agent.memory.scopes import MemoryScope

    now = now_utc()
    calls = []

    async def fake_enqueue(scope, first, last, reason, *, now=None):
        calls.append((scope, first, last, reason))
        return 101

    monkeypatch.setattr(reflection_jobs, "enqueue_scope", fake_enqueue)
    scope = MemoryScope(user_a.id, "qq", "bot-a", "platform-user", "member-1")

    for message_id in range(1, 5):
        assert await reflection_jobs.observe_group_message(
            scope, message_id, now, now=now, trigger_mode="agent", force=False,
        ) is None
    assert calls == []
    assert await reflection_jobs.observe_group_message(
        scope, 5, now, now=now, trigger_mode="agent", force=False,
    ) == 101
    assert calls == [(scope, 1, 5, "active-window")]


@pytest.mark.asyncio
async def test_first_member_tool_message_reflects_immediately(db, user_a, monkeypatch):
    from agent.memory import reflection_jobs
    from agent.memory.scopes import MemoryScope

    now = now_utc()
    calls = []

    async def fake_enqueue(scope, first, last, reason, *, now=None):
        calls.append((scope, first, last, reason))
        return 103

    monkeypatch.setattr(reflection_jobs, "enqueue_scope", fake_enqueue)
    scope = MemoryScope(user_a.id, "qq", "bot-a", "platform-user", "member-tool")

    assert await reflection_jobs.observe_group_message(
        scope, 1, now, now=now, trigger_mode="agent", force=True,
    ) == 103
    assert calls == [(scope, 1, 1, "tool")]


@pytest.mark.asyncio
async def test_member_passive_reflection_threshold_is_thirty(db, user_a, monkeypatch):
    from agent.memory import reflection_jobs
    from agent.memory.scopes import MemoryScope

    now = now_utc()
    calls = []

    async def fake_enqueue(scope, first, last, reason, *, now=None):
        calls.append((scope, first, last, reason))
        return 102

    monkeypatch.setattr(reflection_jobs, "enqueue_scope", fake_enqueue)
    scope = MemoryScope(user_a.id, "qq", "bot-a", "platform-user", "member-2")

    for message_id in range(1, 30):
        assert await reflection_jobs.observe_member_message(scope, message_id, now, now=now) is None
    assert calls == []
    assert await reflection_jobs.observe_member_message(scope, 30, now, now=now) == 102
    assert calls == [(scope, 1, 30, "active-window")]


@pytest.mark.asyncio
async def test_idle_tombstoned_scope_is_not_marked_settled(db, user_a, monkeypatch):
    from app.models import MemoryReflectionCursor
    from agent.memory import reflection_jobs

    now = now_utc()
    cursor = MemoryReflectionCursor(
        owner_user_id=user_a.id,
        platform="qq",
        bot_id="bot-a",
        scope_type="group",
        scope_id="group-deleted",
        last_message_id=42,
        last_reflected_message_id=40,
        last_message_at=now - timedelta(minutes=16),
        active_started_at=now - timedelta(minutes=20),
        settled_at=None,
        scope_version=3,
        created_at=now,
        updated_at=now,
    )
    db.add(cursor)
    await db.commit()

    async def no_job(*_args, **_kwargs):
        return None

    monkeypatch.setattr(reflection_jobs, "enqueue_scope", no_job)
    assert await reflection_jobs.settle_idle_scopes(now=now) == 0
    await db.refresh(cursor)
    assert cursor.settled_at is None


@pytest.mark.asyncio
async def test_reflection_snapshot_excludes_assistant_and_tool_messages(db, user_a):
    from app.models import ConversationMessage, ConversationSession, MemoryReflectionJob
    from agent.memory.im_reflection import _messages_for_job

    session = ConversationSession(
        user_id=user_a.id,
        source="qq",
        bot_id="bot-a",
        chat_id="group-1",
        chat_type="group",
        title="群聊",
    )
    db.add(session)
    await db.flush()
    db.add_all([
        ConversationMessage(
            session_id=session.id,
            role="user",
            content="公开群消息",
            platform_user_id="member-1",
            chat_type="group",
        ),
        ConversationMessage(
            session_id=session.id,
            role="assistant",
            content="包含工具结果的回复",
            chat_type="group",
        ),
        ConversationMessage(
            session_id=session.id,
            role="user",
            content="缺少平台身份，不应进入长期记忆",
            chat_type="group",
        ),
        ConversationMessage(
            session_id=session.id,
            role="tool",
            content="不应进入群记忆",
            chat_type="group",
        ),
    ])
    await db.flush()
    job = MemoryReflectionJob(
        owner_user_id=user_a.id,
        platform="qq",
        bot_id="bot-a",
        scope_type="group",
        scope_id="group-1",
        from_message_id=1,
        to_message_id=999,
        idempotency_key="test-reflection-snapshot",
        extractor_version="im-memory-v1",
    )
    rows = await _messages_for_job(db, job)
    assert [row.content for row in rows] == ["公开群消息"]


def test_member_memory_merge_is_stable_and_deduplicated():
    from agent.memory.im_reflection import _merge_pattern, _merge_profile

    # _merge_profile 复用 store.apply_profile_ops，条目带 ts（owner 路径既有行为）。
    merged = _merge_profile(
        [{"type": "preference", "text": "喜欢画画"}],
        [{"type": "preference", "text": "喜欢画画"}, "常用中文"],
    )
    assert [{"type": m["type"], "text": m["text"]} for m in merged] == [
        {"type": "preference", "text": "喜欢画画"},
        {"type": "note", "text": "常用中文"},
    ]
    assert all("ts" in m for m in merged)
    assert _merge_pattern(
        [{"text": "先确认再执行", "kind": "observed", "importance": 1}],
        [{"text": "先确认再执行", "kind": "inferred", "importance": 2}, {"text": "偏好短回复"}],
    ) == [
        {"text": "先确认再执行", "kind": "observed", "importance": 1},
        {"text": "偏好短回复", "kind": "observed", "importance": 1},
    ]


def test_reflection_prompts_are_separated_by_scope():
    from agent.memory.im_reflection import _scope_prompt
    from agent.memory.scopes import MemoryScope

    group = MemoryScope("owner", "qq", "bot", "group", "group-1")
    member = MemoryScope("owner", "qq", "bot", "platform-user", "member-1")
    assert "群组" in _scope_prompt(group)
    assert "平台用户" in _scope_prompt(member)


@pytest.mark.asyncio
async def test_deleted_scope_is_not_previewed(monkeypatch):
    from agent.memory import scope_lifecycle
    from agent.memory.scopes import MemoryScope

    scope = MemoryScope("owner", "qq", "bot", "group", "group-1")
    monkeypatch.setattr(scope_lifecycle, "is_tombstoned", lambda _scope: _async_true())
    assert await scope_lifecycle.preview_scope(scope) is None


@pytest.mark.asyncio
async def test_scope_deletion_uses_tombstone_and_cleans_storage(db, user_a, monkeypatch):
    from app.models import MemoryScopeTombstone
    from agent.memory import scope_lifecycle
    from agent.memory.scopes import MemoryScope

    class FakeLock:
        async def acquire(self, blocking=False):
            return True

        async def release(self):
            return None

    class FakeRedis:
        def lock(self, _key, **_kwargs):
            return FakeLock()

    class FakeStorage:
        def __init__(self):
            self.deleted = []

        async def delete_prefix(self, prefix):
            self.deleted.append(prefix)
            return 0

    fake_storage = FakeStorage()
    async def _noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(scope_lifecycle.R, "get_redis", lambda: FakeRedis())
    monkeypatch.setattr(scope_lifecycle.R, "ensure_group", _noop)
    monkeypatch.setattr(scope_lifecycle.R, "produce", _noop)
    monkeypatch.setattr("app.services.storage.get_storage", lambda: fake_storage)

    scope = MemoryScope(user_a.id, "qq", "bot-a", "group", "group-1")
    tombstone_id = await scope_lifecycle.request_scope_deletion(scope)
    assert await scope_lifecycle.is_tombstoned(scope)

    assert await scope_lifecycle.execute_scope_deletion(tombstone_id)
    assert fake_storage.deleted == [scope.prefix + "/"]
    assert not await scope_lifecycle.is_tombstoned(scope)
    rows = (await db.execute(select(MemoryScopeTombstone))).scalars().all()
    assert rows == []


async def _async_true():
    return True


def test_owner_group_reflection_excludes_assistant_reply_and_other_members():
    from agent.runner import _reflection_input

    request = SimpleNamespace(chat_id="group-1", message="我喜欢简短一点", source="qq")
    messages = [
        {"role": "assistant", "content": "群友说了不应进入 owner memory"},
        {"role": "tool", "content": "查询到 owner 的项目结果"},
    ]
    user_text, private_text = _reflection_input(request, messages, 0, "整轮群聊回复")
    assert user_text == "我喜欢简短一点"
    assert "查询到 owner 的项目结果" in private_text
    assert "群友说了不应进入 owner memory" not in private_text
