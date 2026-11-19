import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname,join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/modules/agent/tools/registry.js'
import { createAgentTrashRestorePort } from '../../src/modules/agent/tools/trash/restore.js'
import { createPostgresFileRestoreOperations } from '../../src/modules/files/trash/service.js'

const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('回收站工具通过真实 PostgreSQL 和临时磁盘恢复文件及文件夹，重建收据不重做', {skip:!url&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`agent_trash_restore_${randomUUID().replaceAll('-','')}`,owner=randomUUID(),other=randomUUID()
 const admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:4})
 const core=await createPostgresRuntime({url:url!,schema}),root=await mkdtemp(join(tmpdir(),'gugu-trash-tools-'))
 try{
  await pool.query(`CREATE TABLE core_operation_receipts(owner_id uuid NOT NULL,operation_id varchar(36) NOT NULL,fingerprint varchar(64) NOT NULL,method varchar(100) NOT NULL,result_json text NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(owner_id,operation_id));
   CREATE TABLE files(id integer PRIMARY KEY,user_id uuid NOT NULL,display_name text NOT NULL,ext text NOT NULL,space text NOT NULL,project_id integer,folder_id integer,workspace_directory_id integer,stage_name text NOT NULL,mind_map_id integer,storage_key text NOT NULL,version integer NOT NULL,size text NOT NULL,size_bytes bigint NOT NULL,mime_type text,img_width integer,img_height integer,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,deleted_at timestamptz);
   CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid NOT NULL,name text NOT NULL,parent_id integer,project_id integer,workspace_directory_id integer,deleted_at timestamptz,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);
   CREATE TABLE projects(id integer PRIMARY KEY,user_id uuid,name text,start_date date,created_at timestamptz);
   CREATE TABLE workspace_directories(id integer PRIMARY KEY,user_id uuid,directory_name text,deleted_at timestamptz);
   CREATE TABLE mind_maps(id integer PRIMARY KEY,user_id uuid,title text)`)
  await pool.query("INSERT INTO folders(id,user_id,name,deleted_at) VALUES(20,$1,'资料','2026-10-02T00:00:00Z'),(30,$2,'他人',CURRENT_TIMESTAMP)",[owner,other])
  await pool.query(`INSERT INTO files(id,user_id,display_name,ext,space,folder_id,stage_name,storage_key,version,size,size_bytes,created_at,updated_at,deleted_at) VALUES
   (1,$1,'单独','txt','personal',NULL,'',$2,1,'4 B',4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
   (2,$1,'子文件','txt','personal',20,'',$3,1,'4 B',4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'2026-10-02T00:00:00Z'),
   (3,$4,'他人','txt','personal',NULL,'',$5,1,'4 B',4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
   (4,$1,'未知','txt','personal',NULL,'',$6,1,'4 B',4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
   (5,$1,'并发','txt','personal',NULL,'',$7,1,'4 B',4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,[owner,`${owner}/trash/单独.txt`,`${owner}/trash/资料/子文件.txt`,other,`${other}/trash/他人.txt`,`${owner}/trash/未知.txt`,`${owner}/trash/并发.txt`])
  for(const relative of [`${owner}/trash/单独.txt`,`${owner}/trash/资料/子文件.txt`,`${other}/trash/他人.txt`,`${owner}/trash/未知.txt`,`${owner}/trash/并发.txt`]){const path=join(root,relative);await mkdir(dirname(path),{recursive:true});await writeFile(path,'合成正文')}
  const operations=createPostgresFileRestoreOperations(pool,{storageRoot:root,publishChanged:async()=>{}})
  let allowed=true
  const options={core,trashRestore:createAgentTrashRestorePort(core,operations),authorize:async()=>allowed}
  const registry=createAgentToolRegistry(options),identity={ownerId:owner,sessionId:'1',runId:'run'}
  const scope={identity,roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不可执行')}}
  const file={id:'file',name:'restore_file',input:{file_id:1}},folder={id:'folder',name:'restore_folder',input:{folder_id:20}}
  const absent=createAgentToolRegistry({core,authorize:async()=>true})
  assert.equal((await absent.capabilities(identity)).some(item=>item.name==='restore_file'),false)
  const parentBlocked={id:'blocked',name:'restore_file',input:{file_id:2}}
  assert.match(JSON.stringify(await registry.tools.dispatch(parentBlocked,scope)),/先恢复文件夹/)
  assert.ok((await pool.query('SELECT deleted_at FROM files WHERE id=2')).rows[0].deleted_at)
  assert.deepEqual((await registry.tools.dispatch(file,scope)),{kind:'completed',successful:true,mutated:true,value:{success:true,file_id:1}})
  assert.equal(await readFile(join(root,owner,'个人文件','单独.txt'),'utf8'),'合成正文')
  assert.deepEqual((await registry.tools.dispatch(folder,scope)),{kind:'completed',successful:true,mutated:true,value:{success:true,folder_id:20,name:'资料'}})
  assert.equal(await readFile(join(root,owner,'个人文件','资料','子文件.txt'),'utf8'),'合成正文')
  const rebuilt=createAgentToolRegistry(options)
  assert.match(JSON.stringify(await rebuilt.tools.reconcile(file,{...identity,roundId:'round'})),/"success":true/)
  assert.match(JSON.stringify(await rebuilt.tools.dispatch(folder,scope)),/"mutated":false/)
  assert.match(JSON.stringify(await rebuilt.tools.dispatch(parentBlocked,scope)),/先恢复文件夹/)
  assert.equal((await rebuilt.tools.dispatch({...file,input:{file_id:2}},scope)).kind,'unknown')
  assert.match(JSON.stringify(await rebuilt.tools.dispatch({id:'nested',name:'restore_folder',input:{folder_id:30}},scope)),/文件夹不在回收站/)
  const foreign=await registry.tools.dispatch({id:'foreign',name:'restore_file',input:{file_id:3}},scope)
  assert.match(JSON.stringify(foreign),/文件不在回收站/)
  assert.ok((await pool.query('SELECT deleted_at FROM files WHERE id=3')).rows[0].deleted_at)
  let attempts=0
  const uncertain=createAgentToolRegistry({...options,trashRestore:createAgentTrashRestorePort(core,{...operations,async restore(ownerId,fileId){attempts++;await operations.restore(ownerId,fileId);throw new Error('合成提交应答丢失')}})})
  const unknown={id:'unknown',name:'restore_file',input:{file_id:4}}
  assert.equal((await uncertain.tools.dispatch(unknown,scope)).kind,'unknown')
  assert.equal(await readFile(join(root,owner,'个人文件','未知.txt'),'utf8'),'合成正文')
  assert.equal((await rebuilt.tools.dispatch(unknown,scope)).kind,'unknown')
  assert.equal(attempts,1)
  let start!:()=>void,release!:()=>void,concurrentCount=0
  const entered=new Promise<void>(resolve=>{start=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
  const concurrent=createAgentToolRegistry({...options,trashRestore:createAgentTrashRestorePort(core,{...operations,async restore(ownerId,fileId){concurrentCount++;start();await wait;await operations.restore(ownerId,fileId)}})})
  const concurrentCall={id:'concurrent',name:'restore_file',input:{file_id:5}},first=concurrent.tools.dispatch(concurrentCall,scope)
  await entered
  assert.equal((await concurrent.tools.dispatch(concurrentCall,scope)).kind,'unknown')
  release();assert.match(JSON.stringify(await first),/"success":true/)
  assert.equal(concurrentCount,1)
  allowed=false;assert.match(JSON.stringify(await registry.tools.dispatch({id:'denied',name:'restore_folder',input:{folder_id:30}},scope)),/没有权限/)
  allowed=true
  const abort=new AbortController();abort.abort()
  await assert.rejects(registry.tools.dispatch(file,{...scope,signal:abort.signal}))
 }finally{await core.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
