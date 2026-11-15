import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerCredentialCreateRoute} from '../../src/modules/byok/credential-create.js'
test('创建凭据解析与 Pydantic 布尔、整数规则一致并要求认证',async()=>{
 const app=Fastify();let body:any
 registerCredentialCreateRoute(app,{requireUser:async(req,reply)=>{if(!req.headers.authorization)return reply.code(401).send()},ownerIdFromRequest:()=> '00000000-0000-4000-8000-000000000071',create:async(_owner,input)=>{body=input;return {id:1} as never}})
 try{
  assert.equal((await app.inject({method:'POST',url:'/api/v1/byok',payload:{provider:'openai',capability:'llm'}})).statusCode,401)
  const response=await app.inject({method:'POST',url:'/api/v1/byok',headers:{authorization:'x'},payload:{provider:'openai',capability:'llm',value:'x',image:'yes',dimensions:'32'}})
  assert.equal(response.statusCode,200);assert.equal(body.image,true);assert.equal(body.dimensions,32)
 }finally{await app.close()}
})

test('HTTP请求校验与真实 Python CredentialCreate 对照', {skip:!process.env.GUGU_CORE_GOLDEN_PYTHON},async()=>{
 const {execFileSync}=await import('node:child_process'),app=Fastify()
 registerCredentialCreateRoute(app,{requireUser:async()=>{},ownerIdFromRequest:()=> '00000000-0000-4000-8000-000000000071',create:async()=>({id:1} as never)})
 const samples=[{provider:'openai',capability:'llm'}, {provider:'openai',capability:'llm',image:'yes',dimensions:'32'}, {provider:'openai',capability:'embedding',dimensions:-1}, {provider:'',capability:'llm'}, {provider:'openai',capability:'unknown'}, {provider:'openai',capability:'llm',image:null}, {provider:'openai',capability:'llm',max_tokens:'2.0'}, {provider:'openai',capability:'llm',web_search_enabled:'off'}, {provider:'openai',capability:'llm',reasoning_persistence:'bad'}, {provider:'openai',capability:'llm',image_detail:'original'}]
 const script='import json,sys\nfrom app.byok.schemas import CredentialCreate\nfrom pydantic import ValidationError\nfor x in json.load(sys.stdin):\n try: CredentialCreate.model_validate(x);print(1)\n except ValidationError: print(0)'
 const env={...process.env,GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/gugu-n2-byok-nonexistent',PYTHONPATH:'.'}
 const result=execFileSync(process.env.GUGU_CORE_GOLDEN_PYTHON!,['-c',script],{cwd:'../../backend',env,input:JSON.stringify(samples),encoding:'utf8'}).trim().split('\n').map(Number)
 try{for(let i=0;i<samples.length;i++){const response=await app.inject({method:'POST',url:'/api/v1/byok',payload:samples[i]});assert.equal(response.statusCode===200,!!result[i],`case ${i}`)}}finally{await app.close()}
})
