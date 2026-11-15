import type {LightMyRequestResponse} from 'fastify'
import assert from 'node:assert/strict'
import { randomUUID,createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { startServer } from '../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
async function freePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  return address.port
}

import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {createRedisValueReader,createRedisScheduledTaskCommands} from '../../src/adapters/redis-events.js'
test('生产Node签发QQ/Telegram绑定码可由真实Python消费者完成绑定',async()=>{
 const configured=process.env.GUGU_WEBUI_TEST_REDIS_URL;assert.ok(configured);assert.ok(databaseUrl)
 const redis=new URL(configured);redis.pathname='/12';const redisUrl=redis.toString(),schema=`binding_main_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString()}),root=await mkdtemp(join(tmpdir(),'binding-main-')),overridePath=join(root,'override.json'),owner=randomUUID(),other=randomUUID(),secret='synthetic-binding-secret',hosts:Awaited<ReturnType<typeof startServer>>[]=[]
 const commands=createRedisScheduledTaskCommands(redisUrl),get=createRedisValueReader(redisUrl)
 const python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(python)
 const run=(args:string[])=>JSON.parse(execFileSync(python,[resolve('tests/im/fixtures/binding_code_consumer.py'),'--allow-isolated-test-database',...args],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend'),GUGU_WEBUI_TEST_DATABASE_URL:databaseUrl!,GUGU_WEBUI_TEST_REDIS_URL:redisUrl},encoding:'utf8'}).trim().split('\n').at(-1)!)
 let ids:number[]=[]
 try{
  await writeFile(overridePath,'{}');ids=run(['init',schema,owner,other]).ids
  for(const redisSetting of [redisUrl,'']) {
   const host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:overridePath,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:redisSetting});hosts.push(host)
   const headers={authorization:`Bearer ${createUserToken(owner,1,secret)}`}
   for(const [index,platform] of [[0,'qq'],[1,'telegram']] as const) {
    const path=platform==='qq'?`/api/v1/me/bots/${ids[index]}/qq-binding-code`:`/api/v1/me/telegram/connect/${ids[index]}/binding-code`
    assert.equal((await host.app.inject({method:'POST',url:path})).statusCode,401)
    if(redisSetting){
     const wrong=platform==='qq'?`/api/v1/me/bots/${ids[1]}/qq-binding-code`:`/api/v1/me/telegram/connect/${ids[0]}/binding-code`;assert.equal((await host.app.inject({method:'POST',url:wrong,headers})).statusCode,404)
     if(platform==='qq')assert.equal((await host.app.inject({method:'POST',url:`/api/v1/me/bots/${ids[2]}/qq-binding-code`,headers})).statusCode,404)
    }
    const response:LightMyRequestResponse=await host.app.inject({method:'POST',url:path,headers})
    if(!redisSetting){assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{detail:'暂时无法生成绑定码'});continue}
    assert.equal(response.statusCode,200,response.body);const body=response.json();assert.match(body.code,/^\d{6}$/);assert.equal(body.expires_in,600)
    const stored=await get(`im:${platform}-binding:${ids[index]}`);assert.ok(stored);assert.equal(Object.values(JSON.parse(stored)).includes(body.code),false);assert.ok(Number(await commands.eval("return redis.call('TTL',KEYS[1])",1,`im:${platform}-binding:${ids[index]}`))>590)
    const repeated:LightMyRequestResponse[]=await Promise.all([host.app.inject({method:'POST',url:path,headers}),host.app.inject({method:'POST',url:path,headers})])
    for(const item of repeated)assert.equal(item.statusCode,200)
    const latest=JSON.parse((await get(`im:${platform}-binding:${ids[index]}`))!)
    assert.notEqual(latest.challenge_id,JSON.parse(stored).challenge_id)
    const winner=repeated.find(item=>createHmac('sha256',secret).update(`${platform==='qq'?'':'telegram:'}${ids[index]}:${owner}:${item.json().code}`).digest('hex')===latest.code_hash)
    assert.ok(winner);body.code=winner.json().code
    assert.deepEqual(run(['consume',schema,owner,String(ids[index]),platform,body.code]),{consumed:true})
    assert.equal(await get(`im:${platform}-binding:${ids[index]}`),null)
    assert.equal((await host.app.inject({method:'POST',url:path,headers})).statusCode,409)
   }
   if(redisSetting)await pool.query('UPDATE user_bots SET owner_platform_user_id=NULL,owner_bound_at=NULL')
  }
 }finally{for(const host of hosts)await host.close();for(const id of ids)for(const platform of ['qq','telegram'])await commands.eval("return redis.call('DEL',KEYS[1])",1,`im:${platform}-binding:${id}`);await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
