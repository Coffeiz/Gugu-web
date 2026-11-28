import type {LightMyRequestResponse} from 'fastify'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createUserToken } from '../../../../src/modules/auth/session/token.js'
import { startServer } from '../../../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

test('生产main经管理员认证调用Core聚合四接口', {skip:!databaseUrl && '需要隔离PostgreSQL'},async()=>{
 const schema=`analytics_main_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl}),root=await mkdtemp(join(tmpdir(),'analytics-main-'))
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema} -c jit=off`)
 const pool=new Pool({connectionString:scoped.toString()});let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  await pool.query('CREATE TABLE users(id int,is_developer boolean);CREATE TABLE frontend_events(user_id int,event text,properties jsonb);CREATE TABLE conversation_sessions(id int,user_id int);CREATE TABLE conversation_messages(session_id int,role text);CREATE TABLE agent_usage(user_id int,is_byok boolean,tools_used jsonb,created_at timestamptz);CREATE TABLE projects(user_id int,updated_at timestamptz);CREATE TABLE calendar_events(user_id int,created_at timestamptz);CREATE TABLE files(user_id int,updated_at timestamptz,deleted_at timestamptz);CREATE TABLE scheduled_tasks(user_id int,last_run_at timestamptz)')
  await pool.query(`INSERT INTO users VALUES(1,false),(2,true);INSERT INTO conversation_sessions VALUES(1,1),(2,2);INSERT INTO conversation_messages VALUES(1,'user'),(2,'user');INSERT INTO frontend_events VALUES(1,'chat_open','{}'),(1,'chat_message','{"turn":3}');INSERT INTO agent_usage VALUES(1,false,'["read","read"]',now())`)
  const overridePath=join(root,'config.json');await writeFile(overridePath,'{}')
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:'synthetic-analytics-secret',GUGU_CONFIG_OVERRIDE_FILE:overridePath,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const paths=['session-depth','chat-funnel','tool-distribution','active-dimensions']
  for(const path of ['summary','trends'])assert.equal((await host.app.inject({url:`/api/v1/admin/analytics/${path}`})).statusCode,401)
  for(const path of paths)assert.equal((await host.app.inject({url:`/api/v1/admin/analytics/${path}`})).statusCode,401)
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
  assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  const bodies=[]
  for(const path of paths){const response:LightMyRequestResponse=await host.app.inject({url:`/api/v1/admin/analytics/${path}?exclude_dev=YES&include_byok=0`,headers});assert.equal(response.statusCode,200,response.body);bodies.push(response.json())}
  assert.equal(bodies[0].total_users,1);assert.equal(bodies[1].chat_msg_3,1);assert.deepEqual(bodies[2],[{tool:'read',calls:2}]);assert.equal(bodies[3].dimensions[0].users,1)
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})

test('分析summary和trends生产入口提供完整统计契约', {skip:!databaseUrl && '需要隔离PostgreSQL'},async()=>{
 const schema=`analytics_extended_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl}),root=await mkdtemp(join(tmpdir(),'analytics-extended-'))
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema} -c jit=off`)
 const pool=new Pool({connectionString:scoped.toString()});let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  await pool.query(`CREATE TABLE users(id int,is_developer boolean,created_at timestamptz,last_active_at timestamptz);CREATE TABLE frontend_events(user_id int,event text,properties jsonb,created_at timestamptz);CREATE TABLE conversation_sessions(id int,user_id int,source text);CREATE TABLE agent_usage(user_id int,is_byok boolean,created_at timestamptz,tokens_in bigint,tokens_out bigint,scenario text,input_source text,session_id int);CREATE TABLE projects(id int,user_id int,created_at timestamptz,updated_at timestamptz,done_at timestamptz,archived boolean,status text);CREATE TABLE onboarding_state(state jsonb);CREATE TABLE user_bots(user_id int,platform text,enabled boolean)`)
  await pool.query(`INSERT INTO users VALUES(1,false,now()-interval '40 days',now()),(2,true,now(),now());INSERT INTO conversation_sessions VALUES(1,1,'qq');INSERT INTO agent_usage VALUES(1,false,now(),10,3,'chat',NULL,1),(2,false,now(),20,4,'chat','web',NULL);INSERT INTO user_bots VALUES(1,'qq',true);INSERT INTO projects VALUES(1,1,now(),now(),NULL,false,'active')`)
  const overridePath=join(root,'config.json');await writeFile(overridePath,'{}')
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:'synthetic-analytics-extended-secret',GUGU_CONFIG_OVERRIDE_FILE:overridePath,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
  assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  const summary=await host.app.inject({url:'/api/v1/admin/analytics/summary?exclude_dev=true&timezone=UTC',headers})
  const trends=await host.app.inject({url:'/api/v1/admin/analytics/trends?days=7&exclude_dev=true&timezone=UTC',headers})
  assert.deepEqual([summary.statusCode,trends.statusCode],[200,200])
  assert.equal(summary.statusCode,200,summary.body);assert.equal(summary.json().users.total,1);assert.equal(summary.json().agent.total_calls,1);assert.equal(summary.json().im_bots.users_with_bot,1)
  assert.equal(trends.statusCode,200,trends.body);assert.equal(trends.json().labels.length,7);assert.equal(trends.json().agent_calls.at(-1),1);assert.equal(trends.json().agent_tokens.at(-1),13);assert.equal(trends.json().interactions_by_source.qq.at(-1),1);assert.equal(trends.json().interactions_by_source.web.at(-1),0)
  for(const days of ['6','91','bad'])assert.equal((await host.app.inject({url:`/api/v1/admin/analytics/trends?days=${days}`,headers})).statusCode,422)
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
