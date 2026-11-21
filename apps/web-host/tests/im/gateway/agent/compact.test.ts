import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createImProductionCompact} from '../../../../src/modules/im/gateway/memory/compact.js'
import {createConfiguredImAgentProviderBinding} from '../../../../src/modules/im/gateway/agent/provider.js'
import {createPostgresImAccess} from '../../../../src/modules/im/gateway/inbound/access.js'
import {createImProductionFixture} from '../production.fixtures.js'

const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON,redisUrl=process.env.GUGU_WEBUI_TEST_REDIS_URL
test('真实当前配置/PG/Web绑定历史/静态来源→ProviderRuntime摘要branch→原子summary与compaction用量，无旧IM Run也可用',{
 skip:!(databaseUrl&&python&&redisUrl)&&'需隔离PG/Redis及POSIX配置锁运行时',timeout:120000,
},async()=>{
 const f=await createImProductionFixture({databaseUrl,python:python!})
 try{
  const session=await f.insert('conversation_sessions',{user_id:f.ownerId,title:'旧Web历史',source:'web',last_message_seq:32,execution_state:'idle'})
  for(let i=1;i<=32;i++)await f.insert('conversation_messages',{session_id:session.id,conversation_seq:i,role:i%2?'user':'assistant',content:`合成保留事实${i}`})
  const model=await createConfiguredImAgentProviderBinding({pool:f.pool,configPath:f.configPath,versionSecret:f.secretKey,promptRoot:f.promptRoot,environment:f.environment,permissionIdentity:'synthetic-compaction',defaultLimit6h:null})
  const access=createPostgresImAccess({query:(q,p)=>f.pool.query(q,p),supportedPlatforms:()=>['telegram']})
  let calls=0,externalCloses=0;const bodies:string[]=[]
  const compact=createImProductionCompact({pool:f.pool,secretKey:f.secretKey,promptRoot:f.promptRoot,storageRoot:f.storageRoot,model,access,memoryEnabled:async()=>true,redisUrl:redisUrl!,environment:f.environment,supportedPlatforms:()=>['telegram'],readOwnerSession:async()=>Number(session.id),diagnose(){},
   provider:{transport:{async request(request){
    calls++;const body=typeof request.body==='string'||request.body instanceof Uint8Array?JSON.parse(Buffer.from(request.body).toString()):request.body
    bodies.push(JSON.stringify(body))
    return{status:200,headers:{'content-type':'application/json'},body:(async function*(){yield Buffer.from(JSON.stringify({choices:[{message:{content:'合成已保留的早期事实摘要'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}))})(),cancel(){}}
   },async close(){externalCloses++}}}})
  const scope={ownerId:f.ownerId,platform:'telegram' as const,botId:f.botId,chatType:'c2c' as const,chatId:null,platformUserId:'202',eventId:'synthetic-compact',admissionCutoff:(await f.pool.query('SELECT clock_timestamp()::text AS now')).rows[0].now}
  assert.match(await compact.compact(scope),/已经整理/);assert.equal(calls,1)
  assert.match(bodies[0]!,/合成保留事实1/);assert.match(bodies[0]!,/只输出摘要正文/);assert.match(bodies[0]!,/合成测试规范/)
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM agent_run_startups WHERE session_id=$1',[session.id])).rows[0].n,0)
  const usage=(await f.pool.query('SELECT scenario,input_source,tokens_in,tokens_out FROM agent_usage WHERE session_id=$1',[session.id])).rows
  assert.deepEqual(usage,[{scenario:'compaction',input_source:'telegram',tokens_in:10,tokens_out:5}])
  assert.match((await f.pool.query("SELECT content FROM conversation_messages WHERE session_id=$1 AND role='summary'",[session.id])).rows[0].content,/合成已保留的早期事实摘要/)
  assert.match(await compact.compact(scope),/已经整理/);assert.equal(calls,1);assert.equal(externalCloses,0)
 }finally{await f.close()}
})
