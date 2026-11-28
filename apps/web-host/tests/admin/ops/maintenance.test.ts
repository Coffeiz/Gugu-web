import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerAdminMaintenanceStatusRoutes} from '../../../src/modules/admin/runtime.js'
import {createAdminMaintenanceStatus} from '@gugu/core/maintenance/admin-status'

test('后台维护状态对齐空值/损坏JSON，并仅在600秒边界把running持久化为stale',async()=>{
 const data=new Map<string,string>(),writes:unknown[]=[]
 const read=createAdminMaintenanceStatus({get:async key=>data.get(key)??null,compareAndSet:async(key,expected,value,ttl)=>{if(data.get(key)!==expected)return false;writes.push([key,JSON.parse(value),ttl]);data.set(key,value);return true}},()=>1000)
 assert.deepEqual(await read.indexRebuild(),{status:'idle'});assert.deepEqual(await read.memoryCleanup(),{status:'idle'})
 data.set('rag:index-rebuild','broken');assert.deepEqual(await read.indexRebuild(),{status:'idle'})
 data.set('rag:index-rebuild','[1,2]');assert.deepEqual(await read.indexRebuild(),[1,2])
 data.set('mem_cleanup:plan',JSON.stringify({status:'running',ts:401,done:2,total:5}));assert.equal((await read.memoryCleanup()).status,'running');assert.deepEqual(writes,[])
 data.set('mem_cleanup:plan',JSON.stringify({status:'running',ts:400,done:2,total:5}));assert.deepEqual(await read.memoryCleanup(),{status:'stale',done:2,total:5,message:'上次预览已超时，请重新生成'})
 assert.equal(writes.length,1);assert.equal((writes[0] as unknown[])[2],3600)
 const failed=createAdminMaintenanceStatus({get:async()=>{throw new Error('合成Redis故障')},compareAndSet:async()=>true},()=>1000)
 await assert.rejects(failed.indexRebuild(),/Redis/)
})


test('超时转换CAS失败后重读worker终态，不用旧快照覆盖新状态',async()=>{
 let raw=JSON.stringify({status:'running',ts:0,done:1,total:5})
 const read=createAdminMaintenanceStatus({get:async()=>raw,compareAndSet:async()=>{raw=JSON.stringify({status:'done',done:5,total:5});return false}},()=>1000)
 assert.deepEqual(await read.memoryCleanup(),{status:'done',done:5,total:5})
})


test('维护状态Redis读写故障明确503，未认证不访问状态',async()=>{
 const app=Fastify()
 const reader=createAdminMaintenanceStatus({get:async()=>JSON.stringify({status:'running',ts:0}),compareAndSet:async()=>{throw new Error('合成Redis写故障')}},()=>1000)
 await assert.rejects(reader.memoryCleanup(),/Redis/)
 registerAdminMaintenanceStatusRoutes(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='synthetic-admin')return reply.code(401).send({detail:'需要管理员身份'})},available:()=>true,read:{imMemoryModelPreview:async()=>{throw new Error('合成Redis读故障')},indexRebuild:async()=>{throw new Error('合成Redis读故障')},memoryCleanup:reader.memoryCleanup}})
 try{
  assert.equal((await app.inject({url:'/api/v1/admin/config/index-rebuild/status'})).statusCode,401)
  for(const path of ['index-rebuild','memory-cleanup'])assert.equal((await app.inject({url:`/api/v1/admin/config/${path}/status`,headers:{authorization:'synthetic-admin'}})).statusCode,503)
 }finally{await app.close()}
})

test('IM模型预览状态空值包含全部默认计数，现有结果原样读取且坏JSON不伪装idle',async()=>{
 let raw:string|null=null
 const read=createAdminMaintenanceStatus({get:async key=>{assert.equal(key,'im_memory:maintenance:model_preview');return raw},compareAndSet:async()=>{throw new Error('只读状态不得写入')}},()=>1000)
 assert.deepEqual(await read.imMemoryModelPreview(),{status:'idle',done:0,total:0,needs_review:0,failed:0,plan_ready:false})
 raw=JSON.stringify({status:'done',done:2,total:2,needs_review:1,failed:0,plan_ready:true})
 assert.deepEqual(await read.imMemoryModelPreview(),JSON.parse(raw))
 raw='broken';await assert.rejects(read.imMemoryModelPreview(),SyntaxError)
})
