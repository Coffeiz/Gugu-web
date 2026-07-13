"""FileService 内部：文件写操作（P0.3b）——上传/改名移动/复制，全部走 KeyStrategy 抽象。

物理 key 不再裸调 `_build_key`：业务命名交 `compose_logical_path`（纯函数），
物理 key 由 `key_strategy.build_key(KeyContext)` 出、冲突改名由 `key_strategy.resolve_conflict`
出——存储层不认识 project_year/mind_map 等业务字段。等价性由 test_key_strategy 对拍锁定，
逐字复刻 `app/api/v1/files.py` 的 upload / PATCH / copy 语义（含配额、覆盖、跨空间归属）。

校验失败抛领域异常（`app.core.errors`），**status 与原 HTTPException 逐字一致**：文件本身
不存在 → NotFound(404)；项目/文件夹/配额/覆盖目标 → Invalid(400)（files.py 历来对这些用
400，不跟 folders 的 404 对齐——保持既有行为，零回归优先于语义统一）。
mutation 只 `flush`，由调用方（REST/Agent）统一 commit + 发事件 + shape 响应。
软删（delete/回收站）不含 KeyStrategy，归 P2；纯查询（list/tree）留在端点。
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func, select

from app.core.errors import Invalid, NotFound
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import File, Project
from app.services.storage.folders import resolve_folder_path
from app.services.storage.key_strategy import KeyContext
from app.services.storage.keys import compose_logical_path


def _fmt_size(size_bytes: int) -> str:
    if size_bytes >= 1_000_000:
        return f"{size_bytes / 1_000_000:.1f} MB"
    return f"{size_bytes / 1024:.0f} KB"


@dataclass
class FileResult:
    """写操作结果：ORM 行 + 供端点 shape 响应的上下文（project/folder 名色由端点取，
    _color 这类展示逻辑不下沉到领域层）。"""
    file: File
    project: Project | None
    folder_name: str | None
    was_overwrite: bool = False


class FileOps:
    def __init__(self, db, folder_tree, storage, key_strategy):
        self.db = db
        self.folder_tree = folder_tree
        self.storage = storage
        self.key_strategy = key_strategy

    async def _sum_used(self, user_id) -> int:
        return (await self.db.execute(
            select(func.sum(File.size_bytes)).where(File.user_id == user_id)
        )).scalar() or 0

    async def _resolve_target(self, user_id, space, project_id, folder_id, *,
                              folder_msg, project_msg="项目不存在"):
        """解析目标项目/文件夹 → (project, project_year, project_month, folder_name, folder_path)。
        项目缺失/需 project_id/文件夹非法均抛 Invalid（复刻 files.py 的 400）。
        project_msg 因端点而异：upload=「项目不存在」，copy=「目标项目不存在」。"""
        project = None
        project_year = project_month = ""
        folder_name = folder_path = ""
        if space == "project" and project_id:
            project = await get_owned(self.db, Project, project_id, user_id)
            if not project:
                raise Invalid("project.not_found", project_msg)
            date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
            project_year, project_month = date_str[:4], date_str[5:7]
        elif space == "project":
            raise Invalid("project.id_required", "project 空间需要提供 project_id")
        if folder_id is not None:
            resolved = await resolve_folder_path(self.db, user_id, folder_id, project_id)
            # resolve_folder_path 本身不认 deleted_at（folder_dir_key 等内部用途需要在软删后
            # 仍能解析），新内容的落点这里额外拦一道：不能把文件传进已经软删的文件夹（P2）。
            if not resolved or resolved[0].deleted_at is not None:
                raise Invalid("folder.not_found", folder_msg)
            fo, folder_path = resolved
            folder_name = fo.name
        return project, project_year, project_month, folder_name, folder_path

    def _build_key(self, user_id, *, file_id, space, name, ext, project, project_id,
                   project_year, project_month, folder_path) -> str:
        logical = compose_logical_path(
            space,
            project_name=project.name if project else "",
            project_id=project_id or 0,
            project_year=project_year, project_month=project_month,
            folder_path=folder_path,
        )
        return self.key_strategy.build_key(
            KeyContext(user_id=user_id, file_id=file_id, name=name, ext=ext, logical_path=logical)
        )

    # ── 上传（保留两者 / 覆盖）───────────────────────────────────────────────────
    async def create_file(self, user_id, *, space, project_id, folder_id, stage_name,
                          mind_map_id, display_name, ext, mime_type, data,
                          img_width=None, img_height=None,
                          on_conflict="keep_both", overwrite_file_id=None,
                          storage_limit_bytes=None) -> FileResult:
        project, project_year, project_month, folder_name, folder_path = await self._resolve_target(
            user_id, space, project_id, folder_id,
            folder_msg="文件夹不存在，或不属于指定的项目/个人空间")
        size_bytes = len(data)

        # 覆盖已有同名文件：原地替换内容，保留同一个 file id；配额按新旧差值算。
        if on_conflict == "overwrite" and overwrite_file_id is not None:
            existing = await get_owned(self.db, File, overwrite_file_id, user_id)
            if not existing:
                raise Invalid("file.overwrite_target_not_found", "要覆盖的文件不存在")
            if storage_limit_bytes is not None:
                used = await self._sum_used(user_id)
                if used - existing.size_bytes + size_bytes > storage_limit_bytes:
                    raise Invalid("storage.full", "存储空间已满，无法上传")
            await self.storage.put(existing.storage_key, data, mime_type)
            existing.size = _fmt_size(size_bytes)
            existing.size_bytes = size_bytes
            existing.mime_type = mime_type
            existing.img_width = img_width
            existing.img_height = img_height
            await self.db.flush()
            return FileResult(existing, project, folder_name or None, was_overwrite=True)

        # 常规上传（同名自动加后缀）
        base_key = self._build_key(
            user_id, file_id=None, space=space, name=display_name, ext=ext,
            project=project, project_id=project_id,
            project_year=project_year, project_month=project_month, folder_path=folder_path)
        resolved = await self.key_strategy.resolve_conflict(self.storage, base_key, display_name, ext)
        final_key, final_name = resolved.key, resolved.name

        if storage_limit_bytes is not None:
            used = await self._sum_used(user_id)
            if used + size_bytes > storage_limit_bytes:
                raise Invalid("storage.full", "存储空间已满，无法上传")

        await self.storage.put(final_key, data, mime_type)
        db_file = File(
            user_id=user_id, display_name=final_name, ext=ext, space=space,
            project_id=project_id if space == "project" else None,
            folder_id=folder_id, stage_name=stage_name,
            mind_map_id=mind_map_id if space == "mind" else None,
            storage_key=final_key, size=_fmt_size(size_bytes), size_bytes=size_bytes,
            mime_type=mime_type, img_width=img_width, img_height=img_height,
        )
        self.db.add(db_file)
        await self.db.flush()
        return FileResult(db_file, project, folder_name or None)

    # ── 改名 / 移动（PATCH）─────────────────────────────────────────────────────
    async def update_file(self, user_id, fid, *, display_name, stage_name,
                          folder_id, project_id, folder_set, project_set) -> FileResult:
        f = await get_owned(self.db, File, fid, user_id)
        if not f:
            raise NotFound("file.not_found", "文件不存在")
        new_display = display_name if display_name is not None else f.display_name
        new_stage = stage_name if stage_name is not None else f.stage_name
        # folder_id/project_id 只在显式出现（含 null）时才更新，否则保持原值——纯改名 patch
        # 不带这两字段，不能被当成「移到个人空间」。
        new_fid = folder_id if folder_set else f.folder_id
        new_pid = project_id if project_set else f.project_id
        new_space = "project" if new_pid else "personal"

        project = None
        project_year = project_month = ""
        folder_name = folder_path = ""
        if new_space == "project" and new_pid:
            project = await get_owned(self.db, Project, new_pid, user_id)
            if not project:
                raise Invalid("project.not_found", "目标项目不存在")
            date_str = project.start_date or project.created_at.strftime("%Y-%m-%d")
            project_year, project_month = date_str[:4], date_str[5:7]
        if new_fid:
            resolved = await resolve_folder_path(self.db, user_id, new_fid, new_pid)
            if not resolved or resolved[0].deleted_at is not None:   # 不能移进已软删的文件夹（P2）
                raise Invalid("folder.not_found", "目标文件夹不存在，或不属于目标项目/个人空间")
            fo, folder_path = resolved
            folder_name = fo.name

        new_key = self._build_key(
            user_id, file_id=f.id, space=new_space, name=new_display, ext=f.ext,
            project=project, project_id=new_pid,
            project_year=project_year, project_month=project_month, folder_path=folder_path)
        if new_key != f.storage_key:
            resolved = await self.key_strategy.resolve_conflict(self.storage, new_key, new_display, f.ext)
            new_key, new_display = resolved.key, resolved.name
            await self.storage.rename_file(f.storage_key, new_key)
            f.storage_key = new_key
            # 不清旧祖先：源文件夹仍存活，其空目录须持久（P1.2）；孤儿由文件夹级清理 + 对账工具兜底

        f.display_name = new_display
        f.stage_name = new_stage
        f.folder_id = new_fid
        f.project_id = new_pid
        f.space = new_space
        f.updated_at = now_utc()
        await self.db.flush()
        return FileResult(f, project, folder_name or None)

    # ── 复制 ───────────────────────────────────────────────────────────────────
    async def copy_file(self, user_id, fid, *, folder_id, project_id) -> FileResult:
        f = await get_owned(self.db, File, fid, user_id)
        if not f or f.deleted_at:
            raise NotFound("file.not_found", "文件不存在")
        new_space = "project" if project_id else "personal"
        project, project_year, project_month, folder_name, folder_path = await self._resolve_target(
            user_id, new_space, project_id, folder_id,
            folder_msg="目标文件夹不存在，或不属于目标项目/个人空间",
            project_msg="目标项目不存在")

        base_key = self._build_key(
            user_id, file_id=None, space=new_space, name=f.display_name, ext=f.ext,
            project=project, project_id=project_id,
            project_year=project_year, project_month=project_month, folder_path=folder_path)
        resolved = await self.key_strategy.resolve_conflict(self.storage, base_key, f.display_name, f.ext)
        new_key, new_display = resolved.key, resolved.name

        data = await self.storage.get(f.storage_key)
        await self.storage.put(new_key, data, f.mime_type)
        new_file = File(
            user_id=user_id, display_name=new_display, ext=f.ext, storage_key=new_key,
            size=f.size, mime_type=f.mime_type, space=new_space,
            project_id=project_id, folder_id=folder_id, stage_name=f.stage_name,
        )
        self.db.add(new_file)
        await self.db.flush()
        return FileResult(new_file, project, folder_name or None)
