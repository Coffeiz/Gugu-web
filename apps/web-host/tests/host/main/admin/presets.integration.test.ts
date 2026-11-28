import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import type {LightMyRequestResponse} from 'fastify'
import {Pool} from 'pg'
import {startServer} from '../../../../src/main.js'
import {signedUserToken} from '../../../helpers/auth.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('生产LLM六项配置事务与PG状态，由Python实际消费者读取', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`llm_config_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-llm-config-')),owner=randomUUID(),other=randomUUID(),secret='synthetic-llm-configuration-secret'
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema}`)
 const pool=new Pool({connectionString:scoped.toString(),max:3}),override=join(root,'config.json')
 const document={ai:{provider:'openai',model:'active-model',api_key:'synthetic-active-key'},ai_presets:{active_id:'a',items:[{id:'a',provider:'openai',model:'active-model',api_key:'synthetic-active-key',in_pool:false},{id:'b',provider:'openai',model:'pool-model',api_key:'synthetic-pool-key',in_pool:true},{id:'c',provider:'openai',model:'second-pool-model',api_key:'synthetic-second-key',in_pool:true}]},other:{preserve:true}}
 await writeFile(override,JSON.stringify(document))
 const env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:override,TEST_SCHEMA:schema,TEST_OWNER:owner,TEST_OTHER:other}
 const bridge=(action:string)=>JSON.parse(execFileSync(python!,[resolve('../../compat/support/llm_strategy.py'),action],{encoding:'utf8',cwd:resolve('../../backend'),env,timeout:20000}))
 let host:Awaited<ReturnType<typeof startServer>>|undefined
 try{
  bridge('setup')
  const socket=createServer();await new Promise<void>(done=>socket.listen(0,'127.0.0.1',done));const address=socket.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(done=>socket.close(()=>done()))
  host=await startServer({GUGU_WEBUI_DATABASE_URL:scoped.toString(),GUGU_WEBUI_SECRET_KEY:secret,GUGU_CONFIG_OVERRIDE_FILE:override,GUGU_WEBUI_HOST:'127.0.0.1',GUGU_WEBUI_PORT:String(address.port),GUGU_WEBUI_REDIS_URL:'',STORAGE__LOCAL_PATH:join(root,'storage'),ADMIN_USERNAME:'synthetic-admin',ADMIN_PASSWORD:'synthetic-password'})
  const base='/api/v1/admin/agent/llm-presets',strategy=`${base}/strategy`
  for(const [method,url] of [['POST',strategy],['POST',`${base}/c/activate`],['DELETE',`${base}/b`],['PUT',`${base}/c/capability-overrides`],['POST',base],['PUT',`${base}/c`]] as const){assert.equal((await host.app.inject({method,url,payload:method==='DELETE'?undefined:{}})).statusCode,401);assert.equal((await host.app.inject({method,url,payload:method==='DELETE'?undefined:{},headers:{authorization:`Bearer ${signedUserToken(secret,owner)}`}})).statusCode,403)}
  const login:LightMyRequestResponse=await host.app.inject({method:'POST',url:'/api/v1/admin/auth/login',payload:{username:'synthetic-admin',password:'synthetic-password'}})
  assert.equal(login.statusCode,200);const headers={authorization:`Bearer ${login.json().access_token}`}
  const poolResponse:LightMyRequestResponse=await host.app.inject({method:'POST',url:strategy,headers,payload:{strategy:'pool',pool_mode:'round_robin'}})
  assert.equal(poolResponse.statusCode,200,poolResponse.body);assert.deepEqual(poolResponse.json(),{strategy:'pool',pool_mode:'round_robin'})
  const selected=bridge('consume');assert.deepEqual(selected.selections,['pool-model','second-pool-model','pool-model','second-pool-model']);assert.equal(selected.unavailable_reason,'config_changed');assert.equal(selected.expected_version,8)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_reasoning_states WHERE status='invalidated' AND encrypted_payload='' AND payload_nonce='' AND encrypted_data_key='' AND payload_size=0 AND version=8")).rows[0].n,2)
  assert.equal((await pool.query('SELECT status,version FROM provider_reasoning_states WHERE id=3')).rows[0].status,'expired')
  assert.equal((await host.app.inject({method:'POST',url:`${base}/c/activate`,headers})).statusCode,200)
  assert.equal((await host.app.inject({method:'POST',url:strategy,headers,payload:{strategy:'active'}})).statusCode,200)
  assert.equal(bridge('consume').model,'second-pool-model')
  const preserved=JSON.parse(await readFile(override,'utf8'));assert.equal(preserved.ai_presets.active_id,'c');assert.equal(preserved.ai.model,'second-pool-model');assert.equal(preserved.ai.api_key,'synthetic-second-key');assert.equal(preserved.ai.context_tokens,256000);assert.equal(preserved.ai.max_tokens,51200);assert.equal(preserved.ai.ollama_api_mode,'native');assert.deepEqual(preserved.other,document.other)
  const capabilities=`${base}/c/capability-overrides`
  const changed=await host.app.inject({method:'PUT',url:capabilities,headers,payload:{tools:'false',parallel_tools:0,image:'YES'}})
  assert.equal(changed.statusCode,200,changed.body);assert.deepEqual(changed.json(),{capability_overrides:{tools:false,parallel_tools:false,image:true}})
  const observed=bridge('capabilities');assert.equal(observed.tools,false);assert.equal(observed.parallel_tools,false);assert.equal(observed.image,true);assert.deepEqual(observed.overrides,{tools:false,parallel_tools:false,image:true})
  const saved=JSON.parse(await readFile(override,'utf8'));assert.deepEqual(saved.ai.capability_overrides,observed.overrides);assert.equal(saved.ai.capability_checked_at,'');assert.equal(saved.ai.capability_fingerprint,'')
  assert.equal((await host.app.inject({method:'PUT',url:capabilities.replace('/c/','/missing/'),headers,payload:{tools:true}})).statusCode,404)
  assert.equal((await host.app.inject({method:'PUT',url:capabilities,headers,payload:{unknown:true}})).statusCode,400)
  const created=await host.app.inject({method:'POST',url:base,headers,payload:{name:'合成池模型',provider:'qwen',api_format:'responses',model:'created-model',api_key:'synthetic-created-secret'}})
  assert.equal(created.statusCode,200,created.body);assert.match(created.json().id,/^p_[0-9a-f]{8}$/);assert.doesNotMatch(created.body,/synthetic-created-secret/);assert.equal(created.json().web_search_enabled,true)
  assert.equal((await host.app.inject({method:'POST',url:`${base}/${created.json().id}/activate`,headers})).statusCode,200)
  assert.equal(bridge('consume').model,'created-model')
  const edited=await host.app.inject({method:'PUT',url:`${base}/${created.json().id}`,headers,payload:{provider:'openai',model:'edited-model',base_url:'https://changed.example.invalid/v1',api_key:'',image_detail:'bad'}})
  assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().web_search_enabled,false);assert.equal(edited.json().image_detail,'auto');assert.doesNotMatch(edited.body,/synthetic-created-secret/)
  const afterEdit=JSON.parse(await readFile(override,'utf8'));assert.equal(afterEdit.ai.api_key,'synthetic-created-secret');assert.equal(afterEdit.ai.base_url,'https://changed.example.invalid/v1');assert.equal(bridge('consume').model,'edited-model')
  assert.equal((await host.app.inject({method:'PUT',url:`${base}/${created.json().id}`,headers,payload:{web_search_enabled:true}})).statusCode,422)
  assert.equal((await host.app.inject({method:'POST',url:`${base}/c/activate`,headers})).statusCode,200)
  assert.equal((await host.app.inject({method:'DELETE',url:`${base}/${created.json().id}`,headers})).statusCode,200)
  assert.equal((await host.app.inject({method:'DELETE',url:`${base}/c`,headers})).statusCode,400)
  assert.equal((await host.app.inject({method:'POST',url:`${base}/missing/activate`,headers})).statusCode,404)
  assert.deepEqual((await host.app.inject({method:'DELETE',url:`${base}/b`,headers})).json(),{deleted:'b'})
  assert.deepEqual((await host.app.inject({method:'DELETE',url:`${base}/missing`,headers})).json(),{deleted:'missing'})
  assert.deepEqual(JSON.parse(await readFile(override,'utf8')).ai_presets.items.map((item:{id:string})=>item.id),['a','c'])
  await pool.query("UPDATE provider_reasoning_states SET status='active';CREATE FUNCTION fail_llm_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic state failure';END $$;CREATE TRIGGER fail_llm_state BEFORE UPDATE ON provider_reasoning_states FOR EACH ROW EXECUTE FUNCTION fail_llm_state()")
  const failed:LightMyRequestResponse=await host.app.inject({method:'POST',url:strategy,headers,payload:{pool_mode:'least_loaded'}})
  assert.equal(failed.statusCode,500);assert.doesNotMatch(failed.body,/synthetic state failure|synthetic-.*-key/)
  assert.equal(JSON.parse(await readFile(override,'utf8')).ai_presets.pool_mode,'least_loaded');assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_reasoning_states WHERE status='active'")).rows[0].n,3)
  const overrideFailed=await host.app.inject({method:'PUT',url:capabilities,headers,payload:{image:false}})
  assert.equal(overrideFailed.statusCode,500);assert.doesNotMatch(overrideFailed.body,/synthetic state failure|synthetic-.*-key/)
  assert.deepEqual(JSON.parse(await readFile(override,'utf8')).ai.capability_overrides,{image:false});assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_reasoning_states WHERE status='active'")).rows[0].n,3)
  const updateFailed=await host.app.inject({method:'PUT',url:`${base}/c`,headers,payload:{model:'committed-before-db-failure',api_key:''}})
  assert.equal(updateFailed.statusCode,500);assert.doesNotMatch(updateFailed.body,/synthetic state failure|synthetic-.*-key/);assert.equal(JSON.parse(await readFile(override,'utf8')).ai.model,'committed-before-db-failure')
  const createFailed=await host.app.inject({method:'POST',url:base,headers,payload:{name:'持久化失败回执',provider:'local',model:'created-before-db-failure'}})
  assert.equal(createFailed.statusCode,500);assert.ok(JSON.parse(await readFile(override,'utf8')).ai_presets.items.some((item:{model:string})=>item.model==='created-before-db-failure'));assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_reasoning_states WHERE status='active'")).rows[0].n,3)
  await writeFile(override,'{')
  assert.equal((await host.app.inject({method:'POST',url:`${base}/c/activate`,headers})).statusCode,503);assert.equal(await readFile(override,'utf8'),'{')
  await rm(override);assert.equal((await host.app.inject({method:'POST',url:strategy,headers,payload:{strategy:'active'}})).statusCode,503)
 }finally{await host?.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})
