import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {createPostgresImConversationStore} from '../../../src/modules/im/gateway/agent/conversations.js'
import {createPostgresImAccess} from '../../../src/modules/im/gateway/inbound/access.js'
import {imActorInputFromPayload} from '@gugu/core/im/access'
import {createImDispatchOrder} from '../../../src/modules/im/gateway/inbound/order.js'
import {createPostgresAgentDispatch,enqueueAgentRunLocked,type AgentDispatchInput} from '../../../src/modules/agent/run/dispatch.js'
import {registerAgentRunStartupLocked} from '../../../src/modules/agent/run/start.js'
import {createImProductionFixture} from './production.fixtures.js'
const databaseUrl=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,python=process.env.GUGU_IM_FIXTURE_PYTHON
test('真实PG跨会话IM顺序：同peer先入队先领取，其他Bot/群/peer隔离，完整密封证明和逆序early锚点保留',{
 skip:!(databaseUrl&&python)&&'需隔离PG及离线ORM解释器',timeout:120000,
},async t=>{
 const f=await createImProductionFixture({databaseUrl,python:python!}),binding={ownerId:'',platform:'telegram' as const,botId:''}
 binding.ownerId=f.ownerId;binding.botId=f.botId
 let count=0
 const guard=createImDispatchOrder({secretKey:f.secretKey}),dispatch=createPostgresAgentDispatch(f.pool,f.secretKey,30000,['im'],{beforeClaim:guard.beforeClaim})
 async function setup(peer='202',group:string|null=null,botId=f.botId){
  const web=group?null:await f.insert('conversation_sessions',{user_id:f.ownerId,title:'合成独立目标',source:'web',summary:''})
  const bound={...binding,botId}
  const store=createPostgresImConversationStore({pool:f.pool,secretKey:f.secretKey,attachments:{mode:'text-only'},ownerSession:async()=>web?Number(web.id):null,
   authorize:async(client,b,p)=>!!await createPostgresImAccess({query:(q,a)=>client.query(q,a),supportedPlatforms:()=>['telegram']}).resolveActor(imActorInputFromPayload(b,p)),classify:async()=> 'reply'})
  const payload=()=>{const n=++count;return {platform:'telegram',owner_user_id:f.ownerId,bot_id:botId,chat_type:group?'group':'c2c',chat_id:group??peer,
   platform_user_id:peer,message_id:String(7000+n),platform_message_id:String(7000+n),text:`合成消息${n}`,platform_sent_ms:1700000000000+n}}
  const onDispatch=(p:ReturnType<typeof payload>)=>async(client:Parameters<typeof registerAgentRunStartupLocked>[0],anchor:{sessionId:number;messageId:number},batch?:{batchKey:string;segmentKey:string;messageIds:number[]})=>{
   const identity={ownerId:f.ownerId,sessionId:String(anchor.sessionId),runId:randomUUID()}
   assert.equal(await registerAgentRunStartupLocked(client,identity),true)
   await enqueueAgentRunLocked(client,f.secretKey,identity,{v:3,source:'im',origin:null,locale:null,accessVersion:'a'.repeat(64),userMessageId:anchor.messageId,
    im:{platform:'telegram',botId,chatType:group?'group':'c2c',chatId:group,platformUserId:p.platform_user_id,...(batch?{batch}:{})}},60)
   return identity.runId
  }
  async function enqueue(){const p=payload();const anchor=await store.persist(bound,p,{eventId:`1700000000000-${count}`,mode:'dispatch',onDispatch:onDispatch(p)});assert.ok(anchor?.runId);return{ownerId:f.ownerId,sessionId:String(anchor.sessionId),runId:anchor.runId}}
  return {store,bound,payload,onDispatch,enqueue,web}
 }
 try{
  await t.test('跨Session并发只领取先入队Run，未领取者token/fence不变，旧Run终态后后者恢复',async()=>{
   const first=await setup(),second=await setup(),a=await first.enqueue(),b=await second.enqueue()
   const [later,earlier]=await Promise.all([dispatch.claim(f.ownerId,b.sessionId),dispatch.claim(f.ownerId,a.sessionId)])
   assert.equal(later,null);assert.equal(earlier?.identity.runId,a.runId)
   assert.deepEqual((await f.pool.query('SELECT token,fence::text FROM agent_run_dispatch WHERE run_id=$1',[b.runId])).rows[0],{token:null,fence:'0'})
   await f.pool.query("UPDATE agent_run_startups SET status='failed' WHERE run_id=$1",[a.runId])
   assert.equal(await dispatch.finish(earlier!),true)
   assert.equal((await dispatch.claim(f.ownerId,b.sessionId))?.identity.runId,b.runId)
  })
  await t.test('另一个peer、Bot和群均不被同owner当前私聊阻塞；默认Web调度不运行IM回调',async()=>{
   const otherBot=await f.insert('user_bots',{user_id:f.ownerId,platform:'telegram',name:'合成另一机器人',app_id:'synthetic-order-bot',app_secret:'synthetic-unused',enabled:true,owner_platform_user_id:'202',group_chat_enabled:true})
   for(const fixture of [await setup('999'),await setup('202',null,String(otherBot.id)),await setup('202','-701')]){
    const target=await fixture.enqueue();assert.equal((await dispatch.claim(f.ownerId,target.sessionId))?.identity.runId,target.runId)
   }
   const pending=await setup('202'),target=await pending.enqueue();let callbacks=0
   const web=createPostgresAgentDispatch(f.pool,f.secretKey,30000,['web'],{async beforeClaim(){callbacks++;throw Error('不属于Web')}})
   assert.equal(await web.claim(f.ownerId,target.sessionId),null);assert.equal(callbacks,0)
   const client=await f.pool.connect();try{assert.equal(await guard.beforeClaim(client,target,{userMessageId:1,origin:null,locale:null,accessVersion:'a'.repeat(64)} as AgentDispatchInput),false)}finally{client.release()}
  })
  await t.test('早落顺序不同于平台业务顺序时，逆序batch锚点仍可领；坏密封不能变成另一个scope放行',async()=>{
   const fixture=await setup('888'),p1=fixture.payload(),p2=fixture.payload()
   p1.platform_sent_ms=1700000000002;p2.platform_sent_ms=1700000000001
   await fixture.store.persist(fixture.bound,p1,{eventId:'1700000000001-1',mode:'early'})
   await fixture.store.persist(fixture.bound,p2,{eventId:'1700000000001-2',mode:'early'})
   // early只有已有会话才写；Web显式目标确保两锚已按接收顺序落库。
   const result=await fixture.store.persistBatch(fixture.bound,[{eventId:'1700000000001-1',payload:p1},{eventId:'1700000000001-2',payload:p2}],{mode:'dispatch',batchId:'synthetic-order',
    onDispatch:async(client,segment)=>fixture.onDispatch(p1)(client,segment.anchors.at(-1)!,{batchKey:segment.batchKey,segmentKey:segment.segmentKey,messageIds:segment.anchors.map(a=>a.messageId)})})
   const segment=result.segments[0]!,identity={ownerId:f.ownerId,sessionId:String(segment.anchors[0]!.sessionId),runId:segment.runId!}
   assert.ok(segment.anchors[0]!.conversationSeq>segment.anchors[1]!.conversationSeq)
   const originals=(await f.pool.query('SELECT message_id,fingerprint FROM gugu_im_inbound_receipts WHERE run_id=$1',[identity.runId])).rows
   await f.pool.query("UPDATE gugu_im_inbound_receipts SET fingerprint=repeat('0',64) WHERE run_id=$1",[identity.runId])
   await assert.rejects(dispatch.claim(f.ownerId,identity.sessionId),/执行顺序暂不可用/)
   for(const original of originals)await f.pool.query('UPDATE gugu_im_inbound_receipts SET fingerprint=$2 WHERE run_id=$1 AND message_id=$3',[identity.runId,original.fingerprint,original.message_id])
   assert.equal((await dispatch.claim(f.ownerId,identity.sessionId))?.identity.runId,identity.runId)
  })
 }finally{await f.close()}
})
