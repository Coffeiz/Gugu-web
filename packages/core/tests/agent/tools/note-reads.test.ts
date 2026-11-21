import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createAgentMindReader, extractMindReferences } from '../../../src/mind/note-read.js'
import { createNoteReadTools } from '../../../src/agent/tools/note.js'
import { createSearchToolsTool } from '../../../src/agent/tools/meta.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect, fixture } from '../run/fixtures.js'

let folder:string,core:SqlDataRuntime,owner:string,other:string,allowed:boolean,projectId:number,foreignId:number
let reader:ReturnType<typeof createAgentMindReader>,registry:ReturnType<typeof createToolRegistry>
const identity=()=>({ownerId:owner,sessionId:'1',runId:'notes'})
const scope=()=>({identity:identity(),roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}})
const dispatch=(name:string,input:unknown={})=>registry.tools.dispatch({id:name,name,input},scope())
const key=(value:string)=>value.replaceAll('-','')
const tick=String.fromCharCode(96)
async function seed(id:number,user:string,kind:string,title:string,plain:string,md:string,deleted=false){
 await core.db.insertInto('mind_nodes').values({id,user_id:key(user),kind,title,content_md:md,content_plain:plain,color:null,
  ref_type:kind==='ref'?'project':null,ref_id:kind==='ref'?projectId:null,ref_snapshot:null,origin:'gugu',indexed_at:null,indexed_hash:null,
  version:1,captured_at:'2026-11-'+String(16-id).padStart(2,'0')+' 00:00:00.000001',created_at:'2026-11-01 00:00:00',
  updated_at:'2026-11-01 00:00:00',deleted_at:deleted?'2026-11-15 00:00:00':null}).execute()
}
beforeEach(async()=>{
 folder=await mkdtemp(join(tmpdir(),'gugu-note-tools-'));const file=join(folder,'core.db');await initializeSqlite(file)
 const opened=await openSqliteRuntime(file);core=opened.runtime;owner=opened.ownerId;other=randomUUID();allowed=true
 projectId=(await core.transaction(dataContext(owner),data=>data.projects.create({name:'当前项目名'}))).id
 foreignId=(await core.transaction(dataContext(other),data=>data.projects.create({name:'他人私有项目'}))).id
 await sql.raw('CREATE TABLE files(id INTEGER PRIMARY KEY,user_id TEXT,display_name TEXT,deleted_at TEXT)').execute(core.db)
 await sql.raw('INSERT INTO files VALUES(1,\''+key(owner)+'\',\'当前文件名\',NULL),(2,\''+key(other)+'\',\'他人私有文件\',NULL)').execute(core.db)
 await sql`INSERT INTO calendar_events(id,user_id,title,date,time,end_time,type,contact_name,project_id,description,version,created_at,deleted_at)
  VALUES(1,${key(owner)},'当前活动名','2026-11-15',NULL,NULL,'event',NULL,NULL,NULL,1,'2026-11-01 00:00:00',NULL)`.execute(core.db)
 const md='# 重构😀\r\n正文 [[project:'+projectId+'|旧名称]] [[file:drop-owned|旧文件]] [[event:1|旧活动]]\n'
  +tick+'[[project:'+foreignId+'|代码示例]]'+tick+'\n~~~txt\n[[file:2|围栏]]\n~~~\n'
  +'\\[[file:2|转义]] [[project:'+foreignId+'|不可读]] [[file:2|不可读]] [[file:99|缺失]]'
 await seed(1,owner,'note','重构😀','  '+'😀'.repeat(245)+'  ',md)
 await seed(2,owner,'canvas_note','画布重构','重构 条件乙','画布正文')
 await seed(3,other,'note','他人重构','不可泄漏','他人正文')
 await seed(4,owner,'note','已删重构','不可见','已删正文',true)
 await seed(5,owner,'ref','来源重构','不是便签','来源正文')
 await seed(6,owner,'note','邻居','非匹配','邻居正文')
 await seed(7,other,'note','他人邻居','不可泄漏','他人正文')
 await seed(8,owner,'note','已删邻居','不可见','已删正文',true)
 for(const [id,user,dst] of [[1,owner,2],[2,owner,6],[3,owner,7],[4,owner,8],[5,other,2],[6,owner,5]] as const){
  await core.db.insertInto('mind_relations').values({id,user_id:key(user),canvas_id:null,src_node_id:1,dst_node_id:dst,
   rel_type:'related',edge_key:'',origin:'user',status:'active',note:'关系说明',created_at:'2026-11-15 00:00:0'+id,
   updated_at:'2026-11-15 00:00:00',deleted_at:id===2?'2026-11-15 00:00:00':null}).execute()
 }
 reader=createAgentMindReader(core.db,'sqlite',async (candidate,id)=>candidate===owner&&id==='drop-owned'?{label:'当前文件名',path:'/synthetic/当前文件名.md'}:null)
 registry=createToolRegistry({authorize:async()=>allowed,groups:[{id:'mind',name:'笔记',tools:createNoteReadTools(reader)}]})
 registry.registerGroup({id:'meta',name:'元工具',tools:[createSearchToolsTool(user=>registry.capabilities(user))]})
})
afterEach(async()=>{await core?.close();if(folder)await rm(folder,{recursive:true,force:true})})

it('真实搜索/详情分别返回摘要与正文，关系及正文引用按owner和存活状态过滤，时间不损微秒',async()=>{
 const searched=await dispatch('note_search',{query:'重构',limit:1})
 expect(searched).toMatchObject({successful:true,value:{count:1,matches:[{node_id:1,kind:'note',preview:'😀'.repeat(240),captured_at:'2026-11-15T00:00:00.000001+00:00'}],
  related:[{from_node_id:1,node:{node_id:5}},{from_node_id:1,node:{node_id:6}},{from_node_id:1,node:{node_id:2}}],
  references:[{from_node_id:1,ref_type:'project',ref_id:projectId,label:'当前项目名'},{from_node_id:1,ref_type:'file',ref_id:'drop-owned',label:'当前文件名',path:'/synthetic/当前文件名.md'},{from_node_id:1,ref_type:'event',ref_id:1,label:'当前活动名'}]}})
 if(searched.kind==='completed')expect((searched.value as {matches:object[]}).matches[0]).not.toHaveProperty('content_md')
 const full=await dispatch('note_get',{node_id:'#1',owner_id:other})
 expect(full).toMatchObject({successful:true,value:{node:{node_id:1,origin:'gugu',numbered_content:'1: # 重构😀\n2: 正文 [[project:'+projectId+'|旧名称]] [[file:drop-owned|旧文件]] [[event:1|旧活动]]\n3: '+tick+'[[project:'+foreignId+'|代码示例]]'+tick+'\n4: ~~~txt\n5: [[file:2|围栏]]\n6: ~~~\n7: \\[[file:2|转义]] [[project:'+foreignId+'|不可读]] [[file:2|不可读]] [[file:99|缺失]]'}}})
 if(full.kind==='completed'){
  const value=full.value as {node:{numbered_content:string};related:object[]}
  expect(value.node.numbered_content).toContain('3: '+tick+'[[project:'+foreignId+'|代码示例]]'+tick)
  expect(value.related.every(row=>!Object.hasOwn(row,'from_node_id'))).toBe(true)
 }
 expect(JSON.stringify(searched)).not.toMatch(/他人|不可泄漏|已删邻居/)
 expect(await dispatch('note_get',{node_id:3})).toMatchObject({successful:false,value:{error:'找不到这条思维节点'}})
 expect(await dispatch('note_get',{node_id:4})).toMatchObject({successful:false})
 expect(await dispatch('note_get',{node_id:5})).toMatchObject({successful:true,value:{node:{kind:'ref',source:{type:'project',id:projectId}}}})
})
it('多词AND/OR、历史q、limit夹取和全角参数，搜索不包含来源节点，且不写收据',async()=>{
 expect(await dispatch('note_search',{queries:['重构','条件乙'],mode:'AND',include_content:true})).toMatchObject({value:{count:1,matches:[{node_id:2,content_md:'画布正文'}]}})
 expect(await dispatch('note_search',{q:'重构',limit:'０'})).toMatchObject({value:{count:1,matches:[{node_id:1}]}})
 expect(await dispatch('note_search',{queries:['重构','重构'],mode:'OR',limit:999})).toMatchObject({value:{count:2,matches:[{node_id:1},{node_id:2}]}})
 expect(await dispatch('note_search',{query:'重构',kind:'note'})).toMatchObject({value:{count:1,matches:[{node_id:1,kind:'note'}]}})
 expect(await dispatch('note_search',{query:'重构',kind:'canvas_note'})).toMatchObject({value:{count:1,matches:[{node_id:2,kind:'canvas_note'}]}})
 expect(await dispatch('note_search')).toMatchObject({successful:false,value:{error:'需要提供搜索关键词 query 或 queries'}})
 expect(await dispatch('note_search',{mode:'X',query:'重构'})).toMatchObject({successful:false,executed:false})
 expect((await sql.raw<{n:number}>('SELECT count(*) n FROM core_operation_receipts').execute(core.db)).rows[0]!.n).toBe(0)
})
it('引用解析按正文顺序去重，代码围栏/行内代码/转义不冒充真实引用，Unicode十进制一致',()=>{
 const ref='[[project:１|真实]]'
 expect(extractMindReferences(ref+' '+ref+'\n'+tick+ref+tick+'\n~~~\n'+ref+'\n~~~\n\\[[file:2|转义]] \\\\[[event:3|真实]]')).toEqual([{type:'project',id:1},{type:'event',id:3}])
 expect(extractMindReferences(tick.repeat(4)+'\n[[file:1|示例]]\n'+tick.repeat(3)+'\n[[file:2|仍在围栏]]\n'+tick.repeat(4)+'\n[[file:3|真实]]')).toEqual([{type:'file',id:3}])
})
it('权限和组开关先于SQL；查询后取消不发布正文，缺表报安全错误，不伪造空引用',async()=>{
 await registry.capabilities(identity());allowed=false
 expect(await dispatch('note_get',{node_id:1})).toMatchObject({successful:false,executed:false})
 allowed=true;registry.configure({groups:{mind:false}})
 expect(await dispatch('note_search',{query:'重构'})).toMatchObject({successful:false,executed:false})
 registry.configure({})
 const before=new AbortController();before.abort()
 await expect(registry.tools.dispatch({id:'pre',name:'note_get',input:{node_id:1}},{...scope(),signal:before.signal})).rejects.toThrow()
 const after=new AbortController(),get=reader.get.bind(reader)
 vi.spyOn(reader,'get').mockImplementationOnce(async(...args)=>{const value=await get(...args);after.abort();return value})
 await expect(registry.tools.dispatch({id:'post',name:'note_get',input:{node_id:1}},{...scope(),signal:after.signal})).rejects.toThrow()
 await sql.raw('DROP TABLE files').execute(core.db)
 expect(await dispatch('note_get',{node_id:1})).toMatchObject({successful:true,value:{references:expect.arrayContaining([{ref_type:'file',ref_id:'drop-owned',label:'当前文件名',path:'/synthetic/当前文件名.md'}])}})
 await sql.raw('DROP TABLE projects').execute(core.db)
 expect(await dispatch('note_get',{node_id:1})).toMatchObject({successful:false,value:{error:'工具执行失败'}})
})
it('按名称查询 Schema 只发现当前授权工具，重复、未知及停用的名称进入拒绝列表',async()=>{
 expect(await dispatch('search_tools',{names:['note_search','note_get','note_get','missing']})).toMatchObject({value:{results:[{name:'note_search'},{name:'note_get'}],rejected:['note_get','missing']}})
 registry.configure({groups:{mind:false}})
 expect(await dispatch('search_tools',{names:['note_get']})).toMatchObject({successful:true,value:{results:[],rejected:['note_get']}})
 expect(await dispatch('search_tools',{names:[]})).toMatchObject({successful:false,executed:false})
})
it('实际Agent续轮接收笔记读取结果和Schema发现，Provider与RunStore为明确替身',async()=>{
 const f=fixture([[{type:'complete',text:'',calls:[{id:'schema',name:'search_tools',input:{names:['note_get']}},{id:'get',name:'note_get',input:{node_id:1}}]}],
  [{type:'complete',text:'已读取',calls:[]}]])
 f.ports.tools=registry.tools
 f.ports.context.afterTool=async(context,_call,result)=>[...context,result.kind==='completed'?JSON.stringify(result.value):'unknown']
 expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
 expect(vi.mocked(f.ports.provider.stream).mock.calls[1]![0].context.join('\n')).toContain('当前文件名')
})
