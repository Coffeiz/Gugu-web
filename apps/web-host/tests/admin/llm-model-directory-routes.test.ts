import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {registerModelDirectoryRoutes} from '../../src/modules/admin/llm-model-directory.js'
import {createAdminModelDirectory} from '../../../../packages/core/src/agent/config/admin-model-directory.js'
import {installHttpErrorHandler} from '../../src/http/errors.js'

test('模型列表权限先于读取/请求，保存凭据仅用于同目的地语音预览，临时配置不写文件',async()=>{
 const document={other:{keep:true},ai_presets:{active_id:'a',items:[{id:'a',provider:'local',base_url:'http://127.0.0.1:42424/v1',api_key:'synthetic-llm-key',ollama_api_mode:'openai'}]},voice_presets:{active_id:'v',items:[{id:'v',provider:'qwen',base_url:'https://voice.example.invalid/v1/',api_key:'synthetic-voice-key'}]}}
 const before=structuredClone(document);let reads=0,calls=0;const seen:unknown[]=[]
 const operations=createAdminModelDirectory(()=>{reads++;return document},async input=>{calls++;seen.push(input);return {models:['synthetic-model'],source:'provider'}})
 const app=Fastify();installHttpErrorHandler(app)
 registerModelDirectoryRoutes(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')return reply.code(req.headers.authorization?403:401).send({detail:'拒绝访问'})},operations})
 try{
  const base='/api/v1/admin/agent',headers={authorization:'admin'}
  for(const [method,url] of [['GET',`${base}/llm-presets/a/models`],['POST',`${base}/llm-presets/models-preview`],['POST',`${base}/voice-presets/models-preview`]] as const){assert.equal((await app.inject({method,url,payload:method==='POST'?{}:undefined})).statusCode,401);assert.equal((await app.inject({method,url,payload:method==='POST'?{}:undefined,headers:{authorization:'user'}})).statusCode,403)}assert.equal(reads,0);assert.equal(calls,0)
  assert.equal((await app.inject({method:'GET',url:`${base}/llm-presets/a/models`,headers})).statusCode,200);assert.deepEqual(seen.at(-1),{provider:'local',base_url:'http://127.0.0.1:42424/v1',api_key:'synthetic-llm-key',api_format:''})
  assert.equal((await app.inject({method:'GET',url:`${base}/llm-presets/missing/models`,headers})).statusCode,404)
  assert.equal((await app.inject({method:'POST',url:`${base}/llm-presets/models-preview`,headers,payload:{provider:'local',local_runtime:'llama.cpp'}})).statusCode,200);assert.deepEqual(seen.at(-1),{provider:'local',api_key:'',base_url:'',api_format:''})
  const voice=`${base}/voice-presets/models-preview`
  assert.equal((await app.inject({method:'POST',url:voice,headers,payload:{provider:'qwen',base_url:'https://voice.example.invalid/v1',preset_id:'v'}})).statusCode,200);assert.equal((seen.at(-1) as {api_key:string}).api_key,'synthetic-voice-key')
  for(const payload of [{provider:'openai',base_url:'https://voice.example.invalid/v1',preset_id:'v'},{provider:'qwen',base_url:'https://changed.example.invalid/v1',preset_id:'v'},{}]){const previousCallCount:number=calls;assert.equal((await app.inject({method:'POST',url:voice,headers,payload})).statusCode,422);assert.equal(calls,previousCallCount)}
  assert.equal((await app.inject({method:'POST',url:voice,headers,payload:{provider:'local'}})).statusCode,200)
  assert.equal((await app.inject({method:'POST',url:voice,headers,payload:{preset_id:'missing'}})).statusCode,404)
  assert.equal((await app.inject({method:'POST',url:voice,headers,payload:{preset_id:'missing',api_key:'synthetic-explicit'}})).statusCode,200)
  for(const payload of [null,[],{provider:1},{api_key:null},{api_format:[]},{local_runtime:true}])assert.equal((await app.inject({method:'POST',url:voice,headers:{...headers,'content-type':'application/json'},payload:JSON.stringify(payload)})).statusCode,422)
  assert.deepEqual(document,before)
 }finally{await app.close()}
})
