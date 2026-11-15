import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerCredentialListRoute} from '../../src/modules/byok/credential-list.js'

test('BYOK 列表要求认证并只返回 owner 元数据和密钥可用状态',async()=>{
 const app=Fastify(),owners:string[]=[]
 registerCredentialListRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='Bearer valid')return reply.code(401).send()},ownerIdFromRequest:()=> 'owner-a',list:async owner=>{owners.push(owner);return {enabled:true,status:'ready',items:[{id:7,provider:'synthetic',has_value:true}]}}})
 try{
  assert.equal((await app.inject({url:'/api/v1/byok'})).statusCode,401)
  const response=await app.inject({url:'/api/v1/byok',headers:{authorization:'Bearer valid'}})
  assert.equal(response.statusCode,200)
  assert.deepEqual(response.json(),{enabled:true,status:'ready',items:[{id:7,provider:'synthetic',has_value:true}]})
  assert.deepEqual(owners,['owner-a'])
 }finally{await app.close()}
})
