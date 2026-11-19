import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport} from '@gugu/core/providers'
import {createAgentRunCodec} from '@gugu/core/agent/run/codec'
import {createNodeImHostRuntime} from '../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../src/adapters/cache/redis-stream-commands.js'
import {createImProductionFixture} from './production.fixtures.js'
const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield value instanceof Uint8Array?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
function blocked(signal:AbortSignal):Promise<never>{return new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('合成轮询停止'));else signal.addEventListener('abort',()=>reject(Error('合成轮询停止')),{once:true})})}
for(const mode of ['openai','minimax','unsupported'] as const)test(`正式视频bootstrap/${mode}：平台文件→真实探测→Provider视频协议/上传→Harness→稳定checkpoint`,{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis、ffmpeg与离线ORM解释器',timeout:120000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!,platform:'telegram'}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,previous:Set<string>|undefined,polls=0,uploads=0,mainCalls=0
 const delivered:string[]=[],diagnostics:string[]=[]
 try{
  const file=join(f.root,'synthetic-video.mp4')
  const encoded=spawnSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=5','-t','0.8','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',file],{timeout:10000,maxBuffer:1048576,windowsHide:true})
  assert.equal(encoded.status,0,'需要实际ffmpeg合成合法MP4')
  let bytes=await readFile(file)
  if(mode==='minimax'){const free=Buffer.alloc(4*1024*1024+8);free.writeUInt32BE(free.length);free.write('free',4);bytes=Buffer.concat([bytes,free])}
  const document=JSON.parse(await readFile(f.configPath,'utf8'))
  document.ai={...document.ai,video:mode!=='unsupported',thinking:false,capability_overrides:{video:true},
   ...(mode==='minimax'?{provider:'minimax',model:'MiniMax-M3',api_format:'anthropic',base_url:'https://video-provider.example.test/anthropic'}:{})}
  await writeFile(f.configPath,JSON.stringify(document))
  const provider:ProviderTransport={async request(request){
   if(new URL(request.url).pathname.endsWith('/files/upload')){
    uploads++;let size=0;for await(const part of request.body as AsyncIterable<Uint8Array>)size+=part.length
    assert.ok(size>bytes.length);return response({file:{file_id:'synthetic-video-id'}})
   }
   const body=request.body as Record<string,unknown>
   if(!body.stream)return response(mode==='minimax'?{content:[{type:'text',text:'{}'}]}:{choices:[{message:{content:'{}'}}]})
   mainCalls++;const wire=JSON.stringify(body.messages)
   if(mode==='openai'){assert.match(wire,/video_url/);assert.match(wire,/data:video\/mp4;base64,/)}
   if(mode==='minimax'){assert.match(wire,/mm_file:\/\/synthetic-video-id/);assert.ok(!wire.includes(bytes.toString('base64')))}
   if(mode==='unsupported'){assert.match(wire,/视频未发送给模型/);assert.ok(!wire.includes('data:video/'));assert.equal(uploads,0)}
   const answer='合成视频处理结果'
   return mode==='minimax'?response([
    ['message_start',{type:'message_start',message:{id:'synthetic-message',type:'message',role:'assistant',content:[],model:'MiniMax-M3',usage:{input_tokens:10,output_tokens:0}}}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:answer}}],
    ['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:4}}],['message_stop',{type:'message_stop'}],
   ].map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')):
    response(`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
  }}
  const platform:ProviderTransport={async request(request,signal){
   const path=new URL(request.url).pathname
   if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
   if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
   if(path.endsWith('/getUpdates')){if(++polls>1)return blocked(signal);return response({ok:true,result:[{update_id:8100,message:{message_id:8101,date:Math.floor(Date.now()/1000),from:{id:202,first_name:'合成人物'},chat:{id:202,type:'private'},caption:'请查看这个合成视频',video:{file_id:'synthetic-video',file_unique_id:'synthetic-video-unique',duration:99999,mime_type:'video/mp4',file_name:'synthetic.mp4',file_size:bytes.length}}}]})}
   if(path.endsWith('/getFile'))return response({ok:true,result:{file_path:'videos/synthetic.mp4',file_size:bytes.length}})
   if(path.endsWith('/videos/synthetic.mp4'))return response(bytes)
   if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
   if(path.endsWith('/sendMessage')){const body=JSON.parse(Buffer.from(request.body as Uint8Array).toString());delivered.push(body.text);return response({ok:true,result:{message_id:8300+delivered.length}})}
   throw Error('未配置的合成平台请求')
  }}
  previous=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-video-cleanup']) as string[])
  runtime=createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
   mcpRuntime:{async invalidate(){throw Error('不用MCP')}},diagnose:code=>diagnostics.push(code),testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'11.22.33.44',family:4}]}}})
  await runtime.start()
  for(let i=0;i<500;i++){if(delivered.length&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===1)break;await delay(40)}
  assert.equal(delivered.length,1,JSON.stringify({diagnostics,health:runtime.health(),uploads,mainCalls,delivered}));assert.match(delivered[0]!,/合成视频处理结果/)
  assert.equal(mainCalls,1);assert.equal(uploads,mode==='minimax'?1:0,'同一Run多次hydrate必须复用已授权上传引用')
  const row=(await f.pool.query('SELECT user_id,session_id,run_id,version,nonce,payload FROM agent_run_checkpoints')).rows[0]!
  const checkpoint=createAgentRunCodec(f.secretKey).decryptCheckpoint({ownerId:row.user_id,sessionId:String(row.session_id),runId:row.run_id},Number(row.version),row.nonce,row.payload)
  assert.ok(!JSON.stringify(checkpoint).includes(bytes.toString('base64')));assert.ok(!JSON.stringify(checkpoint).includes('mm_file://'))
  if(mode!=='unsupported')assert.match(JSON.stringify(checkpoint),/attachment_ref/)
  if(mode==='minimax'){const keys=await redis.sendCommand(['EVAL','return redis.call("KEYS",ARGV[1])','1','synthetic-cache-list','im:node:video-upload:*']) as string[];assert.equal(keys.length,1);assert.ok(!String(await redis.sendCommand(['GET',keys[0]!])).includes('synthetic-video-id'))}
 }finally{try{await runtime?.stop()}finally{if(previous){const keys=await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-video-cleanup']) as string[];for(const key of keys.filter(key=>!previous!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])}await redis.close();await f.close()}}
})
