"""思维面板 P0 地基：三表约束 + 原子乐观锁 + related 归一幂等 + 跨用户隔离。

对应 docs/product/思维面板/实现方案.md 的 P0 验收项。这一层不碰 API/UI，
只保证「节点全局、画布只是视图、关系挂在节点之间」这套结构和它的底线约束真的成立。
"""
from __future__ import annotations
from app.core.tz import now_utc

from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.core.mind import content_hash, to_plain_text, update_node_atomic, upsert_relation
from app.core.ownership import get_owned
from app.models import MindNode, MindRelation


async def _mk_note(db, user, text="一条想法") -> MindNode:
    n = MindNode(user_id=user.id, kind="note", content_md=text, content_plain=text)
    db.add(n)
    await db.commit()
    await db.refresh(n)
    return n


async def _count(db, model) -> int:
    return await db.scalar(select(func.count()).select_from(model))


# ── 节点：默认值与两种 kind ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_note_node_defaults(db, user_a):
    n = await _mk_note(db, user_a)
    assert n.kind == "note"
    assert n.version == 1
    assert n.origin == "user"
    assert n.deleted_at is None
    assert n.indexed_at is None          # null = 待索引
    assert isinstance(n.captured_at, datetime)   # 面向用户的时间流锚点，默认取当前


@pytest.mark.asyncio
async def test_ref_node_points_at_business_object(db, user_a):
    ref = MindNode(user_id=user_a.id, kind="ref", ref_type="project", ref_id=7, title="某项目")
    db.add(ref)
    await db.commit()
    await db.refresh(ref)
    assert (ref.ref_type, ref.ref_id) == ("project", 7)


@pytest.mark.asyncio
async def test_captured_at_can_be_backfilled_into_the_past(db, user_a):
    """补录昨天的想法：captured_at 可写成过去，created_at 仍是落库时间。"""
    past = datetime(2020, 1, 2, 3, 4, 5, tzinfo=timezone.utc)   # UtcDateTime 读回 aware UTC
    n = MindNode(user_id=user_a.id, content_md="补录", content_plain="补录", captured_at=past)
    db.add(n)
    await db.commit()
    await db.refresh(n)
    assert n.captured_at == past
    assert n.created_at > past


# ── 底线约束（DB 层，不只靠 API 校验）──────────────────────────────────────────

@pytest.mark.asyncio
async def test_ref_kind_requires_both_ref_columns(db, user_a):
    db.add(MindNode(user_id=user_a.id, kind="ref", ref_type="project"))   # 缺 ref_id
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


@pytest.mark.asyncio
async def test_non_ref_kind_must_leave_ref_columns_empty(db, user_a):
    db.add(MindNode(user_id=user_a.id, kind="note", ref_type="project", ref_id=1))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


@pytest.mark.asyncio
async def test_ref_node_is_deduped_per_business_object(db, user_a):
    """同一用户对同一业务对象只保留一个引用代理，关系才不会散在多个 ref 上。"""
    db.add(MindNode(user_id=user_a.id, kind="ref", ref_type="project", ref_id=7))
    await db.commit()
    db.add(MindNode(user_id=user_a.id, kind="ref", ref_type="project", ref_id=7))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


@pytest.mark.asyncio
async def test_many_notes_coexist_despite_null_ref_columns(db, user_a):
    """note 的 ref_type/ref_id 都是 NULL，SQL 里 NULL 互不相等 → 唯一约束不会误伤。"""
    await _mk_note(db, user_a, "想法一")
    await _mk_note(db, user_a, "想法二")
    assert await _count(db, MindNode) == 2


@pytest.mark.asyncio
async def test_relation_self_loop_blocked_at_db_level(db, user_a):
    n = await _mk_note(db, user_a)
    db.add(MindRelation(user_id=user_a.id, src_node_id=n.id, dst_node_id=n.id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


# ── 乐观锁：原子 UPDATE，不是先读再比 ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_update_node_atomic_succeeds_and_bumps_version(db, user_a):
    n = await _mk_note(db, user_a)
    ok = await update_node_atomic(db, n.id, user_a.id, client_version=1, fields={"title": "新标题"})
    assert ok is True
    await db.refresh(n)
    assert n.title == "新标题"
    assert n.version == 2


@pytest.mark.asyncio
async def test_update_node_atomic_rejects_stale_version(db, user_a):
    """并发第二个请求拿着旧 version 过来 → rowcount=0 → False（路由据此抛 409）。"""
    n = await _mk_note(db, user_a)
    assert await update_node_atomic(db, n.id, user_a.id, 1, {"title": "先到"}) is True
    assert await update_node_atomic(db, n.id, user_a.id, 1, {"title": "后到"}) is False
    await db.refresh(n)
    assert n.title == "先到"          # 后到的没覆盖掉先到的
    assert n.version == 2


@pytest.mark.asyncio
async def test_update_node_atomic_cannot_touch_other_users_node(db, user_a, user_b):
    n = await _mk_note(db, user_a)
    assert await update_node_atomic(db, n.id, user_b.id, 1, {"title": "越权"}) is False
    await db.refresh(n)
    assert n.title is None


@pytest.mark.asyncio
async def test_content_change_resets_index_watermark(db, user_a):
    """首次向量化后改正文，必须被重新索引——indexed_at 清回 null、哈希跟着新正文走。"""
    n = await _mk_note(db, user_a, "原文")
    n.indexed_at = now_utc()
    n.indexed_hash = content_hash("原文")
    await db.commit()

    ok = await update_node_atomic(db, n.id, user_a.id, 1, {"content_md": "改了", "content_plain": "改了"})
    assert ok is True
    await db.refresh(n)
    assert n.indexed_at is None
    assert n.indexed_hash == content_hash("改了")


@pytest.mark.asyncio
async def test_non_content_change_keeps_index_watermark(db, user_a):
    """只改标题/颜色（或将来只挪画布位置）不该触发重索引。"""
    n = await _mk_note(db, user_a, "原文")
    stamp = datetime(2026, 1, 1, tzinfo=timezone.utc)   # UtcDateTime 读回 aware UTC
    n.indexed_at = stamp
    n.indexed_hash = content_hash("原文")
    await db.commit()

    assert await update_node_atomic(db, n.id, user_a.id, 1, {"title": "只改标题"}) is True
    await db.refresh(n)
    assert n.indexed_at == stamp
    assert n.indexed_hash == content_hash("原文")


@pytest.mark.asyncio
async def test_content_md_only_update_keeps_hash_paired(db, user_a):
    """只传 content_md（不带 content_plain）：兜底推导纯文本，indexed_hash 跟着新正文走，
    不会停在旧值——否则 P3 索引管线会误判「内容没变」漏掉重索引。"""
    n = await _mk_note(db, user_a, "原文")
    n.indexed_at = now_utc()
    n.indexed_hash = content_hash("原文")
    await db.commit()

    ok = await update_node_atomic(db, n.id, user_a.id, 1, {"content_md": "# 新标题\n\n新正文"})
    assert ok is True
    await db.refresh(n)
    plain = to_plain_text("# 新标题\n\n新正文")
    assert n.content_plain == plain          # 服务端推导，不留旧正文
    assert n.indexed_at is None
    assert n.indexed_hash == content_hash(plain)   # 与新正文成对，不脱钩


@pytest.mark.asyncio
async def test_update_node_atomic_refuses_soft_deleted_node(db, user_a):
    """墓碑不可再改：软删后即便版本、归属都对，原子 UPDATE 也写不进（TOCTOU 兜底）。"""
    n = await _mk_note(db, user_a, "原文")
    n.deleted_at = now_utc()
    await db.commit()

    ok = await update_node_atomic(db, n.id, user_a.id, 1, {"title": "改墓碑"})
    assert ok is False
    await db.refresh(n)
    assert n.title != "改墓碑"
    assert n.version == 1                     # 版本没被 bump


# ── 关系：related 归一 + 幂等 ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_related_is_normalized_so_both_directions_are_one_edge(db, user_a):
    a = await _mk_note(db, user_a, "A")
    b = await _mk_note(db, user_a, "B")

    r1 = await upsert_relation(db, user_a.id, a.id, b.id)
    r2 = await upsert_relation(db, user_a.id, b.id, a.id)   # 反向再连一次

    assert r1.id == r2.id
    assert await _count(db, MindRelation) == 1
    assert (r1.src_node_id, r1.dst_node_id) == (min(a.id, b.id), max(a.id, b.id))


@pytest.mark.asyncio
async def test_upsert_relation_is_idempotent(db, user_a):
    """用户重复点连线、咕咕重复建议，都命中已有那条，不堆重复边。"""
    a = await _mk_note(db, user_a, "A")
    b = await _mk_note(db, user_a, "B")
    first = await upsert_relation(db, user_a.id, a.id, b.id)
    again = await upsert_relation(db, user_a.id, a.id, b.id)
    assert first.id == again.id
    assert await _count(db, MindRelation) == 1


@pytest.mark.asyncio
async def test_upsert_relation_survives_concurrent_insert_race(db, user_a, monkeypatch):
    """并发下的真正保护：预检查时对方还没提交（查不到），插入时唯一约束已经撞上。

    SAVEPOINT 让这次冲突只回滚插入那一小段、不带崩外层事务；捕获后回查返回已有边。
    这条分支平时走不到（预检查就短路了），只能这样逼出来。
    """
    from app.core import mind as mind_core

    a = await _mk_note(db, user_a, "A")
    b = await _mk_note(db, user_a, "B")
    existing = await upsert_relation(db, user_a.id, a.id, b.id)

    real_find = mind_core._find_relation
    calls = {"n": 0}

    async def flaky_find(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return None                      # 预检查：装作还查不到
        return await real_find(*args, **kwargs)

    monkeypatch.setattr(mind_core, "_find_relation", flaky_find)

    got = await upsert_relation(db, user_a.id, a.id, b.id)
    assert got.id == existing.id             # 撞车后回查拿到了已有那条
    assert await _count(db, MindRelation) == 1
    assert calls["n"] == 2                   # 确实走了「预检查 miss → 插入撞车 → 回查」


@pytest.mark.asyncio
async def test_directed_relation_keeps_its_direction(db, user_a):
    """有向类型（P4 才开放）方向有意义，不归一：两个方向是两条边。"""
    a = await _mk_note(db, user_a, "A")
    b = await _mk_note(db, user_a, "B")
    await upsert_relation(db, user_a.id, a.id, b.id, rel_type="supports")
    await upsert_relation(db, user_a.id, b.id, a.id, rel_type="supports")
    assert await _count(db, MindRelation) == 2


@pytest.mark.asyncio
async def test_upsert_relation_refuses_self_loop(db, user_a):
    n = await _mk_note(db, user_a)
    with pytest.raises(ValueError):
        await upsert_relation(db, user_a.id, n.id, n.id)


@pytest.mark.asyncio
async def test_gugu_suggested_relation_is_distinguishable(db, user_a):
    a = await _mk_note(db, user_a, "A")
    b = await _mk_note(db, user_a, "B")
    rel = await upsert_relation(db, user_a.id, a.id, b.id, origin="gugu", status="suggested")
    assert (rel.origin, rel.status) == ("gugu", "suggested")


# ── 跨用户隔离 ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_owned_hides_other_users_node(db, user_a, user_b):
    """B 拥有节点，A 拿着 B 的 id 来取 → 一律「不存在」。"""
    n = await _mk_note(db, user_b)
    assert await get_owned(db, MindNode, n.id, user_b.id) is not None
    assert await get_owned(db, MindNode, n.id, user_a.id) is None


# ── 软删=墓碑：关系不断 ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_soft_deleted_node_keeps_its_relations(db, user_a):
    """删便签只写 deleted_at，节点行和它的关系全留着 → 画布上渲染成墓碑，图谱不静默断裂。"""
    a = await _mk_note(db, user_a, "A")
    b = await _mk_note(db, user_a, "B")
    await upsert_relation(db, user_a.id, a.id, b.id)

    a.deleted_at = now_utc()
    await db.commit()

    assert await _count(db, MindRelation) == 1
    assert await db.get(MindNode, a.id) is not None   # ownership-exempt: 测试内直接取行核对墓碑仍在
