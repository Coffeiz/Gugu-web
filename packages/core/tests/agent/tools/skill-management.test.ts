import { it,expect } from 'vitest'
import SQLite from 'better-sqlite3'
import { Kysely,SqliteDialect } from 'kysely'
import { createBuiltinSkillDefinitions } from '../../../src/agent/skills/builtin.js'
import { createSkillMetadataReader } from '../../../src/agent/skills/user-read.js'
import { createSkillManagementReadTools, createSkillManagementWriteTools, type SkillManagementOperations } from '../../../src/agent/tools/skill-management.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

it('Markdown head和真实用户目录共同列出元数据，包含停用项但不泄漏正文/跨owner',async()=>{
 const file=new SQLite(':memory:'),db=new Kysely<Record<string,never>>({dialect:new SqliteDialect({database:file})})
 const owner='00000000-0000-4000-8000-000000000001',other='00000000000040008000000000000002'
 // 故意不建立body/content_digest列：只读元数据不能依赖或加载正文。
 file.exec('CREATE TABLE user_skills(owner_id TEXT,skill_id TEXT,name TEXT,description_short TEXT,category TEXT,related_tools TEXT,managed_by TEXT,enabled INTEGER,source TEXT)')
 const insert=file.prepare('INSERT INTO user_skills VALUES(?,?,?,?,?,?,?,?,?)')
 insert.run(owner.replaceAll('-',''),'U1','STRASSE','用户摘要','personal','["note_get"]',null,0,'user')
 insert.run(other,'U2','其他账号','隐私','personal','[]','user',1,'user')
 insert.run(owner.replaceAll('-',''),'U3','非用户源','不返回','personal','[]','user',1,'builtin')
 let reads=0,allowed=true
 const defs=await createBuiltinSkillDefinitions([{name:'synthetic.md',read:async()=>{reads++;return '---\nid: S1\nname: Straße\ndescription_short: 内置摘要\ncategory: writing\nrelated_tools: [note_get]\n---\n绝不能返回的正文'}}],new AbortController().signal)
 const list=createSkillMetadataReader(db,'sqlite',defs)
 const registry=createToolRegistry({groups:[{id:'skill_management',name:'技能管理',tools:createSkillManagementReadTools(list)}],authorize:async()=>allowed})
 const scope={identity:{ownerId:owner,sessionId:'1',runId:'skills'},roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}}
 const call={id:'list',name:'list_skills',input:{}}
 try{
  const result=await registry.tools.dispatch(call,scope)
  expect(result).toMatchObject({successful:true,mutated:false,value:{count:2,skills:[{id:'S1',source:'builtin',enabled:true},{id:'U1',source:'user',enabled:false,managed_by:'user',related_tools:['note_get']}]}})
  expect(JSON.stringify(result)).not.toContain('绝不能返回的正文');expect(JSON.stringify(result)).not.toContain('content_digest');expect(reads).toBe(1)
  allowed=false;expect(await registry.tools.dispatch(call,scope)).toMatchObject({successful:false,executed:false})
  allowed=true
  const controller=new AbortController(),wrapped=db.withPlugin({transformQuery:args=>args.node,async transformResult(args){controller.abort();return args.result}})
  const cancelled=createToolRegistry({tools:createSkillManagementReadTools(createSkillMetadataReader(wrapped,'sqlite',defs)),authorize:async()=>true})
  await expect(cancelled.tools.dispatch(call,{...scope,signal:controller.signal})).rejects.toThrow()
  file.exec('DROP TABLE user_skills')
  expect(await registry.tools.dispatch(call,scope)).toMatchObject({successful:false,value:{error:'工具执行失败'}})
 }finally{await db.destroy()}
})

it('Skill管理工具按Python契约创建和局部更新当前owner技能',async()=>{
 const calls:unknown[]=[]
 const operations:SkillManagementOperations={
  async create(owner,input){calls.push(['create',owner,input]);return {id:'U1',name:input.name,description_short:input.description_short,related_tools:input.related_tools,enabled:true,managed_by:input.managed_by??'user',content_digest:'digest'}},
  async update(owner,id,input){calls.push(['update',owner,id,input]);return {id,name:'夜间复盘',description_short:'整理当天事项',related_tools:[],enabled:false,managed_by:'assistant',content_digest:'new-digest'}},
 }
 const tools=createSkillManagementWriteTools(operations)
 const registry=createToolRegistry({groups:[{id:'skill_management',name:'技能管理',tools}],authorize:async()=>true})
 const scope={identity:{ownerId:'00000000-0000-4000-8000-000000000001',sessionId:'1',runId:'skills'},roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}}
 const created=await registry.tools.dispatch({id:'create',name:'create_skill',input:{skill_name:'夜间复盘',description_short:'整理当天事项',body:'先总结完成项，再列阻塞和下一步。',related_tools:[],managed_by:'assistant'}},scope)
 expect(created).toMatchObject({kind:'completed',successful:true,mutated:true,value:{success:true,skill:{id:'U1',managed_by:'assistant'},message:'已创建这个咕咕技能，后续会在需要时按需加载。'}})
 expect(calls[0]).toEqual(['create',scope.identity.ownerId,{name:'夜间复盘',description_short:'整理当天事项',description_long:null,category:'personal',body:'先总结完成项，再列阻塞和下一步。',related_tools:[],managed_by:'assistant'}])
 const updated=await registry.tools.dispatch({id:'update',name:'update_skill',input:{id:'U1',enabled:false}},scope)
 expect(updated).toMatchObject({kind:'completed',successful:true,mutated:true,value:{success:true,skill:{id:'U1',enabled:false,content_digest:'new-digest'},message:'已更新这个咕咕技能。'}})
 expect(calls[1]).toEqual(['update',scope.identity.ownerId,'U1',{enabled:false}])
 expect(await registry.tools.dispatch({id:'bad',name:'create_skill',input:{skill_name:'x'}},scope)).toMatchObject({successful:false,executed:false})
})
