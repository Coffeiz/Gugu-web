import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import type {LightMyRequestResponse} from 'fastify'
import {Pool} from 'pg'
import {startServer} from '../../../../src/main.js'
import {signedUserToken} from '../../../helpers/auth.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('生产Host恢复预检能力，真实Python apply验证并消费轮换token，未运行导入Worker', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`resume_host_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-resume-import-'))
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString(),max:2}),owner=randomUUID(),other=randomUUID(),job=randomUUID(),old='synthetic-old-confirmation-token-with-sufficient-length'
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(root,'nonexistent-config'),PYTHONPATH:'.',TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_JOB:job}
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,username text,email text,is_active boolean,account_status text,security_version integer,avatar text,created_at timestamptz,timezone text,email_subscribed boolean,display_name text,last_active_at timestamptz); CREATE TABLE user_bots(id integer,user_id uuid,platform text,enabled boolean)')
  await pool.query("INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at) VALUES($1,'小北','synthetic-a@example.invalid',true,'active',1,CURRENT_TIMESTAMP),($2,'小月','synthetic-b@example.invalid',true,'active',1,CURRENT_TIMESTAMP)",[owner,other])
  await pool.query(execFileSync(python!,['-c',"from app.models import DataImportJob,DataExportJob; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [DataImportJob,DataExportJob]))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  await pool.query("INSERT INTO data_import_jobs(id,user_id,mode,status,stage,staging_key,import_token_hash,preview,progress_current,created_at,expires_at,updated_at) VALUES($1,$2,'preflight','preview_ready','preview_ready','synthetic-staging',$3,'{\"complete\":true,\"conflicts\":{\"total\":0}}'::json,0,'2026-11-15T00:00:00.123456Z',clock_timestamp()+interval '1 hour',clock_timestamp())",[job,owner,createHash('sha256').update(old).digest('hex')])
  const override=join(root,'config.json');await writeFile(override,'{}')
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()))
  const secret='synthetic-resume-import-secret'
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:join(root,'storage'),ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const path=`/api/v1/data-portability/imports/${job}/resume`,headers={authorization:`Bearer ${signedUserToken(secret,owner)}`},foreign={authorization:`Bearer ${signedUserToken(secret,other)}`}
  assert.equal((await host.app.inject({method:'POST',url:path})).statusCode,401)
  assert.equal((await host.app.inject({method:'POST',url:path,headers:foreign})).statusCode,404)
  const response:LightMyRequestResponse=await host.app.inject({method:'POST',url:path,headers})
  assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'no-store');assert.match(response.json().import_token,/^[A-Za-z0-9_-]{43}$/)
  assert.equal(response.json().created_at,'2026-11-15T00:00:00.123456+00:00');assert.doesNotMatch(response.body,/staging_key|import_token_hash|synthetic-staging/)
  const read:LightMyRequestResponse=await host.app.inject({url:`/api/v1/data-portability/imports/${job}`,headers})
  assert.equal(read.statusCode,200);assert.equal(Object.hasOwn(read.json(),'import_token'),false)
  const script="import asyncio,json,os; from uuid import UUID; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from app.services.data_portability.api_jobs import apply_import_job,PortabilityJobError\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})\n try:\n  async with async_sessionmaker(engine)() as db:\n   try: await apply_import_job(db,user_id=UUID(os.environ['TEST_OWNER']),job_id=UUID(os.environ['TEST_JOB']),mode='incremental',import_token=os.environ['OLD_TOKEN'],idempotency_key='synthetic-production-apply')\n   except PortabilityJobError as error: rejected=error.status_code\n   row=await apply_import_job(db,user_id=UUID(os.environ['TEST_OWNER']),job_id=UUID(os.environ['TEST_JOB']),mode='incremental',import_token=os.environ['NEW_TOKEN'],idempotency_key='synthetic-production-apply')\n   print(json.dumps({'old':rejected,'status':row.status,'hash':row.import_token_hash}))\n finally: await engine.dispose()\nasyncio.run(scenario())"
  const consumed=JSON.parse(execFileSync(python!,['-c',script],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,OLD_TOKEN:old,NEW_TOKEN:response.json().import_token}}))
  assert.deepEqual(consumed,{old:403,status:'queued',hash:null})
  assert.equal((await host.app.inject({method:'POST',url:path,headers})).statusCode,409)
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
