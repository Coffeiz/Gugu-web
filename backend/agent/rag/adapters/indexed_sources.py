"""文件、画布、笔记和对话的统一业务来源桥接。

统一查询主链下，本模块只提供来源容器的 DB 会话托管；文档转换、检索和
conversation 水位过滤全部由 TS Worker 完成（``unified_query`` 的
``before_message_id`` 参数）。
"""
from __future__ import annotations

from contextlib import asynccontextmanager


class IndexedSourceRetriever:
    """把文件、画布、笔记、Knowledge 和对话来源接入统一查询链。"""

    def __init__(self, user_id: object, *, db=None, db_factory=None, source_type: str):
        if source_type not in {"file", "canvas", "note", "conversation", "knowledge"}:
            raise ValueError(f"不支持的统一来源：{source_type}")
        self.user_id = user_id
        self.db = db
        self.db_factory = db_factory
        self.source_type = source_type

    @asynccontextmanager
    async def session_scope(self):
        """每个来源检索使用独立 AsyncSession，避免 gather 共享连接。"""
        if self.db_factory is not None:
            async with self.db_factory() as db:
                yield db
            return
        if self.db is not None:
            yield self.db
            return
        import app.db.session as db_session

        db_session.ensure_engine()
        async with db_session._SessionLocal() as db:
            yield db


__all__ = ["IndexedSourceRetriever"]
