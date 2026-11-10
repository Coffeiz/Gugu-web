"""显式生命周期的单用户 SQLite 宿主；不加载 Web 配置、Redis 或文件工具。"""
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator
from uuid import UUID, uuid4

from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import AsyncEngine

from gugu_core.application.context import DataContext
from gugu_core.application.data import DataServices
from gugu_core.application.projects import ProjectService
from gugu_core.data.config import DataRuntimeConfig, create_runtime_engine, create_session_factory
from gugu_core.data.models import LocalBase, LocalClient, LocalProject, RuntimeMetadata
from gugu_core.data.unit_of_work import SqlDataRuntime

SCHEMA_VERSION = "2"


class RuntimeSchemaError(ValueError):
    """宿主必须处理不兼容 schema，Core 不静默迁移或重建数据。"""


def _engine(path: Path) -> AsyncEngine:
    return create_runtime_engine(DataRuntimeConfig.sqlite(path))

class LocalRuntime:
    def __init__(self, engine: AsyncEngine, owner_id: UUID):
        self.engine = engine
        self.owner_id = owner_id
        self.data = SqlDataRuntime(engine)
        self.sessions = self.data.sessions

    @classmethod
    async def initialize(cls, path: Path) -> "LocalRuntime":
        """只初始化全新文件；已存在文件必须显式 open，不覆盖或补建表。"""
        path = Path(path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb"):
            pass
        engine = _engine(path)
        try:
            async with engine.connect() as connection:
                mode = (await connection.exec_driver_sql("PRAGMA journal_mode=WAL")).scalar_one()
                if mode != "wal":
                    raise RuntimeSchemaError("本地数据库无法启用 WAL")
                await connection.commit()
            async with engine.begin() as connection:
                await connection.run_sync(LocalBase.metadata.create_all)
            owner_id = uuid4()
            sessions = create_session_factory(engine)
            async with sessions.begin() as session:
                session.add_all([
                    RuntimeMetadata(key="schema_version", value=SCHEMA_VERSION),
                    RuntimeMetadata(key="owner_id", value=str(owner_id)),
                ])
            return cls(engine, owner_id)
        except BaseException:
            await engine.dispose()
            raise

    @classmethod
    async def open(cls, path: Path) -> "LocalRuntime":
        """验证已有库的版本与本地身份，不执行 create_all 或自动升级。"""
        path = Path(path).resolve(strict=True)
        engine = _engine(path)
        try:
            async with engine.connect() as connection:
                tables = await connection.run_sync(lambda sync: inspect(sync).get_table_names())
                if "core_runtime_meta" not in tables or "projects" not in tables:
                    raise RuntimeSchemaError("此文件不是已初始化的 Core 数据库")
                rows = (await connection.execute(select(RuntimeMetadata.key, RuntimeMetadata.value))).all()
                metadata = dict(rows)
                if metadata.get("schema_version") != SCHEMA_VERSION:
                    raise RuntimeSchemaError("本地数据库版本不兼容，请由宿主执行显式迁移")
                columns = await connection.run_sync(lambda sync: inspect(sync).get_columns("projects"))
                if {column["name"] for column in columns} != set(LocalProject.__table__.columns.keys()):
                    raise RuntimeSchemaError("本地项目表结构不兼容，请检查数据库完整性")
                if "clients" not in tables:
                    raise RuntimeSchemaError("本地联系人表缺失，请检查数据库完整性")
                client_columns = await connection.run_sync(lambda sync: inspect(sync).get_columns("clients"))
                if {column["name"] for column in client_columns} != set(LocalClient.__table__.columns.keys()):
                    raise RuntimeSchemaError("本地联系人表结构不兼容，请检查数据库完整性")
                try:
                    owner_id = UUID(metadata["owner_id"])
                except (KeyError, ValueError) as exc:
                    raise RuntimeSchemaError("本地数据库身份缺失或损坏") from exc
            return cls(engine, owner_id)
        except BaseException:
            await engine.dispose()
            raise

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[ProjectService]:
        """成功提交、异常回滚；一次事务内可编排多个项目操作。"""
        async with self.unit_of_work() as data:
            yield data.projects

    @asynccontextmanager
    async def unit_of_work(self) -> AsyncIterator[DataServices]:
        """多个数据域共用一个所有者上下文和一次提交。"""
        async with self.data.transaction(DataContext(self.owner_id)) as services:
            yield services

    @staticmethod
    async def migrate(path: Path) -> Path:
        """由宿主显式调用；升级前生成一致性备份。"""
        import asyncio
        from gugu_core.data.migrations import migrate_local_database
        return await asyncio.to_thread(migrate_local_database, path)

    async def close(self) -> None:
        await self.data.close()
