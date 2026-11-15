import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {createLlmModelDirectory} from '../../../../packages/core/src/agent/config/llm-model-directory.js'
import type {ProviderTransport,ProviderHttpRequest} from '../../../../packages/core/src/agent/providers/contracts.js'

test('模型目录由真实Python handler对照协议、去重排序、异常状态且不回显上游密钥',async()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python)
 const cases=[{provider:'openai',payload:{data:[{id:'z'},{id:'a'},{id:'a'},{id:''},{id:0},{id:null},{name:'no'},{id:'\uE000'},{id:'😀'}]}},{provider:'anthropic',payload:[{id:'claude'}]},{provider:'ollama',api_key:'含中文',payload:{models:[{name:'native-model'}]}},{provider:'qwen',api_format:'dashscope',base_url:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',payload:{data:[{id:'qwen'}]}},{provider:'qwen',api_format:'dashscope',base_url:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation///',payload:{data:[{id:'qwen-trailing'}]}},{provider:'local',base_url:'http://127.0.0.1:42424/v1',payload:{data:[{id:'local'}]}},{provider:'mimo',payload:{data:[]}},{provider:'openai',status:401,payload:{error:'synthetic-upstream-secret'}},{provider:'openai',status:429,payload:{error:'synthetic-upstream-secret'}},{provider:'openai',status:500,payload:{error:'synthetic-upstream-secret'}},{provider:'openai',payload:{data:null}},{provider:'openai',payload:{data:{ignored:true}}},{provider:'openai',payload:{data:[{id:true},{id:3},{id:['nested',true,null]},{id:{alias:'m'}},{id:[]},{id:{}}]}},{provider:'openai',raw:'{"data":[{"id":1.0},{"id":1e-7},{"id":1000000000000000000000},{"id":0.0}]}'},{provider:'openai',raw:'bad-json'}].map(item=>({api_key:'synthetic-key',api_format:'',base_url:'',status:200,...item}))
 const expected=JSON.parse(execFileSync(python,['-c',`import asyncio,json,sys,logging
logging.getLogger('gugu.diag').addHandler(logging.NullHandler())
from fastapi import HTTPException
from app.api.v1 import agent_admin as api
result=[]
for case in json.load(sys.stdin):
 requests=[]
 class Response:
  status_code=case['status'];text=case.get('raw',json.dumps(case.get('payload')))
  def json(self):return json.loads(self.text)
 class Client:
  def __init__(self,**kwargs):pass
  async def __aenter__(self):return self
  async def __aexit__(self,*args):pass
  async def get(self,url,headers):requests.append({'url':url,'headers':{key.lower():value for key,value in headers.items()}});return Response()
 api.httpx=None
 import httpx
 httpx.AsyncClient=Client
 try:body=asyncio.run(api.preview_llm_preset_models(api.ModelsPreview.model_validate(case)));result.append({'status':200,'body':body,'requests':requests})
 except HTTPException as error:result.append({'status':error.status_code,'body':{'detail':error.detail},'requests':requests})
print(json.dumps(result))`],{encoding:'utf8',input:JSON.stringify(cases),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-llm-model-directory'}}))
 for(const [index,item] of cases.entries()){
  const requests:unknown[]=[];let cancelled=0,closed=0
  const transport:ProviderTransport={request:async(request:ProviderHttpRequest)=>{requests.push({url:request.url,headers:Object.fromEntries(Object.entries(request.headers).map(([key,value])=>[key.toLowerCase(),value]))});return {status:item.status,headers:{},body:(async function*(){yield Buffer.from(item.raw??JSON.stringify(item.payload))})(),cancel(){cancelled++}}},close:async()=>{closed++}}
  const read=createLlmModelDirectory(()=>transport)
  let status=200,body:unknown
  try{body=await read(item)}catch(error){const e=error as Error&{status:number};status=e.status;body={detail:e.message}}
  assert.equal(status,expected[index].status,`case ${index}`);assert.deepEqual(body,expected[index].body);assert.deepEqual(requests,expected[index].requests);assert.equal(cancelled,1);assert.equal(closed,1);assert.doesNotMatch(JSON.stringify(body),/synthetic-upstream-secret/)
 }
})
