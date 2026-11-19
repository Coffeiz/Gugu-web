import assert from 'node:assert/strict'
import test from 'node:test'
import {readSessionDepth} from '../../src/modules/admin/analytics.js'
test('会话深度按每用户最深会话归档并保留空档位',async()=>{
 const result=await readSessionDepth(async()=>({rows:[{max_turns:1},{max_turns:3},{max_turns:4},{max_turns:30},{max_turns:31}]}),false)
 assert.deepEqual(result,{buckets:[{label:'1',users:1},{label:'2-3',users:1},{label:'4-10',users:1},{label:'11-30',users:1},{label:'30+',users:1}],total_users:5})
})
import {Pool} from 'pg'
import {randomUUID} from 'node:crypto'
import {readChatFunnel,readToolDistribution,readActiveDimensions} from '../../src/modules/admin/analytics.js'
test('真实PG按用户去重、开发者/BYOK过滤和最近七天维度聚合',async()=>{
 const connectionString=process.env.GUGU_WEBUI_TEST_DATABASE_URL;assert.ok(connectionString)
 const admin=new Pool({connectionString}),schema=`analytics_${randomUUID().replaceAll('-','')}`
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString,options:`-c search_path=${schema}`})
 const query=async(sql:string,params:unknown[])=>pool.query(sql,params)
 try {
  await pool.query('CREATE TABLE users(id int PRIMARY KEY,is_developer boolean);CREATE TABLE frontend_events(user_id int,event text,properties jsonb);CREATE TABLE agent_usage(user_id int,is_byok boolean,tools_used jsonb,created_at timestamptz);CREATE TABLE conversation_sessions(id int,user_id int);CREATE TABLE conversation_messages(session_id int,role text);CREATE TABLE projects(user_id int,updated_at timestamptz);CREATE TABLE calendar_events(user_id int,created_at timestamptz);CREATE TABLE files(user_id int,updated_at timestamptz,deleted_at timestamptz);CREATE TABLE scheduled_tasks(user_id int,last_run_at timestamptz)')
  await pool.query(`INSERT INTO users VALUES(1,false),(2,true),(3,false);INSERT INTO conversation_sessions VALUES(1,1),(2,1),(3,2);INSERT INTO conversation_messages VALUES(1,'user'),(2,'user'),(2,'user'),(2,'assistant'),(3,'user');INSERT INTO frontend_events VALUES(1,'chat_open','{}'),(1,'chat_message','{"turn":3}'),(1,'chat_message','{"turn":4}'),(2,'chat_expanded','{}');INSERT INTO agent_usage VALUES(1,false,'["read","read","write"]','2026-11-14'),(2,false,'["read"]','2026-11-14'),(3,true,'["paid"]','2026-11-14');INSERT INTO files VALUES(1,'2026-11-14',NULL),(2,'2026-11-14',NULL),(3,'2026-11-14','2026-11-14');INSERT INTO projects VALUES(1,'2026-11-01'),(2,'2026-11-14')`)
  assert.deepEqual(await readSessionDepth(query,true),{buckets:[{label:'1',users:0},{label:'2-3',users:1},{label:'4-10',users:0},{label:'11-30',users:0},{label:'30+',users:0}],total_users:1})
  assert.deepEqual(await readChatFunnel(query,true),{chat_opened:1,chat_msg_1:1,chat_msg_3:1,chat_expanded:0})
  assert.deepEqual(await readToolDistribution(query,true,false),[{tool:'read',calls:2},{tool:'write',calls:1}])
  assert.equal((await readToolDistribution(query,false,true)).find(item=>item.tool==='paid')?.calls,1)
  const active=await readActiveDimensions(query,true,false,new Date('2026-11-15T00:00:00Z'))
  assert.deepEqual(active.dimensions.map(row=>row.users),[1,0,0,1,0])
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
import Fastify from 'fastify'
import {registerAdminAnalyticsRoutes} from '../../src/modules/admin/analytics.js'
test('分析四接口均校验管理员身份，支持过滤并拒绝错误布尔参数',async()=>{
 const app=Fastify();let queried=0
 registerAdminAnalyticsRoutes(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(401).send({detail:'未登录'})},query:async()=>{queried++;return {rows:[]}}})
 try{
  for(const path of ['session-depth','tool-distribution','chat-funnel','active-dimensions'])assert.equal((await app.inject({url:`/api/v1/admin/analytics/${path}`})).statusCode,401)
  assert.equal(queried,0)
  const response=await app.inject({url:'/api/v1/admin/analytics/session-depth?exclude_dev=true',headers:{authorization:'admin'}})
  assert.equal(response.statusCode,200);assert.equal(response.json().total_users,0)
  for(const value of ['YES','1','on','t','y','FALSE','0','off','n']) assert.equal((await app.inject({url:`/api/v1/admin/analytics/session-depth?exclude_dev=${value}`,headers:{authorization:'admin'}})).statusCode,200)
  assert.equal((await app.inject({url:'/api/v1/admin/analytics/session-depth?exclude_dev=bad',headers:{authorization:'admin'}})).statusCode,422)
 }finally{await app.close()}
})
import {readAnalyticsSummary} from '../../src/modules/admin/analytics.js'
test('summary保留Python四位偶数舍入，1/32不向上偏移',async()=>{
 const result=await readAnalyticsSummary(async()=>({rows:[{summary:{users:{total:32},im_bots:{users_with_bot:1},funnel:{cohort_7d:32,retained_7d:1,cohort_30d:0,retained_30d:0}}}]}),new Date(),new Date(),false,false)
 assert.equal(result.im_bots!.adoption_rate,0.0312);assert.equal(result.funnel!.retention_7d,0.0312)
})
