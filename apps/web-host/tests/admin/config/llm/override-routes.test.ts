import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {registerLlmCapabilityOverrideRoute} from '../../../../src/modules/admin/llm-probe.js'
import {createLlmCapabilityOverrideSetter} from '../../../../../../packages/core/src/agent/config/llm-capability-overrides.js'
import {LlmStrategyConfigurationError} from '../../../../../../packages/core/src/agent/config/llm-strategy.js'
import {installHttpErrorHandler} from '../../../../src/http/errors.js'

test('能力覆盖请求与真实Pydantic字典转换和handler错误优先级一致，权限先于副作用',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python)
 const payloads=[{},null,[],{tools:true},{tools:1,image:'YES',audio:0,video:'off'},{tools:1.0},{tools:2},{tools:null},{tools:[]},{tools:' true '},{unknown:true},{unknown:'bad'},{tools:'FALSE',parallel_tools:'on'}]
 const expected=JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from pydantic import TypeAdapter,ValidationError
from fastapi import HTTPException
from app.api.v1 import agent_admin as api
result=[]
for value in json.load(sys.stdin):
 doc={'ai_presets':{'active_id':'a','items':[{'id':'a','provider':'openai'}]}}
 api._mutate_presets=lambda work:work(doc,api._ensure_presets(doc))
 try: result.append({'status':200,'body':asyncio.run(api.update_capability_overrides('a',TypeAdapter(dict[str,bool]).validate_python(value),db=None))})
 except ValidationError: result.append({'status':422})
 except HTTPException as error: result.append({'status':error.status_code,'body':{'detail':error.detail}})
print(json.dumps(result))`],{encoding:'utf8',input:JSON.stringify(payloads),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-capability-override-route'}}))
 const app=Fastify();installHttpErrorHandler(app);let calls=0,unavailable=false,stateFailure=false
 const set=createLlmCapabilityOverrideSetter(async work=>{calls++;if(unavailable)throw new LlmStrategyConfigurationError();return work({ai_presets:{active_id:'a',items:[{id:'a',provider:'openai'}]}})},async()=>{if(stateFailure)throw new Error('synthetic-secret-state');return 0})
 registerLlmCapabilityOverrideRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},set})
 try{
  const url='/api/v1/admin/agent/llm-presets/a/capability-overrides',headers={authorization:'admin'}
  assert.equal((await app.inject({method:'PUT',url,payload:{}})).statusCode,401);assert.equal((await app.inject({method:'PUT',url,payload:{},headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  for(const [index,payload] of payloads.entries()){
   const response=await app.inject({method:'PUT',url,payload:JSON.stringify(payload),headers:{...headers,'content-type':'application/json'}})
   assert.equal(response.statusCode,expected[index].status,`case ${index}`);if(expected[index].body)assert.deepEqual(response.json(),expected[index].body)
  }
  assert.equal((await app.inject({method:'PUT',url,headers})).statusCode,422)
  assert.equal((await app.inject({method:'PUT',url:url.replace('/a/','/missing/'),payload:{},headers})).statusCode,404)
  unavailable=true;assert.equal((await app.inject({method:'PUT',url,payload:{},headers})).statusCode,503)
  unavailable=false;stateFailure=true;const failed=await app.inject({method:'PUT',url,payload:{},headers});assert.equal(failed.statusCode,500);assert.doesNotMatch(failed.body,/synthetic-secret-state/)
 }finally{await app.close()}
})
