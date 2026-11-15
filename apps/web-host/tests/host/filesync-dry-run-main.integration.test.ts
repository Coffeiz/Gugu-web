import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:net'
import {Pool} from 'pg'
import type {LightMyRequestResponse} from 'fastify'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('生产Admin dry-run并发幂等与真实SSE，实际Python runner完成计划且无业务/源文件修改', {skip:(!databaseUrl||!redisUrl||!python)&&'需要隔离PG/Redis与显式Python'},async()=>{
 const schema=`dry_run_host_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-dry-run-host-')),owner=randomUUID()
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const storage=join(root,'storage'),override=join(root,'config.json'),scoped=new URL(databaseUrl!)
 scoped.searchParams.set('options',`-c search_path=${schema}`)
 await writeFile(override,JSON.stringify({storage:{backend:'local',local_path:storage},filesync:{enabled:true}}))
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:override,PYTHONPATH:'.',TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_STORAGE:storage}
 const bridge=(action:string,extra:Record<string,string>={})=>JSON.parse(execFileSync(python!,[resolve('../../compat/support/filesync_dry_run.py'),action],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,...extra},timeout:30000}))
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  bridge('setup')
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()))
  const secret='synthetic-filesync-dry-run-secret'
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:redisUrl,STORAGE__LOCAL_PATH:storage,ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const path='/api/v1/admin/filesync/bindings/1/dry-run'
  assert.equal((await host.app.inject({method:'POST',url:path})).statusCode,401)
  assert.equal((await host.app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${signedUserToken(secret,owner)}`}})).statusCode,403)
  const login:LightMyRequestResponse=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
  assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  const abort=new AbortController();let id:string|undefined
  try{
   const stream=await fetch(`http://127.0.0.1:${address.port}/api/v1/admin/filesync/events`,{headers,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])})
   assert.equal(stream.status,200);const reader=stream.body!.getReader(),decoder=new TextDecoder();let frames=decoder.decode((await reader.read()).value);assert.match(frames,/: connected/)
   const responses:LightMyRequestResponse[]=await Promise.all([host.app.inject({method:'POST',url:path,headers}),host.app.inject({method:'POST',url:path,headers,payload:{allow_delete:true}})])
   for(const response of responses){assert.equal(response.statusCode,200,response.body);assert.equal(response.json().allowDelete,false);assert.equal(response.json().status,'queued')}
   id=responses[0]!.json().id;assert.equal(responses[1]!.json().id,id)
   while(!frames.includes('filesync.run.changed')){const next=await reader.read();assert.equal(next.done,false);frames+=decoder.decode(next.value)}
   const event=JSON.parse(frames.split('\n').find(line=>line.startsWith('data: '))!.slice(6))
   assert.equal(event.run_id,id);assert.equal(event.binding_id,1);assert.equal(event.revision,0);assert.doesNotMatch(frames,/root_path|user_id/)
   abort.abort();await reader.cancel().catch(()=>undefined)
  }finally{abort.abort()}
  assert.ok(id)
  const consumed=bridge('consume',{TEST_RUN:id})
  assert.equal(consumed.status,'succeeded',JSON.stringify(consumed));assert.equal(consumed.error_code,null);assert.equal(consumed.counts.plannedCreated,2);assert.equal(consumed.counts.created,0);assert.equal(consumed.files_unchanged,true);assert.deepEqual(Object.values(consumed.business),[0,0,0,0,0])
  const snapshot:LightMyRequestResponse=await host.app.inject({url:`/api/v1/admin/filesync/runs/${id}`,headers})
  assert.equal(snapshot.statusCode,200);assert.equal(snapshot.json().status,'succeeded');assert.equal(snapshot.json().allowDelete,false);assert.equal(snapshot.json().resultCounts.plannedCreated,2)
 }finally{await host?.close();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
