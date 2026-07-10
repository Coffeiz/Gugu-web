"""思维面板 P1：记录时间流 + 便签 CRUD + `[[` 引用补全 + 便签进全局搜索。

对应 docs/product/思维面板/实现方案.md 的 P1 验收项。
路由函数直接调（同 test_global_search.py 的做法），不起 TestClient。
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from app.api.v1.mind import create_note, delete_note, list_notes, ref_suggest, update_note
from app.api.v1.search import run_global_search
from app.core.mind import content_hash, to_plain_text
from app.models import CalendarEvent, Client, File, MindNode, Project
from app.schemas import MindNoteCreate, MindNoteUpdate


async def _new_note(db, user, content="一条想法", **kw):
    return await create_note(MindNoteCreate(content_md=content, **kw), current_user=user, db=db)


async def _row(db, nid) -> MindNode:
    return await db.scalar(select(MindNode).where(MindNode.id == nid))


async def _count_notes(db) -> int:
    return await db.scalar(select(func.count()).select_from(MindNode))


# ── to_plain_text：正文能被搜到的前提 ─────────────────────────────────────────

def test_plain_text_strips_markdown_syntax():
    md = "# 标题\n\n- [ ] 待办一\n- 列表项\n\n**粗体** 和 `代码`\n\n> 引用\n"
    plain = to_plain_text(md)
    for noise in ("#", "- [ ]", "**", "`", ">"):
        assert noise not in plain
    assert "标题" in plain and "待办一" in plain and "粗体" in plain and "引用" in plain


def test_plain_text_keeps_object_reference_label():
    """`[[project:7|某项目]]` 要留下「某项目」，否则按名字搜不到引用了它的便签。"""
    plain = to_plain_text("跟进 [[project:7|某项目]] 的收尾")
    assert plain == "跟进 某项目 的收尾"


def test_plain_text_keeps_link_text_drops_url():
    assert to_plain_text("见 [文档](https://example.com/x)") == "见 文档"


# ── 便签 CRUD ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_note_derives_plain_text_and_marks_pending_index(db, user_a):
    resp = await _new_note(db, user_a, content="# 想法\n\n跟进 [[project:7|某项目]]")
    assert resp.kind == "note"
    assert resp.version == 1

    row = await _row(db, resp.id)
    assert row.content_plain == "想法\n跟进 某项目"      # 服务端推导，不信客户端
    assert row.indexed_hash == content_hash(row.content_plain)
    assert row.indexed_at is None                        # null = 待索引


@pytest.mark.asyncio
async def test_create_note_accepts_backfilled_captured_at(db, user_a):
    past = datetime(2020, 5, 6, 7, 8)
    resp = await _new_note(db, user_a, content="补录昨天的想法", captured_at=past)
    assert resp.captured_at == past
    assert resp.created_at > past                        # created_at 仍是落库时间


@pytest.mark.asyncio
async def test_timeline_orders_by_captured_at_not_created_at(db, user_a):
    """补录的旧想法必须落回它「发生」的那天，不能因为刚写就排最前。"""
    now = datetime.utcnow()
    await _new_note(db, user_a, content="今天写的", captured_at=now)
    await _new_note(db, user_a, content="补录很久以前的", captured_at=now - timedelta(days=30))
    await _new_note(db, user_a, content="补录昨天的", captured_at=now - timedelta(days=1))

    rows = await list_notes(limit=50, offset=0, current_user=user_a, db=db)
    assert [r.content_md for r in rows] == ["今天写的", "补录昨天的", "补录很久以前的"]


@pytest.mark.asyncio
async def test_timeline_hides_soft_deleted_and_other_users_notes(db, user_a, user_b):
    keep = await _new_note(db, user_a, content="我的")
    gone = await _new_note(db, user_a, content="待删")
    await _new_note(db, user_b, content="别人的")
    await delete_note(gone.id, current_user=user_a, db=db)

    rows = await list_notes(limit=50, offset=0, current_user=user_a, db=db)
    assert [r.id for r in rows] == [keep.id]


@pytest.mark.asyncio
async def test_update_note_bumps_version_and_resets_index(db, user_a):
    note = await _new_note(db, user_a, content="原文")
    row = await _row(db, note.id)
    row.indexed_at = datetime.utcnow()                   # 装作已经向量化过
    await db.commit()

    resp = await update_note(note.id, MindNoteUpdate(content_md="改了正文", version=1),
                             current_user=user_a, db=db)
    assert resp.version == 2

    row = await _row(db, note.id)
    assert row.content_plain == "改了正文"
    assert row.indexed_at is None                        # 正文变了 → 必须重新索引
    assert row.indexed_hash == content_hash("改了正文")


@pytest.mark.asyncio
async def test_update_note_with_stale_version_returns_409(db, user_a):
    note = await _new_note(db, user_a, content="原文")
    await update_note(note.id, MindNoteUpdate(title="先到", version=1), current_user=user_a, db=db)

    with pytest.raises(HTTPException) as e:
        await update_note(note.id, MindNoteUpdate(title="后到", version=1), current_user=user_a, db=db)
    assert e.value.status_code == 409

    row = await _row(db, note.id)
    assert row.title == "先到"                           # 后到的没覆盖掉先到的


@pytest.mark.asyncio
async def test_update_note_of_other_user_is_404(db, user_a, user_b):
    note = await _new_note(db, user_b, content="别人的")
    with pytest.raises(HTTPException) as e:
        await update_note(note.id, MindNoteUpdate(title="越权", version=1), current_user=user_a, db=db)
    assert e.value.status_code == 404                    # 不泄露「存在但不是你的」


@pytest.mark.asyncio
async def test_update_soft_deleted_note_is_404(db, user_a):
    note = await _new_note(db, user_a, content="待删")
    await delete_note(note.id, current_user=user_a, db=db)
    with pytest.raises(HTTPException) as e:
        await update_note(note.id, MindNoteUpdate(title="改墓碑", version=1), current_user=user_a, db=db)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_delete_note_is_soft_and_keeps_the_row(db, user_a):
    """删便签只写 deleted_at——节点行留着当墓碑，它参与的关系才不会静默断裂。"""
    note = await _new_note(db, user_a, content="待删")
    await delete_note(note.id, current_user=user_a, db=db)

    assert await _count_notes(db) == 1                   # 行还在
    row = await _row(db, note.id)
    assert row.deleted_at is not None


@pytest.mark.asyncio
async def test_delete_note_of_other_user_is_404(db, user_a, user_b):
    note = await _new_note(db, user_b, content="别人的")
    with pytest.raises(HTTPException) as e:
        await delete_note(note.id, current_user=user_a, db=db)
    assert e.value.status_code == 404
    assert (await _row(db, note.id)).deleted_at is None  # 没被删掉


# ── `[[` 对象引用补全 ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_ref_suggest_returns_stable_type_and_id(db, user_a):
    p = Project(user_id=user_a.id, name="星尘计划")
    db.add(p)
    await db.commit()
    await db.refresh(p)

    items = await ref_suggest(q="星尘", limit=6, current_user=user_a, db=db)
    assert [(i.type, i.id, i.label) for i in items] == [("project", p.id, "星尘计划")]


@pytest.mark.asyncio
async def test_ref_suggest_only_covers_project_file_event(db, user_a):
    """客户/对话不作为便签的引用对象，别混进补全列表。"""
    db.add(Client(user_id=user_a.id, name="星尘客户"))
    db.add(Project(user_id=user_a.id, name="星尘计划"))
    db.add(File(user_id=user_a.id, display_name="星尘", ext="md", storage_key="k", size="1"))
    db.add(CalendarEvent(user_id=user_a.id, title="星尘评审", date="2026-07-10"))
    await db.commit()

    items = await ref_suggest(q="星尘", limit=6, current_user=user_a, db=db)
    assert {i.type for i in items} == {"project", "file", "event"}


@pytest.mark.asyncio
async def test_ref_suggest_empty_query_returns_nothing(db, user_a):
    assert await ref_suggest(q="   ", limit=6, current_user=user_a, db=db) == []


# ── 便签进全局搜索（顶栏下拉 + 咕咕 global_search 共用同一套）─────────────────

@pytest.mark.asyncio
async def test_global_search_finds_note_by_body_text(db, user_a):
    """便签短，正文可以直接搜——不像文件那样只能搜名字。"""
    await _new_note(db, user_a, content="要给猫剪指甲，别忘了买指甲刀")

    result = await run_global_search(db, user_a.id, "指甲刀")
    groups = {g["type"]: g for g in result["groups"]}
    assert "note" in groups
    assert groups["note"]["items"][0]["subtitle"]        # 给了命中片段


@pytest.mark.asyncio
async def test_global_search_finds_note_by_referenced_object_name(db, user_a):
    """正文里写的是 `[[project:7|星尘计划]]`，搜「星尘计划」也该召回这条便签。"""
    await _new_note(db, user_a, content="[[project:7|星尘计划]] 下周启动")

    result = await run_global_search(db, user_a.id, "星尘计划", types=["note"])
    assert result["total"] == 1


@pytest.mark.asyncio
async def test_global_search_skips_deleted_notes_and_ref_nodes(db, user_a):
    """墓碑不该出现在搜索里；ref 节点只是代理，真身已在项目/文件那几组里搜过了。"""
    gone = await _new_note(db, user_a, content="星尘的旧想法")
    await delete_note(gone.id, current_user=user_a, db=db)
    db.add(MindNode(user_id=user_a.id, kind="ref", ref_type="project", ref_id=7, title="星尘计划"))
    await db.commit()

    result = await run_global_search(db, user_a.id, "星尘", types=["note"])
    assert result["total"] == 0


@pytest.mark.asyncio
async def test_global_search_isolates_notes_by_user(db, user_a, user_b):
    await _new_note(db, user_b, content="别人的秘密便签")
    result = await run_global_search(db, user_a.id, "秘密", types=["note"])
    assert result["total"] == 0
