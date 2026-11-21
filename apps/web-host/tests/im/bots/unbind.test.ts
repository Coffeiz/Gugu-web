import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {registerUserBotUnbindRoute,createPostgresUserBotUnbinder} from '../../../src/modules/im/connect/unbind.js'
test('解绑仅当前owner的QQ身份，保留凭据、拒绝越权并在提交后通知',async()=>{
 const connectionString=process.env.GUGU_WEBUI_TEST_DATABASE_URL;assert.ok(connectionString)
 const schema=`bot_unbind_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString,options:`-c search_path=${schema}`}),app=Fastify(),owner=randomUUID(),other=randomUUID();let published=0
 registerUserBotUnbindRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='owner')return reply.code(401).send({detail:'未登录'})},ownerIdFromRequest:()=>owner,unbind:createPostgresUserBotUnbinder(pool,async(id)=>{assert.equal(id,owner);assert.equal((await pool.query('SELECT owner_platform_user_id FROM user_bots WHERE id=1')).rows[0].owner_platform_user_id,null);published++})})
 try{
  await pool.query('CREATE TABLE user_bots(id int PRIMARY KEY,user_id uuid,platform text,app_secret text,owner_platform_user_id text,owner_bound_at timestamptz)')
  await pool.query("INSERT INTO user_bots VALUES(1,$1,'qq','secret-cipher','synthetic-owner',now()),(2,$2,'qq','other-cipher','other-owner',now()),(3,$1,'telegram','other-cipher','third-owner',now())",[owner,other])
  assert.equal((await app.inject({method:'DELETE',url:'/api/v1/me/bots/1/qq-binding'})).statusCode,401)
  for(const id of [2,3,99])assert.equal((await app.inject({method:'DELETE',url:`/api/v1/me/bots/${id}/qq-binding`,headers:{authorization:'owner'}})).statusCode,404)
  for(let i=0;i<2;i++)assert.equal((await app.inject({method:'DELETE',url:'/api/v1/me/bots/1/qq-binding',headers:{authorization:'owner'}})).statusCode,204)
  assert.equal(published,2)
  assert.deepEqual((await pool.query('SELECT app_secret,owner_platform_user_id,owner_bound_at FROM user_bots WHERE id=1')).rows[0],{app_secret:'secret-cipher',owner_platform_user_id:null,owner_bound_at:null})
  assert.equal((await pool.query('SELECT owner_platform_user_id FROM user_bots WHERE id=2')).rows[0].owner_platform_user_id,'other-owner')
 }finally{await app.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
