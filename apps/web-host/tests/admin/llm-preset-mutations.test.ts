import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve,join} from 'node:path'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createLlmPresetMutations} from '../../../../packages/core/src/agent/config/llm-preset-mutations.js'
import {createLlmStrategyFileMutator} from '../../src/modules/admin/llm-strategy.js'

test('新建/更新完整配置与实际Python handler一致，密钥保留、目标变更、联网策略、token约束及active同步',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python)
 const base={ai:{provider:'openai',model:'old-model'},ai_presets:{active_id:'a',items:[{id:'a',name:'测试',provider:'qwen',api_key:'synthetic-old-key',base_url:'https://example.invalid/v1',model:'qwen-model',web_search_enabled:true,api_format:'responses',capability_overrides:{audio:true},capability_checked_at:'old-check',capability_fingerprint:'old-fingerprint'},{id:'b',provider:'minimax',model:'b-model',api_key:'synthetic-b'}]},other:{keep:true}}
 const cases=[{method:'create',body:{name:'新模型',provider:'qwen',api_format:'responses',api_key:'synthetic-new-key'}},{method:'create',body:{name:'本地',provider:'local',image_detail:'bad'}},{method:'create',body:{name:'不支持',provider:'openai',web_search_enabled:true}},{method:'create',body:{name:'窗口',provider:'openai',max_tokens:20,context_tokens:20}},{method:'update',id:'a',body:{name:'新名称',api_key:'',model:'new-model',base_url:'https://changed.example.invalid/v1'}},{method:'update',id:'a',body:{provider:'openai',api_key:'synthetic-replacement',image_detail:'bad'}},{method:'update',id:'a',body:{capability_overrides:{tools:false}}},{method:'update',id:'b',body:{in_pool:true,audio:true}},{method:'update',id:'a',body:{api_key:null,model:null}},{method:'update',id:'a',body:{provider:'local',web_search_enabled:true}},{method:'update',id:'a',body:{max_tokens:128000}},{method:'update',id:'missing',body:{max_tokens:128000}}]
 const expected=JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from copy import deepcopy
from types import SimpleNamespace
from fastapi import HTTPException
from app.api.v1 import agent_admin as api
api._uuid.uuid4=lambda:SimpleNamespace(hex='12345678'+'0'*24)
data=json.load(sys.stdin);result=[]
for case in data['cases']:
 doc=deepcopy(data['base'])
 api._mutate_presets=lambda work:work(doc,api._ensure_presets(doc))
 model=(api.PresetCreate if case['method']=='create' else api.PresetUpdate).model_validate(case['body'])
 try:
  body=asyncio.run(api.create_llm_preset(model,db=None) if case['method']=='create' else api.update_llm_preset(case['id'],model,db=None))
  result.append({'input':model.model_dump(),'status':200,'body':body,'document':doc})
 except HTTPException as error:result.append({'input':model.model_dump(),'status':error.status_code,'body':{'detail':error.detail}})
print(json.dumps(result))`],{encoding:'utf8',input:JSON.stringify({base,cases}),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-llm-mutations'}}))
 await Promise.all(cases.map(async(item,index)=>{
  let document:Record<string,unknown>=structuredClone(base),invalidated=0
  const operations=createLlmPresetMutations(async work=>{const next=structuredClone(document),out=work(next);document=next;return out},async()=>{invalidated++;return 0},()=> 'p_12345678')
  let status=200,response:unknown
  try{response=item.method==='create'?await operations.create(expected[index].input):await operations.update(item.id!,expected[index].input)}catch(error){const e=error as Error&{status:number};status=e.status;response={detail:e.message}}
  assert.equal(status,expected[index].status,`case ${index}`);assert.deepEqual(response,expected[index].body)
  if(status===200){assert.deepEqual(document,expected[index].document);assert.equal(invalidated,1)}else{assert.deepEqual(document,base);assert.equal(invalidated,0)}
 }))
})
test('持锁并发新建不丢预设，状态失效失败保留已提交配置，保存失败不失效',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gugu-llm-mutations-')),path=join(root,'config.json')
 try{
  await writeFile(path,JSON.stringify({ai_presets:{active_id:'',items:[]},other:{keep:true}}));let id=0,invalidated=0
  const operations=createLlmPresetMutations(createLlmStrategyFileMutator(path),async()=>{invalidated++;return 0},()=>`p_${++id}`)
  await Promise.all([operations.create({name:'甲',provider:'local'}),operations.create({name:'乙',provider:'qwen',api_format:'responses'})])
  const stored=JSON.parse(await readFile(path,'utf8'));assert.equal(stored.ai_presets.items.length,2);assert.equal(stored.ai_presets.active_id,stored.ai_presets.items[0].id);assert.equal(stored.ai.model,'');assert.equal(invalidated,2);assert.deepEqual(stored.other,{keep:true})
  const failed=createLlmPresetMutations(createLlmStrategyFileMutator(path),async()=>{throw new Error('synthetic state failure')},()=> 'p_failed')
  await assert.rejects(()=>failed.update(stored.ai_presets.active_id,{model:'saved-model',api_key:''}),/synthetic state failure/);assert.equal(JSON.parse(await readFile(path,'utf8')).ai.model,'saved-model')
  await writeFile(path,'{');await assert.rejects(()=>operations.create({name:'丙',provider:'local'}),/模型配置/);assert.equal(invalidated,2);assert.equal(await readFile(path,'utf8'),'{')
 }finally{await rm(root,{recursive:true,force:true})}
})
