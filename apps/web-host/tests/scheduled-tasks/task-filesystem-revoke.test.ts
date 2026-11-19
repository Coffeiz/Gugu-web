import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {createTaskFilesystemRevoker} from '@gugu/core/scheduled-task-filesystem-revoke'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('任务撤权限定owner及普通任务，幂等清授权并同事务审计，失败回滚数据库', {skip:!databaseUrl&&'需要隔离PostgreSQL'},async()=>{
 const schema=`task_revoke_${randomUUID().replaceAll('-','')}`,owner='00000000-0000-4000-8000-000000000091',foreign='00000000-0000-4000-8000-000000000092'
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1}),runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const confirmations:unknown[][]=[];let metrics=0
 try{
  await pool.query('CREATE TABLE scheduled_tasks(id integer PRIMARY KEY,user_id uuid,event_id integer,name text,filesystem_authorization_grant_id integer,updated_at timestamptz)')
  await pool.query('CREATE TABLE filesystem_authorization_grants(id integer PRIMARY KEY,user_id uuid,revoked_at timestamptz,updated_at timestamptz)')
  await pool.query('CREATE TABLE security_events(user_id uuid,event_type text,resource_type text,resource_fingerprint text,owner_fingerprint text,client_fingerprint text,ip_fingerprint text,user_agent_fingerprint text,action text,reason_code text,metadata_json json,occurred_at timestamptz,expires_at timestamptz)')
  await pool.query("INSERT INTO scheduled_tasks VALUES(1,$1,NULL,'合成任务',1,NULL),(2,$2,NULL,'其他任务',2,NULL),(3,$1,10,'日历提醒',3,NULL),(4,$1,NULL,'失败任务',4,NULL),(5,$1,NULL,'脏引用',2,NULL)",[owner,foreign])
  await pool.query('INSERT INTO filesystem_authorization_grants(id,user_id) VALUES(1,$1),(2,$2),(3,$1),(4,$1)',[owner,foreign])
  const revoke=createTaskFilesystemRevoker(runtime.db,{revokeConfirmation:async(...args)=>{confirmations.push(args)},fingerprint:()=> 'synthetic-fingerprint',recordMetric:async()=>{metrics++}})
  for(const id of [2,3,99])await assert.rejects(revoke(owner,id),(error:unknown)=>(error as {code:string}).code==='not_found')
  assert.deepEqual(confirmations,[])
  assert.deepEqual(await revoke(owner,1),{status:'revoked',task_id:1,revoked:true})
  assert.equal((await pool.query('SELECT filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=1')).rows[0].filesystem_authorization_grant_id,null)
  assert.ok((await pool.query('SELECT revoked_at FROM filesystem_authorization_grants WHERE id=1')).rows[0].revoked_at)
  const audit=(await pool.query('SELECT * FROM security_events')).rows[0]
  assert.equal(audit.user_id,owner);assert.equal(audit.reason_code,'revoked');assert.equal(audit.resource_fingerprint,'synthetic-fingerprint')
  assert.deepEqual(audit.metadata_json,{subject_type:'scheduled_task',subject_id:'1',grant_id:'1',scope:'user_sandbox',operation:'authorization',outcome:'revoked',source:'system'})
  assert.deepEqual(await revoke(owner,1),{status:'revoked',task_id:1,revoked:false})
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM security_events')).rows[0].count,1)
  assert.equal((confirmations[0] as string[])[2],'scheduled-task:filesystem:1')
  assert.equal(metrics,1)
  assert.deepEqual(await revoke(owner,5),{status:'revoked',task_id:5,revoked:false})
  assert.equal((await pool.query('SELECT revoked_at FROM filesystem_authorization_grants WHERE id=2')).rows[0].revoked_at,null)
  await pool.query('DROP TABLE security_events')
  await assert.rejects(revoke(owner,4))
  assert.equal((await pool.query('SELECT filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=4')).rows[0].filesystem_authorization_grant_id,4)
  assert.equal((await pool.query('SELECT revoked_at FROM filesystem_authorization_grants WHERE id=4')).rows[0].revoked_at,null)
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

import Fastify from 'fastify'
import {registerTaskFilesystemRevokeRoute} from '../../src/modules/scheduled-tasks/access.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'
import {CoreError} from '@gugu/core'

test('任务撤权HTTP只使用可信owner，认证拒绝及404/参数/成功响应符合契约',async()=>{
 const app=Fastify();installHttpErrorHandler(app)
 const calls:unknown[][]=[]
 registerTaskFilesystemRevokeRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未授权'})},ownerIdFromRequest:()=> 'trusted-owner',revoke:async(owner,id)=>{calls.push([owner,id]);if(id===2)throw new CoreError('not_found','定时任务不存在');return {status:'revoked',task_id:id,revoked:true}}})
 try{
  assert.equal((await app.inject({method:'DELETE',url:'/api/v1/scheduled-tasks/1/filesystem-authorization'})).statusCode,401);assert.deepEqual(calls,[])
  const result=await app.inject({method:'DELETE',url:'/api/v1/scheduled-tasks/1/filesystem-authorization',headers:{authorization:'user'}})
  assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{status:'revoked',task_id:1,revoked:true});assert.deepEqual(calls,[['trusted-owner',1]])
  assert.equal((await app.inject({method:'DELETE',url:'/api/v1/scheduled-tasks/bad/filesystem-authorization',headers:{authorization:'user'}})).statusCode,422)
  const missing=await app.inject({method:'DELETE',url:'/api/v1/scheduled-tasks/2/filesystem-authorization',headers:{authorization:'user'}})
  assert.equal(missing.statusCode,404);assert.deepEqual(missing.json(),{detail:'定时任务不存在'})
 }finally{await app.close()}
})
