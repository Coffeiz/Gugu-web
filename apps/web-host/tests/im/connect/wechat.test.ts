import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerWechatConnectRoutes,createWechatConnectHostOptions} from '../../../src/modules/im/connect/platforms/wechat/index.js'
import {createWechatPairing,WechatConnectionError} from '@gugu/gateway/wechat'
import {installHttpErrorHandler} from '../../../src/http/errors.js'

test('微信扫码Host鉴权先于网络，owner仅取可信上下文，错误不包含上游内容',async()=>{
 const app=Fastify();installHttpErrorHandler(app);const owner='00000000-0000-4000-8000-000000000101';let called=0,failure:Error|undefined
 const work=async(who:string)=>{called++;assert.equal(who,owner);if(failure)throw failure;return {task_id:'synthetic-task',scan_url:'https://scan.example.invalid/q/synthetic'}}
 registerWechatConnectRoutes(app,{requireUser:async(request,reply)=>{if(!request.headers.authorization)return reply.code(401).send({detail:'未登录'})},ownerIdFromRequest:()=>owner,connect:{start:work,poll:async who=>{await work(who);return {status:'waiting'}}}})
 try{
  const base='/api/v1/me/wechat/connect',headers={authorization:'synthetic-user'}
  assert.equal((await app.inject({method:'POST',url:base})).statusCode,401);assert.equal((await app.inject({method:'GET',url:`${base}/synthetic-task`})).statusCode,401);assert.equal(called,0)
  assert.equal((await app.inject({method:'POST',url:base,headers,payload:{owner_id:'untrusted-owner',portal:'http://127.0.0.1'}})).statusCode,200)
  assert.deepEqual((await app.inject({method:'GET',url:`${base}/synthetic-task`,headers})).json(),{status:'waiting'})
  for(const code of [403,502,503]){failure=new WechatConnectionError(code,'synthetic-upstream-secret');const result=await app.inject({method:'GET',url:`${base}/synthetic-task`,headers});assert.equal(result.statusCode,code);assert.doesNotMatch(result.body,/synthetic-upstream-secret/)}
  failure=new Error('synthetic-database-secret');const failed=await app.inject({method:'POST',url:base,headers});assert.equal(failed.statusCode,500);assert.doesNotMatch(failed.body,/synthetic-database-secret/)
  const configured=createWechatConnectHostOptions({},'');assert.equal(configured.portalBase,'https://ilinkai.weixin.qq.com');assert.equal(configured.allowLocal,false);assert.equal(configured.stateAvailable,false);await configured.transport.close()
  const ignored=createWechatConnectHostOptions({WECHAT_API_HOST:'user:secret@example.invalid'},'');assert.equal(ignored.portalBase,'https://ilinkai.weixin.qq.com');assert.equal(ignored.allowLocal,false);await ignored.transport.close()
 }finally{await app.close()}
})

test('微信扫码可交给本地存储保存，返回值不携带凭据', async () => {
 const owner='00000000-0000-4000-8000-000000000101'
 const challenge=new Map<string,string>()
 let saved=false
 const connector=createWechatPairing({
  portalBase:'https://portal.example.invalid',generateId:()=> 'test-task',randomUin:()=>1,platforms:()=>['wechat'],
  store:{async get(key){return challenge.get(key)??null},async saveIfAbsent(key,value){if(challenge.has(key))return false;challenge.set(key,value);return true},async delete(key){challenge.delete(key)}},
  transport:{async request(request){
   const payload=new URL(request.url).pathname.endsWith('status')
    ? {status:'confirmed',bot_token:'synthetic-token',baseurl:'https://bot.example.invalid'}
    : {qrcode:'test-code',qrcode_img_content:'https://qr.example.invalid/test'}
   return {status:200,headers:{},body:(async function*(){yield Buffer.from(JSON.stringify(payload))})(),cancel(){}}
  }},
  async saveBot(id,token,base){
   assert.equal(id,owner);assert.equal(token,'synthetic-token');assert.equal(base,'https://bot.example.invalid')
   saved=true
   return {id:1,name:'测试机器人'}
  },
 })
 const {task_id}=await connector.start(owner)
 await assert.rejects(connector.poll('00000000-0000-4000-8000-000000000102',task_id),{statusCode:403})
 assert.equal(saved,false)
 assert.deepEqual(await connector.poll(owner,task_id),{status:'success',bot:{id:1,name:'测试机器人'}})
 assert.equal(saved,true)
 assert.deepEqual(await connector.poll(owner,task_id),{status:'expired'})
})
