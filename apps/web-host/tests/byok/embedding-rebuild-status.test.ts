import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {createEmbeddingRebuildStatusReader} from '@gugu/core/byok/embedding-rebuild-status'
import { registerEmbeddingRebuildStatusRoute } from '../../src/modules/agent/memory/rebuild.js'
import {createRedisAgentCancellationCommands,createRedisFilesystemAuthorizationCommands} from '../../src/adapters/cache/redis-events.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

test('重建状态缺失/损坏兼容idle，正常进度保持，错误消息复用公共脱敏',async()=>{
 const owner='00000000-0000-4000-8000-000000000081'
 let raw:string|null=null
 const read=createEmbeddingRebuildStatusReader(async id=>{assert.equal(id,owner);return raw})
 assert.deepEqual(await read(owner),{status:'idle'})
 raw='{';assert.deepEqual(await read(owner),{status:'idle'})
 raw=JSON.stringify({status:'running',ts:12,current:3,total:5,message:'处理中 /tmp/合成进度'})
 assert.deepEqual(await read(owner),JSON.parse(raw))
 raw=JSON.stringify({status:'done',pattern_vectors:2,memory_vectors:3,failed_users:0,message:'重建完成：pattern 2 条，memory 3 块',ts:15})
 assert.deepEqual(await read(owner),JSON.parse(raw))
 raw=JSON.stringify({status:'error',message:'无法读取 /tmp/synthetic-file redis://synthetic:secret@localhost/0 token=syntheticsecretvalue',ts:16})
 const result=await read(owner) as {status:string;message:string;ts:number}
 assert.equal(result.status,'error');assert.equal(result.ts,16)
 assert.equal(result.message.includes('synthetic-file'),false)
 assert.equal(result.message.includes('syntheticsecretvalue'),false)
 assert.equal(result.message.includes('redis://'),false)
})

test('重建状态HTTP认证隔离owner且Redis故障返回脱敏500',async()=>{
 const app=Fastify();installHttpErrorHandler(app)
 let calls=0
 registerEmbeddingRebuildStatusRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未授权'})},ownerIdFromRequest:()=> 'trusted-owner',read:async owner=>{assert.equal(owner,'trusted-owner');calls++;throw new Error('synthetic-private-error')}})
 try{
  assert.equal((await app.inject('/api/v1/byok/embedding-rebuild/status')).statusCode,401);assert.equal(calls,0)
  const response=await app.inject({url:'/api/v1/byok/embedding-rebuild/status?user_id=foreign',headers:{authorization:'user'}})
  assert.equal(response.statusCode,500);assert.equal(response.body.includes('synthetic-private-error'),false)
 }finally{await app.close()}
})

const redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL

test('读取真实隔离Redis旧Worker owner键，保留done进度且不读取其他用户', {skip:!redisUrl&&'需要隔离Redis'},async()=>{
 const commands=createRedisAgentCancellationCommands(redisUrl!),cleanup=createRedisFilesystemAuthorizationCommands(redisUrl!)
 const owner=randomUUID(),foreign=randomUUID(),key=(id:string)=>`emb:rebuild:user:${id}`
 try{
  await commands.set(key(owner),JSON.stringify({status:'done',pattern_vectors:7,memory_vectors:9,failed_users:0,message:'合成完成',ts:123}),60)
  await commands.set(key(foreign),JSON.stringify({status:'error',message:'其他用户'}),60)
  const read=createEmbeddingRebuildStatusReader(ownerId=>commands.get(key(ownerId)))
  assert.deepEqual(await read(owner),{status:'done',pattern_vectors:7,memory_vectors:9,failed_users:0,message:'合成完成',ts:123})
  assert.deepEqual(await read(randomUUID()),{status:'idle'})
 }finally{await cleanup.del(key(owner),key(foreign))}
})
