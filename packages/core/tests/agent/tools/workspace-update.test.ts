import { randomUUID } from 'node:crypto'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { beforeEach,afterEach,it,expect,vi } from 'vitest'
import { initializeSqlite,openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createWorkspaceMutationPort,createWorkspaceUpdateTool } from '../../../src/agent/tools/workspaces.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect,fixture } from '../run/fixtures.js'
let core:SqlDataRuntime,folder:string,owner:string,other:string,allowed:boolean,registry:ReturnType<typeof createToolRegistry>
const identity=()=>({ownerId:owner,sessionId:'1',runId:'workspace-run'})
const scope=()=>({identity:identity(),roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}})
const request=(input:unknown,id='update')=>({id,name:'update_workspace',input})
const send=(input:unknown,id='update')=>registry.tools.dispatch(request(input,id),scope())
const query=(statement:string)=>sql.raw<Record<string,unknown>>(statement).execute(core.db)
function mount(){registry=createToolRegistry({groups:[{id:'workspaces',name:'工作区',tools:[createWorkspaceUpdateTool(createWorkspaceMutationPort(core))]}],authorize:async()=>allowed})}
beforeEach(async()=>{
 folder=await mkdtemp(join(tmpdir(),'gugu-workspace-write-'))
 await initializeSqlite(join(folder,'core.db'));const opened=await openSqliteRuntime(join(folder,'core.db'));core=opened.runtime;owner=opened.ownerId;other=randomUUID();allowed=true
 await query('CREATE TABLE workspace_directories(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT,directory_name TEXT,is_system INTEGER,is_default INTEGER,deleted_at TEXT,created_at TEXT,updated_at TEXT)')
 await query('CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT,kind TEXT,project_id INTEGER,directory_id INTEGER,enabled INTEGER,is_default INTEGER,created_at TEXT,updated_at TEXT)')
 const own=owner.replaceAll('-',''),foreign=other.replaceAll('-','')
 await query("INSERT INTO workspace_directories VALUES(7,'"+own+"','目录','固定物理段',0,0,NULL,'2026-01-01','2026-01-01'),(8,'"+own+"','重名','other',0,0,NULL,'2026-01-01','2026-01-01')")
 await query("INSERT INTO workspaces VALUES(1,'"+own+"','目录','directory',NULL,NULL,7,1,0,'2026-01-01','2026-01-01'),(2,'"+own+"','别名','directory',NULL,NULL,7,1,0,'2026-01-01','2026-01-01'),(3,'"+foreign+"','他人','directory',NULL,NULL,7,1,0,'2026-01-01','2026-01-01')")
 mount()
})
afterEach(async()=>{await core?.close();if(folder)await rm(folder,{recursive:true,force:true})})
it('同事务同步目录显示名与owner绑定，完整payload和收据恢复不重复执行，物理段不变',async()=>{
 const input={workspace_id:1,workspace_name:' 新名 ',enabled:false}
 expect(await send(input)).toMatchObject({successful:true,mutated:true,value:{success:true,workspace:{workspace_id:1,name:'新名',enabled:false,directory_name:'新名',bound_session_count:0}}})
 expect((await query('SELECT name FROM workspaces ORDER BY id')).rows.map(row=>row.name)).toEqual(['新名','新名','他人'])
 expect((await query('SELECT directory_name FROM workspace_directories WHERE id=7')).rows[0]!.directory_name).toBe('固定物理段')
 mount()
 expect(await send(input)).toMatchObject({successful:true,mutated:false})
 expect(await registry.tools.reconcile(request(input),{...identity(),roundId:'round'})).toMatchObject({successful:true,mutated:false})
 expect((await query('SELECT count(*) n FROM core_operation_receipts')).rows[0]!.n).toBe(1)
})
it('非法参数、缺字段、越权、重名与系统目录失败不产生副作用',async()=>{
 expect(await send({workspace_id:1})).toMatchObject({successful:false,value:{error:'至少提供 workspace_name 或 enabled 一个要修改的字段'}})
 expect(await send({workspace_id:3,enabled:false},'foreign')).toMatchObject({successful:false,value:{error:'工作区不存在'}})
 expect(await send({workspace_id:1,workspace_name:'重名'},'duplicate')).toMatchObject({successful:false})
 expect(await send({workspace_id:1,workspace_name:''},'blank')).toMatchObject({successful:false,value:{error:'工作区名称不能为空'}})
 expect(await send({workspace_id:-1,enabled:false},'negative')).toMatchObject({successful:false,executed:false})
 expect(await send({workspace_id:0,enabled:false},'zero')).toMatchObject({successful:false,executed:false})
 expect(await send({workspace_id:1,owner_id:other,enabled:false},'extra')).toMatchObject({successful:false,executed:false})
 await query('UPDATE workspace_directories SET is_system=1 WHERE id=7')
 expect(await send({workspace_id:1,workspace_name:'不可改'},'system')).toMatchObject({successful:false})
 expect((await query('SELECT name,enabled FROM workspaces WHERE id=1')).rows[0]).toMatchObject({name:'目录',enabled:1})
})
it('同调用并发去重、改参冲突、撤权及组关闭，未知收据不重做',async()=>{
 const input={workspace_id:1,enabled:false}
 const results=await Promise.all([send(input),send(input)])
 expect(results.filter(row=>row.kind==='completed'&&row.mutated)).toHaveLength(1)
 expect(await send({workspace_id:1,enabled:true})).toMatchObject({successful:false,value:{error:'操作标识已用于不同内容'}})
 expect(await registry.tools.reconcile(request(input,'unseen'),{...identity(),roundId:'round'})).toEqual({kind:'unknown'})
 allowed=false;expect(await send(input,'denied')).toMatchObject({successful:false,executed:false})
 allowed=true;registry.configure({groups:{workspaces:false}})
 expect(await send(input,'disabled')).toMatchObject({successful:false,executed:false})
})
it('提交响应丢失只查收据恢复，取消前不执行',async()=>{
 const operation=core.operationWithTransaction.bind(core)
 vi.spyOn(core,'operationWithTransaction').mockImplementationOnce(async(...args)=>{await operation(...args);throw new Error('合成提交应答丢失')})
 expect(await send({workspace_id:1,enabled:false})).toMatchObject({successful:true,mutated:false})
 const controller=new AbortController();controller.abort()
 await expect(registry.tools.dispatch(request({workspace_id:1,enabled:true},'cancel'),{...scope(),signal:controller.signal})).rejects.toThrow()
 expect((await query('SELECT enabled FROM workspaces WHERE id=1')).rows[0]!.enabled).toBe(0)
})
it('真实Agent续轮获取工作区完整更新结果',async()=>{
 const f=fixture([[{type:'complete',text:'',calls:[request({workspace_id:1,enabled:false})]}],[{type:'complete',text:'已停用',calls:[]}]])
 f.ports.tools=registry.tools
 f.ports.context.afterTool=async(context,_call,result)=>[...context,result.kind==='completed'?JSON.stringify(result.value):'unknown']
 expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
 expect(vi.mocked(f.ports.provider.stream).mock.calls[1]![0].context.join('\n')).toContain('"enabled":false')
})
