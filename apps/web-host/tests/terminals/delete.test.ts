import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {createTerminalDeletion} from '@gugu/core/terminals/delete'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('终端视图删除限定owner及关联会话，原子删除事件，并发只成功一次且提交后通知', {skip:!databaseUrl&&'需要隔离PostgreSQL'},async()=>{
 const owner='00000000-0000-4000-8000-000000000111',foreign='00000000-0000-4000-8000-000000000112',schema=`terminal_delete_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1}),runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const published:unknown[][]=[]
 try{
  await pool.query('CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid)')
  await pool.query('CREATE TABLE terminal_sessions(id text PRIMARY KEY,owner_id uuid,session_id integer)')
  await pool.query('CREATE TABLE terminal_events(id integer PRIMARY KEY,terminal_id text)')
  await pool.query('INSERT INTO conversation_sessions VALUES(10,$1),(20,$2)',[owner,foreign])
  await pool.query("INSERT INTO terminal_sessions VALUES('owned',$1,10),('foreign',$2,NULL),('cross-session',$1,20),('missing-session',$1,999),('concurrent',$1,NULL),('rollback',$1,NULL),('notify-failure',$1,NULL)",[owner,foreign])
  await pool.query("INSERT INTO terminal_events VALUES(1,'owned'),(2,'foreign'),(3,'rollback')")
  const remove=createTerminalDeletion(runtime.db,async(...args)=>{
   assert.equal((await pool.query('SELECT count(*)::integer AS count FROM terminal_sessions WHERE id=$1',[args[1]])).rows[0].count,0)
   published.push(args)
  })
  await assert.rejects(remove(owner,'foreign',null),(error:unknown)=>(error as {code:string}).code==='not_found')
  for(const id of ['cross-session','missing-session'])await assert.rejects(remove(owner,id,null),(error:unknown)=>(error as {statusCode:number}).statusCode===403)
  assert.deepEqual(published,[])
  assert.deepEqual(await remove(owner,'owned','synthetic-client'),{deleted:true,terminalId:'owned'})
  assert.deepEqual(published,[[owner,'owned','synthetic-client']])
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM terminal_events WHERE terminal_id='owned'")).rows[0].count,0)
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM terminal_events WHERE terminal_id='foreign'")).rows[0].count,1)
  const raced=await Promise.allSettled([remove(owner,'concurrent',null),remove(owner,'concurrent',null)])
  assert.equal(raced.filter(result=>result.status==='fulfilled').length,1)
  await pool.query("CREATE FUNCTION block_terminal_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic delete failure'; END; $$ LANGUAGE plpgsql")
  await pool.query("CREATE TRIGGER block_terminal_delete BEFORE DELETE ON terminal_sessions FOR EACH ROW WHEN (OLD.id='rollback') EXECUTE FUNCTION block_terminal_delete()")
  await assert.rejects(remove(owner,'rollback',null))
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM terminal_events WHERE terminal_id='rollback'")).rows[0].count,1)
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM terminal_sessions WHERE id='rollback'")).rows[0].count,1)
  assert.equal(published.length,2)
  assert.deepEqual(await createTerminalDeletion(runtime.db,async()=>{throw new Error('synthetic-notify-failure')})(owner,'notify-failure',null),{deleted:true,terminalId:'notify-failure'})
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM terminal_sessions WHERE id='notify-failure'")).rows[0].count,0)
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

import Fastify from 'fastify'
import {registerTerminalDeleteRoute} from '../../src/modules/terminals/routes.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'
import {CoreError} from '@gugu/core'

test('终端删除HTTP认证、可信owner、客户端origin和404响应符合Python契约',async()=>{
 const app=Fastify();installHttpErrorHandler(app)
 const calls:unknown[][]=[]
 registerTerminalDeleteRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未授权'})},ownerIdFromRequest:()=> 'trusted-owner',remove:async(...args)=>{calls.push(args);if(args[1]==='missing')throw new CoreError('not_found','终端不存在');return {deleted:true,terminalId:args[1]}}})
 try{
  assert.equal((await app.inject({method:'DELETE',url:'/api/v1/terminals/owned'})).statusCode,401);assert.deepEqual(calls,[])
  const result=await app.inject({method:'DELETE',url:'/api/v1/terminals/owned',headers:{authorization:'user','x-client-id':'synthetic-client'}})
  assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{deleted:true,terminalId:'owned'});assert.deepEqual(calls,[['trusted-owner','owned','synthetic-client']])
  const missing=await app.inject({method:'DELETE',url:'/api/v1/terminals/missing',headers:{authorization:'user'}})
  assert.equal(missing.statusCode,404);assert.deepEqual(missing.json(),{detail:'终端不存在'})
 }finally{await app.close()}
})
