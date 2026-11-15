import { randomUUID } from 'node:crypto'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { beforeEach,afterEach,it,expect,vi,type Mock } from 'vitest'
import { initializeSqlite,openSqliteRuntime } from '../../../src/data/sqlite.js'
import { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createCanvasEditPort,createCanvasEditTools } from '../../../src/agent/tools/canvas.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect,fixture } from '../run/fixtures.js'

let core:SqlDataRuntime,folder:string,owner:string,other:string,allowed:boolean
let registry:ReturnType<typeof createToolRegistry>,publish:Mock<Parameters<typeof createCanvasEditPort>[1]>
const identity=()=>({ownerId:owner,sessionId:'1',runId:'canvas-edits'})
const scope=()=>({identity:identity(),roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}})
const call=(name:string,input:unknown,id=name)=>({id,name,input})
const send=(name:string,input:unknown,id=name)=>registry.tools.dispatch(call(name,input,id),scope())
function mount(){registry=createToolRegistry({groups:[{id:'canvas',name:'画布',tools:createCanvasEditTools(createCanvasEditPort(core,publish))}],authorize:async()=>allowed})}
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
