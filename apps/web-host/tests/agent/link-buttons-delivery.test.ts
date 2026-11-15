import assert from 'node:assert/strict'
import test from 'node:test'
import { createFeishuLinkButtonSender } from '../../src/domains/agent-sessions/tools/agent-link-buttons.js'

const identity={ownerId:'00000000-0000-4000-8000-000000000001',sessionId:'1',runId:'run'}
const target={botId:'synthetic-bot',receiveId:'ou_synthetic',accessToken:'synthetic-token'}
const buttons=[{id:'a',label:'查看',url:'https://example.test/'}]

test('飞书通过固定地址发送卡片，明确拒绝后才降级文本',async()=>{
 const requests:Array<{url:string;init:RequestInit}>=[]
 const transport:typeof fetch=async (url,init)=>{
  requests.push({url:String(url),init:init!})
  return new Response(JSON.stringify({code:requests.length===1?123:0}),{status:200})
 }
 const sender=createFeishuLinkButtonSender({resolve:async()=>target,fetch:transport})
 const channel=(await sender.resolve(identity))!
 const result=await sender.send({identity,roundId:'round',toolCallId:'call',message:'入口',buttons,signal:new AbortController().signal,channel})
 assert.deepEqual(result,{status:'sent_with_fallback',delivery:'text',buttonCount:1})
 assert.equal(requests.length,2)
 assert.equal(requests[0]!.url,'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id')
 assert.equal(requests[0]!.init.redirect,'error')
 const first=JSON.parse(String(requests[0]!.init.body)),card=JSON.parse(first.content)
 assert.equal(first.receive_id,target.receiveId)
 assert.equal(card.elements[1].actions[0].behaviors[0].default_url,buttons[0]!.url)
 assert.match(JSON.parse(JSON.parse(String(requests[1]!.init.body)).content).text,/https:\/\/example\.test/)
})

test('未知结果不降级重发，渠道变更和不安全 URL 不出站',async()=>{
 let count=0,current=target
 const sender=createFeishuLinkButtonSender({resolve:async()=>current,fetch:async()=>{count++;throw new Error('合成网络错误')}})
 const channel=(await sender.resolve(identity))!
 const input={identity,roundId:'round',toolCallId:'call',message:'入口',buttons,signal:new AbortController().signal,channel}
 assert.deepEqual(await sender.send(input),{status:'unknown'})
 assert.equal(count,1)
 current={...target,receiveId:'ou_other'}
 assert.deepEqual(await sender.send(input),{status:'unknown'})
 current=target
 assert.deepEqual(await sender.send({...input,buttons:[{...buttons[0]!,url:'javascript:alert(1)'}]}),{status:'failed',delivery:'none',buttonCount:1})
 assert.equal(count,1)
})

test('Host 注册器经实际 SQLite 收据调用飞书网关，重建后恢复而不重发',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {initializeSqlite,openSqliteRuntime}=await import('@gugu/core/data')
 const {createDurableImLinkButtonDeliveryPort}=await import('@gugu/core/tools')
 const {createAgentToolRegistry}=await import('../../src/domains/agent-sessions/tools/agent-tool-registry.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-feishu-'))
 try{
  await initializeSqlite(join(dir,'core.db'))
  const {runtime,ownerId}=await openSqliteRuntime(join(dir,'core.db'))
  try{
   let count=0
   const sender=createFeishuLinkButtonSender({resolve:async current=>current.ownerId===ownerId?target:null,fetch:async()=>{count++;return new Response(JSON.stringify({code:0}),{status:200})}})
   const opts={core:runtime,linkButtons:createDurableImLinkButtonDeliveryPort(runtime,sender),authorize:async()=>true}
   const current={...identity,ownerId},scope={identity:current,roundId:'run:1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行')}}
   const call={id:'call',name:'send_link_buttons',input:{message:'入口',buttons}}
   const result=await createAgentToolRegistry(opts).tools.dispatch(call,scope)
   assert.equal(result.kind,'completed')
   if(result.kind==='completed')assert.deepEqual(result.value,{status:'sent',platform:'feishu',delivery:'native',button_count:1})
   const restored=await createAgentToolRegistry(opts).tools.reconcile(call,{...current,roundId:'run:1'})
   assert.equal(restored.kind,'completed')
   assert.equal(count,1)
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})
