"""显式数据后端配置与连接工厂，不读取环境变量或宿主配置文件。"""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
import re

from sqlalchemy import URL, event
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine


@dataclass(frozen=True)
class DataRuntimeConfig:
    url: URL = field(repr=False)
    backend: Literal["sqlite", "postgres"]
    echo: bool = False
    pool_size: int = 15
    max_overflow: int = 25
    pool_timeout: int = 10
    pool_recycle: int = 1800
    schema: str | None = None

    def __post_init__(self):
        drivers = {"sqlite": "sqlite+aiosqlite", "postgres": "postgresql+asyncpg"}
        if self.backend not in drivers or self.url.drivername != drivers[self.backend]:
            raise ValueError("数据后端与驱动不匹配")
        if self.pool_size < 1 or self.max_overflow < 0 or self.pool_timeout < 1 or self.pool_recycle < 1:
            raise ValueError("连接池参数无效")
        if self.schema is not None and not re.fullmatch(r"[a-z][a-z0-9_]*", self.schema):
            raise ValueError("数据库 schema 名称无效")

    @classmethod
    def sqlite(cls, path: Path) -> "DataRuntimeConfig":
        return cls(URL.create(
            "sqlite+aiosqlite", database=Path(path).resolve().as_uri(), query={"mode": "rw", "uri": "true"},
        ), "sqlite")

    @classmethod
    def postgres(cls, url: str | URL, **options) -> "DataRuntimeConfig":
        try:
            parsed = make_url(url)
        except Exception:
            raise ValueError("PostgreSQL 连接格式无效") from None
        return cls(parsed, "postgres", **options)


def create_runtime_engine(config: DataRuntimeConfig) -> AsyncEngine:
    if config.backend == "postgres":
        server_settings = {"idle_in_transaction_session_timeout": "60000"}
        if config.schema is not None:
            server_settings["search_path"] = config.schema
        return create_async_engine(
            config.url, echo=config.echo,
            connect_args={"server_settings": server_settings}, pool_pre_ping=True,
            pool_size=config.pool_size, max_overflow=config.max_overflow,
            pool_timeout=config.pool_timeout, pool_recycle=config.pool_recycle,
        )
    engine = create_async_engine(config.url, echo=config.echo, connect_args={"timeout": 5})

    @event.listens_for(engine.sync_engine, "connect")
    def configure_connection(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()

    return engine


def create_session_factory(engine: AsyncEngine):
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
