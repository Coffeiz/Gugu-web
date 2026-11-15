import { randomUUID } from 'node:crypto'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { beforeEach,afterEach,it,expect,vi,type Mock } from 'vitest'
import { initializeSqlite,openSqliteRuntime } from '../../../src/data/sqlite.js'
import { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createCanvasEditPort,createCanvasPlacementTools,createCanvasRelationTools } from '../../../src/agent/tools/canvas.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect,fixture } from '../run/fixtures.js'
let core:SqlDataRuntime,folder:string,owner:string,other:string,allowed:boolean
let registry:ReturnType<typeof createToolRegistry>,publish:Mock<Parameters<typeof createCanvasEditPort>[1]>
const identity=()=>({ownerId:owner,sessionId:'1',runId:'canvas-placement'})
const scope=()=>({identity:identity(),roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}})
const call=(name:string,input:unknown,id=name)=>({id,name,input})
const send=(name:string,input:unknown,id=name)=>registry.tools.dispatch(call(name,input,id),scope())
const rows=async(table:string)=>(await sql.raw<Record<string,unknown>>('SELECT * FROM '+table+' ORDER BY id').execute(core.db)).rows
function mount(runtime=core){const port=createCanvasEditPort(runtime,publish);registry=createToolRegistry({groups:[{id:'canvas',name:'画布',tools:[...createCanvasPlacementTools(port),...createCanvasRelationTools(port)]}],authorize:async()=>allowed})}
beforeEach(async()=>{
 folder=await mkdtemp(join(tmpdir(),'gugu-canvas-placement-'));await initializeSqlite(join(folder,'core.db'));const opened=await openSqliteRuntime(join(folder,'core.db'));core=opened.runtime;owner=opened.ownerId;other=randomUUID();allowed=true;publish=vi.fn(async()=>{})
 const key=owner.replaceAll('-',''),foreign=other.replaceAll('-',''),stamp='2026-11-15 00:00:00.000001'
 await sql`INSERT INTO mind_maps(id,user_id,title,data_json,created_at,updated_at) VALUES(1,${key},'画布','{"x":100,"y":50,"scale":2,"viewport":{"width":1000,"height":800},"preserve":"保留"}',${stamp},${stamp}),(2,${foreign},'其他画布','{}',${stamp},${stamp})`.execute(core.db)
 await sql`CREATE TABLE files(id INTEGER PRIMARY KEY,user_id TEXT,display_name TEXT,ext TEXT,deleted_at TEXT)`.execute(core.db)
 await sql`INSERT INTO files VALUES(1,${key},'资料','md',NULL),(2,${foreign},'隐私','md',NULL),(3,${key},'已删','md',${stamp}),(4,${key},'原子回滚','txt',NULL)`.execute(core.db)
 mount()
})
afterEach(async()=>{await core?.close();await rm(folder,{recursive:true,force:true})})
it('便签默认值、viewport/near/auto世界坐标与批量顺序，正文和尺寸真实持久化',async()=>{
 expect(await send('canvas_create_note',{canvas_id:1,title:' 题目 ',content:'# 正文',width:300,position:{anchor:'viewport_center'}})).toMatchObject({successful:true,value:{created:true,node:{kind:'canvas_note',title:'题目',position:{x:90,y:115},size:{w:300,h:null},preview:'正文'}}})
 expect(await send('canvas_create_note',{canvas_id:1,notes:[{position:{anchor:'near_node',near_node_id:1,offset_x:10,offset_y:5}},{title:'\ufeff 保留'}]},'batch')).toMatchObject({successful:true,value:{count:2,results:[{node:{position:{x:550,y:120},title:'新便签'}},{node:{position:{x:920,y:120},title:'\ufeff 保留'}}]}})
 const nodes=await rows('mind_nodes');expect(nodes).toHaveLength(3);expect(nodes[0]).toMatchObject({content_md:'# 正文',content_plain:'正文',kind:'canvas_note',color:'amber',version:1})
 expect(nodes.every(row=>row.kind==='canvas_note')).toBe(true)
})
it('非法坐标不回落自动布局；后项失败、越权与Undo失败不留节点/视图/收据',async()=>{
 for(const input of [{canvas_id:1,position:{x:1}},{canvas_id:1,notes:[{title:'先创建'},{position:{anchor:'near_node',near_node_id:999}}]},{canvas_id:2},{canvas_id:1,w:300}])expect(await send('canvas_create_note',input,randomUUID())).toMatchObject({successful:false})
 expect(await rows('mind_nodes')).toEqual([]);expect(await rows('mind_canvas_items')).toEqual([]);expect(await rows('undo_operations')).toEqual([])
 expect((await sql`SELECT count(*) n FROM core_operation_receipts`.execute(core.db)).rows[0]).toMatchObject({n:0});expect(publish).not.toHaveBeenCalled()
 await sql`DROP TABLE undo_operations`.execute(core.db)
 expect(await send('canvas_create_note',{canvas_id:1,title:'回滚'})).toEqual({kind:'unknown'})
 expect(await rows('mind_nodes')).toEqual([])
})
it('真实资源引用复用/恢复，已放置时不改位置，批量后项失败连引用一起回滚',async()=>{
 const input={canvas_id:1,ref_type:'file',ref_id:1,position:{x:12,y:34}}
 expect(await send('canvas_add_node',input)).toMatchObject({successful:true,mutated:true,value:{created:true,node:{ref_type:'file',ref_id:1,position:{x:12,y:34}}}})
 expect(await send('canvas_add_node',{...input,position:{anchor:'near_node',near_node_id:999}},'existing')).toMatchObject({successful:true,mutated:false,value:{created:false,node:{position:{x:12,y:34}}}})
 expect((await rows('mind_nodes'))).toHaveLength(1)
 for(const ref_id of [2,3,999])expect(await send('canvas_add_node',{canvas_id:1,ref_type:'file',ref_id},randomUUID())).toMatchObject({successful:false,value:{error:'引用对象不存在'}})
 const before=await rows('mind_canvas_items')
 expect(await send('canvas_add_node',{canvas_id:1,nodes:[{ref_type:'file',ref_id:4},{ref_type:'file',ref_id:999}]},'bad-batch')).toMatchObject({successful:false})
 expect(await rows('mind_canvas_items')).toEqual(before)
 expect(await rows('mind_nodes')).toHaveLength(1)
 await sql`UPDATE mind_canvas_items SET deleted_at='2026-11-15' WHERE id=1`.execute(core.db)
 expect(await send('canvas_add_node',{canvas_id:1,node_id:1,position:{x:99,y:88}},'restore')).toMatchObject({successful:true,value:{created:true,node:{item_id:1,position:{x:99,y:88}}}})
 expect((await rows('mind_canvas_items'))[0]).toMatchObject({deleted_at:null,w:null,h:null,z:0,collapsed:0})
})
it('关系端点只更新目标锚点，保留视图/其他锚点/关系；旧已移除项端点仍可编辑',async()=>{
 await send('canvas_create_note',{canvas_id:1,notes:[{},{}]})
 const key=owner.replaceAll('-',''),stamp='2026-11-15 00:00:00.000001'
 await sql`INSERT INTO mind_relations(id,user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key,origin,status,created_at,updated_at) VALUES(1,${key},1,1,2,'related','','user','confirmed',${stamp},${stamp})`.execute(core.db)
 const relations=await rows('mind_relations')
 expect(await send('canvas_update_anchor',{canvas_id:1,relation_id:1,source_side:'left',target_side:'right'})).toMatchObject({successful:true,value:{relation_id:1,source_node_id:1,target_node_id:2,source_side:'left',target_side:'right',updated:true}})
 expect(JSON.parse((await rows('mind_maps'))[0]!.data_json as string)).toMatchObject({preserve:'保留',viewport:{width:1000,height:800},relationAnchors:{'1':{srcSide:'left',dstSide:'right'}}})
 await sql`UPDATE mind_canvas_items SET deleted_at='2026-11-15' WHERE id=2`.execute(core.db)
 expect(await send('canvas_update_anchor',{canvas_id:1,relation_id:1,source_side:'right',target_side:'left'},'removed-item')).toMatchObject({successful:true})
 expect(await rows('mind_relations')).toEqual(relations)
 expect(await send('canvas_update_anchor',{canvas_id:2,relation_id:1,source_side:'left',target_side:'left'},'foreign')).toMatchObject({successful:false,value:{error:'关联不存在'}})
})
it('收据并发/重建/丢应答不重复新增，取消/撤权/组关闭不泄漏结果',async()=>{
 const input={canvas_id:1,title:'只一次'}
 const result=await Promise.all([send('canvas_create_note',input),send('canvas_create_note',input)])
 expect(result.filter(value=>value.kind==='completed'&&value.mutated)).toHaveLength(1)
 mount();expect(await registry.tools.reconcile(call('canvas_create_note',input),{...identity(),roundId:'round'})).toMatchObject({successful:true,mutated:false})
 expect(await send('canvas_create_note',{canvas_id:1,title:'改参'})).toMatchObject({successful:false,value:{error:'操作标识已用于不同内容'}})
 const operation=core.operationWithTransaction.bind(core)
 vi.spyOn(core,'operationWithTransaction').mockImplementationOnce(async(...args)=>{await operation(...args);throw new Error('合成提交应答丢失')})
 expect(await send('canvas_create_note',input,'lost')).toMatchObject({successful:true,mutated:false});expect(await rows('mind_nodes')).toHaveLength(2)
 const controller=new AbortController();controller.abort()
 await expect(registry.tools.dispatch(call('canvas_create_note',input,'cancel'),{...scope(),signal:controller.signal})).rejects.toThrow()
 allowed=false;expect(await send('canvas_create_note',input,'denied')).toMatchObject({successful:false,executed:false})
 allowed=true;registry.configure({groups:{canvas:false}});expect(await send('canvas_create_note',input,'disabled')).toMatchObject({successful:false,executed:false})
})
it('SQL插入后取消整批回滚，真实工具结果进入Agent续轮',async()=>{
 const controller=new AbortController(),db=core.db.withPlugin({transformQuery:args=>args.node,async transformResult(args){if(args.result.rows.some(row=>row.kind==='canvas_note'))controller.abort();return args.result}})
 mount(new SqlDataRuntime(db,core.backend))
 expect(await registry.tools.dispatch(call('canvas_create_note',{canvas_id:1,title:'取消'}),{...scope(),signal:controller.signal})).toEqual({kind:'unknown'})
 expect(await rows('mind_nodes')).toEqual([]);expect(await rows('undo_operations')).toEqual([])
 mount();const f=fixture([[{type:'complete',text:'',calls:[call('canvas_create_note',{canvas_id:1,title:'真实回执'})]}],[{type:'complete',text:'完成',calls:[]}]])
 f.ports.tools=registry.tools;f.ports.context.afterTool=async(context,_call,result)=>[...context,result.kind==='completed'?JSON.stringify(result.value):'unknown']
 expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
 expect(vi.mocked(f.ports.provider.stream).mock.calls[1]![0].context.join('\n')).toContain('真实回执')
})

it('related连接按几何与返回方向保存端点，幂等复用；自定义/单侧/自连/越权不能绕过守卫',async()=>{
 await send('canvas_create_note',{canvas_id:1,notes:[{position:{x:500,y:0}},{position:{x:0,y:0}}]})
 const input={canvas_id:1,source_node_id:1,target_node_id:2}
 expect(await send('canvas_connect',input)).toMatchObject({successful:true,value:{relation_id:1,source_node_id:1,target_node_id:2,type:'related',created_or_reused:true,changed:true,anchor_source:'geometry',source_side:'left',target_side:'right',verification:{checked_node_ids:[1,2],geometry_recommendation:{source_side:'left',target_side:'right'}}}})
 expect(await send('canvas_connect',{canvas_id:1,source_node_id:2,target_node_id:1},'reverse')).toMatchObject({successful:true,value:{relation_id:1,changed:false,source_side:'left',target_side:'right',verification:{checked_node_ids:[2,1],geometry_recommendation:{source_side:'right',target_side:'left'}}}})
 expect(await rows('mind_relations')).toHaveLength(1)
 expect(await send('canvas_connect',{...input,source_side:'right',target_side:'right'},'mismatch')).toMatchObject({successful:false})
 expect(await send('canvas_connect',{...input,source_side:'right',target_side:'right',allow_custom_anchor:true},'custom')).toMatchObject({successful:true,value:{changed:true,anchor_source:'explicit',source_side:'right',target_side:'right'}})
 for(const args of [{...input,target_node_id:1},{...input,source_side:'left'},{...input,target_node_id:999},{...input,canvas_id:2}])expect(await send('canvas_connect',args,randomUUID())).toMatchObject({successful:false})
 const data=JSON.parse((await rows('mind_maps'))[0]!.data_json as string)
 expect(data.relationAnchors).toEqual({'1':{srcSide:'right',dstSide:'right'}})
})

it('项目/活动真实来源快照和跨owner隔离，旧版允许项目/活动墓碑但拒绝文件墓碑',async()=>{
 const project=await core.transaction({ownerId:owner},data=>data.projects.create({name:'项目来源'}))
 const foreign=await core.transaction({ownerId:other},data=>data.projects.create({name:'他人项目'}))
 const key=owner.replaceAll('-',''),stamp='2026-11-15 00:00:00.000001'
 await sql`UPDATE projects SET deleted_at=${stamp} WHERE id=${project.id}`.execute(core.db)
 await sql`INSERT INTO calendar_events(id,user_id,title,date,time,end_time,type,version,created_at,deleted_at) VALUES(1,${key},'活动来源','2026-11-15','09:30','10:15','event',1,${stamp},${stamp})`.execute(core.db)
 expect(await send('canvas_add_node',{canvas_id:1,nodes:[{ref_type:'project',ref_id:project.id},{ref_type:'event',ref_id:1}]})).toMatchObject({successful:true,value:{count:2,results:[{node:{ref_type:'project',title:'项目来源'}},{node:{ref_type:'event',title:'活动来源'}}]}})
 const refs=await rows('mind_nodes')
 expect(JSON.parse(refs[1]!.ref_snapshot as string)).toMatchObject({date:'2026-11-15',time:'09:30',endTime:'10:15'})
 expect(await send('canvas_add_node',{canvas_id:1,ref_type:'project',ref_id:foreign.id},'foreign-project')).toMatchObject({successful:false,value:{error:'引用对象不存在'}})
 expect(await rows('mind_nodes')).toHaveLength(2)
})
