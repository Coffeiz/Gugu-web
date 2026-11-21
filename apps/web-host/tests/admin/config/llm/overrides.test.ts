import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createLlmCapabilityOverrideSetter} from '../../../../../../packages/core/src/agent/config/llm-capability-overrides.js'
import {createLlmStrategyFileMutator} from '../../../../src/modules/admin/llm-strategy.js'

test('人工能力覆盖与Python handler一致：白名单、替换、清指纹、active完整同步及错误顺序',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python,'需要显式隔离测试Python')
 const base={ai:{provider:'openai',model:'old-model',api_key:'synthetic-old'},ai_presets:{active_id:'a',items:[{id:'a',provider:'openai',model:'a-model',api_key:'synthetic-a',capability_overrides:{audio:true},capability_checked_at:'old-check',capability_fingerprint:'old-fingerprint'},{id:'b',provider:'openai',model:'b-model',api_key:'synthetic-b',capability_checked_at:'other-check',capability_fingerprint:'other-fingerprint'}]},other:{keep:true}}
 const cases=[{id:'a',body:{tools:false,image:true}},{id:'b',body:{thinking:true,structured_json:false}},{id:'a',body:{}},{id:'missing',body:{tools:true}},{id:'missing',body:{unknown:true}},{id:'a',body:{tools:1}}]
 const expected=JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from copy import deepcopy
from fastapi import HTTPException
from app.api.v1 import agent_admin as api
data=json.load(sys.stdin);result=[]
for case in data['cases']:
 doc=deepcopy(data['base'])
 api._mutate_presets=lambda work:work(doc,api._ensure_presets(doc))
 try: result.append({'status':200,'body':asyncio.run(api.update_capability_overrides(case['id'],case['body'],db=None)),'document':doc})
 except HTTPException as error: result.append({'status':error.status_code,'body':{'detail':error.detail}})
print(json.dumps(result))`],{encoding:'utf8',input:JSON.stringify({base,cases}),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-capability-overrides'}}))
 for(const [index,item] of cases.entries()){
  let document:Record<string,unknown>=structuredClone(base),invalidated=0
  const set=createLlmCapabilityOverrideSetter(async work=>{const next=structuredClone(document),response=work(next);document=next;return response},async()=>{invalidated++;return 0})
  let status=200,response:unknown
  try{response=await set(item.id,item.body)}catch(error){const e=error as Error&{code:string};status=e.code==='not_found'?404:400;response={detail:e.message}}
  assert.equal(status,expected[index].status);assert.deepEqual(response,expected[index].body)
  if(status===200){assert.deepEqual(document,expected[index].document);assert.equal(invalidated,1)}else{assert.deepEqual(document,base);assert.equal(invalidated,0)}
 }
})
test('真实Python capability_snapshot消费保存覆盖，失效失败时文件仍已提交',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python,'需要显式隔离测试Python')
 const root=await mkdtemp(join(tmpdir(),'gugu-capability-override-')),path=join(root,'config.json')
 try{
  await writeFile(path,JSON.stringify({ai:{obsolete_field:'old',capability_overrides:{audio:true}},ai_presets:{active_id:'a',items:[{id:'a',provider:'openai',base_url:'https://example.invalid/v1',api_key:'synthetic-key',model:'synthetic-model',api_format:'openai',capability_checked_at:'old',capability_fingerprint:'old'}]},other:{keep:true}}))
  const set=createLlmCapabilityOverrideSetter(createLlmStrategyFileMutator(path),async()=>{throw new Error('synthetic state failure')})
  await assert.rejects(()=>set('a',{tools:false,parallel_tools:false,image:true}),/synthetic state failure/)
  const snapshot=JSON.parse(execFileSync(python,['-c',"import json;from app.core.config import get_settings;from agent.providers import capability_snapshot;print(json.dumps(capability_snapshot(get_settings().ai)))"],{encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:path}}))
  assert.equal(snapshot.tools,false);assert.equal(snapshot.parallel_tools,false);assert.equal(snapshot.image,true);assert.deepEqual(snapshot.overrides,{tools:false,parallel_tools:false,image:true})
  const document=JSON.parse(await readFile(path,'utf8'));assert.equal(document.ai_presets.items[0].capability_checked_at,'');assert.equal(document.ai_presets.items[0].capability_fingerprint,'');assert.deepEqual(document.other,{keep:true});assert.equal(Object.hasOwn(document.ai,'obsolete_field'),false)
 }finally{await rm(root,{recursive:true,force:true})}
})
