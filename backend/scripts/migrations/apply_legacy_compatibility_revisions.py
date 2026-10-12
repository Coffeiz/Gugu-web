"""为无 Alembic 版本表的既有 schema 补齐显式允许的幂等数据库对象。"""

import asyncio

from alembic.config import Config
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import get_settings
from app.db.alembic_bootstrap import apply_legacy_compatibility_revisions


async def main() -> None:
    engine = create_async_engine(get_settings().db.url)
    try:
        async with engine.connect() as connection:
            config = Config("alembic.ini")
            await connection.run_sync(
                lambda sync_connection: apply_legacy_compatibility_revisions(sync_connection, config)
            )
            await connection.commit()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
