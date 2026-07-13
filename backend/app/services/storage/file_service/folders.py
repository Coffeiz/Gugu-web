"""FileService 内部：文件夹操作（P0.3）。协调 FolderTree（元数据）+ 物理归位。

改名/移动的**物理文件搬迁**（path-mirror 下 key 内嵌路径，改名/移动要重搬子树文件）经
`relocate_folder_tree_files`；opaque（move_semantics='db-only'）则跳过——**由 key 策略自决**。
物理 mkdir（空文件夹上盘）在 P1 加（storage.ensure_folder）；事件广播在 REST 层（P0.5）。
"""
from __future__ import annotations

from app.services.storage.folders import relocate_folder_tree_files


class FolderOps:
    def __init__(self, db, folder_tree, storage, key_strategy):
        self.db = db
        self.folder_tree = folder_tree
        self.storage = storage
        self.key_strategy = key_strategy

    async def create(self, user_id, *, name, parent_id, project_id):
        # 物理 mkdir 在 P1 加（现在与旧行为一致：只建 DB 行）
        return await self.folder_tree.create(user_id, name=name, parent_id=parent_id, project_id=project_id)

    async def rename(self, user_id, folder_id, new_name):
        folder = await self.folder_tree.rename(user_id, folder_id, new_name)   # 改名 + flush
        if self.key_strategy.move_semantics == "relocate":
            await relocate_folder_tree_files(self.db, user_id, folder.id)      # 物理重搬子树文件
        return folder

    async def move(self, user_id, folder_id, new_parent_id):
        folder = await self.folder_tree.move(user_id, folder_id, new_parent_id)  # 改 parent + flush
        if self.key_strategy.move_semantics == "relocate":
            await relocate_folder_tree_files(self.db, user_id, folder.id)
        return folder
