"""存储层装配（P0.4）：一处构造 KeyStrategy / FolderTree / FileService。

默认装配 `Local + PathMirror`；OSS backend 已单独抽出但不改变默认路径。OSS 正式接入时，
再由这里按配置切换 `get_key_strategy` 与 `get_storage`——业务层不改。
`get_storage()` 保持在 app.services.storage.__init__，本模块不重复。
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.storage.file_service import FileService
from app.services.storage.folder_tree import SqlAlchemyFolderTree
from app.services.storage.key_strategy import KeyStrategy, PathMirrorStrategy


def get_key_strategy() -> KeyStrategy:
    return PathMirrorStrategy()


def get_folder_tree(db: AsyncSession) -> SqlAlchemyFolderTree:
    return SqlAlchemyFolderTree(db)


def get_file_service(db: AsyncSession) -> FileService:
    return FileService(db)
