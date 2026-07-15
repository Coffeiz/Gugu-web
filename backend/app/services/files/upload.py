from dataclasses import dataclass
from typing import Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.models import File, Folder, Project
from app.services.storage.file_service.files import _fmt_size
from app.services.storage.folders import resolve_folder_path
from app.services.storage.keys import _build_key, _resolve_conflict


@dataclass
class PresignTarget:
    display_name: str
    ext: str
    final_key: str
    final_name: str
    overwrite_file_id: Optional[int] = None


@dataclass
class ConfirmUploadResult:
    file: File
    project: Optional[Project]
    folder_name: Optional[str]
    overwritten_file_id: Optional[int] = None


class UploadTargetError(ValueError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def parse_upload_filename(filename: str) -> Tuple[str, str]:
    parts = filename.rsplit('.', 1)
    return parts[0], parts[1].upper()[:10] if len(parts) > 1 else 'FILE'


async def find_conflict(
    db: AsyncSession,
    user_id: int,
    space: str,
    project_id: Optional[int],
    folder_id: Optional[int],
    display_name: str,
    ext: str,
) -> Optional[File]:
    stmt = select(File).where(
        File.user_id == user_id,
        File.deleted_at.is_(None),
        File.space == space,
        File.display_name == display_name,
        File.ext == ext.upper(),
    )
    stmt = stmt.where(File.project_id == project_id) if project_id is not None else stmt.where(File.project_id.is_(None))
    stmt = stmt.where(File.folder_id == folder_id) if folder_id is not None else stmt.where(File.folder_id.is_(None))
    return (await db.execute(stmt)).scalars().first()


async def prepare_presign_target(
    db: AsyncSession,
    storage,
    user_id: int,
    filename: str,
    size_bytes: int,
    space: str,
    project_id: Optional[int],
    folder_id: Optional[int],
    on_conflict: str,
    overwrite_file_id: Optional[int],
    storage_limit_bytes: Optional[int],
) -> PresignTarget:
    """校验上传范围并计算直传目标，不执行写入或签发 URL。"""
    display_name, ext = parse_upload_filename(filename)
    project_name = project_year = project_month = folder_path = ""

    if space == "project" and project_id:
        project = await get_owned(db, Project, project_id, user_id)
        if not project:
            raise UploadTargetError(400, "项目不存在")
        project_name = project.name
        date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]
    elif space == "project":
        raise UploadTargetError(400, "project 空间需要提供 project_id")

    if folder_id is not None:
        resolved = await resolve_folder_path(db, user_id, folder_id, project_id)
        if not resolved or resolved[0].deleted_at is not None:
            raise UploadTargetError(400, "文件夹不存在，或不属于指定的项目/个人空间")
        folder_path = resolved[1]

    existing = None
    if on_conflict == "overwrite" and overwrite_file_id is not None:
        existing = await get_owned(db, File, overwrite_file_id, user_id)
        if not existing:
            raise UploadTargetError(400, "要覆盖的文件不存在")
        final_key, final_name = existing.storage_key, existing.display_name
        if storage_limit_bytes is not None:
            used = (await db.execute(
                select(func.sum(File.size_bytes)).where(File.user_id == user_id)
            )).scalar() or 0
            if used - existing.size_bytes + size_bytes > storage_limit_bytes:
                raise UploadTargetError(400, "存储空间已满，无法上传")
    else:
        base_key = _build_key(
            uid=user_id,
            space=space,
            display_name=display_name,
            ext=ext,
            project_name=project_name,
            project_id=project_id or 0,
            project_year=project_year,
            project_month=project_month,
            folder_path=folder_path,
        )
        final_key, final_name = await _resolve_conflict(storage, base_key, display_name, ext)
        if storage_limit_bytes is not None:
            used = (await db.execute(
                select(func.sum(File.size_bytes)).where(File.user_id == user_id)
            )).scalar() or 0
            if used + size_bytes > storage_limit_bytes:
                raise UploadTargetError(400, "存储空间已满，无法上传")

    return PresignTarget(
        display_name=display_name,
        ext=ext,
        final_key=final_key,
        final_name=final_name,
        overwrite_file_id=existing.id if existing else None,
    )


async def confirm_oss_upload(
    db: AsyncSession,
    user_id: int,
    *,
    storage_key: str,
    display_name: str,
    ext: str,
    mime_type: str,
    size_bytes: int,
    space: str,
    project_id: Optional[int],
    folder_id: Optional[int],
    stage_name: str,
    overwrite_file_id: Optional[int],
) -> ConfirmUploadResult:
    """登记已完成的 OSS 上传，只 flush，不提交事务和发布事件。"""
    project = None
    folder_name = None
    if space == "project" and project_id:
        project = await get_owned(db, Project, project_id, user_id)
        if not project:
            raise UploadTargetError(400, "项目不存在")
    if folder_id is not None:
        folder = await get_owned(db, Folder, folder_id, user_id)
        if not folder:
            raise UploadTargetError(400, "文件夹不存在")
        folder_name = folder.name

    if overwrite_file_id is not None:
        existing = await get_owned(db, File, overwrite_file_id, user_id)
        if not existing:
            raise UploadTargetError(400, "要覆盖的文件不存在")
        if existing.storage_key != storage_key:
            raise UploadTargetError(400, "覆盖目标与直传路径不一致")
        existing.size = _fmt_size(size_bytes)
        existing.size_bytes = size_bytes
        existing.mime_type = mime_type
        await db.flush()
        return ConfirmUploadResult(existing, project, folder_name, existing.id)

    db_file = File(
        user_id=user_id,
        display_name=display_name,
        ext=ext,
        space=space,
        project_id=project_id if space == "project" else None,
        folder_id=folder_id,
        stage_name=stage_name,
        storage_key=storage_key,
        size=_fmt_size(size_bytes),
        size_bytes=size_bytes,
        mime_type=mime_type,
    )
    db.add(db_file)
    await db.flush()
    return ConfirmUploadResult(db_file, project, folder_name)
