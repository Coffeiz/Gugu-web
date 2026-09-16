"""@ 补全候选应包含文件夹（搜索路加 folder 类型；空查询的最近对象含文件夹）。"""
from __future__ import annotations

from app.api.v1.mind import ref_suggest
from app.models import Folder


async def test_ref_suggest_recent_includes_folder(db, user_a):
    db.add(Folder(user_id=user_a.id, name="插画参考"))
    await db.flush()

    items = await ref_suggest(q="", limit=6, current_user=user_a, db=db)

    folder_items = [it for it in items if it.type == "folder"]
    assert folder_items, "最近对象候选里应出现文件夹"
    assert any(it.label == "插画参考" for it in folder_items)


async def test_ref_suggest_folder_search_via_global_types(db, user_a):
    db.add(Folder(user_id=user_a.id, name="插画参考"))
    await db.flush()

    items = await ref_suggest(q="插画", limit=6, current_user=user_a, db=db)

    folder_items = [it for it in items if it.type == "folder"]
    assert folder_items, "关键词搜索候选里应出现文件夹"
    assert any(it.label == "插画参考" for it in folder_items)
