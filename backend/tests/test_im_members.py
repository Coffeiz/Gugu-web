"""PRD-IM-8：members.json 聚合、speaker 解析、IM 记忆相似度合并。"""
from datetime import timedelta

import pytest

from app.core.tz import now_utc


# ── _resolve_speaker：四层匹配优先级 ────────────────────────────────────────


def _members():
    return {
        "pid-1": {
            "name": "moon_小北",
            "aliases": ["小北"],
            "nicknames": ["北神", "队长"],
            "last_seen_at": 100.0,
            "message_count": 42,
        },
        "pid-2": {
            "name": "另一个人",
            "aliases": [],
            "nicknames": ["北神"],
            "last_seen_at": 200.0,
            "message_count": 10,
        },
    }


def test_resolve_speaker_by_platform_user_id():
    from agent.tools.group_context import _resolve_speaker

    assert _resolve_speaker(_members(), "pid-1") == {"platform_user_id": "pid-1"}


def test_resolve_speaker_by_name_unique():
    from agent.tools.group_context import _resolve_speaker

    assert _resolve_speaker(_members(), "moon_小北") == {"platform_user_id": "pid-1"}


def test_resolve_speaker_by_alias_unique():
    from agent.tools.group_context import _resolve_speaker

    assert _resolve_speaker(_members(), "小北") == {"platform_user_id": "pid-1"}


def test_resolve_speaker_nickname_unique():
    from agent.tools.group_context import _resolve_speaker

    # "队长" 只在 pid-1 的 nicknames 里，唯一命中。
    assert _resolve_speaker(_members(), "队长") == {"platform_user_id": "pid-1"}


def test_resolve_speaker_nickname_ambiguous_returns_candidates():
    from agent.tools.group_context import _resolve_speaker

    # "北神" 同时出现在 pid-1 和 pid-2 的 nicknames，触发澄清，按 last_seen_at 倒序。
    result = _resolve_speaker(_members(), "北神")
    assert result["ambiguous"] is True
    assert [c["platform_user_id"] for c in result["candidates"]] == ["pid-2", "pid-1"]
    assert result["candidates"][0]["matched_by"] == "nicknames"
    assert result["candidates"][0]["matched_text"] == "北神"


def test_resolve_speaker_not_found():
    from agent.tools.group_context import _resolve_speaker

    result = _resolve_speaker(_members(), "不存在的人")
    assert result["error"] == "没有找到叫 不存在的人 的群成员"


def test_resolve_speaker_empty():
    from agent.tools.group_context import _resolve_speaker

    assert _resolve_speaker(_members(), "")["error"] == "speaker 不能为空"


# ── _merge_members：DB 聚合 + LLM nicknames 合并 ────────────────────────────


def test_merge_members_first_appearance():
    from agent.memory.im_reflection import _merge_members

    aggregated = {
        "pid-1": {"name": "moon_小北", "last_seen_at": 100.0, "message_count": 3},
    }
    result = _merge_members({}, aggregated, [])
    assert result["members"]["pid-1"]["name"] == "moon_小北"
    assert result["members"]["pid-1"]["aliases"] == []
    assert result["members"]["pid-1"]["nicknames"] == []
    assert result["members"]["pid-1"]["message_count"] == 3


def test_merge_members_rename_appends_alias():
    from agent.memory.im_reflection import _merge_members

    current = {
        "pid-1": {
            "name": "旧名字",
            "aliases": [],
            "nicknames": [],
            "last_seen_at": 50.0,
            "message_count": 1,
        }
    }
    aggregated = {
        "pid-1": {"name": "新名字", "last_seen_at": 100.0, "message_count": 5},
    }
    result = _merge_members(current, aggregated, [])
    member = result["members"]["pid-1"]
    assert member["name"] == "新名字"
    assert member["aliases"] == ["旧名字"]
    assert member["message_count"] == 5


def test_merge_members_merges_llm_nicknames():
    from agent.memory.im_reflection import _merge_members

    aggregated = {
        "pid-1": {"name": "moon_小北", "last_seen_at": 100.0, "message_count": 3},
    }
    result = _merge_members({}, aggregated, [{"platform_user_id": "pid-1", "nickname": "北神"}])
    assert result["members"]["pid-1"]["nicknames"] == ["北神"]


def test_merge_members_ignores_nickname_for_unknown_member():
    from agent.memory.im_reflection import _merge_members

    aggregated = {
        "pid-1": {"name": "moon_小北", "last_seen_at": 100.0, "message_count": 3},
    }
    # pid-999 不在聚合结果里（消息已被裁剪出窗口），称呼被丢弃。
    result = _merge_members({}, aggregated, [{"platform_user_id": "pid-999", "nickname": "幽灵"}])
    assert "pid-999" not in result["members"]


# ── _merge_group_profile / _merge_profile：近义重复合并 ─────────────────────


def test_merge_group_profile_merges_similar_duplicates():
    from agent.memory.im_reflection import _merge_group_profile

    # 子串关系（较短 ≥6 字是较长子串）会被 _pattern_similar 判定为同一条，合并保留更完整措辞。
    profile = _merge_group_profile(
        [],
        [{"type": "nature", "text": "酒店与隔壁餐厅为同一家"}],
        [],
    )
    merged = _merge_group_profile(
        profile,
        [{"type": "nature", "text": "酒店与隔壁餐厅为同一家餐厅"}],
        [],
    )
    assert len(merged) == 1
    assert merged[0]["text"] == "酒店与隔壁餐厅为同一家餐厅"


def test_merge_group_profile_keeps_distinct_items():
    from agent.memory.im_reflection import _merge_group_profile

    profile = _merge_group_profile(
        [],
        [
            {"type": "nature", "text": "这是产品开发讨论群"},
            {"type": "role", "text": "Coffeiz负责最终确认"},
        ],
        [],
    )
    assert len(profile) == 2


def test_merge_group_profile_does_not_merge_low_similarity():
    from agent.memory.im_reflection import _merge_group_profile

    # 文档 4 节提到的真实案例（"酒店与…为同一家" vs "酒店为…"）bigram Jaccard 仅 0.33，
    # 低于 _pattern_similar 的保守阈值 0.7，不会被合并——这是预期行为，不是 bug。
    profile = _merge_group_profile(
        [],
        [{"type": "nature", "text": "酒店与隔壁餐厅为同一家"}],
        [],
    )
    merged = _merge_group_profile(
        profile,
        [{"type": "nature", "text": "酒店为隔壁餐厅"}],
        [],
    )
    assert len(merged) == 2


def test_merge_profile_merges_similar_duplicates():
    from agent.memory.im_reflection import _merge_profile

    # 子串关系会被 _pattern_similar 判定为同一条，合并保留更完整措辞。
    profile = _merge_profile([], [{"type": "note", "text": "酒店与隔壁餐厅为同一家"}])
    merged = _merge_profile(profile, [{"type": "note", "text": "酒店与隔壁餐厅为同一家餐厅"}])
    assert len(merged) == 1
    assert merged[0]["text"] == "酒店与隔壁餐厅为同一家餐厅"


# ── _aggregate_members：DB 聚合 ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_aggregate_members_counts_and_last_seen(db, user_a):
    from app.models import ConversationMessage, ConversationSession
    from agent.memory.im_reflection import _aggregate_members
    from agent.memory.scopes import MemoryScope

    session = ConversationSession(
        user_id=user_a.id,
        source="qq",
        bot_id="bot-a",
        chat_id="group-1",
        chat_type="group",
    )
    db.add(session)
    await db.flush()

    base = now_utc()
    for i, (pid, name) in enumerate([("pid-1", "小北"), ("pid-1", "小北"), ("pid-2", "另一个人")]):
        db.add(ConversationMessage(
            session_id=session.id,
            role="user",
            content=f"消息{i}",
            platform_user_id=pid,
            platform_user_name=name,
            created_at=base + timedelta(minutes=i),
        ))
    await db.commit()

    scope = MemoryScope(user_a.id, "qq", "bot-a", "group", "group-1")
    members = await _aggregate_members(db, scope)
    assert members["pid-1"]["message_count"] == 2
    assert members["pid-1"]["name"] == "小北"
    assert members["pid-2"]["message_count"] == 1
    assert members["pid-2"]["name"] == "另一个人"
    # last_seen_at 取该成员最新一条消息的时间。
    assert members["pid-1"]["last_seen_at"] == pytest.approx((base + timedelta(minutes=1)).timestamp())


@pytest.mark.asyncio
async def test_aggregate_members_ignores_bot_messages(db, user_a):
    from app.models import ConversationMessage, ConversationSession
    from agent.memory.im_reflection import _aggregate_members
    from agent.memory.scopes import MemoryScope

    session = ConversationSession(
        user_id=user_a.id,
        source="qq",
        bot_id="bot-a",
        chat_id="group-1",
        chat_type="group",
    )
    db.add(session)
    await db.flush()

    db.add(ConversationMessage(
        session_id=session.id,
        role="user",
        content="用户消息",
        platform_user_id="pid-1",
        platform_user_name="小北",
    ))
    db.add(ConversationMessage(
        session_id=session.id,
        role="assistant",
        content="咕咕回复",
        platform_user_id=None,
        platform_user_name=None,
    ))
    await db.commit()

    scope = MemoryScope(user_a.id, "qq", "bot-a", "group", "group-1")
    members = await _aggregate_members(db, scope)
    assert "pid-1" in members
    assert len(members) == 1
