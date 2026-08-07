"""PRD-IM-8：members.json 聚合、speaker 解析、IM 记忆相似度合并。"""
from datetime import timedelta

import pytest

from app.core.tz import now_utc


# ── _resolve_speaker：三层匹配优先级（Phase 2.5 修订：①②实时查表，③才读 members.json）──


def _members_nicknames_only():
    """只保留 nicknames——name/aliases 已经改成实时查 ConversationMessage，不再从这里读。"""
    return {
        "pid-1": {"name": "moon_小北", "nicknames": ["北神", "队长"], "last_seen_at": 100.0},
        "pid-2": {"name": "另一个人", "nicknames": ["北神"], "last_seen_at": 200.0},
    }


def _load_members_stub(members: dict):
    async def _load():
        return members
    return _load


async def _seed_group_messages(db, user, chat_id, entries):
    """entries: [(pid, name, minutes_offset), ...]，按 offset 生成递增 created_at。"""
    from app.models import ConversationMessage, ConversationSession

    session = ConversationSession(
        user_id=user.id, source="qq", bot_id="bot-a", chat_id=chat_id, chat_type="group",
    )
    db.add(session)
    await db.flush()
    base = now_utc()
    for i, (pid, name, offset) in enumerate(entries):
        db.add(ConversationMessage(
            session_id=session.id, role="user", content=f"消息{i}",
            platform_user_id=pid, platform_user_name=name,
            created_at=base + timedelta(minutes=offset),
        ))
    await db.commit()


@pytest.mark.asyncio
async def test_resolve_speaker_by_platform_user_id(db, user_a):
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "moon_小北", 0)])
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "pid-1", _load_members_stub({}),
    )
    assert result == {"platform_user_id": "pid-1"}


@pytest.mark.asyncio
async def test_resolve_speaker_by_name_live_unique(db, user_a):
    """②层：直接查 ConversationMessage 里实时的 platform_user_name，不依赖 members.json。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "moon_小北", 0)])
    # members.json 传空字典（模拟反思任务还没跑过），②层照样能命中。
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "moon_小北", _load_members_stub({}),
    )
    assert result == {"platform_user_id": "pid-1"}


@pytest.mark.asyncio
async def test_resolve_speaker_by_former_name_live(db, user_a):
    """②层覆盖曾用名：改名后旧名字依然能查到人，不需要等 members.json 的 aliases 更新。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [
        ("pid-1", "旧名字", 0),
        ("pid-1", "新名字", 1),
    ])
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "旧名字", _load_members_stub({}),
    )
    assert result == {"platform_user_id": "pid-1"}


@pytest.mark.asyncio
async def test_resolve_speaker_by_name_live_ambiguous(db, user_a):
    """②层多候选：两个人历史上用过同一个名字，按 last_seen_at 倒序返回候选。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [
        ("pid-1", "重名", 0),
        ("pid-2", "重名", 5),
    ])
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "重名", _load_members_stub({}),
    )
    assert result["ambiguous"] is True
    assert [c["platform_user_id"] for c in result["candidates"]] == ["pid-2", "pid-1"]
    assert result["candidates"][0]["matched_by"] == "name"


@pytest.mark.asyncio
async def test_resolve_speaker_by_name_substring(db, user_a):
    """②层需要支持包含匹配，不能只做精确相等——这是本次故障的真实复现场景：
    群友喊"小北"，本人平台显示名是"moon_小北"，精确匹配会漏掉这种最常见的称呼方式。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "moon_小北", 0)])
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "小北", _load_members_stub({}),
    )
    assert result == {"platform_user_id": "pid-1"}


@pytest.mark.asyncio
async def test_resolve_speaker_by_name_substring_reverse_direction(db, user_a):
    """反方向包含也要覆盖：speaker 比实际名字更长（比如带了称呼后缀）。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "小北", 0)])
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "小北哥", _load_members_stub({}),
    )
    assert result == {"platform_user_id": "pid-1"}


@pytest.mark.asyncio
async def test_resolve_speaker_nickname_unique(db, user_a):
    """③层：①②都未命中，才读 members.json 的 nicknames。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "moon_小北", 0)])
    # "队长" 只在 pid-1 的 nicknames 里，唯一命中。
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "队长", _load_members_stub(_members_nicknames_only()),
    )
    assert result == {"platform_user_id": "pid-1"}


@pytest.mark.asyncio
async def test_resolve_speaker_nickname_ambiguous_returns_candidates(db, user_a):
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [
        ("pid-1", "moon_小北", 0),
        ("pid-2", "另一个人", 0),
    ])
    # "北神" 同时出现在 pid-1 和 pid-2 的 nicknames，触发澄清，按 last_seen_at 倒序（来自 members.json）。
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "北神", _load_members_stub(_members_nicknames_only()),
    )
    assert result["ambiguous"] is True
    assert [c["platform_user_id"] for c in result["candidates"]] == ["pid-2", "pid-1"]
    assert result["candidates"][0]["matched_by"] == "nicknames"
    assert result["candidates"][0]["matched_text"] == "北神"


@pytest.mark.asyncio
async def test_resolve_speaker_not_found(db, user_a):
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "moon_小北", 0)])
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "不存在的人", _load_members_stub({}),
    )
    assert result["error"] == "没有找到叫 不存在的人 的群成员"


@pytest.mark.asyncio
async def test_resolve_speaker_empty(db, user_a):
    from agent.tools.group_context import _resolve_speaker

    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "", _load_members_stub({}),
    )
    assert result["error"] == "speaker 不能为空"


@pytest.mark.asyncio
async def test_resolve_speaker_does_not_read_members_when_live_hit(db, user_a):
    """①②命中时不应该调用 load_members——避免大多数情况下白读一次 members.json。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "moon_小北", 0)])
    called = False

    async def _load_members():
        nonlocal called
        called = True
        return {}

    result = await _resolve_speaker(db, user_a.id, "qq", "bot-a", "chat-1", "moon_小北", _load_members)
    assert result == {"platform_user_id": "pid-1"}
    assert called is False


# ── _merge_members：纯 DB 字段合并，不碰 LLM 结果 ───────────────────────────
# Phase 4 修订：_merge_members 只处理 name/aliases/last_seen_at/message_count，
# 独立于 LLM 反思调用是否成功；nicknames 合并拆到单独的 _apply_nicknames，
# 只在反思真的成功、拿到 nicknames_add 时才调用。分开测试。


def test_merge_members_first_appearance():
    from agent.memory.im_reflection import _merge_members

    aggregated = {
        "pid-1": {"name": "moon_小北", "last_seen_at": 100.0, "message_count": 3},
    }
    result = _merge_members({}, aggregated)
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
    result = _merge_members(current, aggregated)
    member = result["members"]["pid-1"]
    assert member["name"] == "新名字"
    assert member["aliases"] == ["旧名字"]
    assert member["message_count"] == 5


def test_merge_members_preserves_existing_nicknames():
    """_merge_members 不碰 nicknames，只原样保留已有值——不因为 DB 字段刷新就丢掉。"""
    from agent.memory.im_reflection import _merge_members

    current = {
        "pid-1": {
            "name": "moon_小北", "aliases": [], "nicknames": ["北神"],
            "last_seen_at": 50.0, "message_count": 1,
        }
    }
    aggregated = {
        "pid-1": {"name": "moon_小北", "last_seen_at": 100.0, "message_count": 5},
    }
    result = _merge_members(current, aggregated)
    assert result["members"]["pid-1"]["nicknames"] == ["北神"]


# ── _apply_nicknames：LLM 提炼的群友称呼合并，只在反思成功时才调用 ──────────


def test_apply_nicknames_appends_for_known_member():
    from agent.memory.im_reflection import _apply_nicknames

    members = {"pid-1": {"name": "moon_小北", "aliases": [], "nicknames": [], "last_seen_at": 100.0, "message_count": 3}}
    result = _apply_nicknames(members, [{"platform_user_id": "pid-1", "nickname": "北神"}])
    assert result["pid-1"]["nicknames"] == ["北神"]


def test_apply_nicknames_ignores_unknown_member():
    from agent.memory.im_reflection import _apply_nicknames

    members = {"pid-1": {"name": "moon_小北", "aliases": [], "nicknames": [], "last_seen_at": 100.0, "message_count": 3}}
    # pid-999 不在 members 里（消息已被裁剪出窗口，DB 聚合阶段就没有这个人），称呼被丢弃。
    result = _apply_nicknames(members, [{"platform_user_id": "pid-999", "nickname": "幽灵"}])
    assert "pid-999" not in result


def test_apply_nicknames_dedup():
    from agent.memory.im_reflection import _apply_nicknames

    members = {"pid-1": {"name": "moon_小北", "aliases": [], "nicknames": ["北神"], "last_seen_at": 100.0, "message_count": 3}}
    result = _apply_nicknames(members, [{"platform_user_id": "pid-1", "nickname": "北神"}])
    assert result["pid-1"]["nicknames"] == ["北神"]


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

    # 用简化占位句子验证"低相似度不合并"：这两句 bigram Jaccard 仅 0.33，低于
    # _pattern_similar 的保守阈值 0.7，不会被合并——这是预期行为，不是 bug。
    # （注：文档 4 节提到的真实案例文本本身 Jaccard 约 0.667，同样 <0.7 不合并，
    # 但数值比这条占位句子高得多，不要拿 0.33 当真实案例的相似度参考。）
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
async def test_aggregate_members_rename_within_window_does_not_split_count(db, user_a):
    """同一 platform_user_id 在保留窗口内改过昵称，count/name 不能被拆成两份。

    回归用例：曾经按 (platform_user_id, platform_user_name) 联合 GROUP BY，改名后
    同一个人的消息被拆成两行，逐行覆盖写只留下其中一行，message_count 被腰斩、
    name 也可能停留在旧昵称上。
    """
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
    names = ["旧名字"] * 3 + ["新名字"] * 2
    for i, name in enumerate(names):
        db.add(ConversationMessage(
            session_id=session.id,
            role="user",
            content=f"消息{i}",
            platform_user_id="pid-1",
            platform_user_name=name,
            created_at=base + timedelta(minutes=i),
        ))
    await db.commit()

    scope = MemoryScope(user_a.id, "qq", "bot-a", "group", "group-1")
    members = await _aggregate_members(db, scope)
    assert members["pid-1"]["message_count"] == len(names)
    assert members["pid-1"]["name"] == "新名字"
    assert members["pid-1"]["last_seen_at"] == pytest.approx((base + timedelta(minutes=len(names) - 1)).timestamp())


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
