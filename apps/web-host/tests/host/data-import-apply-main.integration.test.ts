import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import {Pool} from 'pg'
import type {LightMyRequestResponse} from 'fastify'
import {startServer} from '../../src/main.js'
import {signedUserToken} from '../helpers/auth.js'
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert.ok(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port}
test('生产导入确认消费一次性能力，正式Python Worker分别消费incremental与replace且隔离owner',async()=>{
 const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(databaseUrl);assert.ok(python)
 const schema=`apply_main_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'apply-main-')),secret='synthetic-apply-host-secret',token='synthetic-import-confirmation-token-1234567890'
 await admin.query(`CREATE SCHEMA "${schema}"`);let host:Awaited<ReturnType<typeof startServer>>|undefined
 const scoped=new URL(databaseUrl);scoped.searchParams.set('options',`-c search_path=${schema} -c jit=off`)
 const fixture=resolve('tests/portability/fixtures/apply_import_worker.py'),env={...process.env,PYTHONPATH:resolve('../../backend')}
 const fixtureCall=(mode:string,...args:string[])=>JSON.parse(execFileSync(python,[fixture,mode,root,schema,...args],{cwd:resolve('../../backend'),env,encoding:'utf8',timeout:90000,maxBuffer:1024*1024}))
 try{
  await writeFile(join(root,'override.json'),JSON.stringify({storage:{local_path:join(root,'storage')}}));const prepared=fixtureCall('--prepare-isolated')
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:join(root,'override.json'),GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(await freePort()),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:join(root,'storage')})
  const headers={authorization:`Bearer ${signedUserToken(secret,prepared.owner)}`},foreign={authorization:`Bearer ${signedUserToken(secret,prepared.other)}`}
  for(const mode of ['incremental','replace']){
   const url=`/api/v1/data-portability/imports/${prepared.jobs[mode]}/apply`,payload={mode,import_token:token,idempotency_key:`synthetic-${mode}-apply`}
   assert.equal((await host.app.inject({method:'POST',url,payload})).statusCode,401);assert.equal((await host.app.inject({method:'POST',url,payload,headers:foreign})).statusCode,404)
   assert.equal((await host.app.inject({method:'POST',url,payload:{...payload,import_token:'bad'},headers})).statusCode,422)
   assert.equal((await host.app.inject({method:'POST',url,payload:{...payload,import_token:'wrong-token-with-at-least-32-chars'},headers})).statusCode,403)
   const response:LightMyRequestResponse=await host.app.inject({method:'POST',url,payload,headers});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().mode,mode);assert.equal(response.json().status,'queued');assert.doesNotMatch(response.body,/import_token|staging_key|encrypted_data_key/)
   assert.deepEqual((await host.app.inject({method:'POST',url,payload,headers})).json(),response.json())
   const consumed=fixtureCall('--consume-isolated',mode);assert.equal(consumed.mode,mode);assert.equal(consumed.status,'completed');assert.deepEqual(consumed.foreign,['其他用户项目']);if(mode==='replace')assert.equal(consumed.rollback,true)
  }
  const version=(await admin.query(`SELECT security_version FROM "${schema}".users WHERE id=$1`,[prepared.owner])).rows[0].security_version,ownerHeaders={authorization:`Bearer ${signedUserToken(secret,prepared.owner,version)}`}
  const url=`/api/v1/data-portability/imports/${prepared.jobs.replace}/rollback`,payload={idempotency_key:'synthetic-production-rollback'}
  assert.equal((await host.app.inject({method:'POST',url,payload})).statusCode,401);assert.equal((await host.app.inject({method:'POST',url,payload,headers:foreign})).statusCode,404)
  const response=await host.app.inject({method:'POST',url,payload,headers:ownerHeaders});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().mode,'rollback');assert.deepEqual((await host.app.inject({method:'POST',url,payload,headers:ownerHeaders})).json(),response.json())
  const restored=fixtureCall('--consume-isolated','rollback',response.json().id);assert.equal(restored.status,'rolled_back');assert.deepEqual(new Set(restored.names),new Set(['初始项目','增量导入项目']));assert.deepEqual(restored.foreign,['其他用户项目'])
 }finally{await host?.close();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
