"""Node/API dry-run 集成测试的真实 Python 数据与 runner 桥接。"""
import asyncio
import hashlib
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import UUID
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
# 导入生产模块前预置诊断handler，禁止测试创建或写入工作区运行日志。
logging.getLogger("gugu.diag").addHandler(logging.NullHandler())
from app.db.base import Base
from app.db import session as database
from app.models import User, File, Folder, FileSyncBinding, FileSyncReconcileRun, FileSyncJournal, FileSyncOutbox, FileSyncConflict
from app.services.filesync.jobs import claim_next_run, _EMPTY_RESULT_COUNTS
from app.services.filesync.reconcile import _root_fingerprint
from app.services.filesync.runner import _run_claimed
from app.core import redis as redis_module


async def main():
    engine = create_async_engine(os.environ["GUGU_WEBUI_TEST_DATABASE_URL"].replace("postgresql://", "postgresql+asyncpg://"),
        connect_args={"server_settings": {"search_path": os.environ["TEST_SCHEMA"]}})
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner = UUID(os.environ["TEST_OWNER"])
    storage = Path(os.environ["TEST_STORAGE"])
    root = storage / str(owner)
    diagnostic = logging.getLogger("gugu.diag")
    for handler in diagnostic.handlers[:]:
        diagnostic.removeHandler(handler)
        handler.close()
    diagnostic.addHandler(logging.FileHandler(storage.parent / "diagnostic.log"))
    client = None
    try:
        if sys.argv[1] == "setup":
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            (root / "个人文件").mkdir(parents=True)
            (root / "个人文件" / "合成预检.txt").write_bytes(b"synthetic-preview")
            async with factory() as db:
                db.add(User(id=owner, username="合成预检用户", email="synthetic-preview@example.invalid", hashed_password="synthetic-not-a-password"))
                await db.flush()
                db.add(FileSyncBinding(id=1, user_id=owner, source="local_directory", mode="bidirectional", status="active", root_path=".", root_fingerprint=_root_fingerprint(root), revision=3, gap_revision=7))
                await db.commit()
            print(json.dumps({"counts": _EMPTY_RESULT_COUNTS, "fingerprint": _root_fingerprint(root)}))
            return
        import redis.asyncio as redis
        client = redis.from_url(os.environ["GUGU_WEBUI_TEST_REDIS_URL"], decode_responses=True)
        redis_module._client = client
        database._engine = engine
        database._SessionLocal = factory
        database._engine_loop = asyncio.get_running_loop()
        database.ensure_engine = lambda: None
        before = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()}
        async with factory() as db:
            claimed = await claim_next_run(db, "synthetic-dry-run", concurrency=1)
            assert claimed is not None and str(claimed.id) == os.environ["TEST_RUN"]
        with ThreadPoolExecutor(max_workers=1) as executor:
            await asyncio.wait_for(_run_claimed(factory, executor, claimed, "synthetic-dry-run", asyncio.Event()), timeout=20)
        after = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()}
        async with factory() as db:
            row = await db.get(FileSyncReconcileRun, claimed.id)
            counts = {}
            for model in [File, Folder, FileSyncJournal, FileSyncOutbox, FileSyncConflict]:
                counts[model.__tablename__] = int(await db.scalar(select(func.count()).select_from(model)))
            print(json.dumps({"status": row.status, "error_code": row.error_code, "counts": row.result_counts, "business": counts, "files_unchanged": before == after, "allow_delete": row.allow_delete}))
    finally:
        if client is not None:
            await client.aclose()
        await engine.dispose()


asyncio.run(main())
