import {connect} from 'node:net'
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
  const socket = createServer()
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  return address.port
}

import {encryptEncryptedString} from '../../../../src/adapters/security/encrypted-string.js'
test('生产main按认证owner读取Bot且动态IM开关热更新，兼容两种斜杠路径', {skip:!databaseUrl&&'需要隔离PostgreSQL'},async()=>{
 const redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL
 const schema=`bots_main_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString()}),root=await mkdtemp(join(tmpdir(),'bots-main-')),path=join(root,'override.json'),owner=randomUUID(),other=randomUUID(),secret='synthetic-bots-main-secret'
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,username text,display_name text,email text,is_active boolean,account_status text,security_version integer,avatar text,created_at timestamptz,timezone text,email_subscribed boolean,last_active_at timestamptz)`)
await pool.query('CREATE TABLE user_bots(id serial PRIMARY KEY,user_id uuid,platform text,name text,app_id text,app_secret text,sandbox boolean,enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean,group_requires_at boolean,group_read_enabled boolean,group_memory_enabled boolean,group_owner_memory_enabled boolean,member_memory_enabled boolean,group_attention_mode text,group_allowed_tools jsonb,group_message_format text,private_message_format text,private_streaming_enabled boolean,owner_platform_user_id text,owner_bound_at timestamptz)')
  await pool.query(`INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at) VALUES($1,'小北','owner@example.test',true,'active',1,now()),($2,'小南','other@example.test',true,'active',1,now())`,[owner,other])
  await pool.query(`INSERT INTO user_bots(user_id,platform,name,app_id,app_secret,enabled,group_requires_at) VALUES($1,'qq','合成机器人','synthetic-app',$3,true,true),($2,'qq','他人机器人','other-app',$3,true,true)`,[owner,other,encryptEncryptedString(secret,'abcdefghi')])
  await pool.query("UPDATE user_bots SET owner_platform_user_id='synthetic-owner',owner_bound_at=now()")
  await writeFile(path,JSON.stringify({im:{qq:true,feishu:false,wechat:false,telegram:false}}))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:path,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:redisUrl??'',IM__QQ:'false'})
  assert.equal((await host.app.inject({url:'/api/v1/me/bots'})).statusCode,401)
  const headers={authorization:`Bearer ${createUserToken(owner,1,secret)}`}
  for(const url of ['/api/v1/me/bots','/api/v1/me/bots/']) {
   const response:LightMyRequestResponse=await host.app.inject({url,headers});assert.equal(response.statusCode,200,response.body)
   assert.deepEqual(response.json().supported_platforms,['qq']);assert.equal(response.json().items.length,1);assert.equal(response.json().items[0].app_secret,'abc••••••hi')
  }
  await writeFile(path,JSON.stringify({im:{qq:false,feishu:true,wechat:false,telegram:false}}))
  const updated=await host.app.inject({url:'/api/v1/me/bots',headers});assert.deepEqual(updated.json().supported_platforms,['feishu']);assert.equal(updated.json().items.length,1)
  if(redisUrl){
   const target=new URL(redisUrl),subscriber=connect(Number(target.port),target.hostname)
   try{
    await new Promise<void>((resolve,reject)=>{subscriber.once('connect',resolve);subscriber.once('error',reject)})
    const ready=new Promise<void>((resolve,reject)=>{subscriber.once('data',()=>resolve());subscriber.once('error',reject)})
    const channel=`events:${owner}`;subscriber.write(`*2\r\n$9\r\nSUBSCRIBE\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n`);await ready
    const received=new Promise<string>((resolve,reject)=>{let content='';const timer=setTimeout(()=>reject(new Error('未收到解绑事件')),3000);subscriber.on('data',data=>{content+=data.toString();if(content.includes('"resource":"im_channels"')){clearTimeout(timer);resolve(content)}})})
    const denied=await host.app.inject({method:'DELETE',url:'/api/v1/me/bots/2/qq-binding',headers});assert.equal(denied.statusCode,404)
    const unbound=await host.app.inject({method:'DELETE',url:'/api/v1/me/bots/1/qq-binding',headers});assert.equal(unbound.statusCode,204)
    const event=await received;assert.ok(event.includes('"operation":"refresh"'));assert.equal(event.includes('abcdefghi'),false)
    const row=(await pool.query('SELECT owner_platform_user_id,owner_bound_at,app_secret FROM user_bots WHERE id=1')).rows[0];assert.equal(row.owner_platform_user_id,null);assert.equal(row.owner_bound_at,null);assert.ok(row.app_secret.startsWith('gcm1:'))
   }finally{subscriber.destroy()}
  }
  const isolated=await host.app.inject({url:'/api/v1/me/bots',headers:{authorization:`Bearer ${createUserToken(other,1,secret)}`}});assert.equal(isolated.json().items[0].name,'他人机器人')
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
