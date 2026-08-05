import asyncio
from dataclasses import dataclass
from typing import Iterable, Optional, Tuple
from uuid import uuid4

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
    staging_key: str
    overwrite_file_id: Optional[int] = None


@dataclass
class ConfirmUploadResult:
    file: File
    project: Optional[Project]
    folder_name: Optional[str]
    overwritten_file_id: Optional[int] = None
    # 覆盖上传落地到新 key 后，DB 已经指向新 key；旧物理对象要等路由 commit 成功
    # 才能删——confirm_oss_upload 只 flush，提前删掉旧对象会在事务回滚时丢数据。
    old_storage_key: Optional[str] = None


@dataclass(frozen=True)
class UploadedObjectInfo:
    size_bytes: int
    mime_type: str


def _staging_key(user_id: int, ext: str) -> str:
    """签发直传地址用的临时 key，跟最终落点分离。

    presign 不再直接对最终 key（含覆盖场景下已有文件的 storage_key）签发 PUT——
    浏览器一 PUT 就会让 OSS 立即覆盖目标对象，早于服务端任何大小/配额/MIME 校验；
    confirm 校验不通过时，物理对象已经损坏，无法回滚。改为对一个跟最终落点无关的
    临时 key 签 PUT，confirm 通过后再由服务端把临时对象复制到最终 key，全程真实
    数据不会被未经校验的直传覆盖。
    """
    suffix = f".{ext.lower()}" if ext else ""
    return f"{user_id}/.upload-staging/{uuid4().hex}{suffix}"


def _new_version_key(existing_key: str) -> str:
    """覆盖上传的新版本 key：在旧 key 的扩展名前插入一段随机 token，不复用旧 key。

    同样是为了不让浏览器直传直接命中现有文件的物理 key；confirm 里 copy 到这个
    新 key、DB 切换成功后，旧对象才会被删除。"""
    token = uuid4().hex[:8]
    if "." in existing_key.rsplit("/", 1)[-1]:
        base, _, ext = existing_key.rpartition(".")
        return f"{base}.{token}.{ext}"
    return f"{existing_key}.{token}"


async def presign_upload_url(storage, target: PresignTarget, mime_type: str) -> str | None:
    """为 OSS 临时 key 签发直传地址；本地存储返回 None，由路由回退到代理上传。"""
    if not isinstance(storage, OSSStorageBackend):
        return None
    return await asyncio.to_thread(
        storage.presign_put, target.staging_key, mime_type, 600
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
    """校验 OSS 直传对象归属，并返回服务端读取的真实元数据。

    storage_key 必须落在本用户的 ``.upload-staging/`` 目录下——只检查
    ``{user_id}/`` 前缀不够：客户端可以把自己名下任意一个正式文件的 storage_key
    当成 confirm 请求体传回来，confirm 里的 rename_file 会把那个真实对象 copy
    到新 key、删掉原 key，原文件的旧 DB 记录就会指向一个已经不存在的对象。
    """
    if not isinstance(storage, OSSStorageBackend):
        raise UploadTargetError(400, "当前存储后端不是 OSS，请使用普通上传")
    if not storage_key.startswith(f"{user_id}/.upload-staging/"):
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
        staging_key=_staging_key(user_id, ext),
        overwrite_file_id=existing.id if existing else None,
    )


async def confirm_oss_upload(
    db: AsyncSession,
    user_id: int,
    storage,
    *,
    staging_key: str,
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
    """登记已完成的 OSS 上传，只 flush，不提交事务和发布事件。

    ``staging_key`` 是浏览器实际直传到的临时对象（presign 阶段签的就是这个 key，
    不是最终落点）；所有校验通过后才把它 copy 到最终 key，校验失败时临时对象
    留在原地不动，不会碰真实数据。旧物理对象（覆盖场景）不在这里删——那一步要
    等调用方 commit 成功后才能做，否则事务回滚时数据已经丢了。

    调用方（当前只有 files.py 的 /confirm 路由）应该已经用 validate_oss_upload
    校验过 staging_key 的归属和真实存在；这里再校验一次前缀是防御性冗余，避免
    未来新增调用方漏做那一步——传入不在 .upload-staging/ 下的 key（比如用户自己
    另一个正式文件的 storage_key）必须直接拒绝，不能让 rename_file 把它移走。
    """
    if not staging_key.startswith(f"{user_id}/.upload-staging/"):
        raise UploadTargetError(403, "无权限访问该存储路径")
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
        if (existing.space, existing.project_id, existing.folder_id) != (space, project_id, folder_id):
            raise UploadTargetError(400, "覆盖目标与上传位置不一致")
        if storage_limit_bytes is not None and used - existing.size_bytes + size_bytes > storage_limit_bytes:
            raise UploadTargetError(400, "存储空间已满，无法上传")
        old_key = existing.storage_key
        new_key = _new_version_key(old_key)
        await storage.rename_file(staging_key, new_key)   # copy 临时对象到新版本 key，再删临时对象
        existing.storage_key = new_key
        existing.size = _fmt_size(size_bytes)
        existing.size_bytes = size_bytes
        existing.mime_type = actual_mime_type
        await db.flush()
        return ConfirmUploadResult(existing, project, folder_name, existing.id, old_storage_key=old_key)

    final_key = _build_key(
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
    if storage_limit_bytes is not None and used + size_bytes > storage_limit_bytes:
        raise UploadTargetError(400, "存储空间已满，无法上传")

    await storage.rename_file(staging_key, final_key)   # copy 临时对象到最终 key，再删临时对象

    db_file = File(
        user_id=user_id,
        display_name=display_name,
        ext=ext,
        space=space,
        project_id=project_id if space == "project" else None,
        folder_id=folder_id,
        stage_name=stage_name,
        storage_key=final_key,
        size=_fmt_size(size_bytes),
        size_bytes=size_bytes,
        mime_type=actual_mime_type,
    )
    db.add(db_file)
    await db.flush()
    return ConfirmUploadResult(db_file, project, folder_name)
