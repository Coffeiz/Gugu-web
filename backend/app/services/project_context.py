"""Agent 项目上下文使用的项目摘要与文件概览。"""

from sqlalchemy import case, func, select

from app.models import File, Folder


def _empty_file_overview() -> dict[str, int]:
    return {"total_file_count": 0, "root_file_count": 0, "total_folder_count": 0}


async def load_project_file_overviews(db, user_id, project_ids: list[int]) -> dict[int, dict[str, int]]:
    """批量读取用户可见项目的存活文件与目录数量，不加载文件明细。"""
    ids = list(dict.fromkeys(project_ids))
    overviews = {project_id: _empty_file_overview() for project_id in ids}
    if not ids:
        return overviews

    file_rows = await db.execute(
        select(
            File.project_id,
            func.count(File.id),
            func.count(case((File.folder_id.is_(None), 1))),
        )
        .where(
            File.user_id == user_id,
            File.space == "project",
            File.project_id.in_(ids),
            File.deleted_at.is_(None),
        )
        .group_by(File.project_id)
    )
    for project_id, total_files, root_files in file_rows:
        overviews[project_id]["total_file_count"] = total_files
        overviews[project_id]["root_file_count"] = root_files

    folder_rows = await db.execute(
        select(Folder.project_id, func.count(Folder.id))
        .where(
            Folder.user_id == user_id,
            Folder.project_id.in_(ids),
            Folder.deleted_at.is_(None),
        )
        .group_by(Folder.project_id)
    )
    for project_id, total_folders in folder_rows:
        overviews[project_id]["total_folder_count"] = total_folders
    return overviews


def project_context_metadata(project, file_overview: dict[str, int] | None = None) -> dict:
    """生成 Agent 项目工具和动态 snapshot 共用的字段投影。"""
    overview = _empty_file_overview()
    if file_overview:
        overview.update(file_overview)
    return {"summary": getattr(project, "summary", None), "files": overview}
