import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import type {ProviderTransport} from '@gugu/core/providers'
import {createNodeImHostRuntime} from '../../../../src/modules/im/gateway/bootstrap.js'
import {createRedisStreamCommands} from '../../../../src/adapters/cache/redis-stream-commands.js'
import {createImProductionFixture} from '../production.fixtures.js'
const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,redisUrl=process.env.GUGU_IM_BOOTSTRAP_TEST_REDIS_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
const response=(value:unknown)=>({status:200,headers:{},body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value))})(),cancel(){}})
function blocked(signal:AbortSignal):Promise<never>{return new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('合成轮询停止'));else signal.addEventListener('abort',()=>reject(Error('合成轮询停止')),{once:true})})}
async function until(check:()=>Promise<boolean>,detail:()=>Promise<unknown>){for(let i=0;i<800;i++){if(await check())return;await delay(25)}assert.fail(JSON.stringify(await detail()))}

test('正式保留bootstrap：50会话替换/提交后FS回收→真实Run成功后2000条裁剪→Redis丢失后旧事件不复活',{
 skip:!(databaseUrl&&redisUrl&&python)&&'需专用隔离PG/Redis及离线ORM解释器',timeout:180000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),redis=createRedisStreamCommands(redisUrl!)
 let runtime:ReturnType<typeof createNodeImHostRuntime>|undefined,baseline:Set<string>|undefined,mainCalls=0,sent=0,polls=0
 let push!:()=>void,packet:unknown,initial=true
 const diagnostics:string[]=[]
 const oldGroup={update_id:12000,message:{message_id:12001,date:Math.floor(Date.now()/1000),from:{id:202,first_name:'合成人物'},chat:{id:-404,type:'group',title:'合成群'},text:'合成旧群消息'}}
 const privateMessage=(n:number)=>({update_id:12000+n,message:{message_id:12001+n,date:Math.floor(Date.now()/1000),from:{id:202,first_name:'合成人物'},chat:{id:202,type:'private'},text:n===1?'合成第一条保留问题':'合成第二条保留问题'}})
 const provider:ProviderTransport={async request(request){const body=request.body as Record<string,unknown>
  if(!body.stream)return response({choices:[{message:{content:'{}'}}]})
  mainCalls++;if(mainCalls===2)assert.match(JSON.stringify(body.messages),/合成已覆盖摘要/)
  return response(`data: ${JSON.stringify({choices:[{delta:{content:'合成保留处理结果'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
 }}
 const platform:ProviderTransport={async request(request,signal){
  const path=new URL(request.url).pathname
  if(path.endsWith('/getMe'))return response({ok:true,result:{id:303,username:'synthetic_bot'}})
  if(path.endsWith('/getWebhookInfo'))return response({ok:true,result:{url:''}})
  if(path.endsWith('/getUpdates')){
   polls++
   if(initial){initial=false;return response({ok:true,result:[oldGroup]})}
   if(!packet)await Promise.race([new Promise<void>(resolve=>push=resolve),blocked(signal)])
   const value=packet;packet=undefined;return response({ok:true,result:[value]})
  }
  if(path.endsWith('/sendChatAction'))return response({ok:true,result:true})
  if(path.endsWith('/sendMessage')){sent++;return response({ok:true,result:{message_id:14000+sent}})}
  throw Error('未配置的合成保留平台请求')
 }}
 const make=()=>createNodeImHostRuntime({...f,redisUrl:redisUrl!,publicAppUrl:'https://app.example.test',ownership:{runtime:'node',pythonGatewayStopped:true,pythonImConsumerStopped:true},
  mcpRuntime:{async invalidate(){throw Error('本测试不使用MCP')}},diagnose:code=>diagnostics.push(code),testing:{provider:{transport:provider},intervalMs:50,
   platform:{transport:()=>platform,resolve:async()=>[{address:'11.22.33.44',family:4}]}}})
 const detail=async()=>({diagnostics,health:runtime?.health(),mainCalls,sent,polls,
  targets:(await f.pool.query('SELECT generation::text,completed_generation::text,attempts FROM gugu_im_history_retention_targets')).rows,
  messageCounts:(await f.pool.query('SELECT session_id,count(*)::int AS n FROM conversation_messages GROUP BY session_id')).rows})
 async function file(messageId:number){const key=`${f.ownerId}/agent-chat/${randomUUID()}.bin`,path=join(f.storageRoot,key)
  await mkdir(dirname(path),{recursive:true});await writeFile(path,'合成附件字节')
  await f.insert('chat_attachments',{attach_id:randomUUID().replaceAll('-',''),user_id:f.ownerId,storage_key:key,platform:'telegram',name:'合成旧附件',ext:'bin',mime:'application/octet-stream',kind:'binary',size:Buffer.byteLength('合成附件字节'),state:'attached',message_id:messageId})
  return{key,path}}
 try{
  const document=JSON.parse(await readFile(f.configPath,'utf8'));document.agent.memory_enabled=false
  await writeFile(f.configPath,JSON.stringify(document))
  await f.pool.query('UPDATE user_bots SET group_requires_at=true,group_read_enabled=true WHERE id=$1',[f.botId])
  baseline=new Set(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-retention-cleanup']) as string[])
  runtime=make();await runtime.start()
  await until(async()=>(await f.pool.query("SELECT 1 FROM conversation_sessions WHERE chat_type='group'")).rowCount===1,detail)
  const old=(await f.pool.query("SELECT s.id,m.id AS message_id FROM conversation_sessions s JOIN conversation_messages m ON m.session_id=s.id WHERE s.chat_type='group'")).rows[0]!
  const oldFile=await file(Number(old.message_id));await f.pool.query("UPDATE conversation_sessions SET updated_at='2000-01-01' WHERE id=$1",[old.id])
  const protectedSession=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成运行中会话',source:'web',updated_at:'1999-01-01T00:00:00Z',active_run_id:'synthetic-protected-run',execution_state:'running'})
  for(let i=0;i<48;i++)await f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成旧会话',source:'web',updated_at:'2001-01-01T00:00:00Z'})
  packet=privateMessage(1);push?.()
  await until(async()=>sent===1&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===1,detail)
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM conversation_sessions WHERE user_id=$1',[f.ownerId])).rows[0].n,50)
  assert.equal((await f.pool.query('SELECT 1 FROM conversation_sessions WHERE id=$1',[old.id])).rowCount,0)
  assert.equal((await f.pool.query('SELECT 1 FROM conversation_sessions WHERE id=$1',[protectedSession.id])).rowCount,1)
  await until(async()=>{try{await stat(oldFile.path);return false}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error}},detail)
  const current=(await f.pool.query("SELECT * FROM conversation_sessions WHERE source='telegram' AND chat_id IS NULL")).rows[0]!
  const template=(await f.pool.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND role='user' ORDER BY conversation_seq LIMIT 1",[current.id])).rows[0]!
  const oldHistoryFile=await file(Number(template.id))
  const columns=(await f.pool.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='conversation_messages' AND is_generated='NEVER' AND column_name<>'id' ORDER BY ordinal_position")).rows.map(row=>row.column_name)
  assert.ok(columns.every(name=>/^[a-z_]+$/u.test(name)))
  const value=(name:string)=>name==='conversation_seq'||name==='history_anchor_seq'?'g.seq':['run_id','content_json','canonical_batch_id','im_platform_message_id','client_message_id'].includes(name)?'NULL':name==='content'?"'合成历史消息'":`t."${name}"`
  await f.pool.query(`INSERT INTO conversation_messages(${columns.map(n=>`"${n}"`).join(',')}) SELECT ${columns.map(value).join(',')} FROM conversation_messages t CROSS JOIN generate_series(3,2603) g(seq) WHERE t.id=$1`,[template.id])
  await f.insert('conversation_messages',{session_id:Number(current.id),role:'summary',content:'合成已覆盖摘要',conversation_seq:2604,history_anchor_seq:1000,covers_until_seq:1000})
  await f.pool.query('UPDATE conversation_sessions SET last_message_seq=2604,baseline_message_seq=1000,summary=$2 WHERE id=$1',[current.id,'合成已覆盖摘要'])
  packet=privateMessage(2);push?.()
  await until(async()=>sent===2&&(await f.pool.query("SELECT 1 FROM agent_run_checkpoints WHERE status='completed'")).rowCount===2,detail)
  await until(async()=>Number((await f.pool.query('SELECT count(*)::int AS n FROM conversation_messages WHERE session_id=$1',[current.id])).rows[0].n)===2000,detail)
  await until(async()=>{try{await stat(oldHistoryFile.path);return false}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error}},detail)
  assert.equal(mainCalls,2)
  await runtime.stop();runtime=undefined
  // 仅清本fixture创建的键，模拟Redis去重/Worker状态丢失；不使用FLUSH或触及其他任务键。
  for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-retention-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  initial=true;polls=0;runtime=make();await runtime.start()
  await until(async()=>polls>1&&await redis.sendCommand(['EVAL',"return redis.call('XLEN',KEYS[1])",'1','im:node:inbound'])===1
    &&(await redis.sendCommand(['EVAL',"return redis.call('XPENDING',KEYS[1],ARGV[1])",'1','im:node:inbound','gugu-node-im-v1']) as unknown[])?.[0]===0,detail)
  assert.equal(mainCalls,2);assert.equal(sent,2)
  assert.equal((await f.pool.query("SELECT 1 FROM conversation_sessions WHERE chat_type='group'")).rowCount,0)
 }finally{try{await runtime?.stop()}finally{
  if(baseline)for(const key of(await redis.sendCommand(['EVAL','return redis.call("KEYS","*")','1','synthetic-retention-cleanup']) as string[]).filter(key=>!baseline!.has(key)))await redis.sendCommand(['EVAL','return redis.call("DEL",KEYS[1])','1',key])
  await redis.close();await f.close()
 }}
})
