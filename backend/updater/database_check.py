"""只读校验运行中一体化应用的 Alembic 状态是否与其迁移头一致。"""

from __future__ import annotations

import asyncio

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text

import app.db.session as db_session


def validate_revision_state(current: list[str], heads: list[str]) -> None:
    if len(heads) != 1 or current != heads:
        raise RuntimeError("数据库迁移版本不是当前应用的唯一 head")


async def verify_database_revision() -> None:
    config = Config("alembic.ini")
    heads = ScriptDirectory.from_config(config).get_heads()
    db_session._build_engine()
    async with db_session._engine.connect() as connection:
        has_version_table = await connection.scalar(text("SELECT to_regclass('alembic_version') IS NOT NULL"))
        if not has_version_table:
            raise RuntimeError("数据库尚未建立 Alembic 版本表")
        result = await connection.execute(text("SELECT version_num FROM alembic_version ORDER BY version_num"))
        current = list(result.scalars())
    await db_session._engine.dispose()
    validate_revision_state(current, heads)


def main() -> None:
    asyncio.run(verify_database_revision())
    print("database revision matches the current application head")


if __name__ == "__main__":
    main()
