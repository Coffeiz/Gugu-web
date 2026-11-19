import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {createImFileTools} from '../../../src/modules/im/gateway/agent/files.js'
import {createPostgresFileReadOperations} from '../../../src/modules/files/browse.js'
import {createReadFileTool,createImSendFileTool,createToolRegistry} from '@gugu/core/tools'
import {imAttachmentScopeKey} from '../../../src/modules/im/gateway/inbound/attachments.js'
import {context,receipt,platform,temporary,owner,other,data,stored} from './run-sender.fixtures.js'

const url=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
async function fixture(work:(f:{pool:import('pg').Pool;root:string;c:ReturnType<typeof context>})=>Promise<void>){
 await temporary(async root=>{
  const {Pool}=await import('pg'),schema=`im_files_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:5}),c=context()
  try{
   await admin.query(`CREATE SCHEMA "${schema}"`)
   await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text);
    CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,run_id text,role text,chat_type text,platform_user_id text,conversation_seq integer,im_platform_message_id text);
    CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,state text,platform text,bot_id varchar(128),chat_type text,scope_hash text,event_hash text,fingerprint text,sealed_payload jsonb);
    CREATE TABLE chat_attachments(attach_id text,user_id uuid,message_id integer,state text,platform text,extra jsonb,storage_key text,name text,ext text,mime text,size bigint);
    CREATE TABLE projects(id integer,user_id uuid,name text,color text);CREATE TABLE folders(id integer,user_id uuid,name text);
    CREATE TABLE files(id integer,user_id uuid,display_name text,ext text,space text,workspace_directory_id integer,storage_key text,project_id integer,stage_name text,folder_id integer,mind_map_id integer,size text,size_bytes bigint,mime_type text,created_at timestamptz,deleted_at timestamptz,img_width integer,img_height integer,version integer,storage_backend text);`)
   await pool.query(imGatewaySql.fileTools)
   await pool.query('INSERT INTO users VALUES($1)',[owner]);await pool.query("INSERT INTO conversation_sessions VALUES(91,$1,'web',NULL,NULL,NULL)",[owner])
   const r=receipt(c)
   await pool.query("INSERT INTO conversation_messages VALUES(11,91,$1,'user','c2c',$2,3,'31')",[c.identity.runId,c.scope.platformUserId])
   await pool.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,91,11,$2,'dispatched','telegram','91','c2c',$3,$4,$5,$6)",[owner,c.identity.runId,r.scope_hash,r.event_hash,r.fingerprint,r.sealed_payload])
   await pool.query("INSERT INTO chat_attachments VALUES('attachment',$1,11,'attached','telegram',$2,$3,'合成报告','txt','text/plain',$4)",[owner,{im_ingress_scope:imAttachmentScopeKey(c.scope)},stored,data.length])
   await pool.query("INSERT INTO files(id,user_id,display_name,ext,storage_key,size_bytes,mime_type,created_at,version,storage_backend) VALUES(1,$1,'合成文本','txt',$2,$3,'text/plain',clock_timestamp(),1,'local')",[owner,stored,data.length])
   await work({pool,root,c})
  }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
 })
}
test('实际registry→文件ports→真实PG/本地FS→真实TG multipart，跨调用重复只发送一次且恢复不重发', {skip:!url&&'需要显式隔离PG'},async()=>fixture(async f=>{
 let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve}),blocked=new Promise<void>(resolve=>{release=resolve})
 const p=platform('telegram',async()=>{entered();await blocked});let allowed=true
 try{
  const ports=createImFileTools({...f.c,pool:f.pool,storageRoot:f.root,messageIds:['11'],files:createPostgresFileReadOperations(f.pool,null,f.root),sender:()=>p.sender,authorizeTool:async()=>allowed})
  const registry=createToolRegistry({authorize:async()=>allowed,tools:[createReadFileTool(ports.readFile!),createImSendFileTool(ports.sendFile)]})
  const scope={identity:f.c.identity,roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw Error('不能执行Shell')}}
  const read=await registry.tools.dispatch({id:'read',name:'read_file',input:{file_id:1}},scope)
  assert.equal(read.kind,'completed');if(read.kind==='completed')assert.equal((read.value as {content:string}).content,data.toString())
  const first=registry.tools.dispatch({id:'first',name:'send_file',input:{attach_id:'attachment'}},scope)
  await started
  const second=await registry.tools.dispatch({id:'second',name:'send_file',input:{attach_id:'attachment'}},scope)
  assert.deepEqual(second,{kind:'unknown'},'原发送尚未确认时不得猜测成功或再次发送')
  release()
  const result=await first
  assert.equal(result.kind,'completed');if(result.kind==='completed')assert.equal(result.successful,true);assert.ok(!('artifact' in result))
  assert.equal(p.requests.length,1);assert.match(Buffer.from(p.requests[0]!.body as Uint8Array).toString(),/合成报告\.txt/u)
  assert.equal(await ports.sendFile.recover({identity:f.c.identity,roundId:'later',toolCallId:'different',attachId:'attachment'}),'sent')
  assert.equal(p.requests.length,1)
  await f.pool.query('UPDATE files SET user_id=$1',[other])
  assert.equal(await ports.readFile!.resolveOwnedFile(f.c.identity,1,scope.signal),null)
  allowed=false
  assert.equal(await ports.sendFile.send({identity:f.c.identity,roundId:'r',toolCallId:'revoked',attachId:'attachment',signal:scope.signal}),'failed')
  assert.equal(p.requests.length,1)
 }finally{release();await p.close()}
}))
test('成员/群不注册文件库读取；未知平台结果保持持久unknown并且不重发', {skip:!url&&'需要显式隔离PG'},async()=>fixture(async f=>{
 const p=platform('telegram',()=>{throw Error('synthetic-private-failure')})
 try{
  const ports=createImFileTools({...f.c,pool:f.pool,storageRoot:f.root,messageIds:['11'],files:createPostgresFileReadOperations(f.pool,null,f.root),sender:()=>p.sender,authorizeTool:async()=>true})
  const input={identity:f.c.identity,roundId:'r',toolCallId:'one',attachId:'attachment',signal:new AbortController().signal}
  assert.equal(await ports.sendFile.send(input),'unknown')
  const count=p.requests.length
  assert.equal(await ports.sendFile.send({...input,toolCallId:'two'}),'unknown')
  assert.equal(await ports.sendFile.recover(input),'unknown');assert.equal(p.requests.length,count)
  const member=context('telegram',true)
  const limited=createImFileTools({...member,pool:f.pool,storageRoot:f.root,messageIds:['11'],files:createPostgresFileReadOperations(f.pool,null,f.root),sender:()=>p.sender,authorizeTool:async()=>true})
  assert.equal(limited.undefined);assert.equal(limited.sendFile.allowFileId,false)
  assert.equal(createImSendFileTool(limited.sendFile).validate({file_id:1}).success,false)
 }finally{await p.close()}
}))
