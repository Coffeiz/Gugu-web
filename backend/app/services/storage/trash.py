"""文件回收站物理搬迁原语（P2）——files.py（单/批量删除）、trash.py（还原/清空/过期清理）、
文件夹软删（file_service/folders.py）三处共享，行为逐字不变（从 app/api/v1/files.py 与
app/api/v1/trash.py 原样迁出，仅把失效的幂等判断换成真正生效的判断，见 move_to_trash 注释）。
"""
from __future__ import annotations

from app.core.ownership import get_owned
from app.models import File, MindMap, Project
from app.services.storage.folders import resolve_folder_path
from app.services.storage.keys import _build_key, _resolve_conflict


def to_trash_key(user_id, fid: int, storage_key: str) -> str:
    """生成回收站路径，保留原文件名方便识别。"""
    return f"{user_id}/trash/{fid}/{storage_key.rsplit('/', 1)[-1]}"


async def move_file_to_trash(storage, f: File) -> None:
    """把物理文件移入回收站目录，更新 storage_key；失败时静默忽略。

    幂等判断按「当前 key 是否已等于本该算出的 trash_key」——原判断
    `storage_key.startswith("_trash_/")` 与 to_trash_key 实际产出的
    `f"{uid}/trash/{fid}/..."` 格式对不上，从未生效过（迁移时顺带修正，
    行为更安全：本函数现在才是真正可重复调用不出错）。
    """
    trash_key = to_trash_key(f.user_id, f.id, f.storage_key)
    if f.storage_key == trash_key:
        return  # 已在回收站
    try:
        f.storage_key = await storage.move_to_trash(f.storage_key, trash_key)
        # 不清旧祖先：文件所属文件夹可能仍存活，空目录须持久（P1.2）；孤儿由对账工具兜底
    except Exception:
        pass


async def restore_file_storage(f: File, storage, db) -> None:
    """重建原始 storage_key，将文件移回原目录；冲突时自动加 (n) 后缀。"""
    project_name = project_year = project_month = folder_path = mind_map_title = ""
    if f.project_id:
        p = await get_owned(db, Project, f.project_id, f.user_id)
        if p:
            project_name = p.name
            date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
            project_year, project_month = date_str[:4], date_str[5:7]
    if f.folder_id:
        resolved = await resolve_folder_path(db, f.user_id, f.folder_id, f.project_id)
        if resolved:
            _, folder_path = resolved
    if f.mind_map_id:
        mm = await get_owned(db, MindMap, f.mind_map_id, f.user_id)
        if mm:
            mind_map_title = mm.title

    base_key = _build_key(
        uid=f.user_id, space=f.space,
        display_name=f.display_name, ext=f.ext,
        project_name=project_name, project_id=f.project_id or 0,
        project_year=project_year, project_month=project_month,
        folder_path=folder_path,
        mind_map_title=mind_map_title, mind_map_id=f.mind_map_id or 0,
    )
    old_key = f.storage_key
    # OSS 回收站只改数据库 deleted_at，对象仍在原 key；不能把它自己当成重名对象。
    if old_key == base_key:
        final_key, final_name = base_key, f.display_name
    else:
        final_key, final_name = await _resolve_conflict(storage, base_key, f.display_name, f.ext)

    try:
        f.storage_key = await storage.restore_from_trash(old_key, final_key)
        f.display_name = final_name
    except Exception:
        # 物理文件丢失时仍恢复 DB 记录，storage_key 重置为预期路径
        f.storage_key = final_key
        f.display_name = final_name
