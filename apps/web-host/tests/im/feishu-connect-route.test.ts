import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerFeishuConnectRoutes} from '../../src/modules/im/connect/feishu.js'
test('飞书设备授权HTTP认证优先，可信owner及异常脱敏',async()=>{
 const app=Fastify(),calls:string[][]=[]
 registerFeishuConnectRoutes(app,{requireUser:async(req,reply)=>{if(req.headers.authorization!=='user')await reply.code(401).send({detail:'需要认证'})},ownerIdFromRequest:()=> 'trusted-owner',connect:{start:async owner=>{calls.push(['start',owner]);return {poll_id:'synthetic-task',scan_url:'https://example.test/qqbot/openclaw/connect.html'}},poll:async(owner,task)=>{calls.push(['poll',owner,task]);if(task==='unavailable')throw Object.assign(Error('synthetic-secret'),{name:'FeishuConnectionError',statusCode:503});return {status:'waiting'}}}})
 try{
  for(const method of ['POST','GET'] as const)assert.equal((await app.inject({method,url:method==='POST'?'/api/v1/me/feishu/connect':'/api/v1/me/feishu/connect/synthetic-task'})).statusCode,401)
  assert.deepEqual(calls,[])
  assert.equal((await app.inject({method:'POST',url:'/api/v1/me/feishu/connect',headers:{authorization:'user'},payload:{owner:'untrusted'}})).statusCode,200)
  assert.equal((await app.inject({method:'GET',url:'/api/v1/me/feishu/connect/synthetic-task',headers:{authorization:'user'}})).json().status,'waiting')
  assert.deepEqual(calls,[['start','trusted-owner'],['poll','trusted-owner','synthetic-task']])
  const failed=await app.inject({method:'GET',url:'/api/v1/me/feishu/connect/unavailable',headers:{authorization:'user'}});assert.equal(failed.statusCode,503);assert.equal(failed.body.includes('synthetic-secret'),false)
 }finally{await app.close()}
})
