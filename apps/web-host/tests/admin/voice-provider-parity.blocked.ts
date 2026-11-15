import assert from 'node:assert/strict'
import test from 'node:test'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {resolve} from 'node:path'
import {transcribeMiniMax,transcribeCompatibleAsr} from '../../../../packages/core/src/agent/providers/asr.js'
import {NodeProviderTransport} from '../../../../packages/core/src/agent/providers/transport/node.js'
const run=promisify(execFile),python=process.env.GUGU_WEBUI_TEST_PYTHON
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isolatedEnv={...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-asr-parity',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*'}

// 已确认共享差异的失败对照：不接生产，也不通过放宽共享 ASR 安全规则使其变绿。
test('MiniMax空key按真实Python仍试呼，现共享Core预先拒绝导致契约不等价',async()=>{
 assert.ok(python,'需要显式隔离测试Python')
 const expected=JSON.parse((await run(python,['-c',`import asyncio,json
from types import SimpleNamespace
import httpx
from agent.providers.minimax.asr import transcribe
requests=[]
class Client:
 def __init__(self,**kwargs): pass
 async def __aenter__(self): return self
 async def __aexit__(self,*args): pass
 async def post(self,url,**kwargs):
  requests.append(kwargs['headers']['Authorization'])
  return httpx.Response(200,json={'text':''},request=httpx.Request('POST',url))
httpx.AsyncClient=Client
async def main():
 text=await transcribe([{'type':'audio','raw':b'synthetic-audio','mime':'audio/wav','duration':1}],SimpleNamespace(model='asr-1.0',api_key='',base_url='https://api.minimax.cn'),to_wav=None,raise_errors=True)
 print(json.dumps({'text':text,'requests':requests}))
asyncio.run(main())`],{encoding:'utf8',cwd:resolve('../../backend'),env:isolatedEnv})).stdout)
 const requests:string[]=[]
 let actual:unknown
 try{
  const text=await transcribeMiniMax([{type:'audio',raw:new Uint8Array([1,2,3]),mime:'audio/wav',duration:1}],{model:'asr-1.0',api_format:'minimax-asr',api_key:'',base_url:'https://api.minimax.cn'},{digest,transport:{request:async request=>{requests.push(request.headers.Authorization!);return {status:200,headers:{},body:(async function*(){yield new TextEncoder().encode('{"text":""}')})(),cancel(){}}}},probeAudioDuration:async()=>1,toWav:async()=>null},new AbortController().signal,{raiseErrors:true})
  actual={text,requests}
 }catch(error){actual={error:(error as {code?:string}).code,requests}}
 assert.deepEqual(actual,expected)
})

test('config语音试呼无provider字段时Python实际访问合成本地服务，Core不能获得显式local授权',async()=>{
 assert.ok(python,'需要显式隔离测试Python')
 let requests=0
 const server=createServer((request,response)=>{requests++;request.resume();response.setHeader('Content-Type','application/json');response.end(JSON.stringify({id:'synthetic-asr',choices:[{index:0,message:{role:'assistant',content:''},finish_reason:'stop'}]}))})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string')
 const base=`http://127.0.0.1:${address.port}/v1`,transport=new NodeProviderTransport({allowLocal:true,trustEnvironment:false})
 try{
  const expected=JSON.parse((await run(python,['-c',`import asyncio,base64,io,json,os,wave
from agent.voice import transcribe
buffer=io.BytesIO()
with wave.open(buffer,'wb') as audio:
 audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(bytes(32000))
async def main():
 text=await transcribe([{'type':'audio','mime':'audio/wav','b64':base64.b64encode(buffer.getvalue()).decode()}],{'voice':{'model':'synthetic-asr','api_format':'openai','api_key':'synthetic-key','base_url':os.environ['TEST_BASE']}},raise_errors=True)
 print(json.dumps({'text':text}))
asyncio.run(main())`],{encoding:'utf8',cwd:resolve('../../backend'),env:{...isolatedEnv,TEST_BASE:base}})).stdout)
  assert.equal(requests,1)
  let actual:unknown
  try{actual={text:await transcribeCompatibleAsr([{type:'audio',mime:'audio/wav',raw:new Uint8Array([1,2,3])}],{model:'synthetic-asr',api_format:'openai',api_key:'synthetic-key',base_url:base},{digest,transport,toWav:async()=>null},new AbortController().signal,{raiseErrors:true})}}
  catch(error){actual={error:(error as {code?:string}).code}}
  assert.deepEqual(actual,expected)
 }finally{await transport.close();await new Promise<void>(done=>server.close(()=>done()))}
})
