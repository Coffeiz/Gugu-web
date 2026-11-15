import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerCredentialListRoute} from '../../src/modules/byok/credential-list.js'

test('BYOK 列表要求认证并只返回 owner 元数据和密钥可用状态',async()=>{
 const app=Fastify(),owners:string[]=[]
 const item={id:7,provider:'synthetic',api_format:'openai',capability:'llm',base_url:'',model:'',max_tokens:null,dimensions:null,context_tokens:null,thinking:null,reasoning_effort:null,reasoning_persistence:'off',web_search_enabled:false,image:false,video:false,audio:false,image_detail:'auto',enabled:true,has_value:true,last_verified_at:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}
 registerCredentialListRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='Bearer valid')return reply.code(401).send()},ownerIdFromRequest:()=> 'owner-a',list:async owner=>{owners.push(owner);return {enabled:true,status:'ready',items:[item]}}})
 try{
  assert.equal((await app.inject({url:'/api/v1/byok'})).statusCode,401)
  const response=await app.inject({url:'/api/v1/byok',headers:{authorization:'Bearer valid'}})
  assert.equal(response.statusCode,200)
  assert.deepEqual(response.json(),{enabled:true,status:'ready',items:[item]})
  assert.deepEqual(owners,['owner-a'])
 }finally{await app.close()}
})
