import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import {createRequire} from 'node:module'
import type {ProviderTransport} from '@gugu/core/providers'
import type {CanonicalRunContext,Json} from '@gugu/core/agent'
import {createAgentRunCodec} from '@gugu/core/agent/run/codec'
import {createNodeImHostRuntime} from '../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../src/adapters/cache/redis-stream-commands.js'
import {createImProductionFixture} from './production.fixtures.js'
const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield value instanceof Uint8Array?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
function blocked(signal:AbortSignal):Promise<never>{return new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('合成轮询停止'));else signal.addEventListener('abort',()=>reject(Error('合成轮询停止')),{once:true})})}
for(const scenario of ['bmp','tiff','png','duplicate-png'] as const)test(`正式图片bootstrap/${scenario}：平台文件→真实解码/副本→Provider→Harness；原件与稳定引用保留`,{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis、ffmpeg与离线ORM解释器',timeout:120000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!,platform:'telegram'}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,previous:Set<string>|undefined,polls=0,calls=0
 const sent:string[]=[],diagnostics:string[]=[]
 const duplicate=scenario==='duplicate-png',ext=duplicate?'png':scenario
 try{
  const file=join(f.root,`synthetic.${ext}`),mime=`image/${ext}`
  assert.equal(spawnSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=blue:size=64x64','-frames:v','1',file],{timeout:10000,maxBuffer:1048576,windowsHide:true}).status,0)
  const bytes=await readFile(file),document=JSON.parse(await readFile(f.configPath,'utf8'))
  document.ai={...document.ai,image:true,capability_overrides:{image:true}}
  await writeFile(f.configPath,JSON.stringify(document))
  const provider:ProviderTransport={async request(request){
   const body=request.body as Record<string,unknown>
   if(!body.stream)return response({choices:[{message:{content:'{}'}}]})
   calls++
   const wire=JSON.stringify(body.messages),match=/data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)/u.exec(wire)
   assert.equal(wire.match(/data:image\/[a-z]+;base64,/gu)?.length,duplicate?2:1)
   assert.ok(match,'实际Provider收到可解码图片，不能只发文件占位')
   assert.equal(match[1],ext==='png'?'image/png':'image/jpeg')
   const prepared=Buffer.from(match[2]!,'base64'),{loadImage}=createRequire(import.meta.url)('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
   const decoded=await loadImage(prepared);assert.equal(decoded.width,64);assert.equal(decoded.height,64)
   if(ext==='png')assert.deepEqual(prepared,bytes);else assert.notDeepEqual(prepared,bytes)
   // 首轮请求前的持久checkpoint必须能逐消息恢复图片；成功消费后Core会折叠图片为文本。
   const stored=(await f.pool.query('SELECT attach_id,message_id::text FROM chat_attachments ORDER BY message_id,attachment_index')).rows
   assert.equal(stored.length,duplicate?2:1)
   const checkpointRow=(await f.pool.query('SELECT * FROM agent_run_checkpoints')).rows[0]!
   const saved=createAgentRunCodec(f.secretKey).decryptCheckpoint<CanonicalRunContext>({ownerId:checkpointRow.user_id,sessionId:String(checkpointRow.session_id),runId:checkpointRow.run_id},Number(checkpointRow.version),checkpointRow.nonce,checkpointRow.payload)
   const users=saved.context!.prepared.area.entries.filter(item=>item.message.role==='user'&&stored.some(file=>file.message_id===String(item.message._history_id)))
   assert.equal(users.length,duplicate?2:1)
   for(const user of users){const content=user.message.content
    assert.ok(Array.isArray(content))
    const references=content.filter((block):block is Record<string,Json>=>!!block&&typeof block==='object'&&!Array.isArray(block)&&block.type==='attachment_ref')
    assert.deepEqual(references.map(block=>block.attach_id),stored.filter(file=>file.message_id===String(user.message._history_id)).map(file=>file.attach_id))}
   return response(`data: ${JSON.stringify({choices:[{delta:{content:'合成图片结果'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
  }}
  const platform:ProviderTransport={async request(request,signal){
   const path=new URL(request.url).pathname
   if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
   if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
   if(path.endsWith('/getUpdates')){if(++polls>1)return blocked(signal);return response({ok:true,result:Array.from({length:duplicate?2:1},(_,index)=>({update_id:9100+index,message:{message_id:9101+index,date:Math.floor(Date.now()/1000),from:{id:202,first_name:'合成人物'},chat:{id:202,type:'private'},caption:'请查看合成图片',document:{file_id:`synthetic-image-${index}`,file_unique_id:`synthetic-image-unique-${index}`,mime_type:mime,file_name:`synthetic.${ext}`,file_size:bytes.length}}}))})}
   if(path.endsWith('/getFile'))return response({ok:true,result:{file_path:`documents/synthetic.${ext}`,file_size:bytes.length}})
   if(path.endsWith(`/documents/synthetic.${ext}`))return response(bytes)
   if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
   if(path.endsWith('/sendMessage')){sent.push(JSON.parse(Buffer.from(request.body as Uint8Array).toString()).text);return response({ok:true,result:{message_id:9300+sent.length}})}
   throw Error('未配置合成图片平台请求')
  }}
  previous=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-image-cleanup']) as string[])
  runtime=createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
   mcpRuntime:{async invalidate(){throw Error('不用MCP')}},diagnose:code=>diagnostics.push(code),testing:{provider:{transport:provider},intervalMs:100,platform:{transport:()=>platform,resolve:async()=>[{address:'11.22.33.44',family:4}]}}})
  await runtime.start()
  for(let i=0;i<500;i++){if(sent.length&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===1)break;await delay(40)}
  assert.equal(sent.length,1,JSON.stringify({diagnostics,health:runtime.health(),calls,sent}));assert.match(sent[0]!,/合成图片结果/);assert.equal(calls,1)
  const attachment=(await f.pool.query('SELECT * FROM chat_attachments')).rows[0]!
  assert.equal(attachment.mime,mime);assert.equal(attachment.ext,ext);assert.equal(Number(attachment.size),bytes.length)
  assert.deepEqual(await readFile(join(f.storageRoot,attachment.storage_key)),bytes)
  const checkpoints=(await f.pool.query('SELECT * FROM agent_run_checkpoints')).rows
  assert.equal(checkpoints.length,1)
  const row=checkpoints[0]!
  const checkpoint=createAgentRunCodec(f.secretKey).decryptCheckpoint<CanonicalRunContext>({ownerId:row.user_id,sessionId:String(row.session_id),runId:row.run_id},Number(row.version),row.nonce,row.payload)
  assert.match(JSON.stringify(checkpoint),/attachment_ref/);assert.ok(!JSON.stringify(checkpoint).includes(bytes.toString('base64')))
 }finally{try{await runtime?.stop()}finally{if(previous){const keys=await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-image-cleanup']) as string[];for(const key of keys.filter(key=>!previous!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])}await redis.close();await f.close()}}
})
