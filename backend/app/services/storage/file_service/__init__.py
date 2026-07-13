"""FileService：REST 与 Agent 共用的**唯一文件语义入口**（P0.3，见 docs/refactor/文件存储架构方案.md 附三）。

对外只暴露 `FileService` 门面，内部按职责拆（folders / files），防长成 god file。
`FileService(db)` 构造：持 FolderTree + StorageBackend + KeyStrategy；方法只 flush 不 commit，
由调用方（REST/Agent）协调事务与事件。校验失败抛领域异常（app.core.errors），不抛 HTTPException。

P0.3 落文件夹操作（create/rename/move）+ 文件写操作（create/update/copy）；
P2.2/P2.4 补文件夹软删/恢复（delete_folder/restore_folder）；
P2.6：rename_folder/move_folder 现在必传 client_version（乐观并发，同 Project 的 409 模式）。
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.storage import get_storage
from app.services.storage.folder_tree import SqlAlchemyFolderTree
from app.services.storage.key_strategy import PathMirrorStrategy
from app.services.storage.file_service.folders import FolderOps
from app.services.storage.file_service.files import FileOps


class FileService:
    def __init__(self, db: AsyncSession, *, folder_tree=None, storage=None, key_strategy=None):
        self.db = db
        self.folder_tree = folder_tree or SqlAlchemyFolderTree(db)
        self.storage = storage or get_storage()
        self.key_strategy = key_strategy or PathMirrorStrategy()
        self._folders = FolderOps(self.db, self.folder_tree, self.storage, self.key_strategy)
        self._files = FileOps(self.db, self.folder_tree, self.storage, self.key_strategy)

    # ── 文件夹（薄门面 → _folders）─────────────────────────────────────────────
    async def create_folder(self, user_id, *, name, parent_id, project_id):
        return await self._folders.create(user_id, name=name, parent_id=parent_id, project_id=project_id)

    async def rename_folder(self, user_id, folder_id, new_name, *, client_version):
        return await self._folders.rename(user_id, folder_id, new_name, client_version=client_version)

    async def move_folder(self, user_id, folder_id, new_parent_id, *, client_version):
        return await self._folders.move(user_id, folder_id, new_parent_id, client_version=client_version)

    async def delete_folder(self, user_id, folder_id):
        return await self._folders.delete(user_id, folder_id)

    async def restore_folder(self, user_id, folder_id):
        return await self._folders.restore(user_id, folder_id)

    # ── 文件写操作（薄门面 → _files）───────────────────────────────────────────
    async def create_file(self, user_id, **kw):
        return await self._files.create_file(user_id, **kw)

    async def update_file(self, user_id, fid, **kw):
        return await self._files.update_file(user_id, fid, **kw)

    async def copy_file(self, user_id, fid, **kw):
        return await self._files.copy_file(user_id, fid, **kw)
