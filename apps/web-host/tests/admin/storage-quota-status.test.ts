import { storageQuotaStateKey, storageQuotaLockKey } from '../../src/modules/admin/storage.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {readStorageQuotaStatus} from '../../src/modules/admin/storage.js'
import {StorageQuotaReconcileUnavailable} from '../../src/modules/admin/storage.js'
test('配额状态保留终态、无锁标记中断且不覆盖并发完成',async()=>{
 let raw=JSON.stringify({status:'running',processed:2});const saved:string[]=[]
 const store={read:async()=>raw,lockExists:async()=>false,interruptIfUnchanged:async(expected:string,next:string)=>{if(raw!==expected)return false;raw=next;saved.push(next);return true}}
 const result=await readStorageQuotaStatus(store,()=> '2026-11-15T00:00:00+00:00');assert.equal(result.status,'interrupted');assert.equal(result.processed,2);assert.equal(saved.length,1)
 raw=JSON.stringify({status:'running'});store.lockExists=async()=>{raw=JSON.stringify({status:'completed',processed:5});return false}
 assert.deepEqual(await readStorageQuotaStatus(store),{status:'completed',processed:5});assert.equal(saved.length,1)
 raw='broken';assert.deepEqual(await readStorageQuotaStatus(store),{status:'idle'})
})
import Fastify from 'fastify'
import {createRedisStorageQuotaStatusStore,registerStorageQuotaStatusRoute} from '../../src/modules/admin/storage.js'
import {createRedisAgentCancellationCommands,createRedisScheduledTaskCommands} from '../../src/adapters/cache/redis-events.js'
test('真实Redis读取状态、锁丢失写回7天TTL且鉴权在读取前拒绝',async()=>{
 const configured=process.env.GUGU_WEBUI_TEST_REDIS_URL;assert.ok(configured);const scopedRedis=new URL(configured);scopedRedis.pathname='/14';const redisUrl=scopedRedis.toString()
 const io=createRedisAgentCancellationCommands(redisUrl),commands=createRedisScheduledTaskCommands(redisUrl),store=createRedisStorageQuotaStatusStore(redisUrl),app=Fastify()
 const clear=()=>commands.eval("return redis.call('DEL',KEYS[1],KEYS[2])",2,storageQuotaStateKey,storageQuotaLockKey)
 registerStorageQuotaStatusRoute(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(401).send({detail:'未登录'})},store})
 try{
  await clear();assert.equal((await app.inject({url:'/api/v1/admin/storage-quota/reconcile'})).statusCode,401)
  assert.deepEqual(await readStorageQuotaStatus(store),{status:'idle'})
  await io.set(storageQuotaStateKey,JSON.stringify({status:'running',processed:3}),60);await io.set(storageQuotaLockKey,'synthetic-lock',60)
  assert.deepEqual(await readStorageQuotaStatus(store),{status:'running',processed:3})
  await commands.eval("return redis.call('DEL',KEYS[1])",1,storageQuotaLockKey)
  const response=await app.inject({url:'/api/v1/admin/storage-quota/reconcile',headers:{authorization:'admin'}});assert.equal(response.statusCode,200);assert.equal(response.json().status,'interrupted');assert.equal(response.json().processed,3)
  assert.ok(Number(await commands.eval("return redis.call('TTL',KEYS[1])",1,storageQuotaStateKey))>604790)
  await io.set(storageQuotaStateKey,JSON.stringify({status:'completed',processed:4}),60)
  assert.equal(await store.interruptIfUnchanged(JSON.stringify({status:'running'}),JSON.stringify({status:'interrupted'})),false)
  assert.equal((await readStorageQuotaStatus(store)).status,'completed')
 }finally{await app.close();await clear()}
})
test('真实Redis连接失败返回503且不泄露连接细节',async()=>{
 const app=Fastify()
 registerStorageQuotaStatusRoute(app,{requireAdmin:async()=>{},store:createRedisStorageQuotaStatusStore('redis://127.0.0.1:1')})
 try{const response=await app.inject({url:'/api/v1/admin/storage-quota/reconcile'});assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{detail:'暂时无法读取对账状态'});assert.equal(response.body.includes('127.0.0.1'),false)}finally{await app.close()}
})

test('管理员可启动全量配额对账，重复启动返回现有状态，Redis 故障映射为脱敏 503',async()=>{
 const app=Fastify();let starts=0
 registerStorageQuotaStatusRoute(app,{requireAdmin:async(request,reply)=>{if(request.headers.authorization!=='admin')return reply.code(401).send({detail:'未登录'})},store:{async read(){return null},async lockExists(){return true},async interruptIfUnchanged(){return false}},reconcile:{async start(){starts++;return {started:false,state:{status:'running',processed:2}}}}})
 try{
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/storage-quota/reconcile'})).statusCode,401)
  const response=await app.inject({method:'POST',url:'/api/v1/admin/storage-quota/reconcile',headers:{authorization:'admin'}})
  assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{started:false,state:{status:'running',processed:2}});assert.equal(starts,1)
 }finally{await app.close()}
 const unavailable=Fastify();registerStorageQuotaStatusRoute(unavailable,{requireAdmin:async()=>{},store:{async read(){return null},async lockExists(){return true},async interruptIfUnchanged(){return false}},reconcile:{async start(){throw new StorageQuotaReconcileUnavailable()}}})
 try{const response=await unavailable.inject({method:'POST',url:'/api/v1/admin/storage-quota/reconcile'});assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{detail:'暂时无法启动对账'})}finally{await unavailable.close()}
})
