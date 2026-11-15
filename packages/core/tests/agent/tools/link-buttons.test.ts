import { it,expect,vi } from 'vitest'
import { createLinkButtonsTools, createWebLinkButtonDeliveryPort } from '../../../src/agent/tools/link-buttons.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
it('链接按钮整组校验、可信身份、撤权及未知投递恢复',async()=>{
 const deliver=vi.fn(async(_input:Parameters<import('../../../src/agent/tools/link-buttons.js').LinkButtonDeliveryPort['deliver']>[0])=>({kind:'completed' as const,successful:true,mutated:true,value:{status:'sent',delivery:'native',button_count:1}}))
 const reconcile=vi.fn(async()=>({kind:'unknown' as const}))
 let allowed=true
 const registry=createToolRegistry({tools:createLinkButtonsTools({deliver,reconcile}),authorize:async()=>allowed})
 const scope={identity:{ownerId:'owner',sessionId:'s',runId:'r'},roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不可执行')}}
 const send=(url:string,id='a')=>registry.tools.dispatch({id:'call',name:'send_link_buttons',input:{message:' 入口 ',buttons:[{id,label:'查看',url}]}},scope)
 expect(await send('https://example.test/')).toMatchObject({successful:true,value:{status:'sent'}})
 expect(deliver.mock.calls[0]![0]).toMatchObject({identity:scope.identity,message:'入口',buttons:[{id:'a',label:'查看',url:'https://example.test/'}]})
 for(const url of ['javascript:alert(1)','file:///etc/passwd','https://user:pass@example.test/','https://example.test/\u0001','/relative'])expect(await send(url)).toMatchObject({successful:false})
 expect(deliver).toHaveBeenCalledTimes(1)
 allowed=false;expect(await send('https://example.test/')).toMatchObject({successful:false,executed:false})
 allowed=true;expect(await registry.tools.reconcile({id:'call',name:'send_link_buttons',input:{message:'入口',buttons:[{id:'a',label:'查看',url:'https://example.test/'}]}},{...scope.identity,roundId:'1'})).toEqual({kind:'unknown'})
})
it('Web 按钮恢复重建相同 artifact，非 Web 身份不能伪造投递',async()=>{
 const registry=createToolRegistry({tools:createLinkButtonsTools(createWebLinkButtonDeliveryPort(async identity=>identity.ownerId==='owner')),authorize:async()=>true})
 const identity={ownerId:'owner',sessionId:'s',runId:'r'},scope={identity,roundId:'r:1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不可执行')}}
 const call={id:'call',name:'send_link_buttons',input:{message:'入口',buttons:[{id:'a',label:'查看',url:'app:open'}]}}
 const sent=await registry.tools.dispatch(call,scope)
 expect(sent).toMatchObject({kind:'completed',successful:true,artifact:{kind:'link_buttons',message:'入口',buttons:call.input.buttons}})
 expect(await registry.tools.reconcile(call,{...identity,roundId:'r:1'})).toEqual(sent)
 expect(await registry.tools.dispatch(call,{...scope,identity:{...identity,ownerId:'other'}})).toEqual({kind:'unknown'})
 for(const url of ['https://[broken/', 'https://[not-ip]/', 'https://u@example.test/','https://example.test：443/','https://user＠example.test/','https://example.test／path','https://::@example.test/','data:text/html,test']){
   expect(await registry.tools.dispatch({...call,input:{...call.input,buttons:[{id:'a',label:'查看',url}]}},scope)).toMatchObject({successful:false})
 }
 for(const url of ['https://[::1]/','https://@example.test/','https://:@example.test/','mailto:a@example.test']){
   expect(await registry.tools.dispatch({...call,input:{...call.input,buttons:[{id:'a',label:'查看',url}]}},scope)).toMatchObject({successful:true})
 }
})

it('IM 投递使用真实持久收据防止重发，未知投递和改参不能冒充成功',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {initializeSqlite,openSqliteRuntime}=await import('../../../src/data/sqlite.js')
 const {createDurableImLinkButtonDeliveryPort}=await import('../../../src/agent/tools/link-buttons.js')
 const folder=await mkdtemp(join(tmpdir(),'gugu-link-buttons-'))
 try{
  await initializeSqlite(join(folder,'core.db'))
  const {runtime,ownerId}=await openSqliteRuntime(join(folder,'core.db'))
  try{
   const identity={ownerId,sessionId:'1',runId:'run'},scope={identity,roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不可执行')}}
   const send=vi.fn(async()=>({status:'sent' as const,delivery:'native' as const,buttonCount:1}))
   const sender={resolve:async()=>({platform:'feishu' as const,binding:'target'}),send}
   const registry=createToolRegistry({tools:createLinkButtonsTools(createDurableImLinkButtonDeliveryPort(runtime,sender)),authorize:async()=>true})
   const call={id:'call',name:'send_link_buttons',input:{message:'入口',buttons:[{id:'a',label:'打开',url:'https://example.test'}]}}
   expect(await registry.tools.dispatch(call,scope)).toMatchObject({successful:true,value:{status:'sent',platform:'feishu'}})
   const rebuilt=createToolRegistry({tools:createLinkButtonsTools(createDurableImLinkButtonDeliveryPort(runtime,sender)),authorize:async()=>true})
   expect(await rebuilt.tools.reconcile(call,{...identity,roundId:'round'})).toMatchObject({successful:true,mutated:false,value:{status:'sent'}})
   expect(await rebuilt.tools.dispatch(call,scope)).toMatchObject({successful:true,mutated:false})
   expect(send).toHaveBeenCalledTimes(1)
   expect(await rebuilt.tools.dispatch({...call,input:{...call.input,message:'不同内容'}},scope)).toEqual({kind:'unknown'})
   expect(send).toHaveBeenCalledTimes(1)
   const {sql}=await import('kysely')
   const receipts=await sql`SELECT result_json FROM core_operation_receipts`.execute(runtime.db)
   expect(JSON.stringify(receipts.rows)).not.toContain('https://example.test')
   expect(JSON.stringify(receipts.rows)).not.toContain('入口')
   const uncertain=createToolRegistry({tools:createLinkButtonsTools(createDurableImLinkButtonDeliveryPort(runtime,{...sender,send:async()=>({status:'unknown'})})),authorize:async()=>true})
   const pending={...call,id:'uncertain'}
   expect(await uncertain.tools.dispatch(pending,scope)).toEqual({kind:'unknown'})
   expect(await rebuilt.tools.dispatch(pending,scope)).toEqual({kind:'unknown'})
   expect(send).toHaveBeenCalledTimes(1)
   let release!:()=>void
   const wait=new Promise<void>(resolve=>{release=resolve}),started=vi.fn(async()=>{await wait;return {status:'sent' as const,delivery:'native' as const,buttonCount:1}})
   const concurrent=createToolRegistry({tools:createLinkButtonsTools(createDurableImLinkButtonDeliveryPort(runtime,{...sender,send:started})),authorize:async()=>true})
   const same={...call,id:'concurrent'},first=concurrent.tools.dispatch(same,scope)
   while(!started.mock.calls.length)await new Promise(resolve=>setTimeout(resolve,1))
   expect(await concurrent.tools.dispatch(same,scope)).toEqual({kind:'unknown'})
   release();expect(await first).toMatchObject({successful:true})
   expect(started).toHaveBeenCalledTimes(1)
  }finally{await runtime.close()}
 }finally{await rm(folder,{recursive:true,force:true})}
})
