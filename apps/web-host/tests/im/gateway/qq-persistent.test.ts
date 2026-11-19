import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import type {Pool} from 'pg'
import type {RunEvent} from '@gugu/core/agent'
import {createQqClient} from '../../../src/modules/im/gateway/qq/client.js'
import {createQqSender} from '../../../src/modules/im/gateway/qq/sender.js'
import {createPersistentQqProjection} from '../../../src/modules/im/gateway/qq/persistent.js'
import {withPostgresImDeliveryStore,type ImDeliverySession} from '../../../src/modules/im/gateway/delivery-store.js'

const identity={ownerId:'11111111-1111-4111-8111-111111111111',sessionId:'1',runId:'synthetic-qq-projection'},secretKey='synthetic-projection-key'
const target={id:'synthetic-peer',chatType:'c2c' as const,messageFormat:'markdown' as const,messageId:'synthetic-inbound'}
const event=(sequence:number,type:RunEvent['type'],payload:RunEvent['payload']={},round=1):RunEvent=>({identity,id:`event-${sequence}`,sequence,type,payload,round})
function platform(){
 const requests:Record<string,unknown>[]=[],paths:string[]=[],waits:number[]=[];let streams=0,seq=0,allowed=true,authHook=()=>{},handle:((body:Record<string,unknown>)=>unknown)|undefined
 const client=createQqClient({appId:'synthetic-app',appSecret:'synthetic-secret',sandbox:false,transport:{async request(request){
  const auth=request.url.includes('bots.qq.com'),body=JSON.parse(Buffer.from(request.body as Uint8Array).toString())
  if(auth){authHook();return response({access_token:'synthetic-access',expires_in:7200})}
  requests.push(body);paths.push(new URL(request.url).pathname)
  if(handle){const result=handle(body);if(result)return result as ReturnType<typeof response>}
  return request.url.endsWith('/messages')?response({id:`message_${requests.length}`}):response({stream_msg_id:body.stream_msg_id??`stream_${++streams}`})
 }}})
 const sender=createQqSender({botId:'7',client,sanitizeText:value=>value,sequences:{async nextPassive(){return++seq},async nextStream(){return++seq}},sleep:async(ms)=>{waits.push(ms)}})
 return{client,sender,requests,paths,waits,authorize:async()=>allowed,revoke(){allowed=false},setAuthHook(fn:()=>void){authHook=fn},setHandler(fn:typeof handle){handle=fn}}
}
function response(value:unknown,status=200){return{status,headers:{},body:(async function*(){yield Buffer.from(JSON.stringify(value))})(),cancel(){}}}
/** 明确的内存投递CAS替身；真实持久/加密行为在下方PG用例验证。 */
function memory(){
 let version=0,state:unknown=null,fail=false
 const operations=new Map<string,string>()
 const receipts:ImDeliverySession={async cursor(){return 0},async advance(){},async begin(_id,key){if(operations.has(key))return 'pending';operations.set(key,'pending');return 'new'},async settle(_id,key,value){operations.set(key,value)},projection:{async read(){return{version,state:structuredClone(state)}},async checkpoint(expected,value){assert.equal(expected,version);state=structuredClone(value);return++version},async accepted(key,expected,value){if(fail)throw Error('合成提交中断');assert.equal(expected,version);operations.set(key,'accepted');state=structuredClone(value);return++version}}}
 return{receipts,interrupt(){fail=true},state:()=>structuredClone(state)}
}
test('手动flush的snapshot保留真实stream/index/msg_seq，恢复不新建首帧，跨目标或无效状态拒绝',async()=>{
 const p=platform()
 try{
  const first=p.sender.privateStream(target,undefined,{automaticFlush:false,authorize:p.authorize})
  first.push('第一行\n');assert.equal(p.requests.length,0);await first.flush()
  const saved=first.snapshot();assert.equal(saved.msgSeq,1);assert.equal(saved.index,1)
  const resumed=p.sender.privateStream(target,undefined,{automaticFlush:false,authorize:p.authorize,snapshot:saved})
  resumed.push('第二行');assert.equal((await resumed.finish()).closed,true)
  assert.deepEqual(p.requests.map(item=>[item.index,item.msg_seq,item.stream_msg_id]),[[0,1,undefined],[1,1,'stream_1']])
  assert.throws(()=>p.sender.privateStream({...target,id:'other-peer'},undefined,{snapshot:saved}))
  assert.throws(()=>p.sender.privateStream(target,undefined,{snapshot:{...saved,msgSeq:null}}))
 }finally{await p.client.close()}
})
test('流首帧auth等待后撤权及429等待后撤权均不再发业务HTTP',async()=>{
 const p=platform(),q=platform()
 try{
  p.setAuthHook(()=>p.revoke())
  assert.notEqual((await p.sender.privateStream(target,undefined,{automaticFlush:false,authorize:p.authorize}).finish('合成正文')).outcome,'accepted');assert.equal(p.requests.length,0)
  q.setHandler(()=>{q.revoke();return response({code:50002},429)})
  assert.notEqual((await q.sender.privateStream(target,undefined,{automaticFlush:false,authorize:q.authorize}).finish('合成正文')).outcome,'accepted');assert.equal(q.requests.length,1);assert.equal(q.waits.length,1)
 }finally{await p.client.close();await q.client.close()}
})
test('首帧明确零送达拒绝持久切plain，恢复后仅当前buffer主动发送一次且没有过期msg_id',async()=>{
 const p=platform(),m=memory();p.setHandler(body=>body.input_state?response({code:40034005},400):undefined)
 const make=()=>createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>1000})
 try{assert.equal(await make().project({identity,event:event(1,'token',{text:'尚未送达\n'}),deliveryId:'d1'}),'accepted')
  assert.equal((m.state() as {mode:string}).mode,'plain');assert.equal(p.requests.length,1)
  const final=event(2,'final',{status:'completed',text:'尚未送达\n最终后缀'})
  assert.equal(await make().project({identity,event:final,deliveryId:'d2'}),'accepted');assert.equal(p.requests.length,2)
  assert.ok(p.paths[1]!.endsWith('/messages'));assert.equal(p.requests[1]!.msg_id,undefined);assert.equal(p.requests[1]!.msg_seq,1)
  assert.equal((p.requests[1]!.markdown as {content:string}).content,'尚未送达\n最终后缀')
  assert.equal(await make().project({identity,event:final,deliveryId:'d2'}),'accepted');assert.equal(p.requests.length,2)
 }finally{await p.client.close()}
})
test('前段已确认后新段首帧明确拒绝仅fallback新段；unknown及当前段已有ACK绝不普通重发',async()=>{
 for(const failure of ['confirmed','unknown','after-ack'] as const){
  const p=platform(),m=memory();let time=1000
  const make=()=>createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>time})
  try{await make().project({identity,event:event(1,'token',{text:'之前确认段\n'}),deliveryId:'d1'});await make().project({identity,event:event(2,'tool_call',{}),deliveryId:'d2'})
   time=2000;if(failure!=='after-ack')p.setHandler(body=>{if(!body.input_state)return undefined;if(failure==='unknown')throw Error('合成未知');return response({code:40034005},400)})
   const start=await make().project({identity,event:event(3,'token',{text:'新段\n'},2),deliveryId:'d3'})
   if(failure==='unknown'){assert.equal(start,'unknown');assert.ok(!p.paths.some(path=>path.endsWith('/messages')));continue}
   if(failure==='after-ack')p.setHandler(body=>body.input_state?response({code:40034005},400):undefined)
   const result=await make().project({identity,event:event(4,'final',{status:'completed',text:'新段\n最终'},2),deliveryId:'d4'})
   if(failure==='confirmed'){assert.equal(result,'accepted');const ordinary=p.requests[p.paths.findIndex(path=>path.endsWith('/messages'))]!;assert.equal(ordinary.msg_id,undefined);assert.equal((ordinary.markdown as {content:string}).content,'新段\n最终');assert.ok(!JSON.stringify(ordinary).includes('之前确认段'))}
   else{assert.equal(result,'unknown');assert.ok(!p.paths.some(path=>path.endsWith('/messages')))}
  }finally{await p.client.close()}
 }
})
test('普通fallback本身结果未知不能重发，流拒绝同时撤权不能切普通出口',async()=>{
 for(const revoked of [true,false]){
  const p=platform(),m=memory();p.setHandler(body=>{if(body.input_state){if(revoked)p.revoke();return response({code:40034005},400)}throw Error('普通发送结果未知')})
  const make=()=>createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>2000})
  const input={identity,event:event(1,'final',{status:'completed',text:'安全fallback'}),deliveryId:'d1'}
  try{assert.notEqual(await make().project(input),'accepted');const before=p.requests.length;assert.equal(await make().project(input),'unknown');assert.equal(p.requests.length,before);assert.equal(p.paths.filter(path=>path.endsWith('/messages')).length,revoked?0:1)}finally{await p.client.close()}
 }
})
test('同Run事件按序持久，工具前关闭当前流、交互暂停/恢复新段；秘密结果不投递',async()=>{
 const p=platform(),m=memory();let time=1000
 const make=()=>createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>time})
 const send=async(e:RunEvent)=>make().project({identity,event:e,deliveryId:`delivery-${e.sequence}`})
 try{
  assert.equal(await send(event(1,'token',{text:'检查中\n'})),'accepted')
  assert.equal(await send(event(2,'tool_call',{name:'ask_user'})),'accepted')
  assert.equal(p.requests.at(-1)!.input_state,10)
  assert.equal(await send(event(3,'interaction_required',{})),'accepted')
  assert.equal(await send(event(4,'tool_done',{result:{password:'synthetic-private-password'}})),'accepted')
  assert.equal(await send(event(5,'run_resumed',{},2)),'accepted')
  time=2000;assert.equal(await send(event(6,'token',{text:'正式结果\n'},2)),'accepted')
  assert.equal(await send(event(7,'round_end',{text:'正式结果'},2)),'accepted')
  const before=p.requests.length
  assert.equal(await send(event(8,'final',{status:'completed',text:'正式结果'},2)),'accepted');assert.equal(p.requests.length,before+1)
  assert.deepEqual(p.requests.map(item=>item.input_state),[1,10,1,10]);assert.ok(!JSON.stringify(p.requests).includes('synthetic-private-password'))
 }finally{await p.client.close()}
})
test('HTTP成功与状态提交之间中断或网络结果未知，重建不发第二帧也不回退普通文本',async()=>{
 for(const interrupted of [true,false]){
  const p=platform(),m=memory();if(interrupted)m.interrupt();else p.setHandler(()=>{throw Error('synthetic-private-transport')})
  const make=()=>createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>1000})
  const input={identity,event:event(1,'token',{text:'第一行\n'}),deliveryId:'delivery-1'}
  try{
   if(interrupted)await assert.rejects(make().project(input));else assert.equal(await make().project(input),'unknown')
   const before=p.requests.length;assert.equal(await make().project(input),'unknown');assert.equal(p.requests.length,before)
  }finally{await p.client.close()}
 }
})
test('取消只关闭已生成partial，不发final正文、不生成成功送达证据',async()=>{
 const p=platform(),m=memory(),projection=createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>1000,
  acceptedEvidence:{scope:{ownerId:identity.ownerId,botId:'7',platform:'qq',chatType:'c2c',chatId:null,platformUserId:target.id},recipient:target.id,async source(){throw Error('取消不读final来源')}}})
 try{await projection.project({identity,event:event(1,'token',{text:'已生成部分\n'}),deliveryId:'d1'});assert.equal(await projection.project({identity,event:event(2,'final',{status:'cancelled',text:'不应投递的新正文'}),deliveryId:'d2'}),'accepted');assert.equal(p.requests.at(-1)!.content_raw,'已生成部分\n')}finally{await p.client.close()}
})
test('正式失败终态先关闭已见partial，再发送实际final错误文案；未知关闭不追加第二条',async()=>{
 const p=platform(),m=memory(),projection=createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>1000})
 try{await projection.project({identity,event:event(1,'token',{text:'已见部分\n'}),deliveryId:'d1'})
  assert.equal(await projection.project({identity,event:event(2,'final',{status:'failed',text:'合成固定失败说明'}),deliveryId:'d2'}),'accepted')
  assert.deepEqual(p.requests.map(item=>item.input_state),[1,10,10]);assert.equal(p.requests[1]!.content_raw,'已见部分\n');assert.equal(p.requests[2]!.content_raw,'合成固定失败说明\n')
 }finally{await p.client.close()}
 const q=platform(),n=memory(),uncertain=createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:n.receipts,sender:q.sender,authorize:q.authorize,now:()=>1000})
 try{await uncertain.project({identity,event:event(1,'token',{text:'已见部分\n'}),deliveryId:'d1'});q.setHandler(()=>{throw Error('合成平台结果未知')})
  assert.equal(await uncertain.project({identity,event:event(2,'final',{status:'failed',text:'禁止追加'}),deliveryId:'d2'}),'unknown');assert.ok(!q.requests.some(item=>String(item.content_raw).includes('禁止追加')))
 }finally{await q.client.close()}
})
test('round_end仅冻结，final使用权威未发送正文且规范链接不重复发送',async()=>{
 for(const changed of [false,true]){
  const p=platform(),m=memory(),projection=createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>1000})
  const text='请看[内部](gugu://file/1)'
  try{await projection.project({identity,event:event(1,'round_end',{text}),deliveryId:'d1'});const before=p.requests.length
   assert.equal(before,0)
   assert.equal(await projection.project({identity,event:event(2,'final',{status:'completed',text:changed?'权威未发送正文':text}),deliveryId:'d2'}),'accepted');assert.equal(p.requests.length,1)
  }finally{await p.client.close()}
 }
})
test('ROUND_END后final在原stream补后缀；改写已确认前缀只关闭partial并unknown，不另发全文',async()=>{
 for(const rewrite of [false,true]){
  const p=platform(),m=memory(),projection=createPersistentQqProjection({identity,target,policyVersion:'v1',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>1000})
  try{await projection.project({identity,event:event(1,'token',{text:'已确认首行\n'}),deliveryId:'d1'});await projection.project({identity,event:event(2,'round_end',{text:'已确认首行\n'}),deliveryId:'d2'})
   assert.equal(p.requests.length,1)
   assert.equal(await projection.project({identity,event:event(3,'final',{status:'completed',text:rewrite?'完全重写':'已确认首行\n最终后缀'}),deliveryId:'d3'}),rewrite?'unknown':'accepted')
   assert.equal(p.requests.length,2);assert.equal(p.requests[1]!.stream_msg_id,'stream_1');assert.equal(p.requests[1]!.index,1)
   assert.equal(p.requests[1]!.content_raw,rewrite?'已确认首行\n':'已确认首行\n最终后缀\n')
  }finally{await p.client.close()}
 }
})
test('流式图表前关闭文本、真实图片ACK后图后新段；final不重复源码或前文，重建不再上传',async()=>{
 const p=platform(),m=memory(),png=new Uint8Array([137,80,78,71,13,10,26,10,0]);let images=0
 const text='图前说明\n```mermaid\ngraph TD; A-->B\n```\n图后说明'
 const make=()=>createPersistentQqProjection({identity,target,policyVersion:'charts',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>1000,renderCharts:async()=>[png],
  async sendChart(bytes){assert.deepEqual(bytes,png);assert.equal(p.requests.at(-1)!.input_state,10);images++;return{outcome:'accepted',platformMessageIds:['chart-message']}}})
 try{assert.equal(await make().project({identity,event:event(1,'token',{text}),deliveryId:'d1'}),'accepted')
  const final=event(2,'final',{status:'completed',text});assert.equal(await make().project({identity,event:final,deliveryId:'d2'}),'accepted')
  assert.equal(images,1);assert.deepEqual(p.requests.map(item=>item.content_raw),['图前说明\n','图后说明\n']);const before=p.requests.length
  assert.equal(await make().project({identity,event:final,deliveryId:'d2'}),'accepted');assert.equal(images,1);assert.equal(p.requests.length,before)
 }finally{await p.client.close()}
})
test('图表明确拒绝保留源码，未知上传/发送不再补源码或后文',async()=>{
 for(const outcome of ['rejected','unknown'] as const){
  const p=platform(),m=memory(),text='```mermaid\ngraph TD; A-->B\n```\n后文'
  const projection=createPersistentQqProjection({identity,target,policyVersion:'charts',receipts:m.receipts,sender:p.sender,authorize:p.authorize,now:()=>1000,
   renderCharts:async()=>[new Uint8Array([137,80,78,71,13,10,26,10,0])],async sendChart(){return{outcome,platformMessageIds:[]}}})
  try{assert.equal(await projection.project({identity,event:event(1,'token',{text}),deliveryId:'d1'}),outcome==='unknown'?'unknown':'accepted')
   if(outcome==='rejected'){assert.equal(await projection.project({identity,event:event(2,'final',{status:'completed',text}),deliveryId:'d2'}),'accepted');assert.ok(p.requests.some(item=>String(item.content_raw).includes('graph TD')))}
   else assert.equal(p.requests.length,0)
  }finally{await p.client.close()}
 }
})
test('完整外层代码围栏内的mermaid示例不误渲染，renderer失败保留实际源码',async()=>{
 const p=platform(),m=memory();let renders=0
 const text='````text\n```mermaid\ngraph TD; A-->B\n```\n````\n```mermaid\ngraph TD; X-->Y\n```'
 const projection=createPersistentQqProjection({identity,target,policyVersion:'charts',receipts:m.receipts,sender:p.sender,authorize:p.authorize,renderCharts:async()=>{renders++;return[null]},async sendChart(){throw Error('不应上传')}})
 try{assert.equal(await projection.project({identity,event:event(1,'final',{status:'completed',text}),deliveryId:'d1'}),'accepted');assert.equal(renders,1);assert.equal(p.requests.length,1);assert.match(String(p.requests[0]!.content_raw),/A-->B/);assert.match(String(p.requests[0]!.content_raw),/X-->Y/)}finally{await p.client.close()}
})
test('默认正式renderer生成真实PNG进入QQ图表端口，原始Mermaid不作为final正文重复发出',{timeout:60000},async()=>{
 const p=platform(),m=memory();let images=0
 const text='```mermaid\ngraph TD; A-->B\n```'
 const projection=createPersistentQqProjection({identity,target,policyVersion:'actual-renderer',receipts:m.receipts,sender:p.sender,authorize:p.authorize,
  async sendChart(bytes){images++;assert.ok(bytes.byteLength>100);assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);return{outcome:'accepted',platformMessageIds:['actual-rendered-image']}}})
 try{assert.equal(await projection.project({identity,event:event(1,'final',{status:'completed',text}),deliveryId:'d1'}),'accepted');assert.equal(images,1);assert.equal(p.requests.length,0)}finally{await p.client.close()}
})
test('同一Run事件内Mermaid与TeX保持上传顺序并各有独立持久op，不输出已发送源码',async()=>{
 const p=platform(),m=memory(),types:string[]=[];let images=0
 const text='```mermaid\ngraph TD; A-->B\n```\n\n```tex\nx^2+y^2=z^2\n```'
 const projection=createPersistentQqProjection({identity,target,policyVersion:'charts',receipts:m.receipts,sender:p.sender,authorize:p.authorize,
  renderCharts:async request=>{types.push(request.charts[0]!.type);return[new Uint8Array([137,80,78,71,13,10,26,10,0])]},async sendChart(){return{outcome:'accepted',platformMessageIds:[`image-${++images}`]}}})
 try{assert.equal(await projection.project({identity,event:event(1,'final',{status:'completed',text}),deliveryId:'d1'}),'accepted');assert.deepEqual(types,['mermaid','math']);assert.equal(images,2);assert.equal(p.requests.length,0)}finally{await p.client.close()}
})

const url=process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('真实PG加密projection+真实QQ HTTP适配：重建保持stream/index/seq，final evidence仅来自真实DONE，重放不重复', {skip:!url&&'需隔离PG随机schema；内存CAS不代替真实加密恢复'},async()=>{
 const {Pool}=await import('pg'),admin=new Pool({connectionString:url}),schema=`im_qq_stream_${randomUUID().replaceAll('-','')}`
 const pool:Pool=new Pool({connectionString:url,options:`-c search_path=${schema}`}),p=platform();let time=1000
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);await pool.query('CREATE TABLE users(id uuid PRIMARY KEY);CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid)')
  await pool.query('INSERT INTO users VALUES($1)',[identity.ownerId]);await pool.query('INSERT INTO conversation_sessions VALUES(1,$1)',[identity.ownerId])
  await pool.query(await readFile(new URL('../../../src/modules/im/gateway/delivery-schema.sql',import.meta.url),'utf8'))
  const send=(e:RunEvent)=>withPostgresImDeliveryStore(pool,identity,async receipts=>createPersistentQqProjection({identity,target,policyVersion:'v1',receipts,sender:p.sender,authorize:p.authorize,now:()=>time,
   acceptedEvidence:{scope:{ownerId:identity.ownerId,platform:'qq',botId:'7',chatType:'c2c',chatId:null,platformUserId:target.id},recipient:target.id,async source(){return{sourceEventIds:['100-1'],sourceMessageIds:['inbound'],sourceEventIdsComplete:true}}}}).project({identity,event:e,deliveryId:`d${e.sequence}`}),{secretKey,platform:'qq'})
  await send(event(1,'token',{text:'第一行\n'}));time=1200;await send(event(2,'token',{text:'第二行'}));
  const final=event(3,'final',{status:'completed',text:'第一行\n第二行'}),result=await send(final)
  assert.equal(typeof result,'object');if(typeof result!=='object')throw Error('必须有真实送达证据')
  assert.equal(result.outcome,'accepted');assert.match(JSON.stringify(result.evidence),/第一行/)
  const before=p.requests.length;assert.deepEqual(await send(final),result);assert.equal(p.requests.length,before)
  assert.deepEqual(p.requests.map(item=>[item.index,item.msg_seq,item.stream_msg_id]),[[0,1,undefined],[1,1,'stream_1']])
  const raw=(await pool.query("SELECT platform,payload FROM gugu_im_platform_projection WHERE run_id=$1",[identity.runId])).rows[0]
  assert.equal(raw.platform,'qq');assert.ok(!(raw.payload as Buffer).includes(Buffer.from('第一行')))
  // 独立Run模拟平台已经ACK、原子accepted尚未提交时崩溃；真实PG pending/inflight阻断重发。
  const interrupted={...identity,runId:'synthetic-half-event'},partial={...event(1,'token',{text:'半事件正文\n'}),identity:interrupted}
  await assert.rejects(withPostgresImDeliveryStore(pool,interrupted,async receipts=>{
   const projection={...receipts.projection!,async accepted(){throw Error('合成accepted事务前进程中断')}}
   return createPersistentQqProjection({identity:interrupted,target,policyVersion:'v1',receipts:{...receipts,projection},sender:p.sender,authorize:p.authorize,now:()=>2000})
    .project({identity:interrupted,event:partial,deliveryId:'partial'})
  },{secretKey,platform:'qq'}))
  const sent=p.requests.length
  assert.equal(await withPostgresImDeliveryStore(pool,interrupted,async receipts=>createPersistentQqProjection({identity:interrupted,target,policyVersion:'v1',receipts,sender:p.sender,authorize:p.authorize})
   .project({identity:interrupted,event:partial,deliveryId:'partial'}),{secretKey,platform:'qq'}),'unknown')
  assert.equal(p.requests.length,sent)
  assert.equal((await pool.query("SELECT state FROM gugu_im_delivery_receipts WHERE run_id=$1",[interrupted.runId])).rows[0].state,'pending')
  const fallbackId={...identity,runId:'synthetic-known-rejected-fallback'}
  p.setHandler(body=>body.input_state?response({code:40034005},400):undefined)
  const fallback=(e:RunEvent)=>withPostgresImDeliveryStore(pool,fallbackId,receipts=>createPersistentQqProjection({identity:fallbackId,target,policyVersion:'fallback',receipts,sender:p.sender,authorize:p.authorize,now:()=>3000})
   .project({identity:fallbackId,event:{...e,identity:fallbackId},deliveryId:`fallback-${e.sequence}`}),{secretKey,platform:'qq'})
  assert.equal(await fallback(event(1,'token',{text:'仅当前未送段\n'})),'accepted')
  await withPostgresImDeliveryStore(pool,fallbackId,async receipts=>{const saved=await receipts.projection!.read();assert.equal((saved.state as {mode:string}).mode,'plain');assert.equal((saved.state as {plainBuffer:string}).plainBuffer,'仅当前未送段\n')},{secretKey,platform:'qq'})
  const finalFallback=event(2,'final',{status:'completed',text:'仅当前未送段\n完整结尾'})
  assert.equal(await fallback(finalFallback),'accepted');const fallbackRequests=p.requests.length
  assert.equal(p.requests.at(-1)!.msg_id,undefined);assert.equal((p.requests.at(-1)!.markdown as {content:string}).content,'仅当前未送段\n完整结尾')
  assert.equal(await fallback(finalFallback),'accepted');assert.equal(p.requests.length,fallbackRequests)
  assert.deepEqual((await pool.query('SELECT state FROM gugu_im_delivery_receipts WHERE run_id=$1 ORDER BY state',[fallbackId.runId])).rows.map(row=>row.state),['accepted','rejected'])
 }finally{await p.client.close();await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end()}
})
