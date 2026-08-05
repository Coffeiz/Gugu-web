from logging.config import fileConfig
import asyncio
import os
import sys

from alembic import context
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, pool, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

# Alembic Config 对象
config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 导入所有模型，让 Base.metadata 知道所有表
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.db.base import Base
import app.models  # noqa
import onboarding.models  # noqa  # 独立子系统的表也纳入 metadata
from app.core.config import get_settings

settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.db.url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True,
                      dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def _bootstrap_empty_database(connection: Connection) -> bool:
    """让真正空库可以直接执行 ``alembic upgrade head``。

    应用历史上由 ``create_all`` 初始化基础表，旧首条 revision 因而默认旧表
    已存在。空库走当前模型建表并记录 head；已有任何业务表的数据库仍走正常
    revision 链，避免把生产结构误判成空库。
    """
    tables = set(inspect(connection).get_table_names())
    version_table = context.config.get_main_option("version_table") or "alembic_version"
    if tables - {version_table}:
        # inspect() 会开启一个隐式事务；交给 Alembic 前先结束它，避免
        # context.begin_transaction() 被误判为嵌套事务。
        connection.commit()
        return False

    Base.metadata.create_all(connection)
    script = ScriptDirectory.from_config(config)
    head = script.get_current_head()
    connection.execute(text(
        "CREATE TABLE IF NOT EXISTS alembic_version "
        "(version_num VARCHAR(32) NOT NULL)"
    ))
    connection.execute(text("DELETE FROM alembic_version"))
    connection.execute(
        text("INSERT INTO alembic_version (version_num) VALUES (:version_num)"),
        {"version_num": head},
    )
    connection.commit()
    return True


def do_run_migrations(connection: Connection) -> None:
    if _bootstrap_empty_database(connection):
        return
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
