import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { ClientDeleteConfirmationPort } from '../../../src/agent/tools/clients.js'
import type { ConfirmationTargetSnapshot } from '../../../src/agent/tools/confirmation.js'
import type { ToolCall } from '../../../src/agent/models.js'
import { it,expect } from 'vitest'
import SQLite from 'better-sqlite3'
import { Kysely,SqliteDialect } from 'kysely'
import { createBuiltinSkillDefinitions } from '../../../src/agent/skills/builtin.js'
import { createSkillMetadataReader } from '../../../src/agent/skills/user-read.js'
import { createSkillManagementReadTools, createSkillDeleteTool } from '../../../src/agent/tools/skill-management.js'
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
 const defs=await createBuiltinSkillDefinitions([{name:'synthetic.md',read:async()=>{reads++;return '---\nname: Straße\ndescription: 内置摘要\ncategory: writing\nrelated_tools: [note_get]\n---\n绝不能返回的正文'}}],new AbortController().signal)
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

it('技能删除绑定目标版本，确认后与收据提交，重放不重复删除和通知', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-skill-delete-'))
  const path = join(folder, 'core.db')
  await initializeSqlite(path)
  const { runtime, ownerId } = await openSqliteRuntime(path)
  let snapshot: ConfirmationTargetSnapshot | undefined, claims = 0
  const published: string[] = []
  const confirmation: ClientDeleteConfirmationPort = {
    gate: {
      async prepare(toolCall: ToolCall, _scope: unknown, _digest: string, target: ConfirmationTargetSnapshot) {
        snapshot = target
        return { ok: true, value: { id: 'interaction', kind: 'confirmation', toolCall } }
      },
      async verify(_call: unknown, _scope: unknown, _digest: string, target: ConfirmationTargetSnapshot) {
        return target.versionsDigest === snapshot?.versionsDigest ? { ok: true, value: {} } : { ok: false }
      },
    } as unknown as ClientDeleteConfirmationPort['gate'],
    async claim() { claims++; return true },
  }
  const registry = createToolRegistry({ authorize: async () => true,
    tools: [createSkillDeleteTool(runtime, confirmation, async owner => { published.push(owner) })] })
  const call = { id: 'delete', name: 'delete_skill', input: { id: 'U1' } }
  const scope = { identity: { ownerId, runId: 'skills', sessionId: '1' }, roundId: 'skills:1',
    signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不执行进程') } }
  const resolution = { interactionId: 'interaction', receiptId: 'receipt', status: 'confirmed' as const, value: null }
  const read = async () => (await sql`SELECT id FROM user_skills ORDER BY id`.execute(runtime.db)).rows
  try {
    await sql`INSERT INTO user_skills(id,owner_id,skill_id,name,description_short,category,body,related_tools,
      source,managed_by,enabled,content_digest,created_at,updated_at) VALUES
      (1,${ownerId.replaceAll('-', '')},'U1','小北的技能','简述','personal','正文','[]','user','assistant',1,'v1','2026-01-01','2026-01-01'),
      (2,'other','U1','他人技能','简述','personal','正文','[]','user','user',1,'v1','2026-01-01','2026-01-01')`.execute(runtime.db)
    expect(await registry.tools.dispatch(call, scope)).toMatchObject({ kind: 'waiting' })
    expect(await read()).toEqual([{ id: 1 }, { id: 2 }])
    await sql`UPDATE user_skills SET body='修改正文' WHERE id=1`.execute(runtime.db)
    expect(await registry.tools.dispatch(call, { ...scope, resolution })).toMatchObject({ successful: false })
    expect(claims).toBe(0)
    expect(await registry.tools.dispatch(call, scope)).toMatchObject({ kind: 'waiting' })
    expect(await registry.tools.dispatch(call, { ...scope, resolution })).toMatchObject({ successful: true, mutated: true, value: { success: true, id: 'U1' } })
    expect(await registry.tools.dispatch(call, { ...scope, resolution })).toMatchObject({ successful: true, mutated: false })
    expect(await read()).toEqual([{ id: 2 }])
    expect(published).toEqual([ownerId])
    expect(claims).toBe(1)
  } finally {
    await runtime.close()
    await rm(folder, { recursive: true, force: true })
  }
})
