import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {createPostgresRuntime} from '@gugu/core/data'
import {createSecretPromptCancellation} from '@gugu/core/agent-secret-cancel'
import {registerSecretPromptCancelRoute} from '../../src/modules/agent-sessions/secret-cancel.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('凭据取消正式PG事务、owner、到期、并发、回滚与Python等待者消费', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`secret_cancel_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:3}),runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const owner=randomUUID(),other=randomUUID(),server=randomUUID(),schemaJson={secret_fields:[{name:'key',label:'Key',type:'secret'}],context:{secret_target:{kind:'mcp_credentials',server_id:server}},retained:'history'}
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-secret-cancel-config',PYTHONPATH:'.',TEST_SCHEMA:schema,TEST_OWNER:owner}
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE conversation_sessions(id integer PRIMARY KEY,source text,chat_type text); CREATE TABLE user_mcp_servers(id uuid PRIMARY KEY)')
  await pool.query('INSERT INTO users VALUES($1),($2)',[owner,other]);await pool.query("INSERT INTO conversation_sessions VALUES(1,'feishu','group')");await pool.query('INSERT INTO user_mcp_servers VALUES($1)',[server])
  await pool.query(execFileSync(python!,['-c',"from app.models import InteractionRequest,McpSecretInput; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [InteractionRequest,McpSecretInput]))"],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  for(let id=1;id<=13;id++){
   await pool.query("INSERT INTO interaction_prompts(id,user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES($1,$2,1,'form','补全凭据','合成正文',$3::json,'active',clock_timestamp()+interval '1 hour',clock_timestamp())",[id,owner,JSON.stringify(schemaJson)])
   if(id!==7)await pool.query("INSERT INTO mcp_secret_inputs(prompt_id,user_id,server_id,session_id,platform,bot_id,chat_type,platform_user_id,status,next_field_index,consumed_event_ids,encrypted_payload,payload_nonce,encrypted_data_key,key_version,expires_at,created_at,updated_at) VALUES($1,$2,$3,1,'feishu','bot','c2c','actor','awaiting_secret',0,'[]'::json,'synthetic-cipher','synthetic-nonce','synthetic-wrapped',1,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())",[id,id===9?other:owner,server])
  }
  await pool.query("UPDATE interaction_prompts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=3; UPDATE interaction_prompts SET schema_json='{}'::json WHERE id=4; UPDATE interaction_prompts SET status='resolved' WHERE id=5; UPDATE mcp_secret_inputs SET status='completed' WHERE prompt_id=6")
  const cancel=createSecretPromptCancellation(runtime.db)
  await assert.rejects(()=>cancel(other,2),/凭据输入不存在/)
  for(const id of [3,5])await assert.rejects(()=>cancel(owner,id),/凭据输入已结束/)
  await assert.rejects(()=>cancel(owner,4),/当前交互不支持凭据取消/)
  assert.deepEqual(await cancel(owner,1),{ok:true,prompt_id:1,status:'cancelled'})
  const stage=async(id:number)=>(await pool.query('SELECT status,encrypted_payload,payload_nonce,encrypted_data_key FROM mcp_secret_inputs WHERE prompt_id=$1',[id])).rows[0]
  assert.deepEqual(await stage(1),{status:'cancelled',encrypted_payload:'',payload_nonce:'',encrypted_data_key:''})
  await assert.rejects(()=>cancel(owner,1),/凭据输入已结束/)
  await cancel(owner,6);assert.equal((await stage(6)).encrypted_payload,'synthetic-cipher')
  await cancel(owner,7);await cancel(owner,9);assert.equal((await stage(9)).encrypted_payload,'synthetic-cipher')
  await pool.query("CREATE FUNCTION fail_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=10 THEN RAISE EXCEPTION 'synthetic transaction failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_cancel BEFORE UPDATE ON interaction_prompts FOR EACH ROW EXECUTE FUNCTION fail_cancel()")
  await assert.rejects(()=>cancel(owner,10));assert.equal((await stage(10)).encrypted_payload,'synthetic-cipher');assert.equal((await pool.query('SELECT status FROM interaction_prompts WHERE id=10')).rows[0].status,'active')
  const concurrent=await Promise.allSettled([cancel(owner,11),cancel(owner,11)]);assert.equal(concurrent.filter(item=>item.status==='fulfilled').length,1);assert.equal(concurrent.filter(item=>item.status==='rejected').length,1)
  const connection=await pool.connect()
  try{
   await connection.query('BEGIN');await connection.query("UPDATE interaction_prompts SET expires_at=clock_timestamp()+interval '0.5 second' WHERE id=13")
   const waiting=cancel(owner,13);const checked=assert.rejects(()=>waiting,/凭据输入已结束/)
   await new Promise(resolve=>setTimeout(resolve,700));await connection.query('COMMIT');await checked
   assert.equal((await stage(13)).encrypted_payload,'synthetic-cipher')
  }finally{connection.release()}
  const script="import asyncio,json,os; from uuid import UUID; from types import SimpleNamespace; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from app.api.v1.agent_routes.interactions import cancel_secret_interaction; from app.services.interactions import wait_for_resolution; from app.db import session as sessions\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['TEST_SCHEMA']}})\n factory=async_sessionmaker(engine); sessions.ensure_engine=lambda:None; sessions._SessionLocal=factory\n try:\n  async with factory() as db: result=await cancel_secret_interaction(12,current_user=SimpleNamespace(id=UUID(os.environ['TEST_OWNER'])),db=db)\n  waited=await wait_for_resolution(user_id=UUID(os.environ['TEST_OWNER']),prompt_id=1,timeout_seconds=1)\n  print(json.dumps({'result':result,'waited':waited}))\n finally: await engine.dispose()\nasyncio.run(scenario())"
  const reference=JSON.parse(execFileSync(python!,['-c',script],{encoding:'utf8',cwd:resolve('../../backend'),env}))
  assert.deepEqual(reference.result,{ok:true,prompt_id:12,status:'cancelled'});assert.deepEqual(reference.waited,{kind:'form',status:'cancelled',prompt_id:1,option_id:'cancel',value:null,text:'已取消凭据输入'})
  const resolved=(await pool.query('SELECT schema_json FROM interaction_prompts WHERE id=1')).rows[0].schema_json
  assert.equal(resolved.retained,'history');assert.deepEqual(resolved.resolved_result,reference.waited)
  assert.deepEqual(await stage(12),await stage(1))
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

test('取消HTTP使用认证owner，非法prompt422，业务400/409保持',async()=>{
 const app=Fastify();installHttpErrorHandler(app);let calls=0
 registerSecretPromptCancelRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未认证'})},ownerIdFromRequest:()=> 'synthetic-owner',cancel:async(owner,id)=>{calls++;assert.equal(owner,'synthetic-owner');if(id===2)throw Object.assign(new Error('当前交互不支持凭据取消'),{statusCode:400});if(id===3)throw Object.assign(new Error('凭据输入已结束'),{statusCode:409});return {ok:true,prompt_id:id,status:'cancelled'}}})
 try{
  const path=(id:string)=>`/api/v1/agent/interactions/${id}/secrets/cancel`,headers={authorization:'user'}
  assert.equal((await app.inject({method:'POST',url:path('1')})).statusCode,401);assert.equal(calls,0)
  assert.equal((await app.inject({method:'POST',url:path('bad'),headers})).statusCode,422)
  assert.equal((await app.inject({method:'POST',url:path('2'),headers})).statusCode,400);assert.equal((await app.inject({method:'POST',url:path('3'),headers})).statusCode,409)
  assert.deepEqual((await app.inject({method:'POST',url:path('1')+'?user_id=foreign',headers})).json(),{ok:true,prompt_id:1,status:'cancelled'})
 }finally{await app.close()}
})
