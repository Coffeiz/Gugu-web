"""回收站技能：list_trash / restore_file / permanent_delete。

复用后端 `trash.py` 的 `_restore_file_storage`（重建原路径移回）与 `files.py`
的 `_delete_thumb_cache`。永久删除不可逆，走 confirm.gate 二次确认。
"""
import json

from sqlalchemy import select

from app.models import File
from app.services.storage import get_storage
from app.api.v1.trash import _restore_file_storage
from app.api.v1.files import _delete_thumb_cache
from agent import confirm
from agent.skills.base import BaseSkill, Tool


async def _list_trash(db, user_id, args: dict):
    rows = (await db.execute(
        select(File).where(File.user_id == user_id, File.deleted_at.isnot(None))
        .order_by(File.deleted_at.desc()).limit(args.get("limit", 50))
    )).scalars().all()
    return [
        {"id": f.id, "name": f"{f.display_name}.{f.ext}", "space": f.space,
         "deleted_at": f.deleted_at.isoformat() if f.deleted_at else None}
        for f in rows
    ]


async def _restore_file(db, user_id, args: dict):
    f = await db.get(File, args["file_id"])
    if not f or f.user_id != user_id or f.deleted_at is None:
        return json.dumps({"error": "文件不在回收站"})
    await _restore_file_storage(f, db)
    f.deleted_at = None
    await db.commit()
    return {"success": True, "file_id": f.id, "name": f"{f.display_name}.{f.ext}"}


async def _permanent_delete(db, user_id, args: dict):
    f = await db.get(File, args["file_id"])
    if not f or f.user_id != user_id or f.deleted_at is None:
        return json.dumps({"error": "文件不在回收站（只能永久删除回收站里的文件）"})

    # 不可逆 → 二次确认保底
    summary = f"将永久删除「{f.display_name}.{f.ext}」，删除后无法恢复"
    blocked = confirm.needs_confirmation(args, summary)
    if blocked is not None:
        return blocked

    try:
        await get_storage().delete(f.storage_key)
    except Exception:
        pass
    _delete_thumb_cache(f.id)
    await db.delete(f)
    await db.commit()
    return {"success": True, "deleted_file_id": args["file_id"]}


class TrashSkill(BaseSkill):
    name = "trash"
    tools = [
        Tool(
            name="list_trash", label="查看回收站",
            description="列出回收站里的文件（软删除、30 天内可还原的文件）。",
            input_schema={"type": "object", "properties": {}},
            handler=_list_trash,
        ),
        Tool(
            name="restore_file", label="还原文件",
            description="把回收站里的文件还原回原位置。",
            input_schema={
                "type": "object",
                "properties": {"file_id": {"type": "integer"}},
                "required": ["file_id"],
            },
            handler=_restore_file,
        ),
        Tool(
            name="permanent_delete", label="永久删除",
            description="永久删除回收站里的文件（不可恢复）。流程：先不带 confirm 调用 → 返回影响详情 → 转达用户征得明确同意 → 带 confirm=true 再调一次执行。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "confirm": {"type": "boolean", "description": "确认执行；仅在用户明确同意后置 true"},
                },
                "required": ["file_id"],
            },
            handler=_permanent_delete,
            destructive=True,
        ),
    ]


TrashSkill().register()
