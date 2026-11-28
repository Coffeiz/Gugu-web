import type { LightMyRequestResponse } from 'fastify'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { startServer } from '../../../../src/main.js'
import { signedUserToken } from '../../../helpers/auth.js'

const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('生产Host只读取当前认证用户的导入导出状态，不暴露内部能力且保留错误语义', {skip:!url&&'需要隔离PG'}, async () => {
  const schema=`portability_host_${randomUUID().replaceAll('-','')}`
  const admin=new Pool({connectionString:url}); await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped=new URL(url!); scoped.searchParams.set('options',`-c search_path=${schema}`)
  const pool=new Pool({connectionString:scoped.toString()})
  const root=await mkdtemp(join(tmpdir(),'gugu-portability-'))
  let eventStreamClosed=false
  const collector=createHttpServer((request,response)=>{
    if(request.url?.startsWith('/api/events')){response.writeHead(200,{'content-type':'text/event-stream'});response.write('data: {"synthetic":true}\n\n');response.on('close',()=>{eventStreamClosed=true});return}
    response.setHeader('content-type','application/json');response.end('{"synthetic":true}')
  })
  await new Promise<void>(resolve=>collector.listen(0,'127.0.0.1',resolve))
  const collectorAddress=collector.address();assert.ok(collectorAddress&&typeof collectorAddress!=='string')
  let host:Awaited<ReturnType<typeof startServer>>|undefined
  try {
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,username text,email text,is_active boolean,account_status text,security_version integer,avatar text,created_at timestamptz,timezone text,email_subscribed boolean,display_name text,last_active_at timestamptz);
      CREATE TABLE user_bots(id integer,user_id uuid,platform text,enabled boolean);
      CREATE TABLE data_export_jobs(id uuid PRIMARY KEY,user_id uuid,status text,stage text,progress_current integer,progress_total integer,error_code text,artifact_key text,artifact_size bigint,created_at timestamptz,expires_at timestamptz,finished_at timestamptz,updated_at timestamptz,options json,idempotency_key text,UNIQUE(user_id,idempotency_key));
      CREATE TABLE data_import_jobs(id uuid PRIMARY KEY,user_id uuid,status text,stage text,mode text,progress_current integer,progress_total integer,error_code text,preview jsonb,created_at timestamptz,expires_at timestamptz,rollback_expires_at timestamptz,import_token_hash text,staging_key text)`)
    const a=randomUUID(),b=randomUUID(),e=randomUUID(),m=randomUUID()
    await pool.query("INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at) VALUES($1,'小北','a@example.test',true,'active',1,CURRENT_TIMESTAMP),($2,'小月','b@example.test',true,'active',1,CURRENT_TIMESTAMP)",[a,b])
    await pool.query("INSERT INTO data_export_jobs(id,user_id,status,stage,progress_current,progress_total,error_code,artifact_key,artifact_size,created_at,expires_at) VALUES($1,$2,'ready',NULL,1,NULL,NULL,'private-synthetic',500,'2026-01-01T00:00:00.123456Z',NULL)",[e,a])
    await pool.query("INSERT INTO data_import_jobs VALUES($1,$2,'preview_ready',NULL,'preflight',0,NULL,NULL,'{}','2026-01-01T00:00:00.123456Z',NULL,NULL,'hash-synthetic','staging-synthetic')",[m,a])
    const override=join(root,'config.json');await writeFile(override,'{}')
    const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>socket.close(()=>resolve()))
    const secret='synthetic-portability-secret'
    host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:root,LOOPSCOPE_ENDPOINT:`http://127.0.0.1:${collectorAddress.port}`})
    const auth={authorization:`Bearer ${signedUserToken(secret,a)}`}, other={authorization:`Bearer ${signedUserToken(secret,b)}`}
    assert.equal((await host.app.inject({url:'/api/v1/dev/loopscope/sessions'})).statusCode,401)
    const collectorRead=await host.app.inject({url:'/api/v1/dev/loopscope/sessions?tag=a&tag=b',headers:auth});assert.equal(collectorRead.statusCode,200);assert.deepEqual(collectorRead.json(),{synthetic:true})
    const streamingAbort=new AbortController()
    const eventStream=await fetch(`http://127.0.0.1:${address.port}/api/v1/dev/loopscope/events`,{headers:auth,signal:streamingAbort.signal})
    assert.equal(eventStream.status,200);assert.equal(eventStream.headers.get('x-accel-buffering'),'no')
    const eventReader=eventStream.body!.getReader();assert.match(new TextDecoder().decode((await eventReader.read()).value),/synthetic/)
    streamingAbort.abort();await eventReader.cancel().catch(()=>undefined)
    for(let attempt=0;attempt<40&&!eventStreamClosed;attempt++)await new Promise(resolve=>setTimeout(resolve,25))
    assert.equal(eventStreamClosed,true,'下游SSE断连应关闭上游连接')
    for(const path of ['/exports','/imports',`/exports/${e}`,`/imports/${m}`]) assert.equal((await host.app.inject({url:`/api/v1/data-portability${path}`})).statusCode,401)
    for(const [kind,id] of [['exports',e],['imports',m]]) {
      const list: LightMyRequestResponse=await host.app.inject({url:`/api/v1/data-portability/${kind}`,headers:auth});assert.equal(list.statusCode,200);assert.equal(list.json().length,1)
      const detail: LightMyRequestResponse=await host.app.inject({url:`/api/v1/data-portability/${kind}/${id}`,headers:auth});assert.equal(detail.statusCode,200);assert.equal(detail.json().id,id);assert.doesNotMatch(detail.body,/private-synthetic|hash-synthetic|staging-synthetic/)
      assert.equal((await host.app.inject({url:`/api/v1/data-portability/${kind}/${id}`,headers:other})).statusCode,404)
      assert.deepEqual((await host.app.inject({url:`/api/v1/data-portability/${kind}`,headers:other})).json(),[])
      assert.equal((await host.app.inject({url:`/api/v1/data-portability/${kind}/invalid`,headers:auth})).statusCode,422)
    }
    assert.equal((await host.app.inject({url:`/api/v1/data-portability/exports/${e.replaceAll('-','')}`,headers:auth})).statusCode,200)
    const queued=randomUUID(),running=randomUUID()
    for(const [id,state] of [[queued,'queued'],[running,'running']])await pool.query('INSERT INTO data_export_jobs(id,user_id,status,stage,progress_current,created_at) VALUES($1,$2,$3,$3,0,CURRENT_TIMESTAMP)',[id,a,state])
    const cancelPath=`/api/v1/data-portability/exports/${queued}/cancel`
    assert.equal((await host.app.inject({method:'POST',url:cancelPath})).statusCode,401)
    assert.equal((await host.app.inject({method:'POST',url:cancelPath,headers:other})).statusCode,404)
    const canceled=await host.app.inject({method:'POST',url:cancelPath,headers:auth});assert.equal(canceled.statusCode,200);assert.equal(canceled.json().status,'canceled')
    assert.equal((await host.app.inject({method:'POST',url:cancelPath,headers:auth})).statusCode,409)
    assert.equal((await host.app.inject({method:'POST',url:`/api/v1/data-portability/exports/${running}/cancel`,headers:auth})).json().status,'canceling')
    assert.equal((await host.app.inject({method:'POST',url:`/api/v1/data-portability/exports/${e}/cancel`,headers:auth})).statusCode,409)
    assert.equal((await host.app.inject({method:'POST',url:'/api/v1/data-portability/exports/invalid/cancel',headers:auth})).statusCode,422)
    assert.equal((await pool.query('SELECT status FROM data_export_jobs WHERE id=$1',[queued])).rows[0].status,'canceled')
    const createPath='/api/v1/data-portability/exports',createBody={categories:['projects'],idempotency_key:'synthetic-production-request'}
    assert.equal((await host.app.inject({method:'POST',url:createPath,payload:createBody})).statusCode,401)
    const created=await host.app.inject({method:'POST',url:createPath,headers:other,payload:createBody});assert.equal(created.statusCode,202);assert.equal(created.json().status,'queued')
    assert.equal((await host.app.inject({method:'POST',url:createPath,headers:other,payload:createBody})).json().id,created.json().id)
    assert.equal((await host.app.inject({method:'POST',url:createPath,headers:other,payload:{...createBody,categories:['clients']}})).statusCode,409)
    assert.equal((await host.app.inject({method:'POST',url:createPath,headers:auth,payload:{...createBody,categories:['archive_docs']}})).statusCode,422)
  } finally {collector.closeAllConnections();await new Promise<void>(resolve=>collector.close(()=>resolve()));await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
