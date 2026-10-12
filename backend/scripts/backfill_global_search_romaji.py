"""可续跑地回填文件和文件夹拼音搜索别名。

从 backend 目录运行：python scripts/backfill_global_search_romaji.py --batch-size 500
重复运行安全；只更新 search_romaji 仍为 NULL 的记录，每批独立提交。
"""

import argparse
import asyncio

from sqlalchemy import bindparam, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.models import File, Folder
from app.search.romaji_index import build_romaji_search_text


async def _backfill_model(session, model, name_columns, batch_size: int) -> int:
    last_id = 0
    processed = 0
    update_stmt = (
        update(model.__table__)
        .where(model.id == bindparam("row_id"), model.search_romaji.is_(None))
        .values(search_romaji=bindparam("alias_value"))
    )

    while True:
        rows = (await session.execute(
            select(model.id, *name_columns)
            .where(model.id > last_id, model.search_romaji.is_(None))
            .order_by(model.id)
            .limit(batch_size)
        )).all()
        if not rows:
            break

        params = []
        for row in rows:
            last_id = row[0]
            params.append({
                "row_id": row[0],
                "alias_value": build_romaji_search_text(*row[1:]),
            })
        await session.execute(update_stmt, params)
        await session.commit()
        processed += len(params)
        if processed % 5000 < batch_size:
            print(f"{model.__tablename__}: 已处理 {processed} 条")

    return processed


async def _run(batch_size: int) -> None:
    engine = create_async_engine(get_settings().db.url, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as session:
            completed_at = await session.scalar(text(
                "SELECT completed_at FROM global_search_backfill_state "
                "WHERE name = 'file_folder_romaji_v1'"
            ))
            if completed_at is not None:
                print("拼音别名回填已完成，跳过")
                return
            files = await _backfill_model(
                session, File, (File.display_name, File.ext), batch_size,
            )
            folders = await _backfill_model(
                session, Folder, (Folder.name,), batch_size,
            )
            await session.execute(text("""
                INSERT INTO global_search_backfill_state (name, completed_at)
                VALUES ('file_folder_romaji_v1', now())
                ON CONFLICT (name) DO UPDATE SET completed_at = EXCLUDED.completed_at
            """))
            await session.commit()
        print(f"回填完成：文件 {files} 条，文件夹 {folders} 条")
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="分批回填全局搜索的拼音/罗马音别名")
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()
    if args.batch_size < 1 or args.batch_size > 5000:
        parser.error("--batch-size 必须在 1 到 5000 之间")
    asyncio.run(_run(args.batch_size))


if __name__ == "__main__":
    main()
