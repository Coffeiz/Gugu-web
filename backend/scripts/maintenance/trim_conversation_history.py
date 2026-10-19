"""按共享保留策略分批清理超限的历史会话。

预览：PYTHONPATH=. .venv/bin/python -m scripts.maintenance.trim_conversation_history
执行：PYTHONPATH=. .venv/bin/python -m scripts.maintenance.trim_conversation_history --apply
"""
from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import func, select

from app.services.conversation_retention import (
    MESSAGE_RETENTION_LIMIT,
    trim_session_messages,
)


async def _scan_over_limit(db, *, after_session_id: int, page_size: int):
    from app.models import ConversationMessage

    return (await db.execute(
        select(
            ConversationMessage.session_id,
            func.count().label("message_count"),
        )
        .where(ConversationMessage.session_id > after_session_id)
        .group_by(ConversationMessage.session_id)
        .having(func.count() > MESSAGE_RETENTION_LIMIT)
        .order_by(ConversationMessage.session_id)
        .limit(page_size)
    )).all()


async def _run(*, apply: bool, page_size: int, pause_ms: int) -> dict[str, int]:
    import app.db.session as db_session
    from app.models import ConversationMessage

    db_session.ensure_engine()
    try:
        async with db_session._SessionLocal() as db:
            counts = (
                select(
                    ConversationMessage.session_id,
                    func.count().label("message_count"),
                )
                .group_by(ConversationMessage.session_id)
                .subquery()
            )
            over_limit = counts.c.message_count > MESSAGE_RETENTION_LIMIT
            summary = (await db.execute(
                select(
                    func.count().filter(over_limit),
                    func.coalesce(
                        func.sum(counts.c.message_count - MESSAGE_RETENTION_LIMIT)
                        .filter(over_limit),
                        0,
                    ),
                )
            )).one()
            estimated_sessions, estimated_messages = map(int, summary)
        if not apply:
            return {
                "over_limit_sessions": estimated_sessions,
                "estimated_messages_to_remove": estimated_messages,
                "processed_sessions": 0,
                "removed_messages": 0,
                "still_over_limit_sessions": estimated_sessions,
            }

        processed = removed = still_over_limit = 0
        cursor = 0
        while True:
            async with db_session._SessionLocal() as db:
                rows = await _scan_over_limit(
                    db, after_session_id=cursor, page_size=page_size,
                )
            if not rows:
                break

            for session_id, before_count in rows:
                await trim_session_messages(int(session_id))
                async with db_session._SessionLocal() as db:
                    after_count = int((await db.execute(
                        select(func.count()).select_from(ConversationMessage)
                        .where(ConversationMessage.session_id == session_id)
                    )).scalar_one())
                processed += 1
                removed += max(0, int(before_count) - after_count)
                still_over_limit += int(after_count > MESSAGE_RETENTION_LIMIT)
                if pause_ms:
                    await asyncio.sleep(pause_ms / 1000)
            cursor = int(rows[-1].session_id)

        return {
            "over_limit_sessions": estimated_sessions,
            "estimated_messages_to_remove": estimated_messages,
            "processed_sessions": processed,
            "removed_messages": removed,
            "still_over_limit_sessions": still_over_limit,
        }
    finally:
        await db_session.dispose_engine()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true",
        help="实际删除超出最近 2000 条的旧消息，并按现有逻辑清理附件引用",
    )
    parser.add_argument("--page-size", type=int, default=50, help="每页处理的 session 数")
    parser.add_argument("--pause-ms", type=int, default=25, help="每个 session 后暂停毫秒数")
    args = parser.parse_args()
    if args.page_size < 1 or args.pause_ms < 0:
        parser.error("page-size 必须大于 0，pause-ms 不能小于 0")

    result = asyncio.run(_run(
        apply=args.apply,
        page_size=args.page_size,
        pause_ms=args.pause_ms,
    ))
    if not args.apply:
        print(
            "预览完成：超限会话 {over_limit_sessions} 个，预计删除旧消息 "
            "{estimated_messages_to_remove} 条。确认执行请添加 --apply。".format(**result)
        )
        return
    print(
        "清理完成：处理会话 {processed_sessions} 个，删除消息 {removed_messages} 条，"
        "仍超限 {still_over_limit_sessions} 个。".format(**result)
    )


if __name__ == "__main__":
    main()
