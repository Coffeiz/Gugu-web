import { expect,it } from 'vitest'
import SQLite from 'better-sqlite3'
import { Kysely,SqliteDialect } from 'kysely'
import { tablesSql,type Database } from '../../src/data/schema.js'
import { createSqlMindCanvasReader } from '../../src/mind/canvas-read.js'
import { createCanvasReadTools } from '../../src/agent/tools/canvas.js'
import { createToolRegistry } from '../../src/agent/tools/registry.js'

it('真实SQLite画布快照独立关系分页、几何审计、搜索探测、定位和owner边界',async()=>{
 const file=new SQLite(':memory:'),ddl=tablesSql('sqlite')
 file.pragma('foreign_keys=OFF');file.exec(ddl.mindNodes+';'+ddl.mindMaps+';'+ddl.mindItems+';'+ddl.mindRelations)
 const owner='00000000-0000-4000-8000-000000000001',key=owner.replaceAll('-',''),other='00000000000040008000000000000002'
 const time='2026-11-15 00:00:00.000001'
 file.prepare('INSERT INTO mind_maps(id,user_id,title,data_json,created_at,updated_at) VALUES(1,?,?,?,?,?)').run(key,'画布','{"relationAnchors":{"1":{"srcSide":"left","dstSide":"right"}}}',time,time)
 const node=file.prepare("INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at,deleted_at) VALUES(?,?,'canvas_note',?,'正文','检索 条件','gugu',1,?,?,?,?)")
 for(let id=1;id<=4;id++)node.run(id,id===4?other:key,'节点'+id,time,time,time,id===3?time:null)
 const item=file.prepare("INSERT INTO mind_canvas_items(id,user_id,canvas_id,node_id,x,y,w,h,z,collapsed,data_json,created_at,updated_at,deleted_at) VALUES(?,?,1,?,?,0,NULL,NULL,?,0,'{}',?,?,?)")
 item.run(1,key,1,0,1,time,time,null);item.run(2,key,2,600,2,time,time,null)
 item.run(3,key,3,0,3,time,time,null);item.run(4,other,4,0,4,time,time,null)
 file.prepare("INSERT INTO mind_relations(id,user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key,origin,status,created_at,updated_at) VALUES(1,?,1,1,2,'related','','user','confirmed',?,?)").run(key,time,time)
 const db=new Kysely<Database>({dialect:new SqliteDialect({database:file})})
 let allowed=true
 const registry=createToolRegistry({groups:[{id:'canvas',name:'画布',tools:createCanvasReadTools(createSqlMindCanvasReader(db,'sqlite'))}],authorize:async()=>allowed})
 const scope={identity:{ownerId:owner,sessionId:'1',runId:'canvas'},roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}}
 const call=(name:string,input:unknown)=>registry.tools.dispatch({id:name,name,input},scope)
 try{
  const before=file.prepare('SELECT * FROM mind_maps').all()
  expect(await call('canvas_get',{canvas_id:1,limit:1})).toMatchObject({successful:true,value:{nodes:[{node_id:1,layout:{effective_size:{w:240,h:140}}}],pagination:{total:2,next_offset:1},truncated:true,
   relation_count:1,relation_audit_scope:'visible_nodes',relation_audit:[{status:'incomplete'}]}})
  const full=await call('canvas_get',{canvas_id:1,include_nodes:false})
  expect(full).toMatchObject({value:{relation_audit_scope:'relation_endpoints',relation_audit:[{status:'custom',recommended:{source_side:'right',target_side:'left'},source:{center:{x:120,y:70}}}]}})
  if(full.kind==='completed')expect(full.value).not.toHaveProperty('nodes')
  expect(await call('canvas_get',{canvas_id:1,include_relations:false,offset:1,include_content:true})).toMatchObject({value:{nodes:[{node_id:2,content_md:'正文'}],pagination:{next_offset:null},truncated:false}})
  expect(await call('canvas_search',{canvas_id:1,query:'检索',limit:1})).toMatchObject({value:{count:2,matches:[{node_id:2}],truncated:true}})
  expect(await call('canvas_search',{canvas_id:1,queries:['检索','不存在'],mode:'AND'})).toMatchObject({value:{count:0,matches:[]}})
  expect(await call('canvas_focus_node',{canvas_id:1,item_id:2})).toMatchObject({value:{focus_link:'gugu://focus-canvas/1/2'}})
  file.prepare('UPDATE mind_canvas_items SET deleted_at=? WHERE id=2').run(time)
  // Python search保留未过滤item墓碑的历史行为，get/focus则排除。
  expect(await call('canvas_search',{canvas_id:1})).toMatchObject({value:{count:2}})
  expect(await call('canvas_focus_node',{canvas_id:1,item_id:2})).toMatchObject({successful:false})
  expect(await call('canvas_get',{canvas_id:1,limit:0})).toMatchObject({successful:false,executed:false})
  const foreign={...scope,identity:{...scope.identity,ownerId:'00000000-0000-4000-8000-000000000002'}}
  expect(await registry.tools.dispatch({id:'foreign',name:'canvas_get',input:{canvas_id:1}},foreign)).toMatchObject({successful:false,value:{error:'画布不存在'}})
  const controller=new AbortController()
  const wrapped=db.withPlugin({transformQuery:args=>args.node,async transformResult(args){controller.abort();return args.result}})
  const cancelled=createToolRegistry({tools:createCanvasReadTools(createSqlMindCanvasReader(wrapped,'sqlite')),authorize:async()=>true})
  await expect(cancelled.tools.dispatch({id:'cancel',name:'canvas_get',input:{canvas_id:1}},{...scope,signal:controller.signal})).rejects.toThrow()
  file.prepare('UPDATE mind_maps SET data_json=? WHERE id=1').run('{"relationAnchors":[]}')
  expect(await call('canvas_get',{canvas_id:1})).toMatchObject({successful:false,value:{error:'工具执行失败'}})
  file.prepare('UPDATE mind_maps SET data_json=? WHERE id=1').run((before[0] as {data_json:string}).data_json)
  allowed=false;expect(await call('canvas_search',{canvas_id:1})).toMatchObject({successful:false,executed:false})
  expect(file.prepare('SELECT * FROM mind_maps').all()).toEqual(before)
 }finally{await db.destroy()}
})
