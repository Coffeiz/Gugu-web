import asyncio
from dataclasses import dataclass
from typing import Iterable, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.models import File, Project, User
from app.services.storage import OSSStorageBackend
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


@dataclass(frozen=True)
class UploadedObjectInfo:
    size_bytes: int
    mime_type: str


async def presign_upload_url(storage, target: PresignTarget, mime_type: str) -> str | None:
    """为 OSS 目标签发直传地址；本地存储返回 None，由路由回退到代理上传。"""
    if not isinstance(storage, OSSStorageBackend):
        return None
    return await asyncio.to_thread(
        storage.presign_put, target.final_key, mime_type, 600
    )


async def check_upload_conflicts(
    db: AsyncSession,
    user_id: int,
    items: Iterable[tuple[str, str, Optional[int], Optional[int]]],
) -> list[tuple[str, Optional[File]]]:
    """批量查询上传冲突；只读，不落库、不改变配额或存储。"""
    conflicts = []
    for filename, space, project_id, folder_id in items:
        display_name, ext = parse_upload_filename(filename)
        existing = await find_conflict(
            db, user_id, space, project_id, folder_id, display_name, ext,
        )
        conflicts.append((filename, existing))
    return conflicts


class UploadTargetError(ValueError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def validate_oss_upload(storage, user_id: int, storage_key: str) -> UploadedObjectInfo:
    """校验 OSS 直传对象归属，并返回服务端读取的真实元数据。"""
    if not isinstance(storage, OSSStorageBackend):
        raise UploadTargetError(400, "当前存储后端不是 OSS，请使用普通上传")
    if not storage_key.startswith(f"{user_id}/"):
        raise UploadTargetError(403, "无权限访问该存储路径")
    try:
        metadata = await storage.head(storage_key)
    except Exception as exc:
        # OSS 的 NoSuchKey 等 4xx 由 API 边界转成统一的上传状态错误；瞬时错误由
        # storage 层转换为 RetryableError，不继续登记不确定的对象。
        if getattr(exc, "status", None) == 404:
            raise UploadTargetError(400, "文件尚未上传到 OSS，请先完成直传") from exc
        raise
    size_bytes = int(getattr(metadata, "content_length", 0) or 0)
    mime_type = str(getattr(metadata, "content_type", None) or "application/octet-stream")
    if size_bytes <= 0:
        raise UploadTargetError(400, "OSS 对象为空，无法登记文件")
    return UploadedObjectInfo(size_bytes=size_bytes, mime_type=mime_type)


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
        if not existing or existing.deleted_at is not None:
            raise UploadTargetError(400, "要覆盖的文件不存在")
        if (existing.space, existing.project_id, existing.folder_id) != (space, project_id, folder_id):
            raise UploadTargetError(400, "覆盖目标与上传位置不一致")
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
    size_bytes: int,
    actual_mime_type: str,
    space: str,
    project_id: Optional[int],
    folder_id: Optional[int],
    stage_name: str,
    overwrite_file_id: Optional[int],
    storage_limit_bytes: Optional[int],
    max_file_bytes: int,
) -> ConfirmUploadResult:
    """登记已完成的 OSS 上传，只 flush，不提交事务和发布事件。"""
    if size_bytes > max_file_bytes:
        raise UploadTargetError(413, "文件超过单文件大小限制")
    if storage_limit_bytes is not None:
        # 锁定用户行，避免两个并发 confirm 同时通过配额检查。
        await db.execute(select(User).where(User.id == user_id).with_for_update())
        used = (await db.execute(
            select(func.sum(File.size_bytes)).where(File.user_id == user_id)
        )).scalar() or 0
    else:
        used = 0

    project = None
    folder_name = None
    project_name = project_year = project_month = folder_path = ""
    if space not in {"personal", "project"}:
        raise UploadTargetError(400, "无效的文件空间")
    if space == "project" and project_id is None:
        raise UploadTargetError(400, "project 空间需要提供 project_id")
    if space == "personal" and project_id is not None:
        raise UploadTargetError(400, "personal 空间不能提供 project_id")
    if space == "project":
        project = await get_owned(db, Project, project_id, user_id)
        if not project:
            raise UploadTargetError(400, "项目不存在")
        project_name = project.name
        date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]
    if folder_id is not None:
        resolved = await resolve_folder_path(db, user_id, folder_id, project_id)
        if not resolved or resolved[0].deleted_at is not None:
            raise UploadTargetError(400, "文件夹不存在，或不属于指定的项目/个人空间")
        folder_name = resolved[0].name
        folder_path = resolved[1]

    if overwrite_file_id is not None:
        existing = await get_owned(db, File, overwrite_file_id, user_id)
        if not existing or existing.deleted_at is not None:
            raise UploadTargetError(400, "要覆盖的文件不存在")
        if existing.storage_key != storage_key:
            raise UploadTargetError(400, "覆盖目标与直传路径不一致")
        if (existing.space, existing.project_id, existing.folder_id) != (space, project_id, folder_id):
            raise UploadTargetError(400, "覆盖目标与上传位置不一致")
        if storage_limit_bytes is not None and used - existing.size_bytes + size_bytes > storage_limit_bytes:
            raise UploadTargetError(400, "存储空间已满，无法上传")
        existing.size = _fmt_size(size_bytes)
        existing.size_bytes = size_bytes
        existing.mime_type = actual_mime_type
        await db.flush()
        return ConfirmUploadResult(existing, project, folder_name, existing.id)

    expected_key = _build_key(
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
    if storage_key != expected_key:
        raise UploadTargetError(400, "上传路径与目标位置不一致，请重新上传")

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
        mime_type=actual_mime_type,
    )
    db.add(db_file)
    await db.flush()
    return ConfirmUploadResult(db_file, project, folder_name)
