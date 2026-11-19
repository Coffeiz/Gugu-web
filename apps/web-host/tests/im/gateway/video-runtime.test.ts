import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {test} from 'node:test'
import {createImVideoRuntime} from '../../../src/modules/im/gateway/media/video-runtime.js'
import {ImVideoCleanupError} from '../../../src/modules/im/gateway/media/video.js'
import type {ProviderConfig,ProviderTransport} from '@gugu/core/providers'
import type {ImVideoInput} from '../../../src/modules/im/gateway/inbound/message.js'
const config:ProviderConfig={provider:'minimax',model:'MiniMax-M3',api_format:'anthropic',video:true,api_key:'synthetic-key',base_url:'https://video.example.test/anthropic'}
const probe={duration:10,width:16,height:16,bitRate:1,codec:'h264',fps:10}
const processor={async probe(){return probe},async probeVideo(){return{duration:10}},async transcode(){return null}}
const source=(length=4*1024*1024+1):ImVideoInput=>{const bytes=Buffer.alloc(length,3);return {attachId:'synthetic-attach',name:'合成视频.mp4',mime:'video/mp4',size:length,bytes,async assertCurrent(){},async digest(){return createHash('sha256').update(bytes).digest('hex')}}}
const cache=()=>{const values=new Map<string,string>();return{values,async get(key:string){return values.get(key)??null},async set(key:string,value:string,ttl:number){assert.equal(ttl,21600);values.set(key,value);return true}}}
const reply=()=>({status:200,headers:{},body:(async function*(){yield Buffer.from(JSON.stringify({file:{file_id:'synthetic-file-id'}}))})(),cancel(){}})
test('实际Core MiniMax上传协议与密文缓存：owner/scope/模型Key/内容隔离，重建只复用已授权引用',async()=>{
 const redis=cache();let uploads=0,closed=0
 const transport:ProviderTransport={async request(request){uploads++;assert.equal(new URL(request.url).pathname,'/v1/files/upload');assert.equal(request.headers.Authorization,'Bearer synthetic-key')
  let bytes=0;for await(const part of request.body as AsyncIterable<Uint8Array>)bytes+=part.length;assert.ok(bytes>4*1024*1024);return reply()},async close(){closed++}}
 const make=(ownerId='owner-a',scopeKey='scope-a',c=config)=>createImVideoRuntime({ownerId,scopeKey,secretKey:'synthetic-secret',config:c,processor,redis,provider:{transport},authorize:async()=>true,diagnose(){}})
 assert.match(JSON.stringify((await make().prepare(source())).block),/mm_file:\/\/synthetic-file-id/)
 assert.match(JSON.stringify((await make().prepare(source())).block),/mm_file:/);assert.equal(uploads,1)
 assert.ok(!JSON.stringify([...redis.values]).includes('synthetic-key'));assert.ok(!JSON.stringify([...redis.values]).includes('synthetic-file-id'))
 await make('owner-b').prepare(source());await make('owner-a','scope-b').prepare(source());await make('owner-a','scope-a',{...config,model:'MiniMax-M3-synthetic'}).prepare(source())
 assert.equal(uploads,4);assert.equal(closed,0,'外部transport不能由短命媒体分支关闭')
})
test('密文损坏和Redis失败不会返回伪引用，上传失败给明确提示；回执不含原始异常',async()=>{
 const redis=cache();let uploads=0
 const runtime=createImVideoRuntime({ownerId:'owner',scopeKey:'scope',secretKey:'secret',config,processor,redis,authorize:async()=>true,diagnose(){},provider:{transport:{async request(){uploads++;return reply()}}}})
 await runtime.prepare(source());for(const key of redis.values.keys())redis.values.set(key,'forged')
 await runtime.prepare(source());assert.equal(uploads,2)
 const failed=createImVideoRuntime({ownerId:'owner',scopeKey:'scope',secretKey:'secret',config,processor,redis:{async get(){throw Error('synthetic-secret')},async set(){throw Error('synthetic-secret')}},authorize:async()=>true,diagnose(){},provider:{transport:{async request(){throw Error('synthetic-secret')}}}})
 const result=await failed.prepare(source());assert.equal(result.block,null);assert.match(result.note,/上传失败/);assert.ok(!result.note.includes('synthetic-secret'))
})
test('上传响应后撤权、缓存等待读取中来源失效、取消均不能降为普通提示或重发',async()=>{
 let allowed=true,calls=0
 const runtime=createImVideoRuntime({ownerId:'owner',scopeKey:'scope',secretKey:'secret',config,processor,redis:cache(),authorize:async()=>allowed,diagnose(){},provider:{transport:{async request(){calls++;allowed=false;return reply()}}}})
 await assert.rejects(runtime.prepare(source()),/授权或来源已变更/);assert.equal(calls,1)
 const input=source();let valid=true
 input.assertCurrent=async()=>{if(!valid)throw Error('synthetic-secret')}
 const duringCache=createImVideoRuntime({ownerId:'owner',scopeKey:'scope',secretKey:'secret',config,processor,redis:{async get(){valid=false;return null},async set(){return true}},authorize:async()=>true,diagnose(){},provider:{transport:{async request(){throw Error('不应上传')}}}})
 await assert.rejects(duringCache.prepare(input),/授权或来源已变更/)
 await assert.rejects(runtime.prepare(source(),AbortSignal.abort('synthetic-secret')),error=>error instanceof Error&&error.message!=='synthetic-secret')
})
test('未开启视频不探测或发HTTP，真实时长未知和边界超限为明确可见提示',async()=>{
 let probes=0
 const p={...processor,async probe(){probes++;return null}}
 const make=(c=config)=>createImVideoRuntime({ownerId:'owner',scopeKey:'scope',secretKey:'secret',config:c,processor:p,redis:cache(),authorize:async()=>true,diagnose(){},provider:{transport:{async request(){throw Error('不应请求')}}}})
 const disabled=await make({...config,video:false}).prepare(source(3));assert.equal(disabled.block,null);assert.match(disabled.note,/视频未发送给模型/);assert.equal(probes,0)
 assert.match((await make().prepare({...source(3),duration:1})).note,/无法确认视频时长/)
 const over=createImVideoRuntime({ownerId:'owner',scopeKey:'scope',secretKey:'secret',config,processor:{...processor,async probe(){return{...probe,duration:1801}}},redis:cache(),authorize:async()=>true,diagnose(){},provider:{transport:{async request(){throw Error('超限不请求')}}}})
 const rejected=await over.prepare({...source(3),duration:1});assert.equal(rejected.block,null);assert.match(rejected.note,/时长限制/)
})
test('真实processor清理错误传播，自有上传transport仅关闭一次',async()=>{
 const bad={...processor,async probe(){throw new ImVideoCleanupError()}}
 const options={ownerId:'owner',scopeKey:'scope',secretKey:'secret',config,processor:bad,redis:cache(),authorize:async()=>true,diagnose(){},provider:{}}
 await assert.rejects(createImVideoRuntime(options).prepare(source()),ImVideoCleanupError)
 let closed=0
 const runtime=createImVideoRuntime({...options,processor,provider:{createTransport:()=>({async request(){return reply()},async close(){closed++}})}})
 await runtime.prepare(source());assert.equal(closed,1)
})
