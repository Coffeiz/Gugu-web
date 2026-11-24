import { randomUUID } from 'node:crypto'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { beforeEach,afterEach,it,expect,vi,type Mock } from 'vitest'
import { initializeSqlite,openSqliteRuntime } from '../../../src/data/sqlite.js'
import { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createCanvasBatchPort,createCanvasBatchTool,createCanvasDeleteNotePort,createCanvasDeleteNoteTool,createCanvasDisconnectPort,createCanvasDisconnectTool,createCanvasDeletePort,createCanvasDeleteTool,createCanvasEditPort,createCanvasEditTools,type CanvasBatchConfirmationPort } from '../../../src/agent/tools/canvas.js'
import { createConfirmationGate } from '../../../src/agent/tools/confirmation.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect,fixture } from '../run/fixtures.js'

let core:SqlDataRuntime,folder:string,owner:string,other:string,allowed:boolean
let registry:ReturnType<typeof createToolRegistry>,publish:Mock<Parameters<typeof createCanvasEditPort>[1]>
const identity=()=>({ownerId:owner,sessionId:'1',runId:'canvas-edits'})
const scope=()=>({identity:identity(),roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}})
const call=(name:string,input:unknown,id=name)=>({id,name,input})
const send=(name:string,input:unknown,id=name)=>registry.tools.dispatch(call(name,input,id),scope())
function mount(confirmation?:CanvasBatchConfirmationPort){registry=createToolRegistry({groups:[{id:'canvas',name:'画布',tools:[...createCanvasEditTools(createCanvasEditPort(core,publish)),createCanvasBatchTool(createCanvasBatchPort(core,publish,confirmation))]}],authorize:async()=>allowed})}
const rows=async(table:string)=>(await sql.raw<Record<string,unknown>>('SELECT * FROM '+table+' ORDER BY id').execute(core.db)).rows
beforeEach(async()=>{
 folder=await mkdtemp(join(tmpdir(),'gugu-canvas-edits-'));await initializeSqlite(join(folder,'core.db'))
 const opened=await openSqliteRuntime(join(folder,'core.db'));core=opened.runtime;owner=opened.ownerId;other=randomUUID();allowed=true;publish=vi.fn(async()=>{})
 const key=owner.replaceAll('-',''),foreign=other.replaceAll('-',''),stamp='2026-11-15 00:00:00.000001'
 await sql`INSERT INTO mind_maps(id,user_id,title,data_json,created_at,updated_at) VALUES(1,${key},'画布','{}',${stamp},${stamp}),(2,${foreign},'他人画布','{}',${stamp},${stamp})`.execute(core.db)
 for(const [id,kind,ref,deleted] of [[1,'canvas_note',null,null],[2,'canvas_note',null,null],[3,'ref',3,null],[4,'note',null,null],[5,'canvas_note',null,stamp]] as const){
  await sql`INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,ref_type,ref_id,origin,version,captured_at,created_at,updated_at,deleted_at) VALUES(${id},${key},${kind},'原标题','# 原正文','原正文',${ref===null?null:'project'},${ref},'user',1,${stamp},${stamp},${stamp},${deleted})`.execute(core.db)
 }
 await sql`INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES(6,${foreign},'canvas_note','他人便签','','','user',1,${stamp},${stamp},${stamp})`.execute(core.db)
 for(const id of [1,2,3,5])await sql`INSERT INTO mind_canvas_items(id,user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at) VALUES(${id},${key},1,${id},0,0,${id},0,'{}',${stamp},${stamp})`.execute(core.db)
 await sql`INSERT INTO mind_relations(id,user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key,origin,status,created_at,updated_at) VALUES(1,${key},1,1,2,'related','','user','confirmed',${stamp},${stamp})`.execute(core.db)
 mount()
})
afterEach(async()=>{await core?.close();await rm(folder,{recursive:true,force:true})})
it('布局单项/批量真实写入，结果带几何，正文不变；混用、空修改及引用尺寸被拒绝',async()=>{
 const before=await rows('mind_nodes')
 expect(await send('canvas_update_node',{canvas_id:1,item_id:1,x:123,width:320,height:180,collapsed:true})).toMatchObject({successful:true,value:{updated:true,node:{node_id:1,position:{x:123,y:0},size:{w:320,h:180},layout:{effective_size:{w:320,h:180}},collapsed:true}}})
 expect(await send('canvas_update_node',{canvas_id:1,updates:[{item_id:1,y:8},{item_id:2,z:9}]} ,'batch')).toMatchObject({successful:true,value:{count:2,results:[{node:{position:{y:8}}},{node:{z:9}}]}})
 for(const input of [{canvas_id:1,item_id:1},{canvas_id:1,item_id:1,x:1,updates:[{item_id:2,x:1}]},{canvas_id:1,updates:[{item_id:1,unknown:true,x:3}]},{canvas_id:1,item_id:1,width:179}])expect(await send('canvas_update_node',input,randomUUID())).toMatchObject({successful:false,executed:false})
 expect(await send('canvas_update_node',{canvas_id:1,item_id:3,width:300},'ref')).toMatchObject({successful:false,value:{error:'只有画布便签支持设置卡片大小'}})
 expect(await send('canvas_update_node',{canvas_id:1,item_id:1,x:1,w:300},'legacy')).toMatchObject({successful:false,value:{error:'请使用 width 和 height 设置画布便签大小'}})
 expect(await rows('mind_nodes')).toEqual(before)
})
it('批量后项失败回滚前项、Undo与收据，不产生提交后通知',async()=>{
 const before=await rows('mind_canvas_items')
 expect(await send('canvas_update_node',{canvas_id:1,updates:[{item_id:1,x:5},{item_id:999,x:6}]})).toMatchObject({successful:false,value:{error:'画布节点不存在'}})
 expect(await rows('mind_canvas_items')).toEqual(before);expect(await rows('undo_operations')).toEqual([])
 expect((await sql`SELECT count(*) n FROM core_operation_receipts`.execute(core.db)).rows[0]).toMatchObject({n:0});expect(publish).not.toHaveBeenCalled()
 expect(await send('canvas_remove_node',{canvas_id:1,item_ids:[1,1]})).toMatchObject({successful:false})
 expect(await rows('mind_canvas_items')).toEqual(before)
})
it('移除视图保留节点和关系，记录detached；节点墓碑不阻止旧版视图移除',async()=>{
 const nodes=await rows('mind_nodes'),relations=await rows('mind_relations')
 expect(await send('canvas_remove_node',{canvas_id:1,item_ids:[1,2]})).toMatchObject({successful:true,value:{canvas_id:1,count:2,results:[{removed_item_id:1,node_id:1,node_preserved:true},{removed_item_id:2,node_id:2,node_preserved:true}]}})
 expect(JSON.parse((await rows('mind_maps'))[0]!.data_json as string)).toMatchObject({detachedRelationIds:[1]})
 expect((await rows('mind_canvas_items')).slice(0,2).every(row=>row.deleted_at!==null)).toBe(true)
 expect(await rows('mind_nodes')).toEqual(nodes);expect(await rows('mind_relations')).toEqual(relations)
 expect(await send('canvas_update_node',{canvas_id:1,item_id:5,x:33},'deleted-layout')).toMatchObject({successful:true,value:{node:{position:{x:33}}}})
 expect(await send('canvas_remove_node',{canvas_id:1,item_id:5},'deleted-node')).toMatchObject({successful:true,value:{removed_item_id:5,node_preserved:true}})
})
it('画布便签增量更新正文/摘要/版本，空标题默认值和BOM按Python保留，普通笔记/跨owner不可改',async()=>{
 expect(await send('canvas_update_note',{updates:[{node_id:1,title:' ',content:'# 新正文',color:'blue'},{node_id:2,title:'\ufeff 保留'}]})).toMatchObject({successful:true,value:{count:2,results:[{updated:true,node:{title:'新便签',preview:'新正文'}},{node:{title:'\ufeff 保留'}}]}})
 const nodes=await rows('mind_nodes');expect(nodes[0]).toMatchObject({content_md:'# 新正文',content_plain:'新正文',color:'blue',version:2});expect(nodes[1]).toMatchObject({version:2})
 for(const node_id of [4,5,6,999])expect(await send('canvas_update_note',{node_id,content:'不可改'},randomUUID())).toMatchObject({successful:false,value:{error:'找不到这条画布便签'}})
 expect(await send('canvas_update_note',{updates:[{node_id:1,title:'要回滚'},{node_id:4,title:'非法'}]},'rollback')).toMatchObject({successful:false})
 expect(await rows('mind_nodes')).toEqual(nodes)
})
it('收据重建/并发/丢应答恢复不重复修改版本，撤权、组关闭和取消阻断执行',async()=>{
 const input={node_id:1,content:'新内容'}
 const results=await Promise.all([send('canvas_update_note',input),send('canvas_update_note',input)])
 expect(results.filter(row=>row.kind==='completed'&&row.mutated)).toHaveLength(1);expect((await rows('mind_nodes'))[0]!.version).toBe(2)
 mount();expect(await registry.tools.reconcile(call('canvas_update_note',input),{...identity(),roundId:'round'})).toMatchObject({successful:true,mutated:false})
 expect(await send('canvas_update_note',{node_id:1,content:'不同'})).toMatchObject({successful:false,value:{error:'操作标识已用于不同内容'}})
 const operation=core.operationWithTransaction.bind(core)
 vi.spyOn(core,'operationWithTransaction').mockImplementationOnce(async(...args)=>{await operation(...args);throw new Error('合成应答丢失')})
 expect(await send('canvas_update_note',input,'lost')).toMatchObject({successful:true,mutated:false});expect((await rows('mind_nodes'))[0]!.version).toBe(3)
 expect(await registry.tools.reconcile(call('canvas_update_note',input,'absent'),{...identity(),roundId:'round'})).toEqual({kind:'unknown'})
 const controller=new AbortController();controller.abort()
 await expect(registry.tools.dispatch(call('canvas_update_note',input,'cancel'),{...scope(),signal:controller.signal})).rejects.toThrow()
 allowed=false;expect(await send('canvas_update_note',input,'denied')).toMatchObject({successful:false,executed:false})
 allowed=true;registry.configure({groups:{canvas:false}});expect(await send('canvas_update_note',input,'off')).toMatchObject({successful:false,executed:false})
})
it('真实工具编辑结果进入Agent续轮，通知失败不撤销数据库提交',async()=>{
 publish.mockRejectedValue(new Error('合成通知失败'))
 const f=fixture([[{type:'complete',text:'',calls:[call('canvas_update_node',{canvas_id:1,item_id:1,x:77})]}],[{type:'complete',text:'已移动',calls:[]}]])
 f.ports.tools=registry.tools;f.ports.context.afterTool=async(context,_call,result)=>[...context,result.kind==='completed'?JSON.stringify(result.value):'unknown']
 expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
 expect(vi.mocked(f.ports.provider.stream).mock.calls[1]![0].context.join('\n')).toContain('"x":77')
 expect((await rows('mind_canvas_items'))[0]!.x).toBe(77)
})

it('SQL写入后取消回滚整批，Undo失败也不能留下部分布局或成功收据',async()=>{
 const controller=new AbortController()
 const db=core.db.withPlugin({transformQuery:args=>args.node,async transformResult(args){
   if(args.result.rows.some(row=>row.id===1&&row.x===15))controller.abort()
   return args.result
 }})
 const wrapped=new SqlDataRuntime(db,core.backend)
 const cancelled=createToolRegistry({tools:createCanvasEditTools(createCanvasEditPort(wrapped,publish)),authorize:async()=>true})
 // 写入进入执行后，注册器按既有契约保留unknown；数据库必须已经整批回滚。
 expect(await cancelled.tools.dispatch(call('canvas_update_node',{canvas_id:1,updates:[{item_id:1,x:15},{item_id:2,x:20}]}),{...scope(),signal:controller.signal})).toEqual({kind:'unknown'})
 expect((await rows('mind_canvas_items'))[0]!.x).toBe(0)
 expect(await rows('undo_operations')).toEqual([])
 expect((await sql`SELECT count(*) n FROM core_operation_receipts`.execute(core.db)).rows[0]).toMatchObject({n:0})
 await sql`DROP TABLE undo_operations`.execute(core.db)
 expect(await send('canvas_update_node',{canvas_id:1,item_id:1,x:20})).toEqual({kind:'unknown'})
 expect((await rows('mind_canvas_items'))[0]!.x).toBe(0)
 expect(publish).not.toHaveBeenCalled()
})

it('批处理按Python顺序原子执行，request_id同参重放、异参冲突，非法后项整批回滚',async()=>{
 const beforeNodes=await rows('mind_nodes'),beforeItems=await rows('mind_canvas_items')
 const input={canvas_id:1,request_id:'batch-shape',operations:[
  {kind:'create_note',title:'批次便签',content:'正文',position:{x:500,y:30}},
  {kind:'update_item',item_id:1,x:64},
 ]}
 const first=await send('canvas_batch',input,'batch-first')
 expect(first).toMatchObject({successful:true,mutated:true,value:{canvas_id:1,request_id:'batch-shape',atomic:true,operations:[{index:0,kind:'create_note',created:true,node:{title:'批次便签'}},{index:1,kind:'update_item',updated:true,node:{position:{x:64}}}]}})
 expect(publish).toHaveBeenCalledTimes(2)
 expect(await send('canvas_batch',input,'batch-replay')).toMatchObject({successful:true,mutated:false,value:first.value})
 expect((await rows('mind_nodes')).filter(row=>row.kind==='canvas_note')).toHaveLength(5)
 expect(await send('canvas_batch',{...input,operations:[{kind:'remove_item',item_id:1}]},'batch-conflict')).toMatchObject({successful:false,value:{idempotency_conflict:true}})

 const beforeRollbackNodes=await rows('mind_nodes'),beforeRollbackItems=await rows('mind_canvas_items'),beforeUndo=await rows('undo_operations')
 const failed=await send('canvas_batch',{canvas_id:1,request_id:'batch-rollback',operations:[{kind:'create_note',title:'应回滚'},{kind:'update_item',item_id:999,x:1}]},'batch-rollback')
 expect(failed).toMatchObject({successful:false,value:{rolled_back:true,error:'第 2 个操作画布节点不存在'}})
 expect(await rows('mind_nodes')).toEqual(beforeRollbackNodes)
 expect(await rows('mind_canvas_items')).toEqual(beforeRollbackItems)
 expect(await rows('undo_operations')).toEqual(beforeUndo)
 expect(await send('canvas_batch',{canvas_id:2,request_id:'foreign-canvas',operations:[{kind:'remove_item',item_id:1}]},'batch-foreign')).toMatchObject({successful:false,value:{error:'画布不存在'}})
 expect(await send('canvas_batch',{canvas_id:1,request_id:' ',operations:[{kind:'remove_item',item_id:1}]},'batch-empty-request')).toMatchObject({successful:false,value:{error:'需要提供用于重试去重的 request_id'}})
 expect(await send('canvas_batch',{canvas_id:1,request_id:'batch-legacy',operations:[{kind:'remove_item',item_id:1,w:200}]},'batch-legacy')).toMatchObject({successful:false,value:{rolled_back:true,error:'第 1 个操作不能修改画布卡片大小，请使用 width 和 height 设置画布便签大小'}})
 expect(await send('canvas_batch',{canvas_id:1,request_id:'batch-delete',operations:[{kind:'delete_note',node_id:1}]},'batch-delete-closed')).toMatchObject({successful:false,value:{error:'画布便签删除需要可信确认能力'}})
 expect(await rows('mind_nodes')).not.toEqual(beforeNodes)
 expect(await rows('mind_canvas_items')).not.toEqual(beforeItems)
})

it('便签删除分支等待可信确认，并在同一操作事务claim后软删便签和视图',async()=>{
 let prepared:any,receipt:any,claimed=false,allowClaim=true,claimCalls=0
 const gate=createConfirmationGate({
  now:()=>100,
  authorize:async()=> 'epoch-1',
  prepare:async(binding,targets)=>{
   expect(targets.targetIds).toMatchObject({nodeIds:[1],viewItemIds:[1]})
   prepared={schemaVersion:2,binding,intentId:'intent-batch-delete',interactionId:'interaction-batch-delete',operationId:'operation-batch-delete',purpose:'action',action:'delete_canvas_note',targetsDigest:targets.targetsDigest,versionsDigest:targets.versionsDigest,authorizationEpoch:'epoch-1',expiresAt:1000}
   receipt={schemaVersion:2,intentId:prepared.intentId,interactionId:prepared.interactionId,receiptId:'receipt-batch-delete',binding,purpose:'action',action:'delete_canvas_note',status:'approved',expiresAt:1000}
   return prepared
  },
  load:async()=>({intent:prepared,receipt}),
  inspect:async()=>({targetsDigest:prepared.targetsDigest,versionsDigest:prepared.versionsDigest}),
 },{purpose:'action',action:'delete_canvas_note'})
 const confirmation:CanvasBatchConfirmationPort={gate,async claim(_tx,reference){claimCalls++;if(!allowClaim||claimed||reference.intentId!=='intent-batch-delete')return false;claimed=true;return true}}
 mount(confirmation)
 const input={canvas_id:1,request_id:'batch-delete-confirmed',operations:[{kind:'delete_note',node_id:1}]}
 const callId='batch-delete-confirmed-call',toolCall=call('canvas_batch',input,callId)
 const waiting=await registry.tools.dispatch(toolCall,scope())
 expect(waiting).toMatchObject({kind:'waiting',interaction:{kind:'confirmation',toolCall:{id:callId}}})
 allowClaim=false
 const declinedClaim=await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction-batch-delete',receiptId:'receipt-batch-delete',status:'confirmed',value:null}})
 expect(declinedClaim).toMatchObject({successful:false,value:{rolled_back:true}})
 expect((await rows('mind_nodes'))[0]!.deleted_at).toBeNull()
 allowClaim=true;claimed=false;claimCalls=0
 const success=await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction-batch-delete',receiptId:'receipt-batch-delete',status:'confirmed',value:null}})
 expect(success).toMatchObject({successful:true,mutated:true,value:{operations:[{kind:'delete_note',deleted_node_id:1,can_restore:true}]}})
 expect((await rows('mind_nodes'))[0]).toMatchObject({deleted_at:expect.any(String),version:2})
 expect((await rows('mind_canvas_items'))[0]!.deleted_at).not.toBeNull()
 expect(await rows('undo_operations')).toHaveLength(1)
 expect(claimCalls).toBe(1)
})

it.each(['canvas_delete_note','canvas_batch'] as const)('%s 在事务 claim 期间目标变化时回滚',async name=>{
 let prepared:any,receipt:any
 const gate=createConfirmationGate({now:()=>100,authorize:async()=>'epoch-1',
  prepare:async(binding,targets)=>{prepared={schemaVersion:2,binding,intentId:'intent',interactionId:'interaction',operationId:'operation',purpose:'action',action:'delete_canvas_note',targetsDigest:targets.targetsDigest,versionsDigest:targets.versionsDigest,authorizationEpoch:'epoch-1',expiresAt:1000};receipt={schemaVersion:2,intentId:'intent',interactionId:'interaction',receiptId:'receipt',binding,purpose:'action',action:'delete_canvas_note',status:'approved',expiresAt:1000};return prepared},
  load:async()=>({intent:prepared,receipt}),inspect:async()=>({targetsDigest:prepared.targetsDigest,versionsDigest:prepared.versionsDigest}),
 },{purpose:'action',action:'delete_canvas_note'})
 const confirmation:CanvasBatchConfirmationPort={gate,async claim(tx){await sql`UPDATE mind_nodes SET version=version+1 WHERE id=1`.execute(tx);return true}}
 const tool=name==='canvas_batch'?createCanvasBatchTool(createCanvasBatchPort(core,publish,confirmation)):createCanvasDeleteNoteTool(createCanvasDeleteNotePort(core,publish,confirmation))
 registry=createToolRegistry({tools:[tool],authorize:async()=>allowed})
 const input=name==='canvas_batch'?{canvas_id:1,request_id:'claim-change',operations:[{kind:'delete_note',node_id:1}]}:{node_id:1}
 const toolCall=call(name,input,'claim-change')
 expect((await registry.tools.dispatch(toolCall,scope())).kind).toBe('waiting')
 const result=await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction',receiptId:'receipt',status:'confirmed',value:null}})
 expect(result).toMatchObject({successful:false,mutated:false,value:{error:'画布便签删除确认已使用或目标已变化'}})
 expect((await rows('mind_nodes'))[0]).toMatchObject({version:1,deleted_at:null})
 expect(await rows('undo_operations')).toHaveLength(0)
 expect(publish).not.toHaveBeenCalled()
})

it('独立便签删除按旧版单项/批量结果执行，确认绑定目标版本且claim失败不产生副作用',async()=>{
 let prepared:any,receipt:any,claimed=false,allowClaim=false,claimCalls=0
 const gate=createConfirmationGate({
  now:()=>100,authorize:async()=>'epoch-1',
  prepare:async(binding,targets)=>{prepared={schemaVersion:2,binding,intentId:'intent-note-delete',interactionId:'interaction-note-delete',operationId:'operation-note-delete',purpose:'action',action:'delete_canvas_note',targetsDigest:targets.targetsDigest,versionsDigest:targets.versionsDigest,authorizationEpoch:'epoch-1',expiresAt:1000};receipt={schemaVersion:2,intentId:prepared.intentId,interactionId:prepared.interactionId,receiptId:'receipt-note-delete',binding,purpose:'action',action:'delete_canvas_note',status:'approved',expiresAt:1000};return prepared},
  load:async()=>({intent:prepared,receipt}),inspect:async()=>({targetsDigest:prepared.targetsDigest,versionsDigest:prepared.versionsDigest}),
 },{purpose:'action',action:'delete_canvas_note'})
 const confirmation:CanvasBatchConfirmationPort={gate,async claim(_tx,reference){claimCalls++;if(!allowClaim||claimed||reference.intentId!=='intent-note-delete')return false;claimed=true;return true}}
 const tools=[createCanvasDeleteNoteTool(createCanvasDeleteNotePort(core,publish,confirmation))]
 registry=createToolRegistry({groups:[{id:'canvas',name:'画布',tools}],authorize:async()=>allowed})
 const beforeNotes=await rows('mind_nodes'),beforeItems=await rows('mind_canvas_items')
 const input={notes:[{node_id:2},{node_id:1}]},toolCall=call('canvas_delete_note',input,'confirmed-note-delete')
 const waiting=await registry.tools.dispatch(toolCall,scope())
 expect(waiting).toMatchObject({kind:'waiting',interaction:{kind:'confirmation',toolCall:{id:'confirmed-note-delete'}}})
 // 修改已展示目标后，确认检查不得扩大或沿用旧版本。
 await sql`UPDATE mind_nodes SET version=version+1 WHERE id=1 AND user_id=${owner.replaceAll('-','')}`.execute(core.db)
 const stale=await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction-note-delete',receiptId:'receipt-note-delete',status:'confirmed',value:null}})
 expect(stale).toMatchObject({successful:false,value:{error:'画布便签删除确认无效或已过期'}})
 expect((await rows('mind_nodes')).filter(row=>[1,2].includes(Number(row.id))).every(row=>row.deleted_at===null)).toBe(true)
 // 为确认读取当前版本重置本用例的准备意图。
 prepared=undefined;receipt=undefined;claimed=false;claimCalls=0
 const current=await rows('mind_nodes');expect(current[0]!.version).toBe(Number(beforeNotes[0]!.version)+1)
 const fresh={notes:[{node_id:1}]},freshCall=call('canvas_delete_note',fresh,'fresh-note-delete')
 const freshWait=await registry.tools.dispatch(freshCall,scope());expect(freshWait.kind).toBe('waiting')
 const deniedClaim=await registry.tools.dispatch(freshCall,{...scope(),resolution:{interactionId:'interaction-note-delete',receiptId:'receipt-note-delete',status:'confirmed',value:null}})
 expect(deniedClaim).toMatchObject({successful:false,value:{error:'画布便签删除确认已使用或目标已变化'}})
 expect((await rows('mind_nodes')).find(row=>row.id===1)!.deleted_at).toBeNull();expect(await rows('undo_operations')).toHaveLength(0)
 allowClaim=true
 const deleted=await registry.tools.dispatch(freshCall,{...scope(),resolution:{interactionId:'interaction-note-delete',receiptId:'receipt-note-delete',status:'confirmed',value:null}})
 expect(deleted).toMatchObject({successful:true,mutated:true,value:{count:1,results:[{deleted_node_id:1,can_restore:true}]}})
 expect((await rows('mind_nodes')).find(row=>row.id===1)).toMatchObject({deleted_at:expect.any(String),version:3})
 expect((await rows('mind_canvas_items')).find(row=>row.node_id===1)!.deleted_at).not.toBeNull()
 expect(await rows('undo_operations')).toHaveLength(1);expect(publish).toHaveBeenCalledTimes(1);expect(claimCalls).toBe(2)
 expect(await registry.tools.dispatch(freshCall,{...scope(),resolution:{interactionId:'interaction-note-delete',receiptId:'receipt-note-delete',status:'confirmed',value:null}})).toMatchObject({successful:true,mutated:false,value:{count:1,results:[{deleted_node_id:1,can_restore:true}]}})
 expect(publish).toHaveBeenCalledTimes(1);expect(claimCalls).toBe(2)
 prepared=undefined;receipt=undefined;claimed=false;claimCalls=0
 const singleCall=call('canvas_delete_note',{node_id:2},'single-note-delete')
 expect((await registry.tools.dispatch(singleCall,scope())).kind).toBe('waiting')
 const single=await registry.tools.dispatch(singleCall,{...scope(),resolution:{interactionId:'interaction-note-delete',receiptId:'receipt-note-delete',status:'confirmed',value:null}})
 expect(single).toMatchObject({successful:true,mutated:true,value:{deleted_node_id:2,can_restore:true}})
 expect(publish).toHaveBeenCalledTimes(2);expect(await rows('undo_operations')).toHaveLength(2)
 expect(await registry.tools.dispatch(call('canvas_delete_note',{notes:Array.from({length:21},(_,index)=>({node_id:index+1}))},'too-many'),scope())).toMatchObject({successful:false})
 expect(await rows('mind_nodes')).not.toEqual(beforeNotes);expect(await rows('mind_canvas_items')).not.toEqual(beforeItems)
})

it.each(['canvas_disconnect','canvas_delete'] as const)('%s 在事务 claim 期间目标变化时回滚',async name=>{
 let prepared:any,receipt:any
 const action=name==='canvas_disconnect'?'delete_canvas_relation':'delete_canvas'
 const gate=createConfirmationGate({now:()=>100,authorize:async()=>'epoch-1',
  prepare:async(binding,targets)=>{prepared={schemaVersion:2,binding,intentId:'intent',interactionId:'interaction',operationId:'operation',purpose:'action',action,targetsDigest:targets.targetsDigest,versionsDigest:targets.versionsDigest,authorizationEpoch:'epoch-1',expiresAt:1000};receipt={schemaVersion:2,intentId:'intent',interactionId:'interaction',receiptId:'receipt',binding,purpose:'action',action,status:'approved',expiresAt:1000};return prepared},
  load:async()=>({intent:prepared,receipt}),inspect:async()=>({targetsDigest:prepared.targetsDigest,versionsDigest:prepared.versionsDigest}),
 },{purpose:'action',action})
 const confirmation:CanvasBatchConfirmationPort={gate,async claim(tx){
  if(name==='canvas_disconnect')await sql`UPDATE mind_relations SET status='changed' WHERE id=1`.execute(tx)
  else await sql`UPDATE mind_maps SET title='变更画布' WHERE id=1`.execute(tx)
  return true
 }}
 const tool=name==='canvas_disconnect'?createCanvasDisconnectTool(createCanvasDisconnectPort(core,publish,confirmation)):createCanvasDeleteTool(createCanvasDeletePort(core,publish,confirmation))
 registry=createToolRegistry({tools:[tool],authorize:async()=>allowed})
 const input=name==='canvas_disconnect'?{canvas_id:1,relation_id:1}:{canvas_id:1}
 const toolCall=call(name,input,'claim-change')
 expect((await registry.tools.dispatch(toolCall,scope())).kind).toBe('waiting')
 const result=await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction',receiptId:'receipt',status:'confirmed',value:null}})
 expect(result).toMatchObject({successful:false,mutated:false})
 expect((await rows('mind_relations'))[0]).toMatchObject({status:'confirmed',deleted_at:null})
 expect((await rows('mind_maps'))[0]).toMatchObject({title:'画布',deleted_at:null})
 expect(await rows('undo_operations')).toHaveLength(0)
 expect(publish).not.toHaveBeenCalled()
})

it('关系断开按Python批量目标排序与结果契约确认，claim失败无副作用且重放不重复通知',async()=>{
 const key=owner.replaceAll('-',''),stamp='2026-11-15 00:00:00.000002'
 await sql`INSERT INTO mind_relations(id,user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key,origin,status,created_at,updated_at) VALUES(2,${key},1,1,2,'related','manual','user','confirmed',${stamp},${stamp})`.execute(core.db)
 let prepared:any,receipt:any,allowClaim=false,claimed=false,claimCalls=0
 const gate=createConfirmationGate({now:()=>100,authorize:async()=>'epoch-1',
  prepare:async(binding,targets)=>{prepared={schemaVersion:2,binding,intentId:'intent-disconnect',interactionId:'interaction-disconnect',operationId:'operation-disconnect',purpose:'action',action:'delete_canvas_relation',targetsDigest:targets.targetsDigest,versionsDigest:targets.versionsDigest,authorizationEpoch:'epoch-1',expiresAt:1000};receipt={schemaVersion:2,intentId:prepared.intentId,interactionId:prepared.interactionId,receiptId:'receipt-disconnect',binding,purpose:'action',action:'delete_canvas_relation',status:'approved',expiresAt:1000};return prepared},
  load:async()=>({intent:prepared,receipt}),inspect:async()=>({targetsDigest:prepared.targetsDigest,versionsDigest:prepared.versionsDigest}),
 },{purpose:'action',action:'delete_canvas_relation'})
 const confirmation:CanvasBatchConfirmationPort={gate,async claim(_tx,reference){claimCalls++;if(!allowClaim||claimed||reference.intentId!=='intent-disconnect')return false;claimed=true;return true}}
 const port=createCanvasDisconnectPort(core,publish,confirmation)
 registry=createToolRegistry({tools:[createCanvasDisconnectTool(port)],authorize:async()=>allowed})
 expect(await send('canvas_disconnect',{canvas_id:1,relation_ids:[]},'empty-relations')).toMatchObject({successful:false,value:{error:'relation_ids 必须是 1-50 个关联 id'}})
 expect(await send('canvas_disconnect',{canvas_id:1,relation_ids:[999]},'missing-relation')).toMatchObject({successful:false,value:{error:'关联 999 不存在'}})
 expect(await send('canvas_disconnect',{canvas_id:2,relation_id:1},'foreign-canvas')).toMatchObject({successful:false,value:{error:'关联不存在'}})
 const input={canvas_id:1,relation_ids:[2,1]},callId='confirmed-disconnect',toolCall=call('canvas_disconnect',input,callId)
 expect(await registry.tools.dispatch(toolCall,scope())).toMatchObject({kind:'waiting',interaction:{kind:'confirmation',toolCall:{id:callId}}})
 const denied=await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction-disconnect',receiptId:'receipt-disconnect',status:'confirmed',value:null}})
 expect(denied).toMatchObject({successful:false,value:{error:'画布关系删除确认已使用或目标已变化'}})
 expect((await rows('mind_relations')).filter(row=>[1,2].includes(Number(row.id))).every(row=>row.deleted_at===null)).toBe(true)
 allowClaim=true
 expect(await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction-disconnect',receiptId:'receipt-disconnect',status:'confirmed',value:null}})).toMatchObject({successful:true,mutated:true,value:{success:true,deleted_count:2,deleted_relation_ids:[1,2]}})
 expect((await rows('mind_relations')).filter(row=>[1,2].includes(Number(row.id))).every(row=>row.deleted_at!==null)).toBe(true)
 expect(await rows('undo_operations')).toEqual([]);expect(publish).toHaveBeenCalledTimes(2);expect(claimCalls).toBe(2)
 expect(await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction-disconnect',receiptId:'receipt-disconnect',status:'confirmed',value:null}})).toMatchObject({successful:true,mutated:false,value:{success:true,deleted_count:2,deleted_relation_ids:[1,2]}})
 expect(publish).toHaveBeenCalledTimes(2);expect(claimCalls).toBe(2)
})

it('画布级联删除批量共享快照确认和原子收据，复用Mind级联服务且重放不重复通知',async()=>{
 const key=owner.replaceAll('-',''),stamp='2026-11-15 00:00:00.000003'
 await sql`INSERT INTO mind_maps(id,user_id,title,data_json,created_at,updated_at) VALUES(3,${key},'第二画布','{}',${stamp},${stamp})`.execute(core.db)
 let prepared:any,receipt:any,allowClaim=false,claimed=false,claimCalls=0
 const gate=createConfirmationGate({now:()=>100,authorize:async()=>'epoch-1',
  prepare:async(binding,targets)=>{prepared={schemaVersion:2,binding,intentId:'intent-canvas-delete',interactionId:'interaction-canvas-delete',operationId:'operation-canvas-delete',purpose:'action',action:'delete_canvas',targetsDigest:targets.targetsDigest,versionsDigest:targets.versionsDigest,authorizationEpoch:'epoch-1',expiresAt:1000};receipt={schemaVersion:2,intentId:prepared.intentId,interactionId:prepared.interactionId,receiptId:'receipt-canvas-delete',binding,purpose:'action',action:'delete_canvas',status:'approved',expiresAt:1000};return prepared},
  load:async()=>({intent:prepared,receipt}),inspect:async()=>({targetsDigest:prepared.targetsDigest,versionsDigest:prepared.versionsDigest}),
 },{purpose:'action',action:'delete_canvas'})
 const confirmation:CanvasBatchConfirmationPort={gate,async claim(_tx,reference){claimCalls++;if(!allowClaim||claimed||reference.intentId!=='intent-canvas-delete')return false;claimed=true;return true}}
 const port=createCanvasDeletePort(core,publish,confirmation)
 registry=createToolRegistry({tools:[createCanvasDeleteTool(port)],authorize:async()=>allowed})
 expect(await send('canvas_delete',{canvas_ids:[]},'empty-canvases')).toMatchObject({successful:false,value:{error:'canvas_ids 必须是 1-20 个画布 id'}})
 expect(await send('canvas_delete',{canvas_ids:[1,999]},'missing-canvas')).toMatchObject({successful:false,value:{error:'画布 999 不存在'}})
 const input={canvas_ids:[3,1]},toolCall=call('canvas_delete',input,'confirmed-canvas-delete')
 expect(await registry.tools.dispatch(toolCall,scope())).toMatchObject({kind:'waiting',interaction:{kind:'confirmation',toolCall:{id:'confirmed-canvas-delete'}}})
 const denied=await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction-canvas-delete',receiptId:'receipt-canvas-delete',status:'confirmed',value:null}})
 expect(denied).toMatchObject({successful:false,value:{error:'画布删除确认已使用或目标已变化'}})
 expect((await rows('mind_maps')).filter(row=>[1,3].includes(Number(row.id))).every(row=>row.deleted_at===null)).toBe(true)
 allowClaim=true
 expect(await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction-canvas-delete',receiptId:'receipt-canvas-delete',status:'confirmed',value:null}})).toMatchObject({successful:true,mutated:true,value:{success:true,deleted_count:2,deleted_canvas_ids:[1,3]}})
 expect((await rows('mind_maps')).filter(row=>[1,3].includes(Number(row.id))).every(row=>row.deleted_at!==null)).toBe(true)
 expect((await rows('mind_canvas_items')).filter(row=>Number(row.canvas_id)===1).every(row=>row.deleted_at!==null)).toBe(true)
 expect((await rows('mind_relations')).filter(row=>Number(row.canvas_id)===1).every(row=>row.deleted_at!==null)).toBe(true)
 expect(await rows('undo_operations')).toEqual([]);expect(publish).toHaveBeenCalledTimes(2);expect(claimCalls).toBe(2)
 expect(await registry.tools.dispatch(toolCall,{...scope(),resolution:{interactionId:'interaction-canvas-delete',receiptId:'receipt-canvas-delete',status:'confirmed',value:null}})).toMatchObject({successful:true,mutated:false,value:{success:true,deleted_count:2,deleted_canvas_ids:[1,3]}})
 expect(publish).toHaveBeenCalledTimes(2);expect(claimCalls).toBe(2)
})

it('批处理复用既有放置、连接和移除领域行为并按输入顺序返回结果',async()=>{
 const project=await core.transaction({ownerId:owner},data=>data.projects.create({name:'批处理来源'}))
 const result=await send('canvas_batch',{canvas_id:1,request_id:'batch-placement-relation-remove',operations:[
  {kind:'add_node',ref_type:'project',ref_id:String(project.id),position:{x:'240.5',y:80}},
  {kind:'connect',source_node_id:1,target_node_id:2},
  {kind:'remove_item',item_id:3},
 ]})
 expect(result).toMatchObject({successful:true,mutated:true,value:{atomic:true,operations:[
  {index:0,kind:'add_node',created:true,node:{ref_type:'project',ref_id:project.id,position:{x:240.5,y:80}}},
  {index:1,kind:'connect',created_or_reused:true},
  {index:2,kind:'remove_item',removed_item_id:3,node_preserved:true},
 ]}})
 expect((await rows('mind_canvas_items')).find(row=>row.id===3)?.deleted_at).not.toBeNull()
 expect((await rows('mind_nodes')).find(row=>row.id===3)?.deleted_at).toBeNull()
})

it('批处理可按已保存的视口锚点移动已有节点',async()=>{
 await sql`UPDATE mind_maps SET data_json='{"x":0,"y":0,"scale":1,"viewport":{"width":1000,"height":800}}' WHERE id=1`.execute(core.db)
 const result=await send('canvas_batch',{canvas_id:'1',request_id:'move-to-center',operations:[
  {kind:'update_item',item_id:'1',position:{anchor:'viewport_center'}},
 ]})
 expect(result).toMatchObject({successful:true,value:{operations:[{node:{position:{x:390,y:340}}}]}})
 expect((await rows('mind_canvas_items')).find(row=>row.id===1)).toMatchObject({x:390,y:340})
})
