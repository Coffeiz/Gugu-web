import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {Pool} from 'pg'
import {createPostgresRuntime} from '../../../../packages/core/src/data/postgres.js'
import {createLlmStrategySetter,invalidateAllProviderReasoningStates} from '../../../../packages/core/src/agent/config/llm-strategy.js'
import {mutateConfigOverride} from '../../src/adapters/config/config-override-file.js'
import {createPosixConfigFileLock} from '../../src/adapters/config/posix-config-lock.js'
const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL,python=process.env.GUGU_WEBUI_TEST_PYTHON

test('策略原子写入由真实Python pick_model消费，active推理状态全局失效且失败不回滚配置', {skip:(!databaseUrl||!python)&&'需要隔离PG与显式Python'},async()=>{
 const schema=`strategy_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl,max:1}),root=await mkdtemp(join(tmpdir(),'gugu-llm-strategy-')),owner=randomUUID()
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:3}),runtime=await createPostgresRuntime({url:databaseUrl!,schema}),override=join(root,'config.json')
 const initial={ai:{provider:'openai',api_key:'synthetic-preserved-key',base_url:'https://example.invalid/v1',model:'active-model'},ai_presets:{active_id:'a',items:[{id:'a',provider:'openai',api_key:'synthetic-preserved-key',model:'active-model',in_pool:false},{id:'b',provider:'openai',api_key:'synthetic-pool-key',model:'pool-model',in_pool:true},{id:'c',provider:'openai',api_key:'synthetic-second-key',model:'second-pool-model',in_pool:true}]},storage:{backend:'local',local_path:join(root,'storage')},other:{preserve:true}}
 await writeFile(override,JSON.stringify(initial))
 const env={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:override,TEST_SCHEMA:schema,TEST_OWNER:owner}
 const bridge=(action:string,extra:Record<string,string>={})=>JSON.parse(execFileSync(python!,[resolve('../../compat/support/llm_strategy.py'),action],{encoding:'utf8',cwd:resolve('../../backend'),env:{...env,...extra},timeout:20000}))
 try{
  bridge('setup')
  const set=createLlmStrategySetter(work=>mutateConfigOverride(override,work,createPosixConfigFileLock()),()=>invalidateAllProviderReasoningStates(runtime.db))
  assert.deepEqual(await set({strategy:'pool',pool_mode:'round_robin'}),{strategy:'pool',pool_mode:'round_robin'})
  const consumer=bridge('consume');assert.equal(consumer.model,'pool-model');assert.deepEqual(consumer.selections,['pool-model','second-pool-model','pool-model','second-pool-model']);assert.equal(consumer.unavailable_reason,'config_changed');assert.equal(consumer.expected_version,8)
  const rows=(await pool.query('SELECT id,status,version,encrypted_payload,payload_nonce,encrypted_data_key,payload_size,invalidated_reason,invalidated_at IS NOT NULL AS timed FROM provider_reasoning_states ORDER BY id')).rows
  assert.deepEqual(rows.filter(row=>row.id!==3),[1,2].map(id=>({id,status:'invalidated',version:8,encrypted_payload:'',payload_nonce:'',encrypted_data_key:'',payload_size:0,invalidated_reason:'config_changed',timed:true})))
  assert.equal(rows[2].status,'expired');assert.equal(rows[2].version,7);assert.equal(rows[2].encrypted_payload,'synthetic-ciphertext')
  for(const row of (await pool.query('SELECT provider,api_format,key_version,state_version,payload_digest,state_summary FROM provider_reasoning_states')).rows)assert.deepEqual(row,{provider:'openai',api_format:'responses',key_version:1,state_version:1,payload_digest:'synthetic-digest',state_summary:{kind:'response_id'}})
  const saved=JSON.parse(await readFile(override,'utf8'));assert.deepEqual(saved.other,initial.other);assert.deepEqual(saved.ai,initial.ai);assert.deepEqual(saved.ai_presets.items,initial.ai_presets.items)
  await pool.query("UPDATE provider_reasoning_states SET status='active';CREATE FUNCTION fail_strategy_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic invalidation failure';END $$;CREATE TRIGGER fail_strategy_state BEFORE UPDATE ON provider_reasoning_states FOR EACH ROW EXECUTE FUNCTION fail_strategy_state()")
  await assert.rejects(()=>set({strategy:'active'}));assert.equal(JSON.parse(await readFile(override,'utf8')).ai_presets.strategy,'active');assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_reasoning_states WHERE status='active'")).rows[0].n,3)
  await pool.query('DROP TRIGGER fail_strategy_state ON provider_reasoning_states')
  await Promise.all([set({strategy:'router'}),set({pool_mode:'least_loaded'})])
  const both=JSON.parse(await readFile(override,'utf8'));assert.equal(both.ai_presets.strategy,'router');assert.equal(both.ai_presets.pool_mode,'least_loaded')
  const before=await readFile(override,'utf8');for(const patch of [{strategy:'bad'},{pool_mode:'bad'}])await assert.rejects(()=>set(patch));assert.equal(await readFile(override,'utf8'),before)
  await writeFile(override,'{');await assert.rejects(()=>set({strategy:'pool'}));assert.equal(await readFile(override,'utf8'),'{')
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})

test('策略默认迁移及partial/null/no-op与真实Python handler一致，仍执行失效',async()=>{
 assert.ok(python,'需要显式隔离测试Python')
 const cases=[{document:{ai:{provider:'ollama',api_key:'synthetic',model:'local-model',ollama_mode:'cloud',reasoning_persistence:'continuation'},other:{preserve:true}},body:{}},{document:{ai:{model:'legacy'}},body:{strategy:'pool'}},{document:{ai_presets:{items:[],strategy:null,pool_mode:null}},body:{strategy:null,pool_mode:null}},{document:{ai_presets:{items:[],active_id:'',strategy:'pool',pool_mode:'random'}},body:{pool_mode:'least_loaded'}},{document:{ai:{provider:null,api_key:null,model:null,thinking:null}},body:{strategy:'active'}}]
 const expected=JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from app.api.v1 import agent_admin as api
from copy import deepcopy
result=[]
for case in json.load(sys.stdin):
 doc=deepcopy(case['document'])
 def mutate(work): return work(doc,api._ensure_presets(doc))
 api._mutate_presets=mutate
 response=asyncio.run(api.set_llm_strategy(api.StrategyUpdate.model_validate(case['body']),db=None))
 result.append({'document':doc,'response':response})
print(json.dumps(result))`],{encoding:'utf8',input:JSON.stringify(cases),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-strategy-golden'}}))
 for(const [index,item] of cases.entries()){
  const document:Record<string,unknown>=structuredClone(item.document);let invalidated=0
  const set=createLlmStrategySetter(async work=>work(document),async()=>{invalidated++;return 0})
  assert.deepEqual(await set(item.body),expected[index].response);assert.deepEqual(document,expected[index].document);assert.equal(invalidated,1)
 }
})
