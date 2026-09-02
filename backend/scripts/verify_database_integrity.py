"""部署后数据库完整性检查；只读，不修改数据。"""
from __future__ import annotations

import asyncio

from sqlalchemy import text

import app.db.session as db_session


REQUIRED_TABLES = ("users", "conversation_sessions", "user_smtp_configs")


async def main() -> None:
    db_session._build_engine()
    async with db_session._engine.connect() as conn:
        missing = []
        for table in REQUIRED_TABLES:
            exists = await conn.scalar(
                text("SELECT to_regclass(:table_name) IS NOT NULL"),
                {"table_name": table},
            )
            if not exists:
                missing.append(table)
        if missing:
            raise SystemExit(f"数据库缺少关键表：{', '.join(missing)}")

        version = await conn.scalar(text("SELECT version_num FROM alembic_version"))
        user_count = await conn.scalar(text("SELECT count(*) FROM users"))
        smtp_count = await conn.scalar(text("SELECT count(*) FROM user_smtp_configs"))

    print(f"[db-check] alembic={version} users={user_count} user_smtp_configs={smtp_count}")


if __name__ == "__main__":
    asyncio.run(main())
