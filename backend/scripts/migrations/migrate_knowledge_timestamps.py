"""将用户 Knowledge 文件中的时间戳迁移为 ISO 8601 UTC。"""

from __future__ import annotations

import asyncio

from agent.knowledge.timestamp_migration import migrate_all_knowledge_timestamps


async def _main() -> None:
    users, converted = await migrate_all_knowledge_timestamps()
    print(f"Knowledge 时间迁移完成：用户数={users} 转换文件数={converted}")


if __name__ == "__main__":
    asyncio.run(_main())
