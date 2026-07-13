"""FolderTree：文件夹树的 Web 后端领域层（P0.2，见 docs/refactor/文件存储架构方案.md 附三）。

**只管元数据（DB）**：get/children/resolve/descendants/create/rename/move。
**绝不含物理 mkdir / os.rename / 搬 trash**——那些由 FileService 协调 StorageBackend（P0.3+）。
校验失败抛领域异常（`app.core.errors`）；REST 按 status_hint 映射，Agent 映射 {"error"}。
mutation 只 `flush` 不 `commit`——让调用方（FileService/REST）协调 DB+存储后统一提交。
soft_delete/restore 留 P2。逻辑与现 `app/api/v1/folders.py` 逐字等价。
"""
from __future__ import annotations

from typing import Optional, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.ownership import get_owned
from app.models import Folder, Project


class FolderTree(Protocol):
    async def get(self, user_id, folder_id: int) -> Optional[Folder]: ...
    async def get_children(self, user_id, *, project_id: Optional[int], parent_id: Optional[int]) -> list[Folder]: ...
    async def resolve_folder_path(self, user_id, folder_id: int) -> Optional[str]: ...
    async def descendants(self, user_id, folder_id: int) -> list[int]: ...
    async def create(self, user_id, *, name: str, parent_id: Optional[int], project_id: Optional[int]) -> Folder: ...
    async def rename(self, user_id, folder_id: int, new_name: str) -> Folder: ...
    async def move(self, user_id, folder_id: int, new_parent_id: Optional[int]) -> Folder: ...


class SqlAlchemyFolderTree:
    def __init__(self, db: AsyncSession):
        self.db = db

    # ── 读 ──────────────────────────────────────────────────────────────────
    async def get(self, user_id, folder_id: int) -> Optional[Folder]:
        return await get_owned(self.db, Folder, folder_id, user_id)

    async def get_children(self, user_id, *, project_id: Optional[int], parent_id: Optional[int]) -> list[Folder]:
        stmt = select(Folder).where(Folder.user_id == user_id).order_by(Folder.created_at)
        # `== None` 由 SQLAlchemy 渲染成 IS NULL，故 personal 根（project_id/parent_id 皆 None）也对
        stmt = stmt.where(Folder.project_id == project_id) if project_id is not None else stmt.where(Folder.project_id.is_(None))
        stmt = stmt.where(Folder.parent_id == parent_id) if parent_id is not None else stmt.where(Folder.parent_id.is_(None))
        return list((await self.db.execute(stmt)).scalars().all())

    async def resolve_folder_path(self, user_id, folder_id: int) -> Optional[str]:
        """根到叶的**文件夹名链**（如 "设计/评审"），供 compose_logical_path 的 folder_path 参数。
        坏链/越权/循环 → None。"""
        folder = await get_owned(self.db, Folder, folder_id, user_id)
        if not folder:
            return None
        parts: list[str] = []
        current: Optional[Folder] = folder
        seen: set[int] = set()
        while current:
            if current.id in seen:
                return None
            seen.add(current.id)
            parts.append(current.name)
            if current.parent_id is None:
                break
            current = await get_owned(self.db, Folder, current.parent_id, user_id)
            if not current:
                return None
        return "/".join(reversed(parts))

    async def descendants(self, user_id, folder_id: int) -> list[int]:
        """根文件夹及全部子孙 id（含 root）。移动/物理归位用。"""
        ids = [folder_id]
        frontier = [folder_id]
        while frontier:
            rows = (await self.db.execute(
                select(Folder.id).where(Folder.user_id == user_id, Folder.parent_id.in_(frontier))
            )).scalars().all()
            frontier = [i for i in rows if i not in ids]
            ids.extend(frontier)
        return ids

    # ── 写（只 flush，不 commit）──────────────────────────────────────────────
    async def create(self, user_id, *, name: str, parent_id: Optional[int], project_id: Optional[int]) -> Folder:
        if project_id is not None:
            proj = await get_owned(self.db, Project, project_id, user_id)
            if not proj:
                raise NotFound("project.not_found", "项目不存在")
        existing = (await self.db.execute(
            select(Folder).where(
                Folder.user_id == user_id,
                Folder.project_id == project_id,
                Folder.parent_id == parent_id,
                Folder.name == name,
            )
        )).scalar_one_or_none()
        if existing:
            raise Conflict("folder.duplicate", "同名文件夹已存在")
        folder = Folder(user_id=user_id, project_id=project_id, parent_id=parent_id, name=name)
        self.db.add(folder)
        await self.db.flush()
        return folder

    async def rename(self, user_id, folder_id: int, new_name: str) -> Folder:
        folder = await get_owned(self.db, Folder, folder_id, user_id)
        if not folder:
            raise NotFound("folder.not_found", "文件夹不存在")
        folder.name = new_name
        await self.db.flush()
        return folder

    async def move(self, user_id, folder_id: int, new_parent_id: Optional[int]) -> Folder:
        folder = await get_owned(self.db, Folder, folder_id, user_id)
        if not folder:
            raise NotFound("folder.not_found", "文件夹不存在")
        if new_parent_id is not None:
            target = await get_owned(self.db, Folder, new_parent_id, user_id)
            if not target:
                raise NotFound("folder.target_not_found", "目标文件夹不存在")
            if target.project_id != folder.project_id:
                raise Invalid("folder.cross_space", "不能跨个人文件与项目文件移动文件夹")
            cur = new_parent_id                       # 向上走检测循环
            seen: set[int] = set()
            while cur is not None:
                if cur == folder_id:
                    raise Invalid("folder.cycle", "不能将文件夹移动到自身或其子文件夹中")
                if cur in seen:
                    break
                seen.add(cur)
                f = await get_owned(self.db, Folder, cur, user_id)   # 祖先链应全属本人，断链即止
                if f is None:
                    break
                cur = f.parent_id
        folder.parent_id = new_parent_id
        await self.db.flush()
        return folder
