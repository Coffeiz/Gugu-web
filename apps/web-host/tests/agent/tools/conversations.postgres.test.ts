import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../../src/modules/agent/tools/registry.js'
import { createAgentConversationReadPort,createAgentConversationSearchPort,createCoreAgentConversationSearchPort } from '../../../src/modules/agent/tools/conversations.js'
import { createSqlRagConversationSource } from '../../../../../packages/core/src/agent/rag/conversation-source.js'

const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('真实历史工具读取当前 owner 最近普通消息，结构化消息和其他用户不可见', {skip:!url&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`agent_conversation_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID()
 const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:2})
 const core=await createPostgresRuntime({url:url!,schema})
 try{
  await pool.query('CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL,title text,source text,summary text,updated_at timestamptz); CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,conversation_seq integer,role text,content text,content_json jsonb)')
  await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'原对话','web',NULL,'2026-01-02T03:04:00Z'),(2,$2,'他人对话','web',NULL,'2026-01-03T03:04:00Z'),(3,$1,'空对话',NULL,'摘要','2026-01-01T00:00:00Z'),(4,$1,'稍新的对话','web',NULL,'2026-01-02T03:04:00.000001Z')",[owner,other])
  await pool.query(`INSERT INTO conversation_messages VALUES
   (1,1,1,'user','最旧',NULL),(2,1,2,'assistant','早先',NULL),(3,1,3,'user','结构化私有', '{"type":"tool"}'),
   (4,1,4,'user','最近用户',NULL),(5,1,5,'assistant',$1,NULL),(6,1,6,'assistant','JSON null 不应出现','null'::jsonb),
   (7,2,1,'user','他人私有',NULL)`,['😀'.repeat(1201)])
  let allowed=true
  const searchPort=createAgentConversationSearchPort(core,{search:async()=>[{message_id:4,text:'最近用户',role:'user'},{message_id:7,text:'他人私有'}]})
  const registry=createAgentToolRegistry({core,conversations:createAgentConversationReadPort(pool),conversationSearch:searchPort,authorize:async()=>allowed})
  const identity={ownerId:owner,sessionId:'99',runId:'run'},scope={identity,roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不可执行')}}
  assert.equal(await searchPort.resolve(identity,{session_id:2,message_id:4},scope.signal),null)
  assert.equal(await searchPort.resolve(identity,{message_id:7,source_id:1},scope.signal),null)
  assert.equal(await searchPort.resolve(identity,{message_id:4,source_id:2},scope.signal),1)
  assert.equal(await searchPort.resolve(identity,{source_id:'４'},scope.signal),4)
  const call={id:'read',name:'read_conversation',input:{session_id:1,limit:2,owner_id:other}}
  const result=await registry.tools.dispatch(call,scope)
  assert.equal(result.kind,'completed')
  if(result.kind==='completed'){
   const value=result.value as {session_id:number;title:string;messages:Array<{role:string;content:string}>}
   assert.equal(value.session_id,1);assert.equal(value.title,'原对话')
   assert.deepEqual(value.messages,[{role:'你',content:'最近用户'},{role:'咕咕',content:'😀'.repeat(1200)}])
  }
  const recent=await registry.tools.dispatch({id:'recent',name:'search_conversations',input:{}},scope)
  assert.match(JSON.stringify(recent),/原对话/);assert.doesNotMatch(JSON.stringify(recent),/他人对话/)
  assert.equal(recent.kind,'completed');if(recent.kind==='completed')assert.deepEqual((recent.value as {recent:Array<{session_id:number}>}).recent.map(row=>row.session_id),[4,1,3])
  const search=await registry.tools.dispatch({id:'search',name:'search_conversations',input:{query:'最近'}},scope)
  assert.match(JSON.stringify(search),/最近用户/);assert.doesNotMatch(JSON.stringify(search),/他人私有/)
  await pool.query("INSERT INTO conversation_messages VALUES (8,1,7,'assistant','',NULL)")
  const withEmpty=await registry.tools.dispatch({...call,input:{session_id:1,limit:2}},scope)
  assert.equal(withEmpty.kind,'completed')
  if(withEmpty.kind==='completed')assert.deepEqual((withEmpty.value as {messages:unknown[]}).messages,[{role:'咕咕',content:'😀'.repeat(1200)}])
  const foreign=await registry.tools.dispatch({...call,input:{session_id:2}},scope)
  assert.equal(foreign.kind,'completed');if(foreign.kind==='completed')assert.equal((foreign.value as {error:string}).error,'对话不存在或不属于你')
  assert.doesNotMatch(JSON.stringify(foreign),/他人/)
  const empty=await registry.tools.dispatch({...call,input:{session_id:3}},scope)
  assert.match(JSON.stringify(empty),/"messages":\[\]/)
  const invalid=await registry.tools.dispatch({...call,input:{session_id:1,limit:101}},scope)
  assert.equal(invalid.kind==='completed'&&invalid.successful,false)
  allowed=false;assert.match(JSON.stringify(await registry.tools.dispatch(call,scope)),/没有权限/)
  allowed=true;registry.configure({groups:{conversations:false}});assert.match(JSON.stringify(await registry.tools.dispatch(call,scope)),/未开放/)
  registry.configure({groups:{conversations:true}});const abort=new AbortController();abort.abort();await assert.rejects(registry.tools.dispatch(call,{...scope,signal:abort.signal}))
  await pool.query("ALTER TABLE conversation_sessions ADD COLUMN chat_type text; ALTER TABLE conversation_messages ADD COLUMN created_at timestamptz DEFAULT '2026-01-01T00:00:00Z'")
  await pool.query("INSERT INTO conversation_sessions(id,user_id,title,source,summary,updated_at,chat_type) VALUES(5,$1,'群聊','im','','2026-01-01','group')",[owner])
  await pool.query("INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content) VALUES(9,5,1,'user','最近 群私有')")
  const history=createSqlRagConversationSource(core.db,'postgres')
  const actualPort=createAgentConversationSearchPort(core,{search:(ownerId,queries,mode,limit,signal)=>history(ownerId,{scope_type:'owner'},queries,mode,limit,signal)})
  const actualRegistry=createAgentToolRegistry({core,conversationSearch:actualPort,authorize:async()=>true})
  const actual=await actualRegistry.tools.dispatch({id:'history',name:'search_conversations',input:{query:'最近'}},scope)
  assert.match(JSON.stringify(actual),/最近用户/);assert.doesNotMatch(JSON.stringify(actual),/群私有|他人私有/)
  const foreignResults=await history(other,{scope_type:'owner'},['他人'],'OR',10)
  assert.equal(foreignResults[0]?.text,'他人私有')
  const rankedPort=createCoreAgentConversationSearchPort(core,{cut:text=>[text]})
  const rankedRegistry=createAgentToolRegistry({core,conversationSearch:rankedPort,authorize:async()=>true})
  const rankedResult=await rankedRegistry.tools.dispatch({id:'ranked',name:'search_conversations',input:{query:'最近'}},scope)
  assert.match(JSON.stringify(rankedResult),/原对话/);assert.match(JSON.stringify(rankedResult),/最近用户/);assert.doesNotMatch(JSON.stringify(rankedResult),/群私有|他人私有/)
 }finally{await core.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

import { createSqlRagPersistentIndexReader } from '../../../../../packages/core/src/agent/rag/persistent-index.js'
import { createSqlRagPersistentIndexWriter } from '../../../../../packages/core/src/agent/rag/persistent-writer.js'
import { createSqlRagRebuildWorker } from '../../../../../packages/core/src/agent/rag/rebuild-worker.js'
import { createProjectRagSource } from '../../../../../packages/core/src/agent/rag/project-source.js'
import { createCalendarRagSource } from '../../../../../packages/core/src/agent/rag/calendar-source.js'
import { createKyselyCalendarReadPort } from '../../../../../packages/core/src/calendar/read-store.js'
import { createNoteRagSource } from '../../../../../packages/core/src/agent/rag/note-source.js'
import { createSqlMindNoteReader } from '../../../../../packages/core/src/mind/note-read.js'
import { createScheduledTaskRagSource } from '../../../../../packages/core/src/agent/rag/scheduled-task-source.js'
import { createKyselyScheduledTaskRagReader } from '../../../../../packages/core/src/scheduled-tasks/task-list.js'
import { buildDocuments } from '../../../../../packages/core/src/agent/rag/adapters/base.js'
import { createOwnerRagVectorSource } from '../../../src/modules/agent/rag/vectors.js'
import { readRagDocumentVectors } from '../../../../../packages/core/src/agent/rag/vector-reader.js'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('向量来源只读取可信 owner 的固定路径并拒绝符号链接',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gugu-rag-vectors-')),owner=randomUUID(),other=randomUUID()
 try{
  await mkdir(join(root,owner,'.agent', 'memories'),{recursive:true});await mkdir(join(root,other,'.agent', 'memories'),{recursive:true})
  const content=JSON.stringify({'rag:m:v1:0':{t:'model-v1',v:[0.25,0.5]}})
  await writeFile(join(root,owner,'.agent', 'memories','memory_vec.json'),content)
  await writeFile(join(root,other,'.agent', 'memories','pattern_vec.json'),'other vector')
  const read=createOwnerRagVectorSource(root,owner)
  assert.equal(await read('memory'),content)
  assert.equal(await read('knowledge'),null)
  assert.deepEqual(await readRagDocumentVectors([{id:'m:0',parent_id:'m',document_version:'v1',chunk_index:0,source_type:'memory',text:'',scope_type:'owner',scope_id:''}],'model-v1',read),{'m:0':[0.25,0.5]})
  await symlink(join(root,other,'.agent', 'memories','pattern_vec.json'),join(root,owner,'.agent', 'memories','pattern_vec.json'))
  await assert.rejects(readRagDocumentVectors([{id:'m:0',parent_id:'m',document_version:'v1',chunk_index:0,source_type:'memory',text:'',scope_type:'owner',scope_id:''}],'model-v1',read))
  await assert.rejects(read('pattern'))
  await assert.rejects(read('../other' as 'memory'))
  const abort=new AbortController();abort.abort();await assert.rejects(read('memory',abort.signal))
 }finally{await rm(root,{recursive:true,force:true})}
})

test('旧版持久索引按 owner 加载并以微秒和 ID 消费墓碑', {skip:!url&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`rag_persistent_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID()
 const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:2})
 const core=await createPostgresRuntime({url:url!,schema})
 try{
  await pool.query(`CREATE TABLE knowledge_index_entries(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,owner_user_id uuid,indexed_at timestamptz,deleted_at timestamptz,source_type text,source_id text,scope_type text,scope_id text,platform text,bot_id text,group_id text,document_id text,parent_document_id text,document_version text,chunk_index integer,chunk_count integer,title text,summary text,content text,metadata_json jsonb,source_updated_at timestamptz)`)
  const insert=async(id:number,user:string,kind:string,time:string,deleted:string|null,content:string)=>pool.query(`INSERT INTO knowledge_index_entries VALUES($1,$2,$3,$4,$5,$6,'owner','','','','',$6,$6,'v1',0,1,'合成标题','',$7,'{}',NULL)`,[id,user,time,deleted,kind,String(id),content])
  await insert(1,owner,'conversation','2026-01-01T00:00:00.000001Z',null,'合成正文')
  await insert(2,owner,'conversation','2026-01-01T00:00:00.000002Z','2026-01-01T00:00:01Z','已删正文')
  await insert(3,owner,'conversation','2026-01-01T00:00:00.000002Z',null,'同一时刻')
  await insert(4,owner,'file','2026-01-01T00:00:01Z',null,'文件内容')
  await insert(5,other,'conversation','2026-01-01T00:00:01Z',null,'其他用户正文')
  await pool.query("SELECT setval(pg_get_serial_sequence('knowledge_index_entries','id'),5)")
  const reader=createSqlRagPersistentIndexReader(core.db,'postgres'),snapshot=await reader.snapshot(owner)
  assert.deepEqual(snapshot.documents.map(row=>row.content),['合成正文','同一时刻'])
  assert.deepEqual(snapshot.watermark,{timestamp:'2026-01-01T00:00:00.000002+00:00',id:3})
  const page=await reader.delta(owner,{timestamp:'2026-01-01T00:00:00.000001+00:00',id:1},1)
  assert.deepEqual(page.deletes,['conversation:2:0'])
  assert.deepEqual(page.cursor,{timestamp:'2026-01-01T00:00:00.000002+00:00',id:2})
  assert.deepEqual((await reader.delta(owner,page.cursor,1)).upserts.map(row=>row.content),['同一时刻'])
  assert.deepEqual((await reader.snapshot(other)).documents.map(row=>row.content),['其他用户正文'])
  await pool.query('ALTER TABLE knowledge_index_entries ADD COLUMN content_hash text')
  const writer=createSqlRagPersistentIndexWriter(core.db,'postgres')
  const docs=buildDocuments({id:'new',source_type:'conversation',title:'合成',content:'新索引',document_version:'v2',scope:{scope_type:'owner',scope_id:''}})
  assert.deepEqual(await writer.replaceSource(owner,'conversation',docs),{inserted:1,updated:0,deleted:2})
  const changed=await reader.delta(owner,snapshot.watermark)
  assert.deepEqual(changed.upserts.map(row=>row.content),['新索引'])
  assert.deepEqual(new Set(changed.deletes),new Set(['conversation:1:0','conversation:3:0']))
  assert.deepEqual((await reader.snapshot(other)).documents.map(row=>row.content),['其他用户正文'])
  assert.deepEqual(await writer.replaceDocument(owner,'conversation','new',[]),{inserted:0,updated:0,deleted:1})
  assert.deepEqual(await writer.replaceDocument(owner,'conversation','new',docs),{inserted:0,updated:1,deleted:0})
  const a=buildDocuments({id:'a',source_type:'conversation',title:'合成',content:'并发甲',document_version:'v1',scope:{scope_type:'owner',scope_id:''}})
  const b=buildDocuments({id:'b',source_type:'conversation',title:'合成',content:'并发乙',document_version:'v1',scope:{scope_type:'owner',scope_id:''}})
  await Promise.all([writer.replaceDocument(owner,'conversation','a',a),writer.replaceDocument(owner,'conversation','b',b)])
  assert.deepEqual(new Set((await reader.snapshot(owner)).documents.map(row=>row.content)),new Set(['新索引','并发甲','并发乙']))
  await pool.query("ALTER TABLE knowledge_index_entries ADD CONSTRAINT reject_fixture CHECK (content <> '阻止写入')")
  await assert.rejects(writer.replaceSource(owner,'conversation',[...a,{...b[0]!,content:'阻止写入'}]))
  assert.deepEqual(new Set((await reader.snapshot(owner)).documents.map(row=>row.content)),new Set(['新索引','并发甲','并发乙']))
  await pool.query(`CREATE TABLE rag_index_jobs(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,user_id uuid,source_type text,source_id text,pending_source_ids jsonb,status text,generation integer,completed_generation integer,attempts integer,next_attempt_at timestamptz,lease_until timestamptz,last_started_at timestamptz,last_succeeded_at timestamptz,last_error_code text,updated_at timestamptz);
   CREATE TABLE fixture_sources(id text PRIMARY KEY,content text);
   INSERT INTO fixture_sources VALUES ('1','重建正文')`)
  await pool.query("INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,status,generation,completed_generation,attempts,next_attempt_at,updated_at) VALUES ($1,'note','1','[\"1\"]','queued',1,0,0,now()-interval '1 second',now())",[owner])
  const worker=createSqlRagRebuildWorker(core.db,'postgres',{note:async(user,id)=>{
   assert.equal(user,owner)
   const row=(await pool.query('SELECT content FROM fixture_sources WHERE id=$1',[id])).rows[0]
   return buildDocuments({id:id!,source_type:'note',title:'合成',content:row.content,document_version:'v1',scope:{scope_type:'owner',scope_id:''}})
  }})
  assert.equal(await worker(),'ready');assert.equal(await worker(),'idle')
  assert.match(JSON.stringify(await reader.snapshot(owner)),/重建正文/)
  await pool.query(`CREATE TABLE projects(id integer PRIMARY KEY,user_id uuid,name text,summary text,contact_name text,status text,start_date text,deadline text,color text,progress integer,stages_json text,current_stage text,priority text,version integer,archived boolean,done_at timestamptz,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,idempotency_key text,idempotency_fingerprint text)`)
  await pool.query("INSERT INTO projects VALUES(1,$1,'上线计划',NULL,'小北','active',NULL,NULL,'#000',40,'[]',NULL,NULL,1,false,NULL,now(),now(),NULL,NULL,NULL),(2,$2,'其他项目',NULL,NULL,'active',NULL,NULL,'#000',0,'[]',NULL,NULL,1,false,NULL,now(),now(),NULL,NULL,NULL)",[owner,other])
  await pool.query("INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,status,generation,completed_generation,attempts,next_attempt_at,updated_at) VALUES ($1,'project','1','[\"1\"]','queued',1,0,0,now()-interval '1 second',now())",[owner])
  const projectSource=createProjectRagSource(core),projectWorker=createSqlRagRebuildWorker(core.db,'postgres',{project:projectSource})
  assert.equal(await projectWorker(),'ready')
  assert.match(JSON.stringify(await reader.snapshot(owner)),/上线计划/)
  assert.deepEqual(await projectSource(owner,'2'),[])
  await pool.query(`CREATE TABLE calendar_events(id integer PRIMARY KEY,user_id uuid,title text,date text,time text,end_time text,type text,contact_name text,project_id integer,description text,version integer,deleted_at timestamptz)`)
  await pool.query("INSERT INTO calendar_events VALUES (1,$1,'合成活动','2026-03-01',NULL,NULL,'meeting',NULL,NULL,'活动正文',1,NULL),(2,$2,'其他活动','2026-03-01',NULL,NULL,'meeting',NULL,NULL,'私有正文',1,NULL)",[owner,other])
  await pool.query("INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,status,generation,completed_generation,attempts,next_attempt_at,updated_at) VALUES ($1,'calendar','1','[\"1\"]','queued',1,0,0,now()-interval '1 second',now())",[owner])
  const calendarSource=createCalendarRagSource(createKyselyCalendarReadPort(core.db,'postgres'))
  const calendarWorker=createSqlRagRebuildWorker(core.db,'postgres',{calendar:calendarSource})
  assert.equal(await calendarWorker(),'ready')
  assert.match(JSON.stringify(await reader.snapshot(owner)),/活动正文/)
  assert.deepEqual(await calendarSource(owner,'2'),[])
  await pool.query(`CREATE TABLE mind_nodes(id integer PRIMARY KEY,user_id uuid,kind text,title text,content_md text,content_plain text,indexed_hash text,version integer,updated_at timestamptz,deleted_at timestamptz)`)
  await pool.query("INSERT INTO mind_nodes VALUES (1,$1,'note','合成便签','# 合成便签','便签正文','hash-a',2,'2026-01-01T00:00:00.123456Z',NULL),(2,$2,'note','其他便签','','私有正文','hash-b',1,now(),NULL)",[owner,other])
  await pool.query("UPDATE rag_index_jobs SET source_id='1',pending_source_ids='[\"1\"]',status='queued',generation=generation+1,next_attempt_at=now()-interval '1 second' WHERE user_id=$1 AND source_type='note'",[owner])
  const noteSource=createNoteRagSource(createSqlMindNoteReader(core.db,'postgres'))
  const noteWorker=createSqlRagRebuildWorker(core.db,'postgres',{note:noteSource})
  assert.equal(await noteWorker(),'ready')
  const note=(await reader.snapshot(owner)).documents.find(row=>row.source_type==='note'&&row.source_id==='1')
  assert.match(note?.content??'',/便签正文/);assert.match(note?.updated_at??'',/123456/)
  assert.deepEqual(await noteSource(owner,'2'),[])
  await pool.query(`CREATE TABLE scheduled_tasks(id integer PRIMARY KEY,user_id uuid,event_id integer,name text,payload text,cron text,enabled boolean,updated_at timestamptz)`)
  await pool.query("INSERT INTO scheduled_tasks VALUES (1,$1,NULL,'合成任务','任务正文','0 9 * * *',true,'2026-01-01T00:00:00.123456Z'),(2,$1,1,'活动提醒','提醒正文','0 8 * * *',false,now()),(3,$2,NULL,'他人任务','私有正文','* * * * *',true,now())",[owner,other])
  await pool.query("INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,status,generation,completed_generation,attempts,next_attempt_at,updated_at) VALUES ($1,'scheduled_task','1','[\"1\"]','queued',1,0,0,now()-interval '1 second',now())",[owner])
  const taskSource=createScheduledTaskRagSource(createKyselyScheduledTaskRagReader(core.db,'postgres'))
  assert.deepEqual(new Set((await taskSource(owner,null)).map(item=>item.source_id)),new Set(['1','2']))
  assert.deepEqual(await taskSource(owner,'3'),[])
  const taskWorker=createSqlRagRebuildWorker(core.db,'postgres',{scheduled_task:taskSource})
  assert.equal(await taskWorker(),'ready')
  assert.match(JSON.stringify(await reader.snapshot(owner)),/任务正文/)
 }finally{await core.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
