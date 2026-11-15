"""QQ 创建隔离元数据、实际 ORM 与 gateway 消费对照，不启动网关或外部连接。"""
import asyncio
import hashlib
import json
import logging
import os
import sys
from datetime import timedelta
from uuid import UUID, uuid4
logging.getLogger("gugu.diag").addHandler(logging.NullHandler())
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.db.base import Base
from app.db import session as database
from app.models import User, UserBot, ConversationSession
from app.api.v1.user_bots import _out, create_my_bot, BotIn
from agent.gateway.gateway import _fetch_userbots
from app.core.tz import now_utc


async def main():
    engine = create_async_engine(os.environ["GUGU_WEBUI_TEST_DATABASE_URL"].replace("postgresql://", "postgresql+asyncpg://"),
        connect_args={"server_settings": {"search_path": os.environ["TEST_SCHEMA"]}})
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner, other = UUID(os.environ["TEST_OWNER"]), UUID(os.environ["TEST_OTHER"])
    try:
        if sys.argv[1] == "setup":
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with factory() as db:
                db.add_all([User(id=owner, username="小北", email="synthetic-owner@example.invalid", hashed_password="synthetic"),
                            User(id=other, username="小月", email="synthetic-other@example.invalid", hashed_password="synthetic")])
                await db.flush()
                for index, source in enumerate(["web", "qq", "feishu", "telegram", "wechat"]):
                    db.add(ConversationSession(id=index + 1, user_id=owner, source=source, context_epoch=4,
                        snapshot_hash="synthetic-snapshot", session_info_hash="synthetic-session", snapshot_expires_at=now_utc() + timedelta(days=1)))
                db.add(ConversationSession(id=9, user_id=other, source="qq", context_epoch=4,
                    snapshot_hash="synthetic-snapshot", session_info_hash="synthetic-session", snapshot_expires_at=now_utc() + timedelta(days=1)))
                await db.commit()
            print("{}")
            return
        database.ensure_engine = lambda: None
        database._SessionLocal = factory
        if sys.argv[1] == "reference":
            from app.core import events
            from agent.context.session_snapshot import invalidate_user_im_snapshots
            from sqlalchemy import select
            reference_owner = uuid4()
            calls = []
            async with factory() as db:
                user = User(id=reference_owner, username="小星", email=f"{reference_owner}@example.invalid", hashed_password="synthetic")
                db.add(user)
                await db.flush()
                for index, source in enumerate(["web", "qq", "feishu", "telegram", "wechat"]):
                    db.add(ConversationSession(id=101 + index, user_id=reference_owner, source=source, context_epoch=4,
                        snapshot_hash="synthetic-snapshot", session_info_hash="synthetic-session", snapshot_expires_at=now_utc() + timedelta(days=1)))
                await db.commit()
                async def publish(who, *resources, **kwargs):
                    assert who == reference_owner and resources == ("im_channels",) and kwargs == {"operation": "refresh"}
                    await invalidate_user_im_snapshots(who)
                    calls.append(True)
                events.publish = publish
                response = await create_my_bot(BotIn.model_validate(json.loads(os.environ["TEST_INPUT"])), user, db)
                rows = (await db.execute(select(ConversationSession).where(ConversationSession.user_id == reference_owner).order_by(ConversationSession.source))).scalars().all()
                snapshots = [{"source": row.source, "context_epoch": row.context_epoch, "snapshot_hash": row.snapshot_hash,
                    "session_info_hash": row.session_info_hash, "expired": row.snapshot_expires_at < now_utc()} for row in rows]
                print(json.dumps({"response": response, "snapshots": snapshots, "publications": len(calls)}))
            return
        async with factory() as db:
            bot = await db.get(UserBot, int(os.environ["TEST_BOT"]))
            response = _out(bot)
        specs = await _fetch_userbots()
        selected = next(item for item in specs if item["id"] == os.environ["TEST_BOT"])
        print(json.dumps({"response": response, "gateway_secret_sha": hashlib.sha256(selected["app_secret"].encode()).hexdigest(),
            "expected_secret_sha": hashlib.sha256(b"synthetic-qq-secret").hexdigest(),
            "gateway_app_id": selected["app_id"], "gateway_owner": selected["owner"]}))
    finally:
        await engine.dispose()


asyncio.run(main())
