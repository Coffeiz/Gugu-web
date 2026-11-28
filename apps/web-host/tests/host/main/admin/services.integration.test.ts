import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {createServer} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {Pool} from 'pg'
import {startServer} from '../../../../src/main.js'
import {createServiceStatusReader} from '../../../../src/modules/admin/runtime.js'
import {createRedisAdminMaintenanceCommands,createRedisServiceStatusCommands} from '../../../../src/adapters/cache/redis-events.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redis=process.env.GUGU_WEBUI_TEST_REDIS_URL
async function port(){const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()));return address.port}

test('生产服务面板读取真实隔离Redis/PG和当前 Node 生命周期，管理员可重启后台任务', {skip:(!url||!redis)&&'需要隔离PG/Redis'},async()=>{
 const schema=`services_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(url!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString()}),root=await mkdtemp(join(tmpdir(),'gugu-service-status-'))
 const redisUrl=new URL(redis!);redisUrl.pathname='/14'
 const commands=createRedisServiceStatusCommands(redisUrl.toString())
 let host:Awaited<ReturnType<typeof startServer>>|undefined,seeded=false,maintenanceSeeded=false
 try{
  for(const key of ['health:worker','health:gateway','im:inbound'])assert.equal(await commands.get(key),null,'隔离Redis测试库不应已有固定业务键')
  for(const key of ['rag:index-rebuild','mem_cleanup:plan','im_memory:maintenance:model_preview'])assert.equal(await commands.get(key),null,'测试维护状态键不应预先存在')
  const now=Math.floor(Date.now()/1000)
  await commands.eval(`redis.call('SET','health:worker','{"pid":1234,"host":"synthetic-worker","ts":${now}}');redis.call('SET','health:gateway','{"pid":1235,"host":"synthetic-gateway","ts":${now-60}}');redis.call('XADD','im:inbound','*','synthetic','test');redis.call('XGROUP','CREATE','im:inbound','agent-workers','0');return 'ok'`);seeded=true
  await pool.query('CREATE TABLE audit_logs(id serial PRIMARY KEY,username text,action text,description text,ip text,created_at timestamptz)')
  const override=join(root,'config.json');await writeFile(override,'{}')
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:'synthetic-services-secret',GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await port()),GUGU_WEBUI_REDIS_URL:redisUrl.toString(),STORAGE__LOCAL_PATH:root,ADMIN_USERNAME:'synthetic-services-admin',ADMIN_PASSWORD:'synthetic-password'})
  assert.equal((await host.app.inject({url:'/api/v1/admin/services'})).statusCode,401)
  const login=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-services-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200)
  const response=await host.app.inject({url:'/api/v1/admin/services',headers:{authorization:`Bearer ${login.json().access_token}`}});assert.equal(response.statusCode,200)
  const result=response.json();assert.equal(result.services[0].pid,process.pid);assert.equal(result.services[0].restartable,false)
  assert.equal(result.services.find((s:{name:string})=>s.name==='worker').status,'online');assert.equal(result.services.find((s:{name:string})=>s.name==='gateway').status,'offline')
  assert.deepEqual(result.deps,{redis:true,db:true});assert.deepEqual(result.queue,{length:1,pending:0,lag:1,consumers:0})
  assert.equal(result.services.find((s:{name:string})=>s.name==='worker').pid,process.pid)
  const headers={authorization:`Bearer ${login.json().access_token}`}
  const restarted=await host.app.inject({method:'POST',url:'/api/v1/admin/services/worker/restart',headers})
  assert.deepEqual(restarted.json(),{ok:true,msg:'Node 后台任务已重启。'})
  const gateway=await host.app.inject({method:'POST',url:'/api/v1/admin/services/gateway/restart',headers})
  assert.equal(gateway.json().ok,false)
  assert.equal(JSON.parse((await commands.get('health:worker'))!).pid,1234)
  const maintenance=createRedisAdminMaintenanceCommands(redisUrl.toString());maintenanceSeeded=true
  await maintenance.set('rag:index-rebuild',JSON.stringify({status:'done',documents:3}),3600)
  await maintenance.set('mem_cleanup:plan',JSON.stringify({status:'running',ts:now-601,done:2,total:5}),3600)
  const maintenanceAuth={authorization:`Bearer ${login.json().access_token}`}
  assert.equal((await host.app.inject({url:'/api/v1/admin/config/index-rebuild/status'})).statusCode,401)
  const previewPath='/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview/status'
  assert.equal((await host.app.inject({url:previewPath})).statusCode,401)
  assert.deepEqual((await host.app.inject({url:previewPath,headers:maintenanceAuth})).json(),{status:'idle',done:0,total:0,needs_review:0,failed:0,plan_ready:false})
  const previewState={status:'done',done:2,total:2,needs_review:1,failed:0,plan_ready:true}
  await maintenance.set('im_memory:maintenance:model_preview',JSON.stringify(previewState),3600)
  const preview=await host.app.inject({url:previewPath,headers:maintenanceAuth});assert.equal(preview.statusCode,200);assert.deepEqual(preview.json(),previewState)
  await maintenance.set('im_memory:maintenance:model_preview','broken',3600)
  const broken=await host.app.inject({url:previewPath,headers:maintenanceAuth});assert.equal(broken.statusCode,500);assert.equal(broken.body.includes('broken'),false)
  const index=await host.app.inject({url:'/api/v1/admin/config/index-rebuild/status',headers:maintenanceAuth});assert.equal(index.statusCode,200);assert.deepEqual(index.json(),{status:'done',documents:3})
  const memory=await host.app.inject({url:'/api/v1/admin/config/memory-cleanup/status',headers:maintenanceAuth});assert.equal(memory.statusCode,200);assert.equal(memory.json().status,'stale')
  const stale=(await maintenance.get('mem_cleanup:plan'))!;assert.equal(JSON.parse(stale).status,'stale')
  assert.ok(Number(await commands.eval("return redis.call('TTL','mem_cleanup:plan')"))>3500)
  await maintenance.set('mem_cleanup:plan',JSON.stringify({status:'done',done:5,total:5}),3600)
  assert.equal(await maintenance.compareAndSet('mem_cleanup:plan',stale,JSON.stringify({status:'stale'}),3600),'0')
  assert.equal(JSON.parse((await maintenance.get('mem_cleanup:plan'))!).status,'done')
  const independent=await createServiceStatusReader({redis:createRedisServiceStatusCommands(redisUrl.toString()),dbOk:async()=>{await pool.query('SELECT 1');return true}})()
  assert.equal(independent.services.find(s=>s.name==='worker')!.pid,null)
  const down=await createServiceStatusReader({redis:createRedisServiceStatusCommands('redis://127.0.0.1:1'),dbOk:async()=>{await pool.query('SELECT 1');return true}})()
  assert.deepEqual(down.deps,{redis:false,db:true});assert.equal(down.services.find(s=>s.name==='worker')!.status,'offline');assert.deepEqual(down.queue,{length:null,pending:null,lag:null,consumers:null})
 }finally{await host?.close();if(maintenanceSeeded)await commands.eval("redis.call('DEL','rag:index-rebuild','mem_cleanup:plan','im_memory:maintenance:model_preview');return 'ok'");if(seeded)await commands.eval("redis.call('DEL','health:worker','health:gateway','im:inbound');return 'ok'");await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
