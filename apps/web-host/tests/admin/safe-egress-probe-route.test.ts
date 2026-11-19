import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { registerSafeEgressProbeRoute } from '../../src/modules/admin/network.js'

test('安全出站试测先鉴权、严格校验并调用实际测试用例', async () => {
 const app=Fastify();let calls=0
 registerSafeEgressProbeRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='Bearer synthetic')await reply.code(401).send({detail:'未授权'})},probe:async(input)=>{calls++;assert.equal(input.proxy_url,'https://proxy.example');return {ok:true,stage:'connected',message:'ok',status_code:200,elapsed_ms:0}}})
 try {
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/safe-egress/test',payload:{}})).statusCode,401)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/safe-egress/test',headers:{authorization:'Bearer synthetic'},payload:{unknown:true}})).statusCode,422)
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/safe-egress/test',headers:{authorization:'Bearer synthetic'},payload:{enabled:null}})).statusCode,422)
  const result=await app.inject({method:'POST',url:'/api/v1/admin/safe-egress/test',headers:{authorization:'Bearer synthetic'},payload:{proxy_url:'https://proxy.example'}})
  assert.equal(result.statusCode,200);assert.equal(result.json().stage,'connected');assert.equal(calls,1)
 } finally {await app.close()}
})
