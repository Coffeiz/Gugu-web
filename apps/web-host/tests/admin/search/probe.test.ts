import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {execFile} from 'node:child_process'
import {resolve} from 'node:path'
import {probeEmbedding,embeddingDimensions} from '@gugu/core/preferences/embedding-probe'
import Fastify from 'fastify'
import {createEmbeddingFileProbe,registerEmbeddingProbeRoute} from '../../../src/modules/admin/embedding-probe.js'

test('Embedding诊断使用动态配置、真实安全传输及百炼载荷，失败不泄漏密钥',async()=>{
 const received:{url:string;body:any;auth:string|undefined}[]=[]
 const upstream=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);received.push({url:req.url!,body,auth:req.headers.authorization});res.setHeader('content-type','application/json');if(body.model==='redirect'){res.writeHead(302,{location:'/credentials'});res.end('synthetic-secret');return}if(body.model==='error'){res.writeHead(401);res.end('synthetic-secret');return}res.end(JSON.stringify(body.model==='bad'?{}:body.model==='empty'?{data:[{embedding:[]}]}:req.url?.includes('multimodal')?{output:{embeddings:[{embedding:[1,2]}]}}:{data:[{embedding:[1,2,3]}]}))})
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const address=upstream.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`
 const root=await mkdtemp(join(tmpdir(),'embedding-probe-')),path=join(root,'override.json'),app=Fastify()
 await writeFile(path,JSON.stringify({embedding:{provider:'ollama',base_url:base+'/v1',api_key:'synthetic-secret',model:'saved',dimensions:9},db:{preserve:true}}));const original=await readFile(path,'utf8')
 registerEmbeddingProbeRoute(app,{requireAdmin:async(req,reply)=>{if(req.headers.authorization!=='admin')await reply.code(401).send({detail:'需要认证'})},probe:createEmbeddingFileProbe({},path)})
 const call=(payload:object,auth='admin')=>app.inject({method:'POST',url:'/api/v1/admin/config/test-embedding',headers:{authorization:auth},payload})
 try{
  assert.equal((await call({},'')).statusCode,401);assert.equal(received.length,0)
  assert.deepEqual((await call({})).json(),{ok:true,message:'OK — 连通，向量维度 3'})
  assert.deepEqual(received[0],{url:'/v1/embeddings',body:{model:'saved',input:'连通性测试',dimensions:9},auth:'Bearer synthetic-secret'})
  assert.equal((await call({dimensions:'',model:'empty'})).json().message,'返回的向量为空')
  assert.equal((await call({model:'bad'})).json().message,'返回格式不对（不是 OpenAI 兼容 /embeddings 响应）')
  assert.equal((await call({provider:'openai'})).json().ok,false);assert.equal(received.length,3,'云提供方不得继承本地访问许可')
  for(const model of ['redirect','error']){const response=await call({model});assert.equal(response.statusCode,200);assert.equal(response.json().ok,false);assert.equal(response.body.includes('synthetic-secret'),false)}
  assert.equal(received.some(r=>r.url==='/credentials'),false)
  assert.equal((await call({multimodal:true})).json().message,'多模态 Embedding 目前仅支持百炼')
  assert.equal((await call({model:12})).statusCode,422)
  assert.equal(await readFile(path,'utf8'),original)
  const python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(python)
  const cases=[{},{model:'empty'},{model:'bad'},{multimodal:true},{dimensions:'３_２'}]
  const child=execFile(python,[resolve('tests/admin/fixtures/embedding_probe_python.py'),'--allow-isolated-test-config',path],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend')}})
  child.stdin!.end(JSON.stringify(cases));const pythonResult=await new Promise<string>((yes,no)=>{let out='';let err='';child.stdout!.on('data',c=>out+=c);child.stderr!.on('data',c=>err+=c);child.on('exit',code=>code===0?yes(out):no(Error(err)))})
  const nodeResult=[];for(const body of cases)nodeResult.push((await call(body)).json())
  assert.deepEqual(nodeResult,JSON.parse(pythonResult))
  await writeFile(path,JSON.stringify({embedding:{provider:'ollama',base_url:base+'/new',model:'updated'}}));assert.equal((await call({})).json().ok,true);assert.equal(received.at(-1)!.auth,undefined);assert.equal(received.at(-1)!.url,'/new/embeddings')
  const fromEnv=createEmbeddingFileProbe({EMBEDDING:JSON.stringify({provider:'ollama',base_url:base+'/env',model:'json-model'}),embedding__model:'nested-model'},path)
  await fromEnv({});assert.equal(received.at(-1)!.body.model,'updated')
  await writeFile(path,JSON.stringify({embedding:{}}));await fromEnv({});assert.equal(received.at(-1)!.body.model,'nested-model');assert.equal(received.at(-1)!.url,'/env/embeddings')
  await writeFile(path,'broken-json');await assert.rejects(fromEnv({}));assert.equal(await readFile(path,'utf8'),'broken-json')
 }finally{await app.close();await new Promise<void>(r=>upstream.close(()=>r()));await rm(root,{recursive:true,force:true})}
})

 test('百炼多模态与普通载荷按Python规则，维度保留0回退和负值',async()=>{
 const requests:any[]=[]
 const transport={request:async(request:any)=>{requests.push(request);return {status:200,headers:{},body:(async function*(){yield new TextEncoder().encode(JSON.stringify(request.url.includes('multimodal')?{output:{embeddings:[{embedding:[1,2]}]}}:{data:[{embedding:[1,2,3]}]}))})(),cancel:async()=>{}}}}
 const settings={provider:'bailian',base_url:'',api_key:'',model:'text-embedding-v4',dimensions:8}
 assert.deepEqual(await probeEmbedding({},settings,transport),{ok:true,message:'OK — 连通，向量维度 3'})
 assert.equal(requests[0].url,'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');assert.deepEqual(requests[0].body,{model:'text-embedding-v4',input:'连通性测试',dimensions:8,encoding_format:'float'})
 assert.deepEqual(await probeEmbedding({multimodal:true,dimensions:-1},settings,transport),{ok:true,message:'OK — 多模态连通，向量维度 2'})
 assert.equal(requests[1].url,'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding');assert.deepEqual(requests[1].body.parameters,{output_type:'dense',dimension:-1})
 for(const [input,result] of [[null,0],['',0],['abc',0],['3.2',0],[3.2,3],['３_２',32],[true,1]])assert.equal(embeddingDimensions(input),result)
 })
