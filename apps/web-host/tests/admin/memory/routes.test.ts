import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerImMemorySummaryRoutes} from '../../../src/modules/admin/memory.js'

test('两种只读预览经过管理员权限；失败不返回业务汇总',async()=>{
 const app=Fastify();let reads=0
 registerImMemorySummaryRoutes(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(request.headers.authorization?403:401).send({detail:'拒绝访问'})},read:async()=>{reads++;return {total_scopes:0,groups:0,members:0,total_entries:0,pending_jobs:0,needs_maintenance:0,failed_jobs:0,platforms:[]}}})
 try{
  for(const [method,url] of [['GET','/api/v1/admin/agent/memory/im-scopes'],['POST','/api/v1/admin/agent/memory/im-scopes/maintenance/preview']] as const){
   assert.equal((await app.inject({method,url})).statusCode,401)
   assert.equal((await app.inject({method,url,headers:{authorization:'user'}})).statusCode,403)
   const response=await app.inject({method,url,headers:{authorization:'admin'}})
   assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{total_scopes:0,groups:0,members:0,total_entries:0,pending_jobs:0,needs_maintenance:0,failed_jobs:0,platforms:[]})
  }
  assert.equal(reads,2)
 }finally{await app.close()}
})
