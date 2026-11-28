import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,rm,readdir,readlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {test} from 'node:test'
import {Kysely,PostgresDialect} from 'kysely'
import {createHarnessExecutor} from '@gugu/core/executor/runtime'
import {MxcExecutor} from '../../../../../../packages/sandbox/dist/mxc.js'
import {createImHarnessExecutorPorts} from '../../../../src/modules/im/gateway/agent/execute.js'
import {context} from '../run-sender.fixtures.js'

const url=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
async function fixture(work:(f:{pool:import('pg').Pool;db:Kysely<unknown>;root:string;c:ReturnType<typeof context>})=>Promise<void>){
 const {Pool}=await import('pg'),schema=`im_exec_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`}),db=new Kysely({dialect:new PostgresDialect({pool})}),root=await mkdtemp(join(tmpdir(),'gugu-im-exec-')),c=context()
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await pool.query(`CREATE TABLE conversation_sessions(id integer,user_id uuid,workspace_id integer);
   CREATE TABLE filesystem_authorization_grants(user_id uuid,subject_type text,subject_id varchar(64),scope text,permission text,revoked_at timestamptz,expires_at timestamptz);
   CREATE TABLE workspaces(id integer,user_id uuid,name text,kind text,project_id integer,directory_id integer,enabled boolean);
   CREATE TABLE workspace_directories(id integer,user_id uuid,name text,directory_name text,is_default boolean,deleted_at timestamptz);`)
  await pool.query('INSERT INTO conversation_sessions VALUES(91,$1,1)',[c.identity.ownerId])
  await pool.query("INSERT INTO workspaces VALUES(1,$1,'合成工作区','directory',NULL,1,true)",[c.identity.ownerId])
  await pool.query("INSERT INTO workspace_directories VALUES(1,$1,'合成工作区','synthetic',true,NULL)",[c.identity.ownerId])
  for(const key of ['workspace/synthetic','个人文件','项目文件'])await mkdir(join(root,c.identity.ownerId,key),{recursive:true})
  await work({pool,db,root,c})
 }finally{await db.destroy();await pool.end().catch(()=>{});await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
}
const scope=(c:ReturnType<typeof context>)=>({...c.identity,roundId:'synthetic-round',toolCallId:'synthetic-call'})
const request=(_label?:string)=>({id:randomUUID(),command:'printf synthetic',cwd:'.',timeoutMs:1000,destructive:false})
test('管理员关闭完整用户沙箱授权时，IM 执行器在检查授权和创建执行器前拒绝', async () => {
 const {Pool}=await import('pg')
 const pool=new Pool(),db=new Kysely({dialect:new PostgresDialect({pool})}),c=context()
 let authorized=false
 try {
  const ports=createImHarnessExecutorPorts({pool,db,storageRoot:tmpdir(),identity:c.identity,actor:c.actor,
   enabled:()=>false,authorize:async()=>{authorized=true;return true}})
  await assert.rejects(createHarnessExecutor(ports).execute(scope(c),request()),/执行授权被拒绝/u)
  assert.equal(authorized,false)
 } finally { await db.destroy(); await pool.end() }
})
test('真实PG授权表：缺grant、过期/撤销、跨Run/成员及危险命令未确认都在加载后端前拒绝', {skip:!url&&'需要显式隔离PG'},async()=>fixture(async f=>{
 let loads=0
 const ports=createImHarnessExecutorPorts({pool:f.pool,db:f.db,storageRoot:f.root,identity:f.c.identity,actor:f.c.actor,authorize:async()=>true,backend:async()=>{loads++;throw Error('不应加载')}})
 const executor=createHarnessExecutor(ports)
 await assert.rejects(executor.execute(scope(f.c),request()),/执行授权被拒绝/u)
 await f.pool.query("INSERT INTO filesystem_authorization_grants VALUES($1,'session','91','user_sandbox','read_write',NULL,clock_timestamp()-interval '1 second')",[f.c.identity.ownerId])
 await assert.rejects(executor.execute(scope(f.c),request()),/执行授权被拒绝/u)
 await f.pool.query('UPDATE filesystem_authorization_grants SET expires_at=NULL,revoked_at=clock_timestamp()')
 await assert.rejects(executor.execute(scope(f.c),request()),/执行授权被拒绝/u)
 await f.pool.query('UPDATE filesystem_authorization_grants SET revoked_at=NULL')
 await assert.rejects(executor.execute({...scope(f.c),runId:'forged-run'},request()),/执行授权被拒绝/u)
 await assert.rejects(executor.execute(scope(f.c),{...request(),command:'rm -rf synthetic',destructive:false}),/执行授权被拒绝/u)
 const member=context('telegram',true)
 const limited=createHarnessExecutor(createImHarnessExecutorPorts({pool:f.pool,db:f.db,storageRoot:f.root,identity:member.identity,actor:member.actor,authorize:async()=>true}))
 await assert.rejects(limited.execute(scope(member),request()),/执行授权被拒绝/u)
 assert.equal(loads,0)
}))
test('Linux真实PG/安全挂载→正式Harness/Executor/MxcExecutor，原生spawn替身；取消/后端加载期间撤权释放所有目录FD', {skip:!url?'需要显式隔离PG':process.platform!=='linux'&&'安全目录钉住仅Linux，需显式Linux Node运行'},async()=>fixture(async f=>{
 await f.pool.query("INSERT INTO filesystem_authorization_grants VALUES($1,'session','91','user_sandbox','read_write',NULL,NULL)",[f.c.identity.ownerId])
 const opened=async()=>{const result:string[]=[];for(const id of await readdir('/proc/self/fd')){try{const value=await readlink(`/proc/self/fd/${id}`);if(value.startsWith(f.root))result.push(value)}catch{}}return result.sort()}
 const baseline=await opened();let requests=0
 const ports=createImHarnessExecutorPorts({pool:f.pool,db:f.db,storageRoot:f.root,identity:f.c.identity,actor:f.c.actor,authorize:async()=>true,
  backend:async()=>new MxcExecutor(async input=>{
   requests++;assert.equal(input.network.egress.default,'deny');assert.equal(input.ui.disable,true);assert.equal(input.inheritDefaultEnvironment,false)
   assert.ok(input.filesystem.readwritePaths.length>=3)
   assert.equal(await readlink(input.workingDirectory),join(f.root,f.c.identity.ownerId,'workspace/synthetic'))
   // 仅测试的原生SDK替身；子进程实际运行，但不宣称此替身提供MXC隔离。
   const child=spawn('/bin/sh',['-c',input.command],{cwd:input.workingDirectory,env:input.environment,stdio:['ignore','pipe','pipe']})
   const done=new Promise<{exitCode:number;timedOut:boolean}>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve({exitCode:code??1,timedOut:false}))})
   return {standardOutput:child.stdout,standardError:child.stderr,kill(){child.kill('SIGKILL')},wait:()=>done,dispose(){child.stdout.destroy();child.stderr.destroy()}}
  },'bubblewrap')})
 const result=await createHarnessExecutor(ports).execute(scope(f.c),request())
 assert.equal(result.stdout,'synthetic');assert.equal(requests,1);assert.deepEqual(await opened(),baseline)
 const abort=new AbortController();await ports.authorize(scope(f.c),request('abort-before-execute'),abort.signal);abort.abort();await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(await opened(),baseline)
 const changed=createHarnessExecutor(createImHarnessExecutorPorts({pool:f.pool,db:f.db,storageRoot:f.root,identity:f.c.identity,actor:f.c.actor,authorize:async()=>true,
  backend:async()=>{await f.pool.query('UPDATE filesystem_authorization_grants SET revoked_at=clock_timestamp()');return new MxcExecutor(async()=>{assert.fail('撤权后不能启动进程')})}}))
 await assert.rejects(changed.execute(scope(f.c),request('grant-revoked')),/执行授权被拒绝/u)
 assert.deepEqual(await opened(),baseline)
}))
