import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import Fastify from 'fastify'
import {createProviderCapabilityPreview} from '../../../../packages/core/src/byok/capabilities-preview.js'
import { registerProviderCapabilityPreviewRoute } from '../../src/modules/byok/routes.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

const samples=[
 {provider:'openai',model:'gpt-4.1'},
 {provider:'qwen',model:'qwen-max',api_format:'responses'},
 {provider:'minimax',model:'MiniMax-M3',api_format:'anthropic'},
 {provider:'ollama',model:'qwen3:8b',ollama_api_mode:'native'},
 {provider:'local',model:'synthetic-model',api_format:'responses',local_runtime:'vllm'},
 {provider:'custom',model:'synthetic-model',base_url:'https://gateway.example.invalid/v1'},
]
const python=process.env.GUGU_WEBUI_TEST_PYTHON

test('BYOK无凭据能力预览与Python实际handler多Provider/协议完全对照',{skip:!python&&'需要显式测试Python'},async t=>{
 const script="import asyncio,json,sys; from app.api.v1 import byok; byok.require_byok_enabled=lambda:None; payloads=json.load(sys.stdin); print(json.dumps([asyncio.run(byok.preview_provider_capabilities(byok.ProviderCapabilityPreview(**p),None)) for p in payloads]))"
 const expected=JSON.parse(execFileSync(python!,['-c',script],{input:JSON.stringify(samples),encoding:'utf8',cwd:resolve('../../backend'),env:{...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-capability-preview-config',PYTHONPATH:'.:../compat/core-python/src'}}))
 const preview=createProviderCapabilityPreview(()=>true)
 for(let index=0;index<samples.length;index++)await t.test(samples[index]!.provider,()=>assert.deepEqual(preview(samples[index]!),expected[index]))
})

test('能力预览HTTP认证/gate/DTO限制且不接受或回显额外凭据字段',async()=>{
 let enabled=true,calls=0
 const preview=createProviderCapabilityPreview(()=>enabled)
 const app=Fastify();installHttpErrorHandler(app)
 registerProviderCapabilityPreviewRoute(app,{requireUser:async(request,reply)=>{if(request.headers.authorization!=='user')return reply.code(401).send({detail:'未授权'})},preview:config=>{calls++;return preview(config)}})
 try{
  assert.equal((await app.inject({method:'POST',url:'/api/v1/byok/capabilities',payload:{provider:'qwen'}})).statusCode,401)
  assert.equal(calls,0)
  const response=await app.inject({method:'POST',url:'/api/v1/byok/capabilities',headers:{authorization:'user'},payload:{provider:'qwen',api_key:'synthetic-private-key',capability_overrides:{audio:true}}})
  assert.equal(response.statusCode,200);assert.equal(response.json().provider,'qwen');assert.equal(response.body.includes('synthetic-private-key'),false);assert.deepEqual(response.json().overrides,{})
  for(const payload of [{provider:''},{provider:'x'.repeat(65)},{provider:'qwen',model:3}])assert.equal((await app.inject({method:'POST',url:'/api/v1/byok/capabilities',headers:{authorization:'user'},payload})).statusCode,422)
  enabled=false
  const blocked=await app.inject({method:'POST',url:'/api/v1/byok/capabilities',headers:{authorization:'user'},payload:{provider:'qwen'}})
  assert.equal(blocked.statusCode,403)
 }finally{await app.close()}
})
