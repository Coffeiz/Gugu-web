import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {registerLlmStrategyRoute} from '../../src/modules/admin/llm-strategy.js'
import {createLlmStrategySetter,LlmStrategyConfigurationError} from '../../../../packages/core/src/agent/config/llm-strategy.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

test('管理员策略DTO和400/422与Python一致，配置不可用503、状态失败500不泄露',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python,'需要显式隔离测试Python')
 const payloads=[{},null,[],{strategy:null,pool_mode:null},{strategy:'pool'},{pool_mode:'least_loaded'},{strategy:'router',pool_mode:'round_robin',ignored:true},{strategy:'bad'},{pool_mode:'bad'},{strategy:0},{pool_mode:true}]
 const expected=JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys
from copy import deepcopy
from pydantic import ValidationError
from fastapi import HTTPException
from app.api.v1 import agent_admin as api
result=[]
for value in json.load(sys.stdin):
 doc={'ai_presets':{'items':[],'strategy':'active','pool_mode':'random'}}
 api._mutate_presets=lambda work:work(doc,api._ensure_presets(doc))
 try: result.append({'status':200,'body':asyncio.run(api.set_llm_strategy(api.StrategyUpdate.model_validate(value),db=None))})
 except ValidationError: result.append({'status':422})
 except HTTPException as error: result.append({'status':error.status_code,'body':{'detail':error.detail}})
print(json.dumps(result))`],{encoding:'utf8',input:JSON.stringify(payloads),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-llm-strategy-route'}}))
 const app=Fastify();installHttpErrorHandler(app);let calls=0,unavailable=false,stateFailure=false
 const setter=createLlmStrategySetter(async work=>{calls++;if(unavailable)throw new LlmStrategyConfigurationError();return work({ai_presets:{items:[],strategy:'active',pool_mode:'random'}})},async()=>{if(stateFailure)throw new Error('/tmp/synthetic-state-secret token=syntheticsecretvalue');return 0})
 registerLlmStrategyRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},set:setter})
 try{
  const url='/api/v1/admin/agent/llm-presets/strategy',headers={authorization:'admin'}
  assert.equal((await app.inject({method:'POST',url,payload:{}})).statusCode,401);assert.equal((await app.inject({method:'POST',url,payload:{},headers:{authorization:'user'}})).statusCode,403);assert.equal(calls,0)
  for(const [index,payload] of payloads.entries()){
   const response=await app.inject({method:'POST',url,payload:JSON.stringify(payload),headers:{...headers,'content-type':'application/json'}});assert.equal(response.statusCode,expected[index].status,`case ${index}`)
   if(expected[index].body)assert.deepEqual(response.json(),expected[index].body)
  }
  assert.equal((await app.inject({method:'POST',url,headers})).statusCode,422)
  unavailable=true;assert.equal((await app.inject({method:'POST',url,payload:{},headers})).statusCode,503)
  unavailable=false;stateFailure=true;const failure=await app.inject({method:'POST',url,payload:{},headers});assert.equal(failure.statusCode,500);assert.doesNotMatch(failure.body,/synthetic-state-secret|syntheticsecretvalue/)
 }finally{await app.close()}
})
