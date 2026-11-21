import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {registerUserBotCreateRoute} from '../../../src/modules/im/routes.js'
import {QqBotCreationError} from '../../../../../packages/core/src/im/user-bot-create.js'

test('创建仅取认证owner，BotIn DTO与Python一致，业务错误完整映射',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python,'需要显式隔离测试Python')
 const payloads=[{}, {name:' 自定义 ',app_id:' a ',app_secret:' s ',sandbox:'yes',enabled:0}, {app_id:' ',app_secret:' '}, {user_id:'forged-owner',platform:'telegram',extra:'ignored'}, {name:7},{app_id:null},{sandbox:null},{enabled:2},{sandbox:' true '}, {app_secret:false},[]]
 const expected=JSON.parse(execFileSync(python,['-c',"import json,sys;from pydantic import ValidationError;from app.api.v1.user_bots import BotIn\nresult=[]\nfor value in json.load(sys.stdin):\n try: result.append(BotIn.model_validate(value).model_dump())\n except ValidationError: result.append(None)\nprint(json.dumps(result))"],{encoding:'utf8',input:JSON.stringify(payloads),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-qq-dto'}}))
 const app=Fastify({routerOptions:{ignoreTrailingSlash:true}});let last:unknown,calls=0,error:QqBotCreationError|undefined
 registerUserBotCreateRoute(app,{requireUser:async(req,reply)=>{if(req.headers.authorization!=='user')return reply.code(401).send({detail:'未认证'})},ownerIdFromRequest:()=> 'trusted-owner',create:async(owner,body)=>{assert.equal(owner,'trusted-owner');last=body;calls++;if(error)throw error;return {id:1,platform:'qq',app_secret:'••••••'} as never}})
 try{
  const url='/api/v1/me/bots',headers={authorization:'user'}
  assert.equal((await app.inject({method:'POST',url,payload:{}})).statusCode,401);assert.equal(calls,0)
  for(const [index,payload] of payloads.entries()){
   const response=await app.inject({method:'POST',url,payload,headers});assert.equal(response.statusCode,expected[index]===null?422:200,`case ${index}`)
   if(expected[index]!==null){assert.deepEqual(last,expected[index]);assert.doesNotMatch(response.body,/forged-owner|app_id/)}
  }
  assert.equal((await app.inject({method:'POST',url:url+'/',payload:{},headers})).statusCode,200)
  assert.equal((await app.inject({method:'POST',url,headers})).statusCode,422)
  for(const [code,status] of [['platform_disabled',503],['invalid_credentials',400],['already_exists',409]] as const){error=new QqBotCreationError(code,'合成业务错误');const response=await app.inject({method:'POST',url,payload:{},headers});assert.equal(response.statusCode,status);assert.deepEqual(response.json(),{detail:'合成业务错误'})}
 }finally{await app.close()}
})
