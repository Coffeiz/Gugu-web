import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { beforeEach, afterEach, it, expect, vi, type Mock } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createCanvasCreationPort, createCanvasCreateTool, createCanvasPlaceableSearchTool } from '../../../src/agent/tools/canvas.js'
import { createAgentPlaceableSearch } from '../../../src/mind/canvas-read.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect, fixture } from '../run/fixtures.js'

let core: SqlDataRuntime, folder: string, owner: string, other: string, allowed: boolean
let registry: ReturnType<typeof createToolRegistry>, publish: Mock<Parameters<typeof createCanvasCreationPort>[1]>
const identity=()=>({ownerId:owner,sessionId:'1',runId:'canvas-ready'})
const scope=()=>({identity:identity(),roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}})
const call=(name:string,input:unknown,id=name)=>({id,name,input})
const send=(name:string,input:unknown,id=name)=>registry.tools.dispatch(call(name,input,id),scope())
function mount(){registry=createToolRegistry({groups:[{id:'canvas',name:'画布',tools:[createCanvasCreateTool(createCanvasCreationPort(core,publish)),createCanvasPlaceableSearchTool(createAgentPlaceableSearch(core.db,core.backend))]}],authorize:async()=>allowed})}
beforeEach(async()=>{
  folder=await mkdtemp(join(tmpdir(),'gugu-canvas-ready-'));await initializeSqlite(join(folder,'core.db'))
  const opened=await openSqliteRuntime(join(folder,'core.db'));core=opened.runtime;owner=opened.ownerId;other=randomUUID();allowed=true;publish=vi.fn(async()=>{})
  await sql`CREATE TABLE files(id INTEGER PRIMARY KEY,user_id TEXT,display_name TEXT,ext TEXT,stage_name TEXT,updated_at TEXT,deleted_at TEXT)`.execute(core.db)
  mount()
})
afterEach(async()=>{await core?.close();await rm(folder,{recursive:true,force:true})})
it('创建复用真实共享事务、Undo与收据，重放/改参/提交应答丢失不重复创建',async()=>{
  const input={title:' 新画布 ',project_id:null}
  expect(await send('canvas_create',input)).toMatchObject({successful:true,mutated:true,value:{canvas:{canvas_id:1,title:'新画布',project_id:null}}})
  expect(publish).toHaveBeenCalledTimes(1)
  mount();expect(await send('canvas_create',input)).toMatchObject({successful:true,mutated:false})
  expect(await registry.tools.reconcile(call('canvas_create',input),{...identity(),roundId:'round'})).toMatchObject({successful:true,mutated:false})
  expect(await send('canvas_create',{title:'不同内容'})).toMatchObject({successful:false,value:{error:'操作标识已用于不同内容'}})
  const operation=core.operationWithTransaction.bind(core)
  vi.spyOn(core,'operationWithTransaction').mockImplementationOnce(async(...args)=>{await operation(...args);throw new Error('合成提交应答丢失')})
  expect(await send('canvas_create',{title:'已提交'},'lost')).toMatchObject({successful:true,mutated:false})
  expect((await sql`SELECT title FROM mind_maps ORDER BY id`.execute(core.db)).rows).toEqual([{title:'新画布'},{title:'已提交'}])
  expect((await sql`SELECT count(*) n FROM undo_operations`.execute(core.db)).rows[0]).toMatchObject({n:2})
  expect((await sql`SELECT count(*) n FROM core_operation_receipts`.execute(core.db)).rows[0]).toMatchObject({n:2})
  expect(await registry.tools.reconcile(call('canvas_create',input,'absent'),{...identity(),roundId:'round'})).toEqual({kind:'unknown'})
})
it('无效标题、非法参数、跨owner项目、取消与撤权不写入；通知失败不丢失提交',async()=>{
  const foreignProject=await core.transaction({ownerId:other},data=>data.projects.create({name:'他人项目'}))
  expect(await send('canvas_create',{title:'越权',project_id:foreignProject.id},'foreign')).toMatchObject({successful:false,value:{error:'项目不存在'}})
  for(const input of [{title:' '},{title:'a'.repeat(301)},{title:'无权项目',project_id:999},{title:{invalid:true}}])expect(await send('canvas_create',input,randomUUID())).toMatchObject({successful:false})
  expect((await sql`SELECT count(*) n FROM mind_maps`.execute(core.db)).rows[0]).toMatchObject({n:0})
  const controller=new AbortController();controller.abort()
  await expect(registry.tools.dispatch(call('canvas_create',{title:'取消'}),{...scope(),signal:controller.signal})).rejects.toThrow()
  allowed=false;expect(await send('canvas_create',{title:'拒绝'})).toMatchObject({successful:false,executed:false})
  allowed=true;publish.mockRejectedValue(new Error('合成通知失败'))
  expect(await send('canvas_create',{title:'\ufeff 保留BOM'},'bom')).toMatchObject({successful:true,value:{canvas:{title:'\ufeff 保留BOM'}}})
  registry.configure({groups:{canvas:false}});expect(await send('canvas_create',{title:'关闭'})).toMatchObject({successful:false,executed:false})
})
it('候选按项目/文件/活动分组探测并保留分页count和墓碑标记，不创建引用',async()=>{
  const project=await core.transaction({ownerId:owner},data=>data.projects.create({name:'发布项目'}))
  await core.transaction({ownerId:other},data=>data.projects.create({name:'发布隐私'}))
  const key=owner.replaceAll('-',''),foreign=other.replaceAll('-',''),stamp='2026-11-15 00:00:00.000000'
  await sql`INSERT INTO files VALUES(1,${key},'发布资料','md','准备',${stamp},NULL),(2,${foreign},'发布隐私','md','准备',${stamp},NULL),(3,${key},'发布删除','md','准备',${stamp},${stamp})`.execute(core.db)
  await sql`INSERT INTO calendar_events(id,user_id,title,date,type,description,contact_name,version,created_at) VALUES(1,${key},'发布活动','2026-11-15','event','计划','小北',1,${stamp})`.execute(core.db)
  await send('canvas_create',{title:'画布'})
  const node=(await sql<{id:number}>`INSERT INTO mind_nodes(user_id,kind,title,content_md,content_plain,ref_type,ref_id,origin,version,captured_at,created_at,updated_at) VALUES(${key},'ref','项目','','','project',${project.id},'user',1,${stamp},${stamp},${stamp}) RETURNING id`.execute(core.db)).rows[0]!
  await sql`INSERT INTO mind_canvas_items(user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at,deleted_at) VALUES(${key},1,${node.id},0,0,0,0,'{}',${stamp},${stamp},${stamp})`.execute(core.db)
  const before=(await sql`SELECT count(*) n FROM mind_nodes`.execute(core.db)).rows
  expect(await send('canvas_search_placeable',{query:'发布',canvas_id:1,limit:1})).toMatchObject({value:{count:2,truncated:true,matches:[{ref_type:'project',ref_id:project.id,node_id:node.id,already_placed:true,canvas_item_id:1}]}})
  expect(await send('canvas_search_placeable',{queries:['发布','发布'],canvas_id:1,offset:1,limit:2})).toMatchObject({value:{queries:['发布'],count:3,truncated:false,matches:[{ref_type:'file',ref_id:1},{ref_type:'event',ref_id:1}]}})
  expect(await send('canvas_search_placeable',{queries:['发布','准备'],mode:'AND',types:['file']})).toMatchObject({value:{count:1,matches:[{ref_type:'file'}]}})
  expect(await send('canvas_search_placeable',{query:'发布',canvas_id:999})).toMatchObject({successful:false,value:{error:'画布不存在'}})
  expect(await send('canvas_search_placeable',{})).toMatchObject({successful:false,value:{error:'需要提供搜索关键词 query 或 queries'}})
  expect(await send('canvas_search_placeable',{query:'发布',offset:-1})).toMatchObject({successful:false,executed:false})
  expect((await sql`SELECT count(*) n FROM mind_nodes`.execute(core.db)).rows).toEqual(before)
})
it('真实工具结果进入Agent下一轮，组能力只有可信Host可装配',async()=>{
  const f=fixture([[{type:'complete',text:'',calls:[call('canvas_create',{title:'发布画布'})]}],[{type:'complete',text:'已创建',calls:[]}]])
  f.ports.tools=registry.tools;f.ports.context.afterTool=async(context,_call,result)=>[...context,result.kind==='completed'?JSON.stringify(result.value):'unknown']
  expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
  expect(vi.mocked(f.ports.provider.stream).mock.calls[1]![0].context.join('\n')).toContain('发布画布')
})

it('同调用并发只创建一次，Undo失败回滚画布和收据',async()=>{
  const results=await Promise.all([send('canvas_create',{title:'并发'}),send('canvas_create',{title:'并发'})])
  expect(results.filter(row=>row.kind==='completed'&&row.mutated)).toHaveLength(1)
  expect(publish).toHaveBeenCalledTimes(1)
  await sql`DROP TABLE undo_operations`.execute(core.db)
  expect(await send('canvas_create',{title:'必须回滚'},'rollback')).toEqual({kind:'unknown'})
  expect((await sql`SELECT title FROM mind_maps`.execute(core.db)).rows).toEqual([{title:'并发'}])
  expect((await sql`SELECT count(*) n FROM core_operation_receipts`.execute(core.db)).rows[0]).toMatchObject({n:1})
})
