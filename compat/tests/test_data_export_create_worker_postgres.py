"""Node创建导出与实际Python归档消费者，隔离PG/临时FS/合成密钥。"""
import asyncio
import json
import hashlib
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.process
@pytest.mark.external_service
@pytest.mark.skipif(not os.environ.get("GUGU_WEBUI_TEST_DATABASE_URL"), reason="需要独立测试PG")
def test_node_created_export_is_consumed_into_owner_scoped_encrypted_archive(tmp_path, monkeypatch):
    monkeypatch.setenv("GUGU_ENV_FILE", os.devnull)
    monkeypatch.setenv("GUGU_CONFIG_OVERRIDE_FILE", str(tmp_path / "not-created.json"))
    from app.db.base import Base
    from app.models import DataExportJob, Project, User
    from app.services import storage as storage_service
    from app.services.storage import LocalStorageBackend
    from app.services.data_portability import crypto_stream, memories, worker
    from app.services.data_portability.jobs import claim_next_job
    from app.services.data_portability.archive_validation import validate_encrypted_archive
    async def scenario():
        url = os.environ["GUGU_WEBUI_TEST_DATABASE_URL"]
        schema = "export_consumer_" + uuid4().hex
        admin = create_async_engine(url.replace("postgresql://", "postgresql+asyncpg://", 1))
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_async_engine(url.replace("postgresql://", "postgresql+asyncpg://", 1), connect_args={"server_settings": {"search_path": schema}})
        factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            owner, other = uuid4(), uuid4()
            async with factory() as db:
                db.add_all([User(id=owner, username="小北", email="a@example.test", hashed_password="synthetic"), User(id=other, username="小月", email="b@example.test", hashed_password="synthetic")])
                await db.flush()
                db.add_all([Project(user_id=owner, name="本账号合成项目"), Project(user_id=other, name="他人合成项目")])
                await db.commit()
            storage = LocalStorageBackend(tmp_path / "storage")
            monkeypatch.setattr(worker, "get_storage", lambda: storage)
            monkeypatch.setattr(storage_service, "get_storage", lambda: storage)
            monkeypatch.setattr(memories, "get_storage", lambda: storage)
            monkeypatch.setattr(crypto_stream, "get_settings", lambda: SimpleNamespace(secret_key="synthetic-portability-key"))
            script = """
import {Pool} from 'pg';import {randomUUID} from 'node:crypto';
import {createDataExportCreator} from '@gugu/core/data-portability/create-export';
import {withPostgresTransaction} from './src/adapters/postgres-transaction.ts';
const pool=new Pool({connectionString:process.env.GUGU_WEBUI_TEST_DATABASE_URL,options:'-c search_path='+process.env.GUGU_TEST_SCHEMA});
try {const create=createDataExportCreator(work=>withPostgresTransaction(pool,client=>work((sql,params)=>client.query(sql,params))),(sql,params)=>pool.query(sql,params),{now:()=>new Date(),uuid:randomUUID});console.log(JSON.stringify(await create(process.env.GUGU_TEST_OWNER,['projects'],'synthetic-consumer-request')));}finally{await pool.end();}
"""
            result = await asyncio.to_thread(subprocess.run, ["node", "--import", "tsx", "--input-type=module", "--eval", script], cwd=Path(__file__).resolve().parents[2] / "apps/web-host", env={**os.environ, "GUGU_TEST_SCHEMA": schema, "GUGU_TEST_OWNER": str(owner)}, capture_output=True, text=True, timeout=15)
            assert result.returncode == 0, "Node创建导出失败"
            created = json.loads(result.stdout)
            assert created["status"] == "queued"
            async with factory() as db:
                claimed = await claim_next_job(db, "synthetic-worker")
                assert claimed is not None and claimed.job_id == UUID(created["id"])
            await asyncio.wait_for(worker.process_export_job(claimed, worker_id="synthetic-worker", session_factory=factory), 15)
            async with factory() as db:
                row = await db.get(DataExportJob, UUID(created["id"]))
                assert row.status == "ready" and row.artifact_key and row.artifact_size > 0
                assert row.lease_owner is None and row.lease_until is None
                with tempfile.TemporaryFile(mode="w+b") as encrypted:
                    async for chunk in storage.iter_chunks(row.artifact_key):
                        encrypted.write(chunk)
                    encrypted.seek(0)
                    context = f"data-portability:{owner.hex}:{row.id.hex}"
                    assert validate_encrypted_archive(encrypted, context=context).manifest.complete is False
                    encrypted.seek(0)
                    reader = crypto_stream.EncryptedArchiveReader(encrypted, context)
                    with zipfile.ZipFile(reader, "r") as archive:
                        records = archive.read("records/projects.jsonl").decode("utf-8")
                    reader.seek(0)
                    plaintext_zip = reader.read()
                    reader.close()
                assert "本账号合成项目" in records and "他人合成项目" not in records
                download_script = """
import {createHash} from 'node:crypto';import {createServer} from 'node:net';
import {startServer} from './src/main.ts';import {signedUserToken} from './tests/helpers/auth.ts';
const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const db=new URL(process.env.GUGU_WEBUI_TEST_DATABASE_URL);db.searchParams.set('options','-c search_path='+process.env.GUGU_TEST_SCHEMA);
const secret='synthetic-portability-key';const host=await startServer({GUGU_WEBUI_DATABASE_URL:db.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:process.env.GUGU_TEST_OVERRIDE,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(port),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:process.env.GUGU_TEST_STORAGE});
try {const base='/api/v1/data-portability/exports/'+process.env.GUGU_TEST_JOB;const headers={authorization:'Bearer '+signedUserToken(secret,process.env.GUGU_TEST_OWNER)};
const full=await host.app.inject({url:base+'/download',headers});const ranged=await host.app.inject({url:base+'/download',headers:{...headers,range:'bytes=-7'}});
const ticket=await host.app.inject({method:'POST',url:base+'/download-ticket',headers});const browser=await host.app.inject({url:ticket.json().url,headers:{cookie:String(ticket.headers['set-cookie']).split(';')[0]}});
console.log(JSON.stringify({status:full.statusCode,size:full.rawPayload.length,sha:createHash('sha256').update(full.rawPayload).digest('hex'),rangeStatus:ranged.statusCode,rangeSha:createHash('sha256').update(ranged.rawPayload).digest('hex'),browserStatus:browser.statusCode,browserSha:createHash('sha256').update(browser.rawPayload).digest('hex')}));}finally{await host.close();}
"""
                override = tmp_path / "download-host-config.json"
                override.write_text("{}")
                download_env = {**os.environ, "GUGU_TEST_SCHEMA": schema, "GUGU_TEST_OWNER": str(owner), "GUGU_TEST_JOB": created["id"], "GUGU_TEST_OVERRIDE": str(override), "GUGU_TEST_STORAGE": str(tmp_path / "storage")}
                downloaded = await asyncio.to_thread(subprocess.run, ["node", "--import", "tsx", "--input-type=module", "--eval", download_script], cwd=Path(__file__).resolve().parents[2] / "apps/web-host", env=download_env, capture_output=True, text=True, timeout=15)
                assert downloaded.returncode == 0, "生产Node下载调用失败"
                outcome = json.loads(downloaded.stdout.strip().splitlines()[-1])
                assert outcome["status"] == outcome["browserStatus"] == 200
                assert outcome["rangeStatus"] == 206
                assert outcome["size"] == len(plaintext_zip)
                assert outcome["sha"] == outcome["browserSha"] == hashlib.sha256(plaintext_zip).hexdigest()
                assert outcome["rangeSha"] == hashlib.sha256(plaintext_zip[-7:]).hexdigest()
        finally:
            await engine.dispose()
            async with admin.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
            await admin.dispose()
    asyncio.run(scenario())
