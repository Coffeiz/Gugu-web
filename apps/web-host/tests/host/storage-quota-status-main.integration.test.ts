import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startServer } from '../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

import {createRedisAgentCancellationCommands,createRedisScheduledTaskCommands} from '../../src/adapters/cache/redis-events.js'
import {storageQuotaStateKey,storageQuotaLockKey} from '../../src/modules/admin/storage.js'
test('生产Host读取真实配额状态且未配置Redis返回脱敏503',async()=>{
 const configured=process.env.GUGU_WEBUI_TEST_REDIS_URL;assert.ok(configured);const scopedRedis=new URL(configured);scopedRedis.pathname='/15';const redisUrl=scopedRedis.toString();assert.ok(databaseUrl)
 const root=await mkdtemp(join(tmpdir(),'quota-status-main-')),overridePath=join(root,'config.json'),hosts:Awaited<ReturnType<typeof startServer>>[]=[]
 const io=createRedisAgentCancellationCommands(redisUrl),commands=createRedisScheduledTaskCommands(redisUrl)
 const clear=()=>commands.eval("return redis.call('DEL',KEYS[1],KEYS[2])",2,storageQuotaStateKey,storageQuotaLockKey)
 try{
  await writeFile(overridePath,'{}');await clear();await io.set(storageQuotaStateKey,JSON.stringify({status:'completed',processed:7}),60)
  for(const redis of [redisUrl,'']) {
   const host=await startServer({GUGU_WEBUI_DATABASE_URL:databaseUrl,GUGU_WEBUI_SECRET_KEY:'synthetic-quota-status-secret',GUGU_CONFIG_OVERRIDE_FILE:overridePath,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:redis,ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'});hosts.push(host)
   assert.equal((await host.app.inject({url:'/api/v1/admin/storage-quota/reconcile'})).statusCode,401)
   const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200)
   const response=await host.app.inject({url:'/api/v1/admin/storage-quota/reconcile',headers:{authorization:`Bearer ${login.json().access_token}`}})
   if(redis){assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{status:'completed',processed:7})}
   else {assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{detail:'暂时无法读取对账状态'})}
  }
 }finally{for(const host of hosts)await host.close();await clear();await rm(root,{recursive:true,force:true})}
})
