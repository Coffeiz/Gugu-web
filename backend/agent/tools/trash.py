"""回收站技能：list_trash / restore_file / permanent_delete。

复用 `app.services.storage.trash` 的 `restore_file_storage`（重建原路径移回）与
`app.services.files.previews` 的 `delete_thumb_cache`。永久删除不可逆，走 confirm.gate 二次确认。
"""
import json

from sqlalchemy import select

from app.models import File
from app.core.ownership import get_owned
from app.services.storage import get_storage
from app.services.storage.file_service import FileService
from app.services.storage.trash import restore_file_storage
from app.services.files.previews import delete_thumb_cache
from agent import confirm
from agent.tools.base import BaseSkill, Tool


async def _list_trash(db, user_id, args: dict):
    limit = args.get("limit", 50)
    rows = (await db.execute(
        select(File).where(File.user_id == user_id, File.deleted_at.isnot(None))
        .order_by(File.deleted_at.desc()).limit(limit)
    )).scalars().all()
    items = [
        {"id": f.id, "name": f"{f.display_name}.{f.ext}", "space": f.space,
         "deleted_at": f.deleted_at.isoformat() if f.deleted_at else None}
        for f in rows
    ]
    # 列满 limit 说明可能还有更多（本工具不翻页）→ 提示用整体操作，别误以为只有这些
    if len(rows) == limit:
        return {"items": items, "note": f"仅列出最近 {limit} 个，可能还有更多；要清空整个回收站用 permanent_delete(all=true) 一次清，别逐个删。"}
    return items


async def _restore_file(db, user_id, args: dict):
    f = await get_owned(db, File, args["file_id"], user_id)
    if not f or f.deleted_at is None:
        return json.dumps({"error": "文件不在回收站"})
    await restore_file_storage(f, get_storage(), db)
    f.deleted_at = None
    await db.commit()
    return {"success": True, "file_id": f.id, "name": f"{f.display_name}.{f.ext}"}


async def _restore_folder(db, user_id, args: dict):
    folder = await FileService(db).restore_folder(user_id, args["folder_id"])
    await db.commit()
    return {"success": True, "folder_id": folder.id, "name": folder.name}


async def _permanent_delete(db, user_id, args: dict):
    storage = get_storage()

    # 清空整个回收站：all=true → 一次永久删除回收站里所有文件（不要逐个删）
    if args.get("all"):
        rows = (await db.execute(
            select(File).where(File.user_id == user_id, File.deleted_at.isnot(None))
        )).scalars().all()
        if not rows:
            return {"success": True, "deleted_count": 0, "note": "回收站本来就是空的"}
        # 不可逆 → 二次确认保底（按数量提示）
        blocked = confirm.needs_confirmation(args, f"将永久删除回收站里全部 {len(rows)} 个文件，删除后无法恢复", user_id)
        if blocked is not None:
            return blocked
        fids = [f.id for f in rows]
        for f in rows:
            try:
                await storage.delete(f.storage_key)
            except Exception:
                pass
            await db.delete(f)
        await db.commit()
        for fid in fids:
            delete_thumb_cache(fid)
        return {"success": True, "deleted_count": len(fids), "note": "回收站已清空"}

    # 单个永久删除
    fid = args.get("file_id")
    if not fid:
        return json.dumps({"error": "需提供 file_id（单个删除）或 all=true（清空全部）"})
    f = await get_owned(db, File, fid, user_id)
    if not f or f.deleted_at is None:
        return json.dumps({"error": "文件不在回收站（只能永久删除回收站里的文件）"})

    # 不可逆 → 二次确认保底
    blocked = confirm.needs_confirmation(args, f"将永久删除「{f.display_name}.{f.ext}」，删除后无法恢复", user_id)
    if blocked is not None:
        return blocked

    try:
        await storage.delete(f.storage_key)
    except Exception:
        pass
    delete_thumb_cache(f.id)
    await db.delete(f)
    await db.commit()
    return {"success": True, "deleted_file_id": fid}


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
            mutates=True,
        ),
        Tool(
            name="restore_folder", label="还原文件夹",
            description="把回收站里的文件夹及其子文件、子文件夹还原回原位置。",
            input_schema={
                "type": "object",
                "properties": {"folder_id": {"type": "integer"}},
                "required": ["folder_id"],
            },
            handler=_restore_folder,
            mutates=True,
        ),
        Tool(
            name="permanent_delete", label="永久删除",
            description="永久删除回收站里的文件（不可恢复）。删单个传 file_id；**要清空整个回收站就传 all=true，一次全清，绝不要逐个 file_id 删**。流程：先不带 confirm 调用 → 返回影响详情（含数量）→ 转达用户征得明确同意 → 带 confirm=true 再调一次执行。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer", "description": "要永久删除的单个文件 id"},
                    "all": {"type": "boolean", "description": "true=清空回收站全部文件（一次清，不用逐个删）"},
                    "confirm": {"type": "boolean", "description": "确认执行；仅在用户明确同意后置 true"},
                    "confirm_token": {"type": "string", "description": "上一步确认请求返回的短时确认凭证"},
                },
                "required": [],
            },
            handler=_permanent_delete,
            mutates=True,
            destructive=True,
        ),
    ]


TrashSkill().register()
