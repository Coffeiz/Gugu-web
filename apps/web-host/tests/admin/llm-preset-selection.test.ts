import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {createLlmPresetSelection} from '../../../../packages/core/src/agent/config/llm-preset-selection.js'

test('激活完整同步模型字段；删除last/active/不存在语义与实际Python handler一致',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python,'需要显式隔离测试Python')
 const document={ai:{provider:'old',api_key:'synthetic-old',model:'old-model',unrelated:'discard-on-activate'},ai_presets:{active_id:'a',strategy:'pool',pool_mode:'round_robin',items:[{id:'a',name:'A',provider:'openai',model:'a-model',api_key:'synthetic-a'},{id:'b',name:'B',provider:'ollama',model:'b-model',api_key:'synthetic-b',base_url:'https://example.invalid',api_format:'openai',thinking:'enabled',image:true,video:true,audio:true,web_search_enabled:true,ollama_mode:'cloud',capability_overrides:{tools:false},custom:'preserved'}],custom:'keep'},storage:{backend:'local'},other:{preserve:true}}
 const cases=[{document,operation:'activate',id:'b'},{document,operation:'activate',id:'missing'},{document,operation:'delete',id:'b'},{document,operation:'delete',id:'missing'},{document,operation:'delete',id:'a'},{document:{ai:{model:'legacy'}},operation:'delete',id:'missing'},{document:{ai:{model:'legacy'}},operation:'activate',id:'default'}]
 const expected=JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from copy import deepcopy
from fastapi import HTTPException
from app.api.v1 import agent_admin as api
result=[]
for case in json.load(sys.stdin):
 doc=deepcopy(case['document'])
 def mutate(work): return work(doc,api._ensure_presets(doc))
 api._mutate_presets=mutate
 try:
  response=asyncio.run((api.activate_llm_preset if case['operation']=='activate' else api.delete_llm_preset)(case['id'],db=None))
  result.append({'status':200,'body':response,'document':doc})
 except HTTPException as error: result.append({'status':error.status_code,'body':{'detail':error.detail}})
print(json.dumps(result))`],{encoding:'utf8',input:JSON.stringify(cases),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-preset-selection'}}))
 for(const [index,item] of cases.entries()){
  let current:Record<string,unknown>=structuredClone(item.document),invalidations=0,writes=0
  const operations=createLlmPresetSelection(async work=>{const next=structuredClone(current),result=work(next);current=next;writes++;return result},async()=>{invalidations++;return 0})
  let response:unknown,status=200
  try{response=await (item.operation==='activate'?operations.activate(item.id):operations.delete(item.id))}
  catch(error){const e=error as Error&{code:string};status=e.code==='not_found'?404:400;response={detail:e.message}}
  assert.equal(status,expected[index].status,`case ${index}`);assert.deepEqual(response,expected[index].body)
  if(status===200){assert.deepEqual(current,expected[index].document);assert.equal(invalidations,1);assert.equal(writes,1)}
  else{assert.deepEqual(current,item.document);assert.equal(invalidations,0);assert.equal(writes,0)}
 }
})
test('状态失效失败时配置已提交，保存失败不调用状态清理',async()=>{
 let current:Record<string,unknown>={ai_presets:{active_id:'a',items:[{id:'a',model:'a'},{id:'b',model:'b'}]}},invalidations=0
 const operations=createLlmPresetSelection(async work=>work(current),async()=>{invalidations++;throw new Error('synthetic DB failure')})
 await assert.rejects(()=>operations.activate('b'),/synthetic DB failure/)
 assert.equal((current.ai_presets as Record<string,unknown>).active_id,'b');assert.equal(invalidations,1)
 await assert.rejects(()=>operations.delete('a'),/synthetic DB failure/)
 assert.deepEqual((current.ai_presets as Record<string,unknown>).items,[{id:'b',model:'b'}]);assert.equal(invalidations,2)
 const failed=createLlmPresetSelection(async()=>{throw new Error('synthetic save failure')},async()=>{invalidations++;return 0})
 await assert.rejects(()=>failed.activate('b'));assert.equal(invalidations,2)
})
