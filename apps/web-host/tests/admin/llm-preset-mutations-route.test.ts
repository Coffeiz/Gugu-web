import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {registerLlmPresetMutationRoutes} from '../../src/modules/admin/llm-preset-mutations.js'
import {createLlmPresetMutations} from '../../../../packages/core/src/agent/config/llm-preset-mutations.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

test('LLM创建/更新DTO与真实Pydantic一致，权限先于写入，响应遮蔽凭据',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python)
 const cases=[{method:'POST',body:{}},{method:'POST',body:{name:'甲',provider:'local'}},{method:'POST',body:{name:'甲',provider:1}},{method:'POST',body:{name:'甲',provider:'local',max_tokens:true,context_tokens:'2.0',image:'yes',capability_overrides:{tools:'false'}}},{method:'POST',body:{name:'甲',provider:'local',max_tokens:'1_000',context_tokens:2000}},{method:'POST',body:{name:'甲',provider:'local',max_tokens:1.2}},{method:'POST',body:{name:'甲',provider:'local',context_tokens:1}},{method:'POST',body:{name:'甲',provider:'local',api_key:null}},{method:'POST',body:{name:'甲',provider:'local',reasoning_persistence:'bad'}},{method:'PUT',body:{name:null,model:null,api_key:''}},{method:'PUT',body:{max_tokens:'2.0',context_tokens:1000,image:1,in_pool:'on',capability_overrides:{tools:0}}},{method:'PUT',body:{max_tokens:null,context_tokens:null}},{method:'PUT',body:{capability_overrides:[]}},{method:'PUT',body:{model:2}},{method:'PUT',body:{image:[]}}, {method:'PUT',body:[]},{method:'PUT',body:null}]
 const expected=JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from types import SimpleNamespace
from pydantic import ValidationError
from fastapi import HTTPException
from app.api.v1 import agent_admin as api
api._uuid.uuid4=lambda:SimpleNamespace(hex='12345678'+'0'*24)
result=[]
for case in json.load(sys.stdin):
 doc={'ai_presets':{'active_id':'a','items':[{'id':'a','name':'原名称','provider':'qwen','api_key':'synthetic-old-secret','model':'original','api_format':'responses'}]}}
 api._mutate_presets=lambda work:work(doc,api._ensure_presets(doc))
 try:
  body=(api.PresetCreate if case['method']=='POST' else api.PresetUpdate).model_validate(case['body'])
  result.append({'status':200,'body':asyncio.run(api.create_llm_preset(body,db=None) if case['method']=='POST' else api.update_llm_preset('a',body,db=None))})
 except ValidationError:result.append({'status':422})
 except HTTPException as error:result.append({'status':error.status_code,'body':{'detail':error.detail}})
print(json.dumps(result))`],{encoding:'utf8',input:JSON.stringify(cases),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-llm-mutation-route'}}))
 const app=Fastify();installHttpErrorHandler(app);let calls=0
 const operations=createLlmPresetMutations(async work=>{calls++;return work({ai_presets:{active_id:'a',items:[{id:'a',name:'原名称',provider:'qwen',api_key:'synthetic-old-secret',model:'original',api_format:'responses'}]}})},async()=>0,()=> 'p_12345678')
 registerLlmPresetMutationRoutes(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},operations})
 try{
  const base='/api/v1/admin/agent/llm-presets'
  for(const method of ['POST','PUT'] as const){const url=method==='POST'?base:`${base}/a`;assert.equal((await app.inject({method,url,payload:{}})).statusCode,401);assert.equal((await app.inject({method,url,payload:{},headers:{authorization:'user'}})).statusCode,403)}assert.equal(calls,0)
  for(const [index,item] of cases.entries()){
   const response=await app.inject({method:item.method as 'POST'|'PUT',url:item.method==='POST'?base:`${base}/a`,headers:{authorization:'admin','content-type':'application/json'},payload:JSON.stringify(item.body)})
   assert.equal(response.statusCode,expected[index].status,`case ${index}`);if(expected[index].body)assert.deepEqual(response.json(),expected[index].body)
   assert.doesNotMatch(response.body,/synthetic-old-secret/)
  }
 }finally{await app.close()}
})
