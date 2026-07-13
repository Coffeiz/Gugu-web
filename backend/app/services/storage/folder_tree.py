"""FolderTree：文件夹树的 Web 后端领域层（P0.2，见 docs/refactor/文件存储架构方案.md 附三）。

**只管元数据（DB）**：get/children/resolve/descendants/create/rename/move/soft_delete/restore。
**绝不含物理 mkdir / os.rename / 搬 trash**——那些由 FileService 协调 StorageBackend（P0.3+）。
校验失败抛领域异常（`app.core.errors`）；REST 按 status_hint 映射，Agent 映射 {"error"}。
mutation 只 `flush` 不 `commit`——让调用方（FileService/REST）协调 DB+存储后统一提交。

**软删语义（P2）**：`get`/`get_children`/`resolve_folder_path`/`descendants`/`create`（重名检测）/
`rename`/`move` 全部只认「存活」文件夹（`deleted_at IS NULL`）——软删的文件夹对这些方法而言
如同不存在，与「行不存在」同一套错误处理，不另开一条判断分支。只有 `soft_delete`/`restore`
本身会触碰已删状态；查看/恢复回收站是完全独立的读路径（trash.py 直接查 Folder，不经本类）。

**乐观并发（P2.6）**：`rename`/`move` 延伸现有 Project 的 409 并发锁模式——`client_version`
必传，走原子 `UPDATE ... WHERE version = client_version`，`rowcount` 不为 1（存在性已在此之前
确认过）即版本过期，抛 `Conflict`（REST 映射 409）。`soft_delete`/`restore` 也各自把
`version` 顺带 +1（任何 mutation 都应使旧 version 失效，防止并发的改名/移动请求在文件夹已被
删除/恢复之后仍凭旧 version 静默成功）。create 不需要 version——新行无「旧版本」可言。
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional, Protocol

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.ownership import get_owned
from app.core.tz import now_utc
from app.models import Folder, Project


class FolderTree(Protocol):
    async def get(self, user_id, folder_id: int) -> Optional[Folder]: ...
    async def get_children(self, user_id, *, project_id: Optional[int], parent_id: Optional[int]) -> list[Folder]: ...
    async def resolve_folder_path(self, user_id, folder_id: int) -> Optional[str]: ...
    async def descendants(self, user_id, folder_id: int) -> list[int]: ...
    async def create(self, user_id, *, name: str, parent_id: Optional[int], project_id: Optional[int]) -> Folder: ...
    async def rename(self, user_id, folder_id: int, new_name: str, *, client_version: int) -> Folder: ...
    async def move(self, user_id, folder_id: int, new_parent_id: Optional[int], *, client_version: int) -> Folder: ...
    async def soft_delete(self, user_id, folder_id: int) -> tuple[Folder, list[int]]: ...
    async def restore(self, user_id, folder_id: int) -> tuple[Folder, list[int], datetime]: ...


class SqlAlchemyFolderTree:
    def __init__(self, db: AsyncSession):
        self.db = db

    # ── 读（只认存活）───────────────────────────────────────────────────────────
    async def get(self, user_id, folder_id: int) -> Optional[Folder]:
        folder = await get_owned(self.db, Folder, folder_id, user_id)
        return folder if folder and folder.deleted_at is None else None

    async def get_children(self, user_id, *, project_id: Optional[int], parent_id: Optional[int]) -> list[Folder]:
        stmt = (select(Folder)
                .where(Folder.user_id == user_id, Folder.deleted_at.is_(None))
                .order_by(Folder.created_at))
        # `== None` 由 SQLAlchemy 渲染成 IS NULL，故 personal 根（project_id/parent_id 皆 None）也对
        stmt = stmt.where(Folder.project_id == project_id) if project_id is not None else stmt.where(Folder.project_id.is_(None))
        stmt = stmt.where(Folder.parent_id == parent_id) if parent_id is not None else stmt.where(Folder.parent_id.is_(None))
        return list((await self.db.execute(stmt)).scalars().all())

    async def resolve_folder_path(self, user_id, folder_id: int) -> Optional[str]:
        """根到叶的**文件夹名链**（如 "设计/评审"），供 compose_logical_path 的 folder_path 参数。
        坏链/越权/循环/途经已软删文件夹 → None（存活文件夹的祖先链在正确状态下不会经过已删节点；
        防御性判断，真出现即视为断链）。"""
        folder = await self.get(user_id, folder_id)
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
            current = await self.get(user_id, current.parent_id)
            if not current:
                return None
        return "/".join(reversed(parts))

    async def descendants(self, user_id, folder_id: int) -> list[int]:
        """根文件夹及全部**存活**子孙 id（含 root）。移动/物理归位用。"""
        ids = [folder_id]
        frontier = [folder_id]
        while frontier:
            rows = (await self.db.execute(
                select(Folder.id).where(Folder.user_id == user_id, Folder.deleted_at.is_(None),
                                        Folder.parent_id.in_(frontier))
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
                Folder.deleted_at.is_(None),   # 重名检测只认存活文件夹——回收站里同名不挡新建
            )
        )).scalar_one_or_none()
        if existing:
            raise Conflict("folder.duplicate", "同名文件夹已存在")
        folder = Folder(user_id=user_id, project_id=project_id, parent_id=parent_id, name=name)
        self.db.add(folder)
        await self.db.flush()
        return folder

    async def rename(self, user_id, folder_id: int, new_name: str, *, client_version: int) -> Folder:
        folder = await self.get(user_id, folder_id)
        if not folder:
            raise NotFound("folder.not_found", "文件夹不存在")
        result = await self.db.execute(
            update(Folder)
            .where(Folder.id == folder_id, Folder.user_id == user_id,
                   Folder.deleted_at.is_(None), Folder.version == client_version)
            .values(name=new_name, version=Folder.version + 1, updated_at=now_utc())
        )
        if result.rowcount != 1:
            raise Conflict("folder.version_mismatch", "文件夹已被修改，请刷新后重试")
        await self.db.refresh(folder)
        return folder

    async def move(self, user_id, folder_id: int, new_parent_id: Optional[int], *, client_version: int) -> Folder:
        folder = await self.get(user_id, folder_id)
        if not folder:
            raise NotFound("folder.not_found", "文件夹不存在")
        if new_parent_id is not None:
            target = await self.get(user_id, new_parent_id)
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
                f = await self.get(user_id, cur)   # 祖先链应全属本人且存活，断链即止
                if f is None:
                    break
                cur = f.parent_id
        result = await self.db.execute(
            update(Folder)
            .where(Folder.id == folder_id, Folder.user_id == user_id,
                   Folder.deleted_at.is_(None), Folder.version == client_version)
            .values(parent_id=new_parent_id, version=Folder.version + 1, updated_at=now_utc())
        )
        if result.rowcount != 1:
            raise Conflict("folder.version_mismatch", "文件夹已被修改，请刷新后重试")
        await self.db.refresh(folder)
        return folder

    # ── 软删 / 恢复（P2.2/P2.4）──────────────────────────────────────────────────
    async def soft_delete(self, user_id, folder_id: int) -> tuple[Folder, list[int]]:
        """软删 folder 及其全部存活子孙，同一批打上同一个 deleted_at 时间戳（供 FileService
        据此时间戳精确匹配「本次删除连带软删的文件」，与更早独立删除的文件区分开）。
        返回 (根 folder, 本次涉及的全部 folder id，含根)。"""
        folder = await self.get(user_id, folder_id)
        if not folder:
            raise NotFound("folder.not_found", "文件夹不存在")
        ids = await self.descendants(user_id, folder_id)   # 只含存活子孙（含根）
        stamp = now_utc()
        rows = (await self.db.execute(select(Folder).where(Folder.id.in_(ids)))).scalars().all()
        for f in rows:
            f.deleted_at = stamp
            f.updated_at = stamp
            f.version += 1   # 让并发中的旧 version 改名/移动请求之后必 409，不会静默复活已删记录
        await self.db.flush()
        return folder, ids

    async def restore(self, user_id, folder_id: int) -> tuple[Folder, list[int], datetime]:
        """恢复一棵此前整体软删的子树；folder_id 须是那次删除动作的根（回收站列出的即为根）。
        只恢复与根**同一 deleted_at 时间戳**的节点——若子树内某节点是更早、独立被删的（其父当时
        仍存活），该节点保留原状不随之恢复（见文件顶注：与本次删除动作无关，回收站里仍是它自己
        的独立条目，直到单独恢复或过期清理）。返回 (根 folder, 本次恢复涉及的全部 folder id, 原
        deleted_at)。"""
        folder = await get_owned(self.db, Folder, folder_id, user_id)   # 绕过 live-only：要能取到已删的行
        if not folder or folder.deleted_at is None:
            raise NotFound("folder.not_found", "文件夹不在回收站")
        stamp = folder.deleted_at
        ids = [folder_id]
        frontier = [folder_id]
        while frontier:
            rows = (await self.db.execute(
                select(Folder.id, Folder.deleted_at).where(
                    Folder.user_id == user_id, Folder.parent_id.in_(frontier))
            )).all()
            frontier = [fid for fid, dt in rows if dt == stamp and fid not in ids]
            ids.extend(frontier)
        restore_rows = (await self.db.execute(select(Folder).where(Folder.id.in_(ids)))).scalars().all()
        now = now_utc()
        for f in restore_rows:
            f.deleted_at = None
            f.updated_at = now
            f.version += 1
        await self.db.flush()
        return folder, ids, stamp
