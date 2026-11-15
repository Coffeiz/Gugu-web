import { randomUUID } from 'node:crypto'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { beforeEach,afterEach,it,expect,vi,type Mock } from 'vitest'
import { initializeSqlite,openSqliteRuntime } from '../../../src/data/sqlite.js'
import { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createNoteLifecyclePort,createNoteLifecycleTools } from '../../../src/agent/tools/note.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect,fixture } from '../run/fixtures.js'
let core:SqlDataRuntime,folder:string,owner:string,other:string,allowed:boolean
let registry:ReturnType<typeof createToolRegistry>,publish:Mock<Parameters<typeof createNoteLifecyclePort>[1]>
const identity=()=>({ownerId:owner,sessionId:'1',runId:'note-lifecycle'})
const scope=()=>({identity:identity(),roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}})
const call=(name:string,input:unknown,id=name)=>({id,name,input})
const send=(name:string,input:unknown,id=name)=>registry.tools.dispatch(call(name,input,id),scope())
const rows=async(table:string)=>(await sql.raw<Record<string,unknown>>('SELECT * FROM '+table+' ORDER BY id').execute(core.db)).rows
function mount(runtime=core){registry=createToolRegistry({groups:[{id:'mind',name:'笔记',tools:createNoteLifecycleTools(createNoteLifecyclePort(runtime,publish))}],authorize:async()=>allowed})}
beforeEach(async()=>{
 folder=await mkdtemp(join(tmpdir(),'gugu-note-lifecycle-'));await initializeSqlite(join(folder,'core.db'));const opened=await openSqliteRuntime(join(folder,'core.db'));core=opened.runtime;owner=opened.ownerId;other=randomUUID();allowed=true;publish=vi.fn(async()=>{})
 const key=owner.replaceAll('-',''),foreign=other.replaceAll('-',''),stamp='2026-11-15 00:00:00.123456'
 for(const [id,kind,origin,user,created,captured,deleted] of [
   [1,'note','user',key,'2026-11-15 20:00:00',stamp,null],
   [2,'note','gugu',key,'2026-11-15 01:00:00','2026-11-15 10:00:00',null],
   [3,'note','gugu',key,'2026-11-15 02:00:00','2026-11-15 01:00:00',null],
   [4,'note','gugu',key,'2026-11-15 02:00:00',stamp,null],
   [5,'canvas_note','gugu',key,'2026-11-15 20:00:00',stamp,null],
   [6,'note','gugu',foreign,'2026-11-15 21:00:00',stamp,null],
   [7,'note','gugu',key,'2026-11-15 22:00:00',stamp,stamp],
 ] as const)await sql`INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at,deleted_at) VALUES(${id},${user},${kind},'标题','# 正文','正文',${origin},3,${captured},${created},${stamp},${deleted})`.execute(core.db)
 mount()
})
afterEach(async()=>{await core?.close();await rm(folder,{recursive:true,force:true})})
it('精确软删/恢复保留正文、来源及微秒，版本各递增一次，Undo和事件提交后可见',async()=>{
 const before=(await rows('mind_nodes'))[0]!
 publish.mockImplementation(async event=>{const current=(await rows('mind_nodes')).find(row=>row.id===(event.operation==='delete'?event.nodeId:event.note.id))!;expect(current.version).toBe(event.operation==='delete'?4:5)})
 expect(await send('note_delete',{node_id:1})).toMatchObject({successful:true,mutated:true,value:{deleted_node_id:1,can_restore:true}})
 expect((await rows('mind_nodes'))[0]).toMatchObject({version:4,content_md:'# 正文',content_plain:'正文',origin:'user'})
 expect((await rows('mind_nodes'))[0]!.deleted_at).not.toBeNull()
 expect(await send('note_restore',{node_id:1})).toMatchObject({successful:true,mutated:true,value:{note:{node_id:1,kind:'note',title:'标题',captured_at:'2026-11-15T00:00:00.123456+00:00',content_md:'# 正文',content_plain:'正文',origin:'user',source:null}}})
 const after=(await rows('mind_nodes'))[0]!;expect(after).toMatchObject({version:5,deleted_at:null,content_md:before.content_md,captured_at:before.captured_at})
 expect(await rows('undo_operations')).toHaveLength(2);expect(publish).toHaveBeenCalledTimes(2)
})
it('非法参数、越权、画布类型、重复状态均不写入，不允许模型版本或模糊删除',async()=>{
 const before=await rows('mind_nodes')
 for(const input of [{},{node_id:1,version:0},{node_id:1,query:'标题'},{node_id:5},{node_id:6},{node_id:7},{node_id:999}])expect(await send('note_delete',input,randomUUID())).toMatchObject({successful:false})
 for(const node_id of [1,5,6,999])expect(await send('note_restore',{node_id},randomUUID())).toMatchObject({successful:false,value:{error:'找不到可恢复的便签'}})
 expect(await rows('mind_nodes')).toEqual(before);expect(await rows('undo_operations')).toEqual([]);expect(publish).not.toHaveBeenCalled()
})
it('撤销仅按created_at/id选择最近存活gugu note，重放/恢复收据不选择下一条',async()=>{
 expect(await send('note_undo',{})).toMatchObject({successful:true,value:{deleted_node_id:4,can_restore:true}})
 mount();expect(await send('note_undo',{})).toMatchObject({successful:true,mutated:false,value:{deleted_node_id:4}})
 expect(await registry.tools.reconcile(call('note_undo',{}),{...identity(),roundId:'round'})).toMatchObject({successful:true,mutated:false,value:{deleted_node_id:4}})
 expect(await send('note_undo',{},'next')).toMatchObject({successful:true,value:{deleted_node_id:3}})
 expect(await send('note_undo',{},'last')).toMatchObject({successful:true,value:{deleted_node_id:2}})
 expect(await send('note_undo',{},'empty')).toMatchObject({successful:false,value:{error:'没有可撤销的咕咕记录'}})
 const nodes=await rows('mind_nodes');for(const id of [1,5,6])expect(nodes.find(row=>row.id===id)!.deleted_at).toBeNull()
})
it('同调用并发只删一次，提交应答丢失恢复原目标，改参冲突与未知收据不重做',async()=>{
 const input={node_id:1},result=await Promise.all([send('note_delete',input),send('note_delete',input)])
 expect(result.filter(row=>row.kind==='completed'&&row.mutated)).toHaveLength(1)
 expect((await rows('mind_nodes'))[0]!.version).toBe(4)
 expect(await send('note_delete',{node_id:2})).toMatchObject({successful:false,value:{error:'操作标识已用于不同内容'}})
 const operation=core.operationWithTransaction.bind(core)
 vi.spyOn(core,'operationWithTransaction').mockImplementationOnce(async(...args)=>{await operation(...args);throw new Error('合成提交应答丢失')})
 expect(await send('note_undo',{})).toMatchObject({successful:true,mutated:false,value:{deleted_node_id:4}})
 expect((await rows('mind_nodes')).find(row=>row.id===3)!.deleted_at).toBeNull()
 expect(await registry.tools.reconcile(call('note_undo',{},'absent'),{...identity(),roundId:'round'})).toEqual({kind:'unknown'})
})
it('取消和Undo失败回滚节点、版本及收据，通知失败不撤销已提交恢复',async()=>{
 const controller=new AbortController(),db=core.db.withPlugin({transformQuery:args=>args.node,async transformResult(args){if(args.result.rows.some(row=>row.id===1&&row.version===4))controller.abort();return args.result}})
 mount(new SqlDataRuntime(db,core.backend))
 expect(await registry.tools.dispatch(call('note_delete',{node_id:1}),{...scope(),signal:controller.signal})).toEqual({kind:'unknown'})
 expect((await rows('mind_nodes'))[0]).toMatchObject({version:3,deleted_at:null});expect(await rows('undo_operations')).toEqual([])
 mount();publish.mockRejectedValue(new Error('合成通知失败'))
 expect(await send('note_restore',{node_id:7})).toMatchObject({successful:true});expect((await rows('mind_nodes')).find(row=>row.id===7)).toMatchObject({version:4,deleted_at:null})
 await sql`DROP TABLE undo_operations`.execute(core.db)
 expect(await send('note_delete',{node_id:1},'undo-fail')).toEqual({kind:'unknown'})
 expect((await rows('mind_nodes'))[0]).toMatchObject({version:3,deleted_at:null})
})
it('撤权/组关闭/预先取消不执行，真实工具恢复结果进入Agent续轮',async()=>{
 const controller=new AbortController();controller.abort()
 await expect(registry.tools.dispatch(call('note_delete',{node_id:1}),{...scope(),signal:controller.signal})).rejects.toThrow()
 allowed=false;expect(await send('note_delete',{node_id:1})).toMatchObject({successful:false,executed:false})
 allowed=true;registry.configure({groups:{mind:false}});expect(await send('note_restore',{node_id:7})).toMatchObject({successful:false,executed:false})
 mount();const f=fixture([[{type:'complete',text:'',calls:[call('note_restore',{node_id:7})]}],[{type:'complete',text:'已恢复',calls:[]}]])
 f.ports.tools=registry.tools;f.ports.context.afterTool=async(context,_call,result)=>[...context,result.kind==='completed'?JSON.stringify(result.value):'unknown']
 expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
 expect(vi.mocked(f.ports.provider.stream).mock.calls[1]![0].context.join('\n')).toContain('"content_md":"# 正文"')
})
