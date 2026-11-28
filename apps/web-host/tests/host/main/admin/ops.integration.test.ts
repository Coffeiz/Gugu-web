import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:net'
import {startServer} from '../../../../src/main.js'
import {createRedisScheduledTaskCommands,createRedisHashReader} from '../../../../src/adapters/cache/redis-events.js'
async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>server.close(()=>r()));return a.port}
test('生产运维汇总读取真实Redis，与Python handler全字段一致，故障503脱敏',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisBase=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(databaseUrl);assert.ok(redisBase);assert.ok(python)
 const redisUrl=new URL(redisBase);redisUrl.pathname='/9';const command=createRedisScheduledTaskCommands(redisUrl.toString()),today=new Date(),day=today.toISOString().slice(0,10).replaceAll('-',''),previous=new Date(today.getTime()-86400000).toISOString().slice(0,10).replaceAll('-','')
 const keys=['tool','lat','sec','email','filesystem-auth'].flatMap(kind=>[day,previous].map(date=>`ops:${kind}:${date}`))
 for(const key of keys)assert.equal(Number(await command.eval("return redis.call('EXISTS',KEYS[1])",1,key)),0,'仅允许空的隔离测试日键')
 const seed=async(key:string,fields:Record<string,string>)=>command.eval("for i=1,#ARGV,2 do redis.call('HSET',KEYS[1],ARGV[i],ARGV[i+1]) end;return 1",1,key,...Object.entries(fields).flat())
 const root=await mkdtemp(join(tmpdir(),'ops-main-')),path=join(root,'override.json');let host:Awaited<ReturnType<typeof startServer>>|undefined

 try{
  await seed(`ops:tool:${day}`,{'read:calls':'32','read:fails':'1','read:ms_sum':'100','tool:unknown':'2'});await seed(`ops:tool:${previous}`,{'write:calls':'2','write:fails':'1','write:ms_sum':'21'})
  await seed(`ops:lat:${day}`,{'50':'99','inf':'1'});await seed(`ops:sec:${day}`,{'ownership.denied':'1','new.event':'2'});await seed(`ops:email:${day}`,{calls:'32',failed:'1',sent:'31',ms_sum:'210','error:timeout':'1'});await seed(`ops:filesystem-auth:${day}`,{'session:requested':'1','session:granted:ignored':'3'})
  const expected=JSON.parse(execFileSync(python,[resolve('tests/admin/fixtures/ops_summary_python.py'),'--allow-isolated-test-redis',redisUrl.toString(),today.toISOString().slice(0,10)],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend')},encoding:'utf8'}))
  await writeFile(path,'{}');const start=async(url:string)=>{const envPort=await freePort();return startServer({GUGU_WEBUI_DATABASE_URL:databaseUrl,GUGU_WEBUI_SECRET_KEY:'synthetic-ops-secret',GUGU_CONFIG_OVERRIDE_FILE:path,STORAGE__LOCAL_PATH:join(root,'storage'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(envPort),GUGU_WEBUI_REDIS_URL:url,ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})}
  host=await start(redisUrl.toString());const url='/api/v1/admin/ops/summary?days=2'
  assert.equal((await host.app.inject({url})).statusCode,401)
  const auth=async()=>{const login=await host!.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}});assert.equal(login.statusCode,200);return {authorization:`Bearer ${login.json().access_token}`}}
  const headers=await auth(),response=await host.app.inject({url,headers});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),expected);assert.equal(response.json().tools.find((r:any)=>r.tool==='read').fail_rate,.0312)
  assert.deepEqual({...await createRedisHashReader(redisUrl.toString())(`ops:tool:${day}`)},{'read:calls':'32','read:fails':'1','read:ms_sum':'100','tool:unknown':'2'})
  await command.eval("redis.call('DEL',KEYS[1]);return redis.call('SET',KEYS[1],ARGV[1])",1,`ops:tool:${day}`,'synthetic-secret');const corrupt=await host.app.inject({url,headers});assert.equal(corrupt.statusCode,503);assert.equal(corrupt.body.includes('synthetic-secret'),false)
  await host.close();host=await start('');assert.equal((await host.app.inject({url})).statusCode,401);const failed=await host.app.inject({url,headers:await auth()});assert.equal(failed.statusCode,503);assert.deepEqual(failed.json(),{detail:'暂时无法读取运维指标'});assert.equal(failed.body.includes(root),false)
 }finally{await host?.close();await command.eval("return redis.call('DEL',unpack(KEYS))",keys.length,...keys);await rm(root,{recursive:true,force:true})}
})
