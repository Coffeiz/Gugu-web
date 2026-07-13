"""FileService 内部：文件夹操作（P0.3 + P1）。协调 FolderTree（元数据）+ 物理目录一致性。

P0.3：改名/移动的**物理文件搬迁**（path-mirror 下 key 内嵌路径）经 `relocate_folder_tree_files`；
opaque（move_semantics='db-only'）则跳过——由 key 策略自决。
P1：物理**目录骨架**也要一致（治 today 的 123 空夹缺失 / adr 幽灵目录）：
- 建夹 → `storage.ensure_folder` 物化目录（空夹也上盘）；
- 改名/移动 → 搬文件后再对账目录：物化新位置整棵子树（含无文件的空夹）+ 清旧位置搬空的骨架。
物理动作走 backend 钩子（Local 真 mkdir/mv/rm、对象存储 no-op），**不写 if local**。
"""
from __future__ import annotations

from app.core.ownership import get_owned
from app.models import Project
from app.services.storage.folders import relocate_folder_tree_files, resolve_folder_path
from app.services.storage.keys import compose_logical_path


class FolderOps:
    def __init__(self, db, folder_tree, storage, key_strategy):
        self.db = db
        self.folder_tree = folder_tree
        self.storage = storage
        self.key_strategy = key_strategy

    @property
    def _relocates(self) -> bool:
        return self.key_strategy.move_semantics == "relocate"

    async def _dir_key(self, user_id, folder) -> str | None:
        """该文件夹的物理目录 key（root 相对、含 uid 前缀）：`{uid}/{compose_logical_path(...)}`。
        与文件 key 的目录部分同构，故空夹目录 = 该文件夹下文件 key 的公共前缀。坏链/越权 → None。"""
        project_id = folder.project_id
        space = "project" if project_id is not None else "personal"
        project_name = project_year = project_month = ""
        if project_id is not None:
            proj = await get_owned(self.db, Project, project_id, user_id)
            if not proj:
                return None
            project_name = proj.name
            date_str = proj.start_date or proj.created_at.strftime("%Y-%m-%d")
            project_year, project_month = date_str[:4], date_str[5:7]
        resolved = await resolve_folder_path(self.db, user_id, folder.id, project_id)
        if not resolved:
            return None
        _, folder_path = resolved
        logical = compose_logical_path(
            space, project_name=project_name, project_id=project_id or 0,
            project_year=project_year, project_month=project_month, folder_path=folder_path)
        return f"{user_id}/{logical}"

    async def _materialize_subtree(self, user_id, root_folder_id) -> None:
        """物化以 root 为根的整棵文件夹子树目录（含无文件的空夹）——供建夹/移动后补齐空目录。"""
        for fid in await self.folder_tree.descendants(user_id, root_folder_id):
            sub = await self.folder_tree.get(user_id, fid)
            if sub is None:
                continue
            dir_key = await self._dir_key(user_id, sub)
            if dir_key:
                await self.storage.ensure_folder(dir_key)

    async def create(self, user_id, *, name, parent_id, project_id):
        folder = await self.folder_tree.create(user_id, name=name, parent_id=parent_id, project_id=project_id)
        if self._relocates:
            dir_key = await self._dir_key(user_id, folder)
            if dir_key:
                await self.storage.ensure_folder(dir_key)   # P1.2：空夹上盘
        return folder

    async def rename(self, user_id, folder_id, new_name):
        old_dir = None
        if self._relocates:
            cur = await self.folder_tree.get(user_id, folder_id)
            if cur is not None:
                old_dir = await self._dir_key(user_id, cur)   # 改名前的目录（含旧名）
        folder = await self.folder_tree.rename(user_id, folder_id, new_name)   # 改名 + flush
        if self._relocates:
            await relocate_folder_tree_files(self.db, user_id, folder.id)      # 搬子树文件
            await self._reconcile_dirs(user_id, folder, old_dir)               # P1.4：目录对账
        return folder

    async def move(self, user_id, folder_id, new_parent_id):
        old_dir = None
        if self._relocates:
            cur = await self.folder_tree.get(user_id, folder_id)
            if cur is not None:
                old_dir = await self._dir_key(user_id, cur)   # 移动前的目录
        folder = await self.folder_tree.move(user_id, folder_id, new_parent_id)  # 改 parent + flush
        if self._relocates:
            await relocate_folder_tree_files(self.db, user_id, folder.id)
            await self._reconcile_dirs(user_id, folder, old_dir)
        return folder

    async def _reconcile_dirs(self, user_id, folder, old_dir) -> None:
        """改名/移动后对账物理目录：物化新位置整棵子树（空夹也补），清旧位置搬空的骨架。
        非空目录（relocate 若因异常漏搬文件）由 remove_folder 保守跳过，绝不误删数据。"""
        await self._materialize_subtree(user_id, folder.id)
        if old_dir:
            new_dir = await self._dir_key(user_id, folder)
            if new_dir != old_dir:
                await self.storage.remove_folder(old_dir)   # 治 adr 幽灵目录
