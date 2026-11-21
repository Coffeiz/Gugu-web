import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {createImMemorySummaryReader} from '@gugu/core/im-memory-summary'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON
const owner='00000000-0000-4000-8000-000000000121'

test('IM记忆汇总真实四表与Pythonhandler完全对照，包含inactive/墓碑和任务分类且无标识正文', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式测试Python'},async()=>{
 const schema=`im_summary_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1}),runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const pythonEnv={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-im-summary-config',PYTHONPATH:'.',GUGU_IM_SUMMARY_SCHEMA:schema}
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)');await pool.query('INSERT INTO users VALUES($1)',[owner])
  const ddl=execFileSync(python!,['-c',"from app.models import MemoryReflectionCursor,MemoryScopeTombstone,MemoryEntry,MemoryReflectionJob; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import postgresql; print(';'.join(str(CreateTable(model.__table__).compile(dialect=postgresql.dialect())) for model in [MemoryReflectionCursor,MemoryScopeTombstone,MemoryEntry,MemoryReflectionJob]))"],{encoding:'utf8',cwd:resolve('../../backend'),env:pythonEnv})
  await pool.query(ddl)
  const cursorSql="INSERT INTO memory_reflection_cursors(owner_user_id,platform,bot_id,scope_type,scope_id,last_message_id,last_reflected_message_id,scope_version,pending_passive_count,pending_agent_count,created_at,updated_at) VALUES($1,$2,'private-bot',$3,$4,$5,$6,0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
  await pool.query(cursorSql,[owner,'qq','group','private-group',12,8]);await pool.query(cursorSql,[owner,'qq','platform-user','private-member',4,4])
  await pool.query("INSERT INTO memory_scope_tombstones(owner_user_id,platform,bot_id,scope_type,scope_id,status,delete_version,created_at,updated_at) VALUES($1,'feishu','private-bot','platform-user','private-tomb','pending',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[owner])
  for(const [platform,scopeType,scopeId,count] of [['qq','group','private-group',3],['qq','platform-user','private-member',1],['feishu','platform-user','private-tomb',2],['ignored','group','private-ignored',8]] as const){
   for(let index=0;index<count;index++)await pool.query("INSERT INTO memory_entries(owner_user_id,platform,bot_id,scope_type,scope_id,entry_key,kind,content_hash,active,created_at,updated_at) VALUES($1,$2,'private-bot',$3,$4,$5,'fact','private-hash',false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[owner,platform,scopeType,scopeId,String(index)])
  }
  for(const [index,status] of ['pending','retry','running','dead','failed','done'].entries())await pool.query("INSERT INTO memory_reflection_jobs(owner_user_id,platform,bot_id,scope_type,scope_id,idempotency_key,extractor_version,task_type,reason,status,retry_count,last_error_code,created_at,updated_at) VALUES($1,'qq','private-bot','group','private-group',$2,'v1','group','idle',$3,0,'private-error',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[owner,String(index),status])
  const reader=createImMemorySummaryReader(runtime.db)
  const result=await reader()
  assert.deepEqual(result,{total_scopes:3,groups:1,members:2,total_entries:6,pending_jobs:3,needs_maintenance:1,failed_jobs:2,platforms:[{platform:'feishu',scopes:1,groups:0,members:1,entries:2},{platform:'qq',scopes:2,groups:1,members:1,entries:4}]})
  assert.doesNotMatch(JSON.stringify(result),/private-|00000000/)
  const script="import asyncio,json,os; from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker; from agent.memory import scope_lifecycle; from app.api.v1 import agent_admin\nasync def scenario():\n engine=create_async_engine(os.environ['GUGU_WEBUI_TEST_DATABASE_URL'].replace('postgresql://','postgresql+asyncpg://'),connect_args={'server_settings':{'search_path':os.environ['GUGU_IM_SUMMARY_SCHEMA']}})\n factory=async_sessionmaker(engine)\n async def session(): return factory()\n scope_lifecycle._db_session=session\n try: print(json.dumps({'get':await agent_admin.list_im_memory_scopes(),'preview':await agent_admin.preview_im_memory_maintenance()}))\n finally: await engine.dispose()\nasyncio.run(scenario())"
  const reference=JSON.parse(execFileSync(python!,['-c',script],{encoding:'utf8',cwd:resolve('../../backend'),env:pythonEnv}))
  assert.deepEqual(result,reference.get);assert.deepEqual(result,reference.preview)
  // 旧 cursor 在第一阶段被截掉；墓碑仍会补回，但不能恢复其游标进度。
  await pool.query('TRUNCATE memory_reflection_cursors,memory_scope_tombstones,memory_entries,memory_reflection_jobs')
  await pool.query("INSERT INTO memory_reflection_cursors(owner_user_id,platform,bot_id,scope_type,scope_id,last_message_id,last_reflected_message_id,scope_version,pending_passive_count,pending_agent_count,created_at,updated_at) SELECT $1,'qq','bot','group',i::text,10,0,0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + i * interval '1 second' FROM generate_series(1,10001) AS i",[owner])
  await pool.query("INSERT INTO memory_scope_tombstones(owner_user_id,platform,bot_id,scope_type,scope_id,status,delete_version,created_at,updated_at) VALUES($1,'qq','bot','group','1','pending',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[owner])
  const capped=await reader()
  assert.equal(capped.total_scopes,10000);assert.equal(capped.needs_maintenance,9999)
  const cappedReference=JSON.parse(execFileSync(python!,['-c',script],{encoding:'utf8',cwd:resolve('../../backend'),env:pythonEnv}))
  assert.deepEqual(capped,cappedReference.get)
  // Unicode 码点排序影响截断边界，补充平面字符不能按 UTF-16 顺序提前。
  await pool.query('TRUNCATE memory_reflection_cursors,memory_scope_tombstones')
  await pool.query("INSERT INTO memory_scope_tombstones(owner_user_id,platform,bot_id,scope_type,scope_id,status,delete_version,created_at,updated_at) SELECT $1,'a','bot','group',i::text,'pending',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM generate_series(1,9999) AS i",[owner])
  for(const [platform,type] of [['\ue000','group'],['\u{10000}','platform-user']])await pool.query("INSERT INTO memory_scope_tombstones(owner_user_id,platform,bot_id,scope_type,scope_id,status,delete_version,created_at,updated_at) VALUES($1,$2,'bot',$3,'scope','pending',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",[owner,platform,type])
  const unicode=await reader()
  assert.equal(unicode.groups,10000);assert.equal(unicode.members,0)
  const unicodeReference=JSON.parse(execFileSync(python!,['-c',script],{encoding:'utf8',cwd:resolve('../../backend'),env:pythonEnv}))
  assert.deepEqual(unicode,unicodeReference.get)

 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
