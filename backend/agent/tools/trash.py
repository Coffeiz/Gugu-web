"""回收站技能：list_trash / restore_file / permanent_delete。

复用 `app.services.storage.trash` 的 `restore_file_storage`（重建原路径移回）与
`app.services.files.previews` 的 `delete_thumb_cache`。永久删除不可逆，走 confirm.gate 二次确认。
"""
import json

from app.services.storage import get_storage
from app.services.storage.file_service import FileService
from app.services.files.trash import (
    RestoreParentTrashError,
    count_deleted_files,
    get_deleted_file,
    get_top_level_deleted_folder,
    list_deleted_files,
    list_deleted_folders,
    list_top_level_deleted_folders,
    permanently_delete_all_files,
    permanently_delete_folder,
    permanently_delete_file,
    restore_file_by_id,
)
from app.services.files.previews import delete_thumb_cache
from agent.security import confirm
from agent.tools.base import BaseSkill, Tool


async def _list_trash(db, user_id, args: dict):
    limit = max(1, min(int(args.get("limit", 50)), 100))

    # 文件夹是整体恢复单元：文件夹内的文件不再重复列出，只列独立删除的文件。
    file_rows = await list_deleted_files(db, user_id, limit)
    folder_rows = await list_deleted_folders(db, user_id, limit)

    items = [
        {"id": f.id, "file_id": f.id, "kind": "file", "name": f"{f.display_name}.{f.ext}",
         "space": f.space, "deleted_at": f.deleted_at.isoformat() if f.deleted_at else None}
        for f in file_rows
    ] + [
        {"id": folder.id, "folder_id": folder.id, "kind": "folder", "name": folder.name,
         "space": "project" if folder.project_id is not None else "personal",
         "deleted_at": folder.deleted_at.isoformat() if folder.deleted_at else None}
        for folder in folder_rows
    ]
    items.sort(key=lambda item: item["deleted_at"] or "", reverse=True)
    has_more = len(items) > limit or len(file_rows) == limit or len(folder_rows) == limit
    items = items[:limit]
    # 列满 limit 说明可能还有更多（本工具不翻页）→ 提示用整体操作，别误以为只有这些
    if has_more:
        return {"items": items, "note": f"仅列出最近 {limit} 个，可能还有更多；要清空整个回收站用 permanent_delete(all=true) 一次清，别逐个删。"}
    return items


async def _restore_file(db, user_id, args: dict):
    try:
        restored = await restore_file_by_id(
            db, get_storage(), user_id, args["file_id"])
    except RestoreParentTrashError:
        return json.dumps({"error": "所属文件夹仍在回收站，请先恢复文件夹"})
    if not restored:
        return json.dumps({"error": "文件不在回收站"})
    await db.commit()
    return {"success": True, "file_id": args["file_id"]}


async def _restore_folder(db, user_id, args: dict):
    folder = await FileService(db).restore_folder(user_id, args["folder_id"])
    await db.commit()
    return {"success": True, "folder_id": folder.id, "name": folder.name}


async def _permanent_delete(db, user_id, args: dict):
    storage = get_storage()

    # 清空整个回收站：all=true → 一次永久删除回收站里所有文件（不要逐个删）
    if args.get("all"):
        deleted_count = await count_deleted_files(db, user_id)
        folders = await list_top_level_deleted_folders(db, user_id)
        if not deleted_count and not folders:
            return {"success": True, "deleted_count": 0, "note": "回收站本来就是空的"}
        # 不可逆 → 二次确认保底；all=true 绑定确认瞬间回收站的目标 ID 集合，
        # 确认后又新增回收站项时授权不会命中，需要重新确认。
        trash_file_ids = sorted(f.id for f in await list_deleted_files(db, user_id, limit=10_000))
        trash_folder_ids = sorted(f.id for f in folders)
        blocked = confirm.needs_confirmation(
            args,
            f"将永久删除回收站里全部 {deleted_count} 个文件和 {len(folders)} 个文件夹，删除后无法恢复",
            user_id,
            identity=f"permanent_delete_all:file_ids={trash_file_ids};folder_ids={trash_folder_ids}",
        )
        if blocked is not None:
            return blocked
        file_ids = await permanently_delete_all_files(db, storage, user_id)
        folder_file_ids = []
        folder_ids = []
        # 文件先清理，文件夹再按顶层恢复单元删除；其子文件夹会级联移除。
        for folder in folders:
            folder_file_ids.extend(await permanently_delete_folder(db, storage, folder))
            folder_ids.append(folder.id)
        await db.commit()
        for fid in {*file_ids, *folder_file_ids}:
            delete_thumb_cache(fid)
        return {
            "success": True,
            "deleted_count": len(file_ids) + len(folder_file_ids),
            "deleted_file_count": len(file_ids) + len(folder_file_ids),
            "deleted_folder_count": len(folder_ids),
            "note": "回收站已清空（文件和文件夹均已删除）",
        }

    # 指定文件/文件夹也支持批量，确认摘要绑定完整目标集合，避免逐项弹确认。
    file_ids = args.get("file_ids")
    folder_ids = args.get("folder_ids")
    if file_ids is None and args.get("file_id") is not None:
        file_ids = [args["file_id"]]
    if folder_ids is None and args.get("folder_id") is not None:
        folder_ids = [args["folder_id"]]
    file_ids = file_ids or []
    folder_ids = folder_ids or []
    if not isinstance(file_ids, list) or not isinstance(folder_ids, list):
        return json.dumps({"error": "file_ids 和 folder_ids 必须是数组"})
    if not file_ids and not folder_ids:
        return json.dumps({"error": "需提供 file_id/file_ids、folder_id/folder_ids，或 all=true"})
    if len(file_ids) + len(folder_ids) > 50:
        return json.dumps({"error": "单次最多永久删除 50 个文件或文件夹"})

    files = []
    for fid in file_ids:
        file = await get_deleted_file(db, user_id, fid)
        if file is None:
            return json.dumps({"error": f"文件 {fid} 不在回收站"})
        files.append(file)
    folders = []
    for folder_id in folder_ids:
        folder = await get_top_level_deleted_folder(db, user_id, folder_id)
        if folder is None:
            return json.dumps({"error": f"文件夹 {folder_id} 不在回收站"})
        folders.append(folder)

    names = [f"{f.display_name}.{f.ext}" for f in files] + [f"文件夹：{f.name}" for f in folders]
    preview = "、".join(names[:10])
    if len(names) > 10:
        preview += f"等 {len(names)} 项"
    blocked = confirm.needs_confirmation(
        args, f"将永久删除 {preview}，共 {len(names)} 项，删除后无法恢复", user_id,
        identity=f"permanent_delete:file_ids={sorted(file_ids)};folder_ids={sorted(folder_ids)}")
    if blocked is not None:
        return blocked

    deleted_ids = []
    for file in files:
        deleted_id = await permanently_delete_file(db, storage, user_id, file.id)
        if deleted_id is not None:
            deleted_ids.append(deleted_id)
    deleted_folder_ids = []
    for folder in folders:
        deleted_ids.extend(await permanently_delete_folder(db, storage, folder))
        deleted_folder_ids.append(folder.id)
    await db.commit()
    for deleted_id in set(deleted_ids):
        delete_thumb_cache(deleted_id)
    if len(names) == 1 and files:
        return {"success": True, "deleted_file_id": files[0].id}
    if len(names) == 1 and folders:
        return {"success": True, "deleted_folder_id": folders[0].id,
                "deleted_file_count": len(deleted_ids)}
    return {"success": True, "deleted_count": len(names),
            "deleted_file_count": len(deleted_ids),
            "deleted_folder_count": len(deleted_folder_ids)}


class TrashSkill(BaseSkill):
    name = "trash"
    tools = [
        Tool(
            name="list_trash", label="查看回收站",
            description_short='查看回收站文件和顶层文件夹；无需参数',
            description="列出回收站里的独立文件和顶层文件夹（软删除、30 天内可还原）；文件夹内的文件随文件夹整体恢复，不重复列出。",
            input_schema={"type": "object", "properties": {}},
            handler=_list_trash,
        ),
        Tool(
            name="restore_file", label="还原文件",
            description_short='还原文件。',
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
            description_short='还原文件夹。',
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
            description_short='永久删除；清空回收站或删除目标前必须确认。',
            description="永久删除回收站文件或顶层文件夹；必须先确认目标，用户在界面确认后重新调用即可执行。",
            input_schema={
                "type": "object",
                "properties": {
                    "file_id": {"type": "integer"},
                    "folder_id": {"type": "integer"},
                    "file_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50},
                    "folder_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50},
                    "all": {"type": "boolean"},
                },
                "required": [],
            },
            handler=_permanent_delete,
            mutates=True,
            destructive=True,
        ),
    ]


TrashSkill().register()
