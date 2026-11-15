"""Node取消与实际Python Worker消费的隔离PG回归，不投影真实用户数据。"""
import asyncio
import json
import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine



@pytest.mark.process
@pytest.mark.external_service
@pytest.mark.skipif(not os.environ.get("GUGU_WEBUI_TEST_DATABASE_URL"), reason="需要独立测试PG")
def test_node_cancel_is_consumed_by_actual_python_export_worker(tmp_path, monkeypatch):
    monkeypatch.setenv("GUGU_ENV_FILE", os.devnull)
    monkeypatch.setenv("GUGU_CONFIG_OVERRIDE_FILE", str(tmp_path / "not-created.json"))
    from app.models import DataExportJob
    from app.services.data_portability import worker
    from app.services.data_portability.jobs import ClaimedJob
    from app.services.storage import LocalStorageBackend
    async def scenario():
        url = os.environ["GUGU_WEBUI_TEST_DATABASE_URL"]
        schema = "cancel_consumer_" + uuid4().hex
        admin = create_async_engine(url.replace("postgresql://", "postgresql+asyncpg://", 1))
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_async_engine(url.replace("postgresql://", "postgresql+asyncpg://", 1),
                                     connect_args={"server_settings": {"search_path": schema}})
        factory = async_sessionmaker(engine, expire_on_commit=False)
        task = None
        try:
            async with engine.begin() as connection:
                await connection.execute(text("CREATE TABLE users(id uuid PRIMARY KEY)"))
                await connection.run_sync(DataExportJob.__table__.create)
            owner, job_id = uuid4(), uuid4()
            async with factory() as db:
                await db.execute(text("INSERT INTO users(id) VALUES(:id)"), {"id": owner})
                db.add(DataExportJob(id=job_id, user_id=owner, status="running", stage="running",
                                     options={"categories": ["projects"]}, lease_owner="synthetic-worker"))
                await db.commit()
            started = asyncio.Event()
            async def synthetic_projection(*_args, **_kwargs):
                started.set()
                await asyncio.Event().wait()
            monkeypatch.setattr(worker, "build_record_producers", synthetic_projection)
            monkeypatch.setattr(worker, "get_storage", lambda: LocalStorageBackend(tmp_path / "storage"))
            monkeypatch.setattr(worker, "_EXPORT_HEARTBEAT_INTERVAL_SECONDS", 0.02)
            task = asyncio.create_task(worker.process_export_job(
                ClaimedJob("export", job_id, owner, "export", "running"),
                worker_id="synthetic-worker", session_factory=factory))
            await asyncio.wait_for(started.wait(), 5)
            script = """
import {Pool} from 'pg';
import {createDataExportCanceler} from '@gugu/core/data-portability/cancel-export';
import {withPostgresTransaction} from './src/adapters/postgres-transaction.ts';
const pool=new Pool({connectionString:process.env.GUGU_WEBUI_TEST_DATABASE_URL,options:'-c search_path='+process.env.GUGU_TEST_SCHEMA});
try {const cancel=createDataExportCanceler(work=>withPostgresTransaction(pool,client=>work((sql,params)=>client.query(sql,params))),(sql,params)=>pool.query(sql,params));
console.log(JSON.stringify(await cancel(process.env.GUGU_TEST_OWNER,process.env.GUGU_TEST_JOB)));}finally{await pool.end();}
"""
            env = {**os.environ, "GUGU_TEST_SCHEMA": schema, "GUGU_TEST_OWNER": str(owner), "GUGU_TEST_JOB": str(job_id)}
            root = Path(__file__).resolve().parents[2]
            result = await asyncio.to_thread(subprocess.run,
                ["node", "--import", "tsx", "--input-type=module", "--eval", script],
                cwd=root / "apps/web-host", env=env, capture_output=True, text=True, timeout=15)
            assert result.returncode == 0, "Node取消调用失败"
            assert json.loads(result.stdout)["status"] in {"canceling", "canceled"}
            await asyncio.wait_for(task, 5)
            async with factory() as db:
                row = await db.get(DataExportJob, job_id)
                assert row.status == row.stage == "canceled"
                assert row.finished_at is not None
                assert row.lease_owner is None and row.lease_until is None
                assert row.artifact_key is None and row.artifact_size is None
            assert not list((tmp_path / "storage").rglob("*.gupa"))
        finally:
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            await engine.dispose()
            async with admin.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
            await admin.dispose()
    asyncio.run(scenario())
