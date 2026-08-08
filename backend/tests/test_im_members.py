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
async def test_resolve_speaker_by_stale_platform_user_id_from_members(db, user_a):
    """①层的契约是"platform_user_id 精确匹配最高优先级"，不应该只查实时表——
    沉默成员的消息已经被保留窗口裁掉，live_ids 里查不到了，但 _merge_members()
    明确保证沉默成员会继续留在 members.json 里、不会被删除。直接传这个人的
    platform_user_id 必须还能命中，否则跟①层"最高优先级"的契约矛盾
    （code review 复审发现：members.json 保留了这个人，但按 id 查却返回
    "没有找到"）。"""
    from agent.tools.group_context import _resolve_speaker

    # 数据库里没有 pid-stale 的任何消息——模拟这个人的历史已经完全被裁出保留窗口。
    await _seed_group_messages(db, user_a, "chat-1", [("pid-active", "在线成员", 0)])
    members = {
        "pid-stale": {"name": "沉默的人", "aliases": [], "nicknames": [],
                      "last_seen_at": 10.0, "message_count": 0},
    }
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "pid-stale", _load_members_stub(members),
    )
    assert result == {"platform_user_id": "pid-stale"}


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
async def test_resolve_speaker_alias_after_name_left_retention_window(db, user_a):
    """③层的存在意义：旧名字对应的消息已经被保留窗口裁掉，②层查不到了，
    但 members.json.aliases 还记着这个曾用名，改名很久之后依然要能查到人
    （code review 发现的真实场景：不补这层，"上线几天后才坏"）。"""
    from agent.tools.group_context import _resolve_speaker

    # 数据库里只剩新名字的消息——模拟旧名字的消息已经被 MESSAGE_RETENTION_LIMIT 裁剪出窗口。
    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "新名字", 0)])
    members = {"pid-1": {"name": "新名字", "aliases": ["旧名字"], "nicknames": [], "last_seen_at": 100.0}}

    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "旧名字", _load_members_stub(members),
    )
    assert result == {"platform_user_id": "pid-1"}


@pytest.mark.asyncio
async def test_resolve_speaker_alias_ambiguous_returns_candidates(db, user_a):
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [
        ("pid-1", "新名字1", 0),
        ("pid-2", "新名字2", 5),
    ])
    members = {
        "pid-1": {"name": "新名字1", "aliases": ["撞车曾用名"], "nicknames": [], "last_seen_at": 100.0},
        "pid-2": {"name": "新名字2", "aliases": ["撞车曾用名"], "nicknames": [], "last_seen_at": 200.0},
    }
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "撞车曾用名", _load_members_stub(members),
    )
    assert result["ambiguous"] is True
    assert [c["platform_user_id"] for c in result["candidates"]] == ["pid-2", "pid-1"]
    assert result["candidates"][0]["matched_by"] == "aliases"


@pytest.mark.asyncio
async def test_resolve_speaker_nickname_unique(db, user_a):
    """④层：①②③都未命中，才读 members.json 的 nicknames。"""
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
async def test_resolve_speaker_does_not_read_members_when_id_hit(db, user_a):
    """①层（speaker 本身就是 platform_user_id）不应该调用 load_members——唯一能跳过
    读 members.json 的情况。②③层（哪怕是精确的实时名字匹配）都必须先加载 members.json
    才能判断是否存在更强的精确 alias/nickname 匹配，见 _resolve_speaker 顶部注释。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "moon_小北", 0)])
    called = False

    async def _load_members():
        nonlocal called
        called = True
        return {}

    result = await _resolve_speaker(db, user_a.id, "qq", "bot-a", "chat-1", "pid-1", _load_members)
    assert result == {"platform_user_id": "pid-1"}
    assert called is False


@pytest.mark.asyncio
async def test_resolve_speaker_reads_members_even_on_exact_live_name_hit(db, user_a):
    """②层即使实时名字精确唯一命中，也必须先加载 members.json——否则无法判断是否存在
    更强的精确 alias/nickname 匹配（这正是 code review 发现的静默查错人漏洞的根因）。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [("pid-1", "moon_小北", 0)])
    called = False

    async def _load_members():
        nonlocal called
        called = True
        return {}

    result = await _resolve_speaker(db, user_a.id, "qq", "bot-a", "chat-1", "moon_小北", _load_members)
    assert result == {"platform_user_id": "pid-1"}
    assert called is True


@pytest.mark.asyncio
async def test_resolve_speaker_exact_alias_beats_fuzzy_live_name(db, user_a):
    """回归 code review 发现的真实漏洞：A 的曾用名精确等于"小北"，B 的当前群昵称是
    "小北哥"（只是模糊包含"小北"）。旧实现只看②层实时名字、唯一命中就直接 return，
    根本不会去看 A 的精确 alias，会把这次查询静默判给 B。修复后必须优先命中 A。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [
        ("pid-a", "Moon", 0),
        ("pid-b", "小北哥", 5),
    ])
    members = {
        "pid-a": {"name": "Moon", "aliases": ["小北"], "nicknames": [], "last_seen_at": 100.0},
        "pid-b": {"name": "小北哥", "aliases": [], "nicknames": [], "last_seen_at": 200.0},
    }
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "小北", _load_members_stub(members),
    )
    assert result == {"platform_user_id": "pid-a"}


@pytest.mark.asyncio
async def test_resolve_speaker_multiple_exact_matches_are_ambiguous_not_silent(db, user_a):
    """两个精确匹配（一个来自实时名字，一个来自另一人的精确 alias）应该走 ambiguous，
    而不是任选其一静默返回——精确匹配内部平级，不分「来源优先级」。"""
    from agent.tools.group_context import _resolve_speaker

    await _seed_group_messages(db, user_a, "chat-1", [
        ("pid-a", "小北", 0),
        ("pid-b", "另一个人", 5),
    ])
    members = {
        "pid-a": {"name": "小北", "aliases": [], "nicknames": [], "last_seen_at": 100.0},
        "pid-b": {"name": "另一个人", "aliases": ["小北"], "nicknames": [], "last_seen_at": 200.0},
    }
    result = await _resolve_speaker(
        db, user_a.id, "qq", "bot-a", "chat-1", "小北", _load_members_stub(members),
    )
    assert result["ambiguous"] is True
    assert {c["platform_user_id"] for c in result["candidates"]} == {"pid-a", "pid-b"}


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


def test_merge_members_appends_intermediate_names_from_multi_rename_batch():
    """同一批反思消息里连续改名两次以上（A→B→C）：中间名字 B 既不等于上一轮
    members.json 记录的 name（A），也不等于这一轮的最终 name（C），单靠
    "上一轮 name vs 这一轮最终 name"的比较会漏记 B——必须靠 _aggregate_members
    的 names_seen 补齐（code review 复审发现的真实场景）。"""
    from agent.memory.im_reflection import _merge_members

    current = {
        "pid-1": {"name": "A", "aliases": [], "nicknames": [], "last_seen_at": 50.0, "message_count": 1},
    }
    aggregated = {
        "pid-1": {"name": "C", "last_seen_at": 100.0, "message_count": 4, "names_seen": ["A", "B", "C"]},
    }
    result = _merge_members(current, aggregated)
    member = result["members"]["pid-1"]
    assert member["name"] == "C"
    assert set(member["aliases"]) == {"A", "B"}


def test_merge_members_names_seen_missing_does_not_break():
    """aggregated 缺少 names_seen 键（比如旧调用点没传）时不应该报错，退化成
    只靠"上一轮 name vs 这一轮最终 name"的原有比较。"""
    from agent.memory.im_reflection import _merge_members

    current = {"pid-1": {"name": "旧", "aliases": [], "nicknames": [], "last_seen_at": 1.0, "message_count": 1}}
    aggregated = {"pid-1": {"name": "新", "last_seen_at": 2.0, "message_count": 2}}
    result = _merge_members(current, aggregated)
    assert result["members"]["pid-1"]["aliases"] == ["旧"]


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


def test_merge_members_keeps_stale_member_out_of_aggregation_window():
    """code review 发现的真实数据生命周期 bug：aggregated 只覆盖 ConversationMessage
    保留窗口（500~600 条）内还能看到的成员，早期实现是 `out = {}` 只填 aggregated 里
    的 pid，等于成员一旦沉默太久、消息被裁出窗口，就连他的 aliases/nicknames 也被
    一起删掉了——这些字段本来就是为了在成员长期不活跃后依然能被找到而设计的，结果
    反而在成员本身被裁出窗口时先丢了。修复后：本轮聚合看不到的旧成员应该原样保留
    name/aliases/nicknames/last_seen_at，只有 message_count 归零（不在窗口内 = 没有
    近期活跃度，但人和曾用名/称呼依然存在）。"""
    from agent.memory.im_reflection import _merge_members

    current = {
        "pid-1": {
            "name": "moon_小北", "aliases": ["旧名字"], "nicknames": ["北神"],
            "last_seen_at": 50.0, "message_count": 20,
        }
    }
    # 本轮聚合看不到 pid-1——群里刷了新一批消息，pid-1 的历史已经被裁出保留窗口。
    aggregated: dict = {}
    result = _merge_members(current, aggregated)
    member = result["members"]["pid-1"]
    assert member["name"] == "moon_小北"
    assert member["aliases"] == ["旧名字"]
    assert member["nicknames"] == ["北神"]
    assert member["last_seen_at"] == 50.0
    assert member["message_count"] == 0


def test_merge_members_stale_member_reappears_next_round_keeps_history():
    """pid-1 沉默一轮后（message_count 归零但字段保留），下一轮重新出现在聚合结果里，
    旧的 aliases/nicknames 依然要能延续下去（不能因为中间空窗一轮就彻底丢失）。"""
    from agent.memory.im_reflection import _merge_members

    stale = _merge_members(
        {"pid-1": {"name": "moon_小北", "aliases": ["旧名字"], "nicknames": ["北神"],
                    "last_seen_at": 50.0, "message_count": 20}},
        {},
    )["members"]
    aggregated = {"pid-1": {"name": "moon_小北", "last_seen_at": 300.0, "message_count": 4}}
    result = _merge_members(stale, aggregated)
    member = result["members"]["pid-1"]
    assert member["aliases"] == ["旧名字"]
    assert member["nicknames"] == ["北神"]
    assert member["message_count"] == 4
    assert member["last_seen_at"] == 300.0


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
async def test_aggregate_members_collects_all_distinct_names_seen(db, user_a):
    """_merge_members 只能拿到"上一轮记录的 name"和"这一轮最终 name"两个点；如果
    同一批消息内部连续改名两次以上（A→B→C），中间名字 B 不会被单纯的名字比较捕获
    到（code review 复审发现）。_aggregate_members 需要顺带记下本批内出现过的全部
    不同名字，交给 _merge_members 决定是否补进 aliases。"""
    from app.models import ConversationMessage, ConversationSession
    from agent.memory.im_reflection import _aggregate_members
    from agent.memory.scopes import MemoryScope

    session = ConversationSession(
        user_id=user_a.id, source="qq", bot_id="bot-a", chat_id="group-1", chat_type="group",
    )
    db.add(session)
    await db.flush()

    base = now_utc()
    names = ["A", "A", "B", "C"]
    for i, name in enumerate(names):
        db.add(ConversationMessage(
            session_id=session.id, role="user", content=f"消息{i}",
            platform_user_id="pid-1", platform_user_name=name,
            created_at=base + timedelta(minutes=i),
        ))
    await db.commit()

    scope = MemoryScope(user_a.id, "qq", "bot-a", "group", "group-1")
    members = await _aggregate_members(db, scope)
    assert members["pid-1"]["name"] == "C"
    # 相邻重复（连续两条都是 "A"）去重，但完整的改名链路 A→B→C 都要记下来。
    assert members["pid-1"]["names_seen"] == ["A", "B", "C"]


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
