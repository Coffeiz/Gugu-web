import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'kysely'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { dataContext, CoreError } from '../../../src/contracts/index.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createDurableProjectMutationPort } from '../../../src/agent/tools/projects/mutation-port.js'
import { createProjectMutationTools, createProjectStageTools } from '../../../src/agent/tools/projects/index.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect, fixture } from '../run/fixtures.js'

let folder:string,filename:string,core:SqlDataRuntime,owner:string,other:string,id:number,oldPrefix:string,allowed:boolean
let registry:ReturnType<typeof createToolRegistry>,port:ReturnType<typeof createDurableProjectMutationPort>
let moves:string[],published:number,failAfterMove:boolean
let abortAfterMove:AbortController|undefined,abortOnPublish:AbortController|undefined
const identity=()=>({ownerId:owner,sessionId:'1',runId:'persistent-run'})
const scope=()=>({identity:identity(),roundId:'round',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}})
const call=(name:string,input:unknown,callId='same-call')=>({id:callId,name,input})
function mount(){
 port=createDurableProjectMutationPort({core,runtime:{
  async renameProjectDirectory(_owner,from,to,onMoved){
   const source=join(folder,'files',from),target=join(folder,'files',to)
   await mkdir(dirname(target),{recursive:true});await rename(source,target);moves.push(`${from}->${to}`);onMoved?.()
   if(abortAfterMove){abortAfterMove.abort();abortAfterMove=undefined}
   if(failAfterMove){failAfterMove=false;throw new CoreError('conflict','合成提交前失败')}
  },getFileCount:async()=>1,publishProjectUpdated:async()=>{published++;abortOnPublish?.abort();abortOnPublish=undefined},
 },metadata:()=>({undoContextId:'agent-session-1'})})
 registry=createToolRegistry({groups:[{id:'projects',name:'项目',tools:[...createProjectMutationTools(port),...createProjectStageTools(port)]}],authorize:async()=>allowed})
}
beforeEach(async()=>{
 folder=await mkdtemp(join(tmpdir(),'gugu-project-receipt-'));filename=join(folder,'core.db');await initializeSqlite(filename)
 const opened=await openSqliteRuntime(filename);core=opened.runtime;owner=opened.ownerId;other=randomUUID();allowed=true;moves=[];published=0;failAfterMove=false
 const project=await core.transaction(dataContext(owner),data=>data.projects.create({name:'计划😀',start_date:'2026-11-01',stages:[{key:'s0',label:'阶段',todos:[{id:'t0',text:'未完',done:false},{id:'t1',text:'已完',done:true}]}]}))
 id=project.id;oldPrefix=`${owner}/项目文件/2026/11/计划😀 #${id}`
 await mkdir(join(folder,'files',oldPrefix),{recursive:true});await writeFile(join(folder,'files',oldPrefix,'owned.txt'),'合成正文')
 mount()
})
afterEach(async()=>{await core?.close();if(folder)await rm(folder,{recursive:true,force:true})})

it('无旧文件表时更新项目和磁盘目录，重建后重放不再次改名或发布',async()=>{
 const request=call('update_project',{project:'计划😀',project_name:'新名😀',status:'done',summary:'摘要'})
 expect(await registry.tools.dispatch(request,scope())).toMatchObject({successful:true,mutated:true,value:{project_id:id,name:'新名😀'}})
 const project=await core.transaction(dataContext(owner),data=>data.projects.get(id))
 expect(project).toMatchObject({version:2,status:'done',progress:100,summary:'摘要'})
 expect(JSON.parse(project!.stages_json)[0].todos).toEqual([{id:'t0',text:'未完',done:true,_savedDone:false,autoCompleted:true},{id:'t1',text:'已完',done:true}])
 const next=`${owner}/项目文件/2026/11/新名😀 #${id}`
 expect(await readFile(join(folder,'files',next,'owned.txt'),'utf8')).toBe('合成正文')
 expect((await sql<{n:number}>`SELECT count(*) n FROM undo_operations`.execute(core.db)).rows[0]!.n).toBe(1)
 expect((await sql<{n:number}>`SELECT count(*) n FROM core_operation_receipts`.execute(core.db)).rows[0]!.n).toBe(1)
 await core.close();core=(await openSqliteRuntime(filename)).runtime;mount()
 // 同名新目标不能改变原调用收据的目标。
 await core.transaction(dataContext(owner),data=>data.projects.create({name:'计划😀'}))
 expect(await registry.tools.dispatch(request,scope())).toMatchObject({successful:true,mutated:false,value:{project_id:id,name:'新名😀'}})
 expect(await registry.tools.reconcile(request,{...identity(),roundId:'round'})).toMatchObject({successful:true,mutated:false,value:{project_id:id}})
 expect(moves).toHaveLength(1);expect(published).toBe(1)
 expect((await core.transaction(dataContext(owner),data=>data.projects.get(id)))!.version).toBe(2)
})

it('相同调用改参先拒绝fingerprint；不同run可独立操作，归档与颜色投影保持旧协议',async()=>{
 const original=call('set_color',{project_id:id,color:'teal'})
 expect(await registry.tools.dispatch(original,scope())).toMatchObject({successful:true,value:{color:'teal'}})
 expect(await registry.tools.dispatch(call('set_color',{project_id:id,color:'rose'}),scope())).toMatchObject({successful:false,value:{error:'操作标识已用于不同内容'}})
 expect(await registry.tools.dispatch(call('set_color',{project_id:id,color:'rose'}),{...scope(),identity:{...identity(),runId:'another-run'}})).toMatchObject({successful:true,value:{color:'rose'}})
 expect(await registry.tools.dispatch(call('archive_project',{project_id:id},'archive'),scope())).toMatchObject({successful:true,value:{archived:true}})
 expect(await registry.tools.dispatch(call('archive_project',{project_id:id,archived:false},'unarchive'),scope())).toMatchObject({successful:true,value:{archived:false}})
})

it('并发相同调用只更新一次；越权、组关闭和撤权不得读回其他owner收据',async()=>{
 const request=call('archive_project',{project_id:id})
 const results=await Promise.all([registry.tools.dispatch(request,scope()),registry.tools.dispatch(request,scope())])
 expect(results.filter(result=>result.kind==='completed'&&result.mutated)).toHaveLength(1)
 expect((await core.transaction(dataContext(owner),data=>data.projects.get(id)))!.version).toBe(2)
 expect(await registry.tools.dispatch(request,{...scope(),identity:{...identity(),ownerId:other}})).toMatchObject({successful:false})
 allowed=false
 expect(await registry.tools.reconcile(request,{...identity(),roundId:'round'})).toMatchObject({successful:false,executed:false})
 allowed=true;registry.configure({groups:{projects:false}})
 expect(await registry.tools.dispatch(request,scope())).toMatchObject({successful:false,executed:false})
})

it('目录移动后事务内失败补偿文件系统并回滚数据库及收据，不把失败当成功',async()=>{
 failAfterMove=true
 expect(await registry.tools.dispatch(call('update_project',{project_id:id,project_name:'失败新名'}),scope())).toMatchObject({successful:false})
 await access(join(folder,'files',oldPrefix,'owned.txt'))
 expect((await core.transaction(dataContext(owner),data=>data.projects.get(id)))!.name).toBe('计划😀')
 expect((await sql<{n:number}>`SELECT count(*) n FROM core_operation_receipts`.execute(core.db)).rows[0]!.n).toBe(0)
 expect(moves).toHaveLength(2);expect(published).toBe(0)
})

it('提交回执丢失不盲重试；只查持久收据恢复结果，未知调用保持unknown',async()=>{
 const request=call('archive_project',{project_id:id})
 const operation=core.operationWithTransaction.bind(core)
 const spy=vi.spyOn(core,'operationWithTransaction')
 spy.mockImplementationOnce(async(...args)=>{await operation(...args);throw new Error('合成提交回执丢失')})
 expect(await registry.tools.dispatch(request,scope())).toMatchObject({successful:true,mutated:false,value:{archived:true}})
 spy.mockRestore()
 const version=(await core.transaction(dataContext(owner),data=>data.projects.get(id)))!.version
 expect(await registry.tools.reconcile(request,{...identity(),roundId:'round'})).toMatchObject({successful:true,mutated:false})
 expect(await registry.tools.reconcile({...request,id:'unseen'},{...identity(),roundId:'round'})).toEqual({kind:'unknown'})
 expect((await core.transaction(dataContext(owner),data=>data.projects.get(id)))!.version).toBe(version)
})

it('真实Agent续轮接收已提交修改，完成Run后重建注册器仍能读取相同收据',async()=>{
 const request=call('archive_project',{project_id:id})
 const f=fixture([[{type:'complete',text:'',calls:[request]}],[{type:'complete',text:'已归档',calls:[]}]])
 f.ports.tools=registry.tools;f.ports.context.afterTool=async(context,_call,result)=>[...context,result.kind==='completed'?JSON.stringify(result.value):'unknown']
 expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
 mount()
 expect(await registry.tools.reconcile(request,{...identity(),roundId:`${identity().runId}:1`})).toMatchObject({successful:true,value:{archived:true}})
})


it('提交前取消回滚并补偿目录，提交后取消保留成功，不把已提交操作当未执行',async()=>{
 const early=new AbortController();early.abort()
 await expect(registry.tools.dispatch(call('archive_project',{project_id:id}),{...scope(),signal:early.signal})).rejects.toThrow()
 const during=new AbortController();abortAfterMove=during
 expect(await registry.tools.dispatch(call('update_project',{project_id:id,project_name:'取消改名'}),{...scope(),signal:during.signal})).toEqual({kind:'unknown'})
 await access(join(folder,'files',oldPrefix,'owned.txt'))
 expect((await core.transaction(dataContext(owner),data=>data.projects.get(id)))!.name).toBe('计划😀')
 expect((await sql<{n:number}>`SELECT count(*) n FROM core_operation_receipts`.execute(core.db)).rows[0]!.n).toBe(0)
 const late=new AbortController();abortOnPublish=late
 expect(await registry.tools.dispatch(call('archive_project',{project_id:id},'late'),{...scope(),signal:late.signal})).toMatchObject({successful:true,mutated:true,value:{archived:true}})
 expect(late.signal.aborted).toBe(true)
 expect(await registry.tools.reconcile(call('archive_project',{project_id:id},'late'),{...identity(),roundId:'round'})).toMatchObject({successful:true,mutated:false})
})

const change=(name:string,input:Record<string,unknown>,callId=name)=>registry.tools.dispatch(call(name,{project_id:id,...input},callId),scope())
const persisted=()=>core.transaction(dataContext(owner),data=>data.projects.get(id))
it('阶段新增、重命名、切换和删除保留稳定key；删除当前阶段切首项且最后一个不能删除',async()=>{
 expect(await change('add_stage',{label:'  验收  ',position:0})).toMatchObject({value:{stage_key:'s1',label:'验收'}})
 expect(await change('rename_stage',{stage:'s1',new_label:'交付'})).toMatchObject({value:{label:'交付'}})
 expect(await change('update_stage',{stage:'s1'})).toMatchObject({value:{current_stage:'s1'}})
 expect(await change('remove_stage',{stage:'s1'})).toMatchObject({value:{removed:'交付',remaining_stages:[{key:'s0',label:'阶段'}],current_stage_key:'s0',current_stage:'阶段'}})
 expect(await persisted()).toMatchObject({version:5,current_stage:'s0'})
 expect(await change('remove_stage',{stage:'s0'},'last')).toMatchObject({successful:false,value:{error:'项目至少保留一个阶段，无法删除最后一个阶段'}})
 expect((await persisted())!.version).toBe(5)
 expect((await sql.raw<{n:number}>('SELECT count(*) n FROM undo_operations').execute(core.db)).rows[0]!.n).toBe(4)
 expect(moves).toEqual([])
})
it('整体设置同名阶段必须带key，省略todos保留元数据，显式todos重建编号并保留当前key',async()=>{
 await change('update_stage',{stage:'s0'},'seed-current')
 await change('add_stage',{label:'阶段'})
 const before=(await persisted())!
 expect(await change('set_stages',{stages:['阶段']})).toMatchObject({successful:false,value:{error:'阶段名称「阶段」重名，请在 stages 项中提供 key'}})
 expect((await persisted())!.version).toBe(before.version)
 expect(await change('set_stages',{stages:[{key:'s1',label:'第二项',todos:['新待办']},{key:'s0',label:'第一项'}]},'valid')).toMatchObject({
  value:{stages:['第二项','第一项'],stage_details:[{key:'s1',todo_count:1},{key:'s0',todo_count:2}],current_stage:'s0'}})
 const stages=JSON.parse((await persisted())!.stages_json)
 expect(stages[0].todos).toEqual([{id:'t2',text:'新待办',done:false}])
 expect(stages[1].todos).toEqual(JSON.parse(before.stages_json)[0].todos)
 expect(await change('set_stages',{stages:['第二项','第一项']},'names')).toMatchObject({value:{current_stage:'s0',input_adaptations:['stages:stage_names_to_objects']}})
})
it('批量待办先校验移动目标，失败项不能随成功项偷偷写入；范围不切换当前阶段',async()=>{
 await change('update_stage',{stage:'s0'},'seed-current')
 await change('add_stage',{label:'交付'})
 const result=await change('update_stage',{stage:'s0',add:['  新增  '],todos:[
  {text:'t0',new_text:'不得生效',done:true,to_stage:'missing'},
  {text:'t1',new_text:'已改名',done:false,to_stage:'s1'},
  {text:'t2',done:true},
  {text:'t0',stage:'s1',done:true},
 ]})
 expect(result).toMatchObject({successful:true,value:{results:[
  {action:'add',added:['新增']},{todo:'未完',error:'目标阶段不存在: missing'},
  {todo:'已完',action:'rename+done+move',done:false},{todo:'新增',action:'done',done:true},
  {todo:'t0',error:'未找到待办',hint:expect.stringContaining('to_stage')},
 ]}})
 const project=(await persisted())!,stages=JSON.parse(project.stages_json)
 expect(project.current_stage).toBe('s0')
 expect(stages[0].todos).toEqual([{id:'t0',text:'未完',done:false},{id:'t2',text:'新增',done:true}])
 expect(stages[1].todos).toEqual([{id:'t1',text:'已改名',done:false}])
 expect(await change('update_stage',{todos:[{text:'t2',remove:true,new_text:'忽略'}]},'delete')).toMatchObject({value:{results:[{action:'remove'}]}})
})
it('模糊或跨阶段重名待办返回候选，全失败不更改版本；非法嵌套参数不触及持久层',async()=>{
 await change('add_stage',{label:'交付'})
 await change('update_stage',{stage:'s1',add:['未完']},'seed')
 const before=(await persisted())!
 expect(await change('update_stage',{todos:[{text:'未完',done:true}]})).toMatchObject({successful:false,value:{error:'没有任何待办被修改',results:[
  {error:'待办匹配到多项，请提供 todos[].stage 或待办 ID',candidates:[{stage_key:'s0',todo_id:'t0'},{stage_key:'s1',todo_id:'t2'}]},
 ]}})
 expect((await persisted())!.stages_json).toBe(before.stages_json)
 expect((await persisted())!.version).toBe(before.version)
 expect(await change('update_stage',{todos:[{text:'t0',new_text:' '}]},'blank')).toMatchObject({successful:false,value:{error:'todos 第 1 项的 new_text 必须是非空文本'}})
 expect((await persisted())!.version).toBe(before.version)
 expect(await change('update_stage',{todos:[{text:'t0',invented:true}]},'invalid')).toMatchObject({successful:false,executed:false})
 expect(await change('add_stage',{label:' ',position:-1},'negative')).toMatchObject({successful:false,executed:false})
 expect(await change('rename_stage',{stage:'s0',new_label:' ',owner_id:other},'extra')).toMatchObject({successful:false,executed:false})
})
it('阶段调用并发及重建恢复只创建一次，跨owner和撤权不能恢复收据',async()=>{
 const request=call('add_stage',{project_id:id,label:'唯一新增'},'parallel-stage')
 const results=await Promise.all([registry.tools.dispatch(request,scope()),registry.tools.dispatch(request,scope())])
 expect(results.filter(row=>row.kind==='completed'&&row.mutated)).toHaveLength(1)
 mount()
 expect(await registry.tools.reconcile(request,{...identity(),roundId:'round'})).toMatchObject({successful:true,mutated:false,value:{stage_key:'s1'}})
 expect(JSON.parse((await persisted())!.stages_json)).toHaveLength(2)
 expect(await registry.tools.dispatch({...request,id:'cross'},{...scope(),identity:{...identity(),ownerId:other}})).toMatchObject({successful:false})
 allowed=false
 expect(await registry.tools.reconcile(request,{...identity(),roundId:'round'})).toMatchObject({successful:false,executed:false})
})

it('批量阶段错误在收据持久化和Provider续轮前递归脱敏，正常待办正文和失败项原状态保留',async()=>{
 const request=call('update_stage',{project_id:id,todos:[
  {text:'t0',new_text:'不应写入',to_stage:'/tmp/synthetic-private token=synthetic-secret-value-000'},
  {text:'t1',done:false},
 ]},'partial-secret')
 const f=fixture([[{type:'complete',text:'',calls:[request]}],[{type:'complete',text:'已处理',calls:[]}]])
 f.ports.tools=registry.tools
 f.ports.context.afterTool=async(context,_call,result)=>[...context,result.kind==='completed'?JSON.stringify(result.value):'unknown']
 expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
 const wire=vi.mocked(f.ports.provider.stream).mock.calls[1]![0].context.join('\n')
 expect(wire).toContain('未完');expect(wire).toContain('‹路径已隐藏›');expect(wire).toContain('‹密钥已隐藏›')
 expect(wire).not.toMatch(/synthetic-private|synthetic-secret-value/)
 const receipt=(await sql.raw<{result_json:string}>('SELECT result_json FROM core_operation_receipts').execute(core.db)).rows[0]!
 expect(receipt.result_json).not.toMatch(/synthetic-private|synthetic-secret-value/)
 expect(JSON.parse((await persisted())!.stages_json)[0].todos[0]).toEqual({id:'t0',text:'未完',done:false})
})
