"""存储层装配（P0.4）：一处构造 KeyStrategy / FolderTree / FileService。

现在只装 `Local + PathMirror` 一条（YAGNI）。OSS 到来时 `get_key_strategy` 按配置返
`OpaqueStrategy`、`get_storage`（在 __init__）返 OSS backend——业务层只认工厂，不改。
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
