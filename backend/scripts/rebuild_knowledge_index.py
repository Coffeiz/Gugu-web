"""重建一个用户的统一知识索引。

用法：
    PYTHONPATH=. .venv/bin/python scripts/rebuild_knowledge_index.py --user-id <UUID>
"""
from __future__ import annotations

import argparse
import asyncio
from uuid import UUID

from agent.rag.index_builder import INDEX_SOURCE_TYPES, rebuild_knowledge_index
from app.db.session import get_db


async def _run(user_id: UUID, sources: tuple[str, ...]) -> None:
    async for db in get_db():
        counts = await rebuild_knowledge_index(db, user_id, sources)
        print({"sources": counts, "total_chunks": sum(counts.values())})
        return


def main() -> None:
    parser = argparse.ArgumentParser(description="重建 Gugu 统一知识索引")
    parser.add_argument("--user-id", required=True, type=UUID)
    parser.add_argument("--source", action="append", choices=INDEX_SOURCE_TYPES)
    args = parser.parse_args()
    asyncio.run(_run(args.user_id, tuple(args.source or INDEX_SOURCE_TYPES)))


if __name__ == "__main__":
    main()
