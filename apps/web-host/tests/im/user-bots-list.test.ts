import {readFile} from 'node:fs/promises'
import {decryptEncryptedString} from '../../src/adapters/security/encrypted-string.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {Pool} from 'pg'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import { createPostgresUserBotsReader } from '../../src/modules/im/bots.js'
import { registerUserBotsListRoute } from '../../src/modules/im/routes.js'
import {encryptEncryptedString as encryptSmtpPassword} from '../../src/adapters/security/encrypted-string.js'
test('Bot列表仅当前owner、真实密文遮蔽、旧模式和工具白名单规范化',async()=>{
 const connectionString=process.env.GUGU_WEBUI_TEST_DATABASE_URL;assert.ok(connectionString)
 const schema=`bots_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString,options:`-c search_path=${schema}`}),app=Fastify({routerOptions:{ignoreTrailingSlash:true}}),owner=randomUUID(),other=randomUUID(),secret='synthetic-bot-secret'
 registerUserBotsListRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='owner')return reply.code(401).send({detail:'未登录'})},ownerIdFromRequest:()=>owner,readBots:createPostgresUserBotsReader(pool,secret,()=>['qq','telegram'])})
 try{
  await pool.query('CREATE TABLE user_bots(id serial PRIMARY KEY,user_id uuid,platform text,name text,app_id text,app_secret text,sandbox boolean,enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean,group_requires_at boolean,group_read_enabled boolean,group_memory_enabled boolean,group_owner_memory_enabled boolean,member_memory_enabled boolean,group_attention_mode text,group_allowed_tools jsonb,group_message_format text,private_message_format text,private_streaming_enabled boolean,owner_platform_user_id text)')
  await pool.query(`INSERT INTO user_bots(user_id,platform,name,app_id,app_secret,enabled,group_requires_at,group_read_enabled,group_attention_mode,group_allowed_tools,group_message_format,private_message_format,owner_platform_user_id) VALUES($1,'qq','测试机器人','synthetic-app',$3,true,true,true,'old','["web_search","web_search","similar_image_search","delete_file"]','old','old','synthetic-owner'),($2,'qq','他人机器人','other-app',$3,true,false,false,'quiet',NULL,'compat','markdown',NULL)`,[owner,other,encryptSmtpPassword(secret,'abcdefghi')])
  assert.equal((await app.inject({url:'/api/v1/me/bots/'})).statusCode,401)
  assert.equal((await app.inject({url:'/api/v1/me/bots',headers:{authorization:'owner'}})).statusCode,200)
  const response=await app.inject({url:'/api/v1/me/bots/',headers:{authorization:'owner'}});assert.equal(response.statusCode,200)
  const body=response.json();assert.deepEqual(body.supported_platforms,['qq','telegram']);assert.equal(body.items.length,1)
  const bot=body.items[0];assert.equal(bot.app_secret,'abc••••••hi');assert.equal(bot.owner_bound,true);assert.equal(bot.group_response_mode,'record_only');assert.equal(bot.group_attention_mode,'autonomous');assert.equal(bot.group_message_format,'compat');assert.equal(bot.private_message_format,'markdown')
  assert.deepEqual(bot.group_allowed_tools,['web_search','http_get','similar_image_search','read_file'])
  assert.equal(response.body.includes('abcdefghi'),false);assert.equal(response.body.includes('gcm1:'),false);assert.equal(response.body.includes(other),false)
 }finally{await app.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

test('Python实际密文跨语言解密及损坏/换密钥行为与Python一致',async()=>{
 const token=(await readFile(new URL('./fixtures/python-bot-ciphertext.txt',import.meta.url),'utf8')).trim()
 assert.equal(decryptEncryptedString('synthetic-bot-secret',token),'abcdefghi')
 assert.equal(decryptEncryptedString('wrong-key',token),token)
 assert.equal(decryptEncryptedString('synthetic-bot-secret','gcm1:broken'),'gcm1:broken')
})
