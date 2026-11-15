"""隔离 PG/Redis/临时存储的真实反思生产者与最近案例 handler 对照。"""
import asyncio
import json
import logging
import os
from pathlib import Path
from types import SimpleNamespace

logging.getLogger("gugu.diag").addHandler(logging.NullHandler())
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
import redis.asyncio as redis
from app.core import redis as redis_module
from app.api.v1 import agent_perception
from app.services.storage import LocalStorageBackend
from agent.memory import reflection, store


async def main():
    client = redis.from_url(os.environ["TEST_REDIS_URL"], decode_responses=True)
    engine = create_async_engine(os.environ["GUGU_WEBUI_TEST_DATABASE_URL"].replace("postgresql://", "postgresql+asyncpg://"),
                                 connect_args={"server_settings": {"search_path": os.environ["TEST_SCHEMA"]}})
    try:
        redis_module._client = client
        store.get_storage = lambda: LocalStorageBackend(Path(os.environ["TEST_STORAGE"]))
        lease = "gugu:test:recent-misread-owner"
        if os.environ["TEST_ACTION"] == "cleanup":
            if await client.get(lease) == os.environ["TEST_SCHEMA"]:
                await client.delete("perc:events", "perc:misread_cases", lease)
            return
        if os.environ["TEST_ACTION"] in {"corrupt", "corrupt-export"}:
            assert await client.get(lease) == os.environ["TEST_SCHEMA"]
            key = "perc:events" if os.environ["TEST_ACTION"] == "corrupt-export" else "perc:misread_cases"
            await client.set(key, "synthetic-wrongtype-value")
            return
        if await client.exists("perc:events", "perc:misread_cases"):
            raise RuntimeError("隔离遥测键已被占用，拒绝覆盖")
        if not await client.set(lease, os.environ["TEST_SCHEMA"], nx=True, ex=120):
            raise RuntimeError("隔离遥测测试已在运行")
        for owner, pattern in [(os.environ["TEST_OWNER"], "情绪当任务"), (os.environ["TEST_DEVELOPER"], "潜台词漏读")]:
            await reflection._emit_perc(reflection._perc_rec(owner, {"intent": "查询", "ambiguity": 20.25,
                "emo_strength": 1, "emotion": "无"}, SimpleNamespace(model="synthetic-model", provider="synthetic-provider", is_byok=False)))
            await reflection._emit_perc(reflection._fb_rec(owner, "确认夸赞"))
            record = reflection._misperc_llm(owner, {"is_correction": True, "kind": "感知误读", "miss": {
                "read_as": "执行", "actual": "synthetic-private-input", "pattern": pattern}})
            assert record is not None and record["miss"]["actual"] == "其他"
            await reflection._emit_perc(record)
        async with async_sessionmaker(engine)() as db:
            plain = await agent_perception.misread_recent(n=30, exclude_dev=False, db=db)
            filtered = await agent_perception.misread_recent(n=30, exclude_dev=True, db=db)
            download = await agent_perception.export_events(hours=0)
            statistics = await agent_perception.perception_stats(db=db)
            filtered_statistics = await agent_perception.perception_stats(db=db, exclude_dev=True)
            markdown = await agent_perception.misread_export()
        assert len(plain["cases"]) == 2 and len(filtered["cases"]) == 1
        assert "synthetic-private-input" not in json.dumps(plain)
        assert (Path(os.environ["TEST_STORAGE"]) / "_analytics" / "misread.md").is_file()
        print(json.dumps({"plain": plain, "filtered": filtered, "statistics": statistics, "filtered_statistics": filtered_statistics, "markdown": {
            "body": markdown.body.decode("utf-8"), "type": markdown.headers["content-type"], "disposition": markdown.headers["content-disposition"]}, "download": {
            "raw": download.body.decode("utf-8"), "events": json.loads(download.body),
            "disposition": download.headers["content-disposition"], "type": download.headers["content-type"]}}))
    finally:
        await client.aclose()
        await engine.dispose()


asyncio.run(main())
