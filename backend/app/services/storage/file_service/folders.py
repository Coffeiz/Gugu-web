"""FileService 内部：文件夹操作（P0.3 + P1 + P2）。协调 FolderTree（元数据）+ 物理目录一致性。

P0.3：改名/移动的**物理文件搬迁**（path-mirror 下 key 内嵌路径）经 `relocate_folder_tree_files`；
opaque（move_semantics='db-only'）则跳过——由 key 策略自决。
P1：物理**目录骨架**也要一致（治 today 的 123 空夹缺失 / adr 幽灵目录）：
- 建夹 → `storage.ensure_folder` 物化目录（空夹也上盘）；
- 改名/移动 → 搬文件后再对账目录：物化新位置整棵子树（含无文件的空夹）+ 清旧位置搬空的骨架。
物理动作走 backend 钩子（Local 真 mkdir/mv/rm、对象存储 no-op），**不写 if local**。

P2.2/P2.4：软删/恢复。`FolderTree.soft_delete/restore` 只管 DB（Folder.deleted_at 批量打
同一时间戳）；本层协调「子树里当时存活的文件」同批软删 + 搬物理 trash（复用
`app.services.storage.trash`，与单文件删除同一套物理落点），以及目录骨架清理/补回——
与 P1 的 rename/move 走同一物理钩子（remove_folder/ensure_folder），不重造一套。
"""
from __future__ import annotations

from sqlalchemy import select

from app.models import File, Folder
from app.services.storage.folders import folder_dir_key, relocate_folder_tree_files
from app.services.storage.trash import move_file_to_trash, restore_file_storage


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
        return await folder_dir_key(self.db, user_id, folder)

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

    async def rename(self, user_id, folder_id, new_name, *, client_version):
        old_dir = None
        if self._relocates:
            cur = await self.folder_tree.get(user_id, folder_id)
            if cur is not None:
                old_dir = await self._dir_key(user_id, cur)   # 改名前的目录（含旧名）
        folder = await self.folder_tree.rename(user_id, folder_id, new_name,
                                               client_version=client_version)   # 改名 + flush
        if self._relocates:
            await relocate_folder_tree_files(self.db, user_id, folder.id)      # 搬子树文件
            await self._reconcile_dirs(user_id, folder, old_dir)               # P1.4：目录对账
        return folder

    async def move(self, user_id, folder_id, new_parent_id, *, client_version):
        old_dir = None
        if self._relocates:
            cur = await self.folder_tree.get(user_id, folder_id)
            if cur is not None:
                old_dir = await self._dir_key(user_id, cur)   # 移动前的目录
        folder = await self.folder_tree.move(user_id, folder_id, new_parent_id,
                                             client_version=client_version)  # 改 parent + flush
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

    # ── 软删 / 恢复（P2.2/P2.4）──────────────────────────────────────────────────
    async def delete(self, user_id, folder_id):
        """软删 folder 及其存活子树：DB 层面（FolderTree.soft_delete）+ 当时存活的文件同批
        软删并搬物理 trash（与单文件删除同一落点，与 KeyStrategy 无关——同现有单文件删除）；
        目录骨架清理（非空保守跳过）只在 path-mirror 下做（同 create/rename/move 的 `_relocates`
        门控——opaque 无「目录」概念）。"""
        folder, ids = await self.folder_tree.soft_delete(user_id, folder_id)
        stamp = folder.deleted_at

        dir_keys: list[str] = []
        if self._relocates:
            # 目录骨架清理要在文件搬空之后；先取每个受影响文件夹当前的物理 key（deleted_at 已
            # 置位不影响 folder_dir_key 的路径解析——它只关心归属链，不关心软删状态）。
            rows = (await self.db.execute(select(Folder).where(Folder.id.in_(ids)))).scalars().all()
            for f in rows:
                dk = await self._dir_key(user_id, f)
                if dk:
                    dir_keys.append(dk)

        files = (await self.db.execute(
            select(File).where(File.folder_id.in_(ids), File.deleted_at.is_(None))
        )).scalars().all()
        for f in files:
            await move_file_to_trash(self.storage, f)
            f.deleted_at = stamp
        await self.db.flush()

        for dk in dir_keys:
            await self.storage.remove_folder(dk)   # 空了才真删；非空（残留孤儿文件等）保守跳过
        return folder

    async def restore(self, user_id, folder_id):
        """恢复此前整体软删的子树：DB 层面（FolderTree.restore）+ 物化目录骨架（仅 path-mirror）
        + 同批文件物理搬回原位（冲突自动加后缀，复用单文件还原的同一套逻辑，与 KeyStrategy 无关）。"""
        folder, ids, stamp = await self.folder_tree.restore(user_id, folder_id)
        if self._relocates:
            await self._materialize_subtree(user_id, folder.id)   # 补回目录骨架（含空夹）

        files = (await self.db.execute(
            select(File).where(File.folder_id.in_(ids), File.deleted_at == stamp)
        )).scalars().all()
        for f in files:
            await restore_file_storage(f, self.storage, self.db)
            f.deleted_at = None
        await self.db.flush()
        return folder
