import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Kysely, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createSqliteConversationSearch } from '../../../src/search/sqlite-conversations.js'
import { parseGlobalSearchQuery } from '../../../src/search/query.js'
import { isCanonicalSqliteTime } from '../../../src/data/sqlite-time-sql.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import type { Database } from '../../../src/data/schema.js'

it('正式 SQLite 会话搜索隔离 owner、保留各角色消息并在排序前校验全部时间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-conversation-search-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', ''), other = randomUUID(), stamp = '2026-01-01 00:00:00.000000'
      for (let id = 1; id <= 10; id++) {
        const user = owner, title = id === 1 ? '目标标题' : `会话${id}`
        await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at)
          VALUES (${id},${user},${title},0,'','web',1,${stamp},${stamp})`.execute(runtime.db)
      }
      for (let id = 1; id <= 10; id++) {
        const date = `2026-01-01 00:00:00.${String(id).padStart(6, '0')}`
        await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,created_at)
          VALUES (${id},${id},1,${id === 10 ? 'tool' : 'assistant'},'目标 正文',${date})`.execute(runtime.db)
      }
      const source = createSqliteConversationSearch(runtime.db), query = parseGlobalSearchQuery({ q: '目标', types: ['conversation'], per_type: '20' })
      const rows = await source.search(ownerId, query)
      expect(rows.map(row => row.id)).toEqual([1,10,9,8,7,6,5,4,3])
      expect(rows[0]).toEqual({ id: 1, title: '目标标题', subtitle: '对话' })
      expect(rows[1]).toMatchObject({ id: 10, message_id: 10, subtitle: '目标 正文' })
      expect(await source.search(other, query)).toEqual([])
      const and = parseGlobalSearchQuery({ queries: ['目标', '正文'], mode: 'AND', types: ['conversation'] })
      expect((await source.search(ownerId, and)).every(row => 'message_id' in row)).toBe(true)
      expect((await source.search(ownerId, parseGlobalSearchQuery({ q: '目_ 正%', per_type: '1' }))).map(row => row.id)).toEqual([10])
      const aborted = new AbortController(); aborted.abort()
      await expect(source.search(ownerId, query, aborted.signal)).rejects.toThrow()
      await sql`UPDATE conversation_messages SET created_at='损坏' WHERE id=2`.execute(runtime.db)
      await expect(source.search(ownerId, query)).rejects.toMatchObject({ code: 'storage_error', message: '搜索时间格式无效' })
      await sql`UPDATE conversation_messages SET created_at=${stamp} WHERE id=2`.execute(runtime.db)
      await sql`UPDATE conversation_sessions SET updated_at='2026-02-30 00:00:00.000000' WHERE id=2`.execute(runtime.db)
      await expect(source.search(ownerId, query)).rejects.toMatchObject({ code: 'storage_error', message: '搜索时间格式无效' })
    } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

const stamp = '2026-01-01 00:00:00.123456'
const query = () => parseGlobalSearchQuery({ q: '目标', per_type: '20' })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function withConversations(work: (context: { runtime: SqlDataRuntime; ownerId: string; path: string }) => Promise<void>, exclusive = false) {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-conversation-statement-')), path = join(dir, 'core.db')
  let runtime: SqlDataRuntime | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path, { exclusive }); runtime = opened.runtime
    const owner = opened.ownerId.replaceAll('-', '')
    for (const [id, title] of [[1, '目标标题'], [2, '正文会话']] as const) {
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at)
        VALUES (${id},${owner},${title},0,'','web',1,${stamp},${stamp})`.execute(runtime.db)
      await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,created_at)
        VALUES (${id},${id},1,${id === 1 ? 'user' : 'tool'},${id === 1 ? '目标旧正文' : '目标工具'},${stamp})`.execute(runtime.db)
    }
    await work({ runtime, ownerId: opened.ownerId, path })
  } finally { await runtime?.close(); await rm(dir, { recursive: true, force: true }) }
}

it.each(['UTF-8', 'UTF-16le', 'UTF-16be'])('规范时间校验在%s引擎中保留真实Gregorian与微秒边界，拒绝NUL', async encoding => {
  const native = new SQLite(':memory:')
  native.pragma(`encoding='${encoding}'`)
  const db = new Kysely<{}>({ dialect: new SqliteDialect({ database: native }) })
  const valid = [stamp, '0001-01-01 00:00:00.000000', '0099-12-31 23:59:59.000001',
    '9999-12-31 23:59:59.999999', '2000-02-29 00:00:00.000000', '2024-02-29 00:00:00.123000']
  const invalid: unknown[] = [null, 123, Buffer.from(stamp), '', '0000-01-01 00:00:00.000000',
    '1900-02-29 00:00:00.000000', '2100-02-29 00:00:00.000000', '2026-02-30 00:00:00.000000',
    '2026-04-31 00:00:00.000000', '2026-00-01 00:00:00.000000', '2026-13-01 00:00:00.000000',
    '2026-01-00 00:00:00.000000', '2026-01-32 00:00:00.000000', '2026-01-01 24:00:00.000000',
    '2026-01-01 00:60:00.000000', '2026-01-01 00:00:60.000000', '2026-01-01 00:00:00.00000',
    '2026-01-01 00:00:00.0000000', '２０２６-01-01 00:00:00.000000',
    stamp + '\0垃圾', stamp.slice(0, -1) + '\0', stamp + ' ', stamp.replace(' ', 'T'), stamp + 'Z']
  try {
    for (const value of [...valid, ...invalid]) {
      const result = await sql<{ valid: number }>`SELECT ${isCanonicalSqliteTime(sql`${value}`)} AS valid`.execute(db)
      expect(Boolean(result.rows[0]!.valid), JSON.stringify(value)).toBe(valid.includes(value as string))
    }
  } finally { await db.destroy() }
})

it('正式单owner约束拒绝foreign行，自身未命中坏时间仍失败且读取不改写原值', async () => {
  await withConversations(async ({ runtime, ownerId }) => {
    const otherId = randomUUID(), other = otherId.replaceAll('-', '')
    await expect(sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at)
      VALUES (3,${other},'其他账号',0,'','web',1,${stamp},'坏时间')`.execute(runtime.db)).rejects.toThrow('owner 不匹配')
    expect((await sql`SELECT id FROM conversation_sessions WHERE id=3`.execute(runtime.db)).rows).toEqual([])
    const source = createSqliteConversationSearch(runtime.db)
    expect((await source.search(ownerId, query())).map(row => row.id)).toEqual([1, 2])
    expect(await source.search(otherId, query())).toEqual([])
    await sql`UPDATE conversation_messages SET content='完全无关',created_at='坏时间' WHERE id=2`.execute(runtime.db)
    const before = (await sql`SELECT id,content,created_at FROM conversation_messages ORDER BY id`.execute(runtime.db)).rows
    await expect(source.search(ownerId, query())).rejects.toMatchObject({ code: 'storage_error', message: '搜索时间格式无效' })
    expect((await sql`SELECT id,content,created_at FROM conversation_messages ORDER BY id`.execute(runtime.db)).rows).toEqual(before)
  })
})

it('独立写者持保留锁时搜索可读已提交快照，不申请BEGIN IMMEDIATE写锁', async () => {
  await withConversations(async ({ runtime, ownerId, path }) => {
    await sql`PRAGMA busy_timeout=75`.execute(runtime.db)
    const writer = new SQLite(path)
    try {
      writer.exec('BEGIN IMMEDIATE')
      writer.prepare('UPDATE conversation_sessions SET title=? WHERE id=1').run('目标新标题')
      const source = createSqliteConversationSearch(runtime.db)
      expect((await source.search(ownerId, query()))[0]!.title).toBe('目标标题')
      writer.exec('COMMIT')
      expect((await source.search(ownerId, query()))[0]!.title).toBe('目标新标题')
    } finally { if (writer.inTransaction) writer.exec('ROLLBACK'); writer.close() }
  })
})

it('查询结果处理期间并发提交不混合前后快照，下一次读取可见新状态', async () => {
  await withConversations(async ({ runtime, ownerId, path }) => {
    const entered = deferred(), release = deferred()
    let first = true
    const db = runtime.db.withPlugin({ transformQuery(args) { return args.node }, async transformResult(args) {
      if (first) { first = false; entered.resolve(); await release.promise }
      return args.result
    } })
    const pending = createSqliteConversationSearch(db).search(ownerId, query())
    await entered.promise
    const writer = new SQLite(path)
    try {
      writer.exec('BEGIN IMMEDIATE')
      writer.prepare('UPDATE conversation_sessions SET title=? WHERE id=1').run('目标新标题')
      writer.prepare('UPDATE conversation_messages SET content=? WHERE id=2').run('目标新正文')
      writer.exec('COMMIT')
    } finally { if (writer.inTransaction) writer.exec('ROLLBACK'); writer.close(); release.resolve() }
    const original = await pending
    expect(original[0]!.title).toBe('目标标题')
    expect(original[1]!.subtitle).toBe('目标工具')
    const current = await createSqliteConversationSearch(runtime.db).search(ownerId, query())
    expect(current[0]!.title).toBe('目标新标题')
    expect(current[1]!.subtitle).toBe('目标新正文')
  })
})

it('运行中取消等真实结果处理清理后传播原原因，连接仍可复用', async () => {
  await withConversations(async ({ runtime, ownerId }) => {
    const entered = deferred(), release = deferred(), controller = new AbortController(), reason = new Error('合成搜索取消')
    let cleaned = false, settled = false
    const db = runtime.db.withPlugin({ transformQuery(args) { return args.node }, async transformResult(args) {
      entered.resolve(); await release.promise; cleaned = true; return args.result
    } })
    const observed = createSqliteConversationSearch(db).search(ownerId, query(), controller.signal)
      .then(() => { settled = true; return null }, error => { settled = true; return error })
    await entered.promise; controller.abort(reason); await Promise.resolve()
    expect(settled).toBe(false); expect(cleaned).toBe(false)
    release.resolve()
    expect(await observed).toBe(reason); expect(cleaned).toBe(true)
    expect((await createSqliteConversationSearch(runtime.db).search(ownerId, query()))[0]!.title).toBe('目标标题')
  })
})

it('已绑定事务句柄可直接查询而不重开事务，root连接查询等待回滚后再执行', async () => {
  await withConversations(async ({ runtime, ownerId }) => {
    await runtime.db.transaction().execute(async tx => {
      await sql`UPDATE conversation_sessions SET title='目标事务内标题' WHERE id=1`.execute(tx)
      expect((await createSqliteConversationSearch<Database>(tx).search(ownerId, query()))[0]!.title).toBe('目标事务内标题')
    })
    const entered = deferred(), release = deferred(), rollback = new Error('合成事务回滚')
    let pending!: ReturnType<ReturnType<typeof createSqliteConversationSearch>['search']>, settled = false
    const transaction = runtime.db.transaction().execute(async tx => {
      await sql`UPDATE conversation_sessions SET title='目标未提交标题' WHERE id=1`.execute(tx)
      pending = createSqliteConversationSearch(runtime.db).search(ownerId, query()).finally(() => { settled = true })
      entered.resolve(); await release.promise; throw rollback
    }).catch(error => error)
    await entered.promise; await Promise.resolve(); expect(settled).toBe(false)
    release.resolve(); expect(await transaction).toBe(rollback)
    expect((await pending)[0]!.title).toBe('目标事务内标题')
  })
})

it('桌面独占句柄内查询复用同一连接，不另开数据库句柄', async () => {
  await withConversations(async ({ runtime, ownerId, path }) => {
    const other = new SQLite(path)
    other.pragma('busy_timeout=20')
    try {
      expect(() => other.prepare('SELECT title FROM conversation_sessions').all()).toThrow()
      expect((await createSqliteConversationSearch(runtime.db).search(ownerId, query()))[0]!.title).toBe('目标标题')
    } finally { other.close() }
  }, true)
})

it('共享历史正文工具使用正式 SQLite，按 owner 和最近顺序读取且不暴露结构化消息',async()=>{
 const {createSqlAgentConversationTextReader,createSqlAgentConversationSearchSources}=await import('../../../src/agent/sessions/data.js')
 const {createConversationReadTool,createConversationSearchTool}=await import('../../../src/agent/tools/conversations.js')
 const {createToolRegistry}=await import('../../../src/agent/tools/registry.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-conversation-read-')),path=join(dir,'core.db')
 try{
  await initializeSqlite(path)
  const {runtime,ownerId}=await openSqliteRuntime(path)
  try{
   const owner=ownerId.replaceAll('-',''),stamp='2026-01-01 00:00:00.000000',other=randomUUID()
   await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (1,${owner},'原对话',0,'','web',1,${stamp},${stamp})`.execute(runtime.db)
   await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,content_json,created_at) VALUES
    (1,1,1,'user','最旧',NULL,${stamp}),(2,1,2,'assistant','早先',NULL,${stamp}),
    (3,1,3,'assistant','私有结构化','null',${stamp}),(4,1,4,'user','最近',NULL,${stamp}),
    (5,1,5,'assistant',${'😀'.repeat(1201)},NULL,${stamp})`.execute(runtime.db)
   const read=createSqlAgentConversationTextReader(runtime.db,'sqlite')
   const registry=createToolRegistry({tools:[createConversationReadTool({read:(identity,id,limit,signal)=>read(identity.ownerId,id,limit,signal)})],authorize:async()=>true})
   const identity={ownerId,sessionId:'9',runId:'run'},scope={identity,roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不可执行')}}
   const call={id:'read',name:'read_conversation',input:{session_id:1,limit:2}}
   const result=await registry.tools.dispatch(call,scope)
   expect(result).toMatchObject({successful:true,value:{session_id:1,title:'原对话',messages:[{role:'你',content:'最近'},{role:'咕咕',content:'😀'.repeat(1200)}]}})
   await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,content_json,created_at) VALUES (6,1,6,'assistant','',NULL,${stamp})`.execute(runtime.db)
   const withEmpty=await registry.tools.dispatch(call,scope)
   expect(withEmpty).toMatchObject({successful:true,value:{messages:[{role:'咕咕',content:'😀'.repeat(1200)}]}})
   const normalized=await registry.tools.dispatch({...call,input:{session_id:'#１',limit:'2'}},scope)
   expect(normalized).toMatchObject({successful:true,value:{session_id:1,messages:[{role:'咕咕',content:'😀'.repeat(1200)}],input_adaptations:['session_id:string_to_integer','limit:string_to_integer']}})
   const larger=await registry.tools.dispatch({...call,input:{session_id:1,limit:4}},scope)
   expect(larger).toMatchObject({successful:true,value:{messages:[{role:'咕咕',content:'早先'},{role:'你',content:'最近'},{role:'咕咕',content:'😀'.repeat(1200)}]}})
   const foreign=await registry.tools.dispatch(call,{...scope,identity:{...identity,ownerId:other}})
   expect(foreign).toMatchObject({successful:false,value:{error:'对话不存在或不属于你'}})
   expect(JSON.stringify(foreign)).not.toContain('私有结构化')
   const source=createSqlAgentConversationSearchSources(runtime.db,'sqlite')
   expect(await source.resolve(ownerId,{session_id:1,message_id:999})).toBe(1)
   expect(await source.resolve(other,{session_id:1,message_id:4})).toBeNull()
   expect(await source.resolve(ownerId,{message_id:4,source_id:999})).toBe(1)
   expect(await source.resolve(ownerId,{source_id:1})).toBe(1)
   expect(await source.resolve(ownerId,{source_id:'４'})).toBe(1)
   expect(await source.resolve(ownerId,{session_id:999,message_id:4})).toBeNull()
   const search=createToolRegistry({tools:[createConversationSearchTool({recent:(who,limit,signal)=>source.recent(who.ownerId,limit,signal),resolve:(who,hit,signal)=>source.resolve(who.ownerId,hit,signal),search:async()=>[{message_id:4,source_id:'4',text:'最近',role:'user'},{session_id:999,text:'不应显示'}]})],authorize:async()=>true})
   expect(await search.tools.dispatch({id:'recent',name:'search_conversations',input:{}},scope)).toMatchObject({successful:true,value:{recent:[{session_id:1,title:'原对话'}]}})
   await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (2,${owner},'更新对话',0,'','web',1,${stamp},'2026-01-01 00:00:00.000001')`.execute(runtime.db)
   expect((await source.recent(ownerId,2)).map(row=>row.session_id)).toEqual([2,1])
   expect(await search.tools.dispatch({id:'search',name:'search_conversations',input:{query:'最近'}},scope)).toMatchObject({successful:true,value:{matches:[{session_id:1,match:{role:'你',snippet:'最近'}}]}})
   const notOwned=await search.tools.dispatch({id:'search-other',name:'search_conversations',input:{query:'最近'}},{...scope,identity:{...identity,ownerId:other}})
   expect(notOwned).toMatchObject({successful:false,value:{matches:[]}})
   expect(JSON.stringify(notOwned)).not.toContain('不应显示')
   const cancelled=new AbortController();cancelled.abort();await expect(read(ownerId,1,2,cancelled.signal)).rejects.toThrow()
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})

it('历史搜索经可信端口保留旧版分词、会话去重与无法定位保护',async()=>{
 const {createConversationSearchTool}=await import('../../../src/agent/tools/conversations.js')
 const {createToolRegistry}=await import('../../../src/agent/tools/registry.js')
 const identity={ownerId:randomUUID(),sessionId:'9',runId:'run'},observed:{queries?:string[];mode?:string;limit?:number}={}
 let hits:Array<import('../../../src/agent/tools/conversations.js').ConversationSearchHit>=[
  {session_id:'1',title:'合成会话',role:'user',text:'内容一',session_updated_at:'2026-01-02T03:04:00+08:00'},
  {session_id:'1',title:'重复',text:'内容二'},{message_id:8,source_id:'8',role:'assistant',text:'历史片段'},{session_id:'99',text:'不应显示的片段'}]
 const port={recent:async()=>[{session_id:1,title:'合成',summary:'',source:'web',updated_at:'2026-01-02 03:04'}],
  search:async(_identity:typeof identity,queries:string[],mode:'OR'|'AND',limit:number)=>{observed.queries=queries;observed.mode=mode;observed.limit=limit;return hits},
  resolve:async(_identity:typeof identity,hit:typeof hits[number])=>hit.session_id==='1'?1:hit.message_id===8?2:null}
 let allowed=true
 const registry=createToolRegistry({tools:[createConversationSearchTool(port)],authorize:async()=>allowed})
 const scope={identity,roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不可执行')}}
 const call={id:'search',name:'search_conversations',input:{queries:['部署 上线','部署'],mode:'AND',limit:2}}
 const result=await registry.tools.dispatch(call,scope)
 expect(observed).toEqual({queries:['部署','上线'],mode:'AND',limit:8})
 expect(result).toMatchObject({successful:true,value:{matches:[{session_id:1,match:{role:'你',snippet:'内容一'}},{session_id:2,match:{role:'咕咕',snippet:'历史片段'}}]}})
 expect(JSON.stringify(result)).not.toContain('不应显示的片段')
 hits=[{session_id:'1',session_updated_at:'2026-02-30T03:04:00Z'},{message_id:8,session_updated_at:'2026-01-02'}]
 const dates=await registry.tools.dispatch({...call,input:{query:'时间'}},scope)
 expect(dates).toMatchObject({successful:true,value:{matches:[{session_id:1,updated_at:''},{session_id:2,updated_at:'2026-01-02 00:00'}]}})
 for(const [input,expected] of [['20260102T030405','2026-01-02 03:04'],['2026-W01-5','2026-01-02 00:00'],['2026-W01','2025-12-29 00:00'],['2026-01-02x03:04:05,123+08','2026-01-02 03:04'],['2026-01-02T03:04:05+01:02:03','2026-01-02 03:04'],['2026-01-02T03:04:05+01:99','2026-01-02 03:04'],['2026-01-02T03:04:05+01:02:60','2026-01-02 03:04'],['2026-01-02T03:04:05+00:99:99','2026-01-02 03:04'],['2026-01-02T03:04:05+23:59:60',''],['2026-01-02T03:04:05+24:00','']] as const){
  hits=[{session_id:'1',session_updated_at:input}]
  expect(await registry.tools.dispatch({...call,input:{query:'时间'}},scope)).toMatchObject({successful:true,value:{matches:[{updated_at:expected}]}})
 }
 hits=[{session_id:'99',text:'私有内容'}]
 const unresolved=await registry.tools.dispatch({...call,input:{query:'部署'}},scope)
 expect(unresolved).toMatchObject({successful:false,value:{matches:[],error:'找到历史消息片段，但无法定位所属会话，不能安全读取正文；请重试历史对话搜索。'}})
 expect(JSON.stringify(unresolved)).not.toContain('私有内容')
 const recent=await registry.tools.dispatch({...call,input:{}},scope)
 expect(recent).toMatchObject({successful:true,value:{recent:[{session_id:1}]}})
 expect(await registry.tools.dispatch({...call,input:{query:'甲',keyword:'乙'}},scope)).toMatchObject({successful:false})
 allowed=false;expect(await registry.tools.dispatch(call,scope)).toMatchObject({successful:false,executed:false})
})

it('迁入的历史 RAG 来源适配保留会话关联、分块和范围元数据',async()=>{
 const {buildSourceDocuments}=await import('../../../src/agent/rag/index-builder.js')
 const {buildDocuments}=await import('../../../src/agent/rag/adapters/base.js')
 const owner={scope_type:'owner',scope_id:''}
 const docs=buildSourceDocuments({conversations:[
  {kind:'message',id:7,session_id:3,role:'user',title:'会话',content:'😀'.repeat(1200),version_parts:[7],scope:owner},
  {kind:'message',id:8,session_id:3,role:'assistant',title:'会话',content:'',version_parts:[8],scope:owner},
  {kind:'message',id:9,session_id:3,role:'user',title:'会话',content:'私有',version_parts:[9],scope:{scope_type:'group',scope_id:''}},
 ]})
 expect(docs.length).toBeGreaterThan(1)
 expect(docs.every(doc=>doc.metadata?.session_id==='3'&&doc.metadata?.message_id==='7')).toBe(true)
 expect(docs.every(doc=>[...(doc.content??'')].length<=1000)).toBe(true)
 expect(docs.some(doc=>doc.content?.includes('私有'))).toBe(false)
 const memory=buildDocuments({source_type:'memory',id:'m',source_id:'m',title:'记忆',summary:'同一正文',content:'同一正文',document_version:'v1',scope:owner})
 expect(memory[0]?.text).toBe('记忆\n同一正文')
})

// 迁入 1.7.7 原来源适配测试，保持行为断言。
import { strict as ragAssert } from 'node:assert'
import { buildSourceDocuments } from '../../../src/agent/rag/index-builder.js'
import { buildDocuments } from '../../../src/agent/rag/adapters/base.js'
const ownerScope = { scope_type: "owner", scope_id: "owner-1" };

it("退役的文件自动索引字段不会把文件正文送入 RAG 索引", () => {
  const documents = buildSourceDocuments({
    files: [{ id: 7, title: "方案.md", content: "不应进入自动索引", scope: ownerScope }],
  } as never);
  ragAssert.deepEqual(documents, []);
});

it("画布适配器以 id 为稳定标识并保留关系引用，不把普通时间流笔记混入", () => {
  const documents = buildSourceDocuments({
    canvas: [{
      id: 21, canvas_id: 2, canvas_title: "发布规划", node_id: 9, node_title: "接口",
      node_type: "canvas_note", content: "接口说明", group_path: "后端",
      relation_summary: "连接到测试", version_parts: [21], scope: ownerScope,
    }],
    note: [{
      id: 31, title: "时间流片段", content_plain: "不应进入画布", kind: "note",
      version_parts: [31], scope: ownerScope,
    }],
  });
  const canvasDocuments = documents.filter((document) => document.source_type === "canvas");
  ragAssert.equal(canvasDocuments.length, 1);
  ragAssert.equal(canvasDocuments[0].parent_id, "canvas:21");
  ragAssert.match(canvasDocuments[0].content, /关系：连接到测试/);
  ragAssert.equal(canvasDocuments[0].metadata?.canvas_id, "2");
  ragAssert.equal(canvasDocuments[0].metadata?.node_id, "9");
  ragAssert.ok(documents.some((document) => document.source_type === "note"));
});

it("对话适配器只接受有 scope 的稳定摘要或消息切片", () => {
  const documents = buildSourceDocuments({
    conversations: [
      {
        kind: "message", id: 2, session_id: 1, role: "user", content: "保留的片段",
        title: "测试", version_parts: [2], scope: ownerScope,
      },
      {
        kind: "message", id: 3, session_id: 1, role: "assistant", content: "",
        title: "测试", version_parts: [3], scope: ownerScope,
      },
      {
        kind: "message", id: 4, session_id: 1, role: "assistant", content: "不应进入",
        title: "测试", version_parts: [4], scope: { scope_type: "", scope_id: "" },
      },
    ],
  });
  ragAssert.equal(documents.length, 1);
  ragAssert.equal(documents[0].metadata?.message_id, "2");
  ragAssert.equal(documents[0].metadata?.role, "user");
  ragAssert.equal(documents[0].metadata?.kind, "message");
});

it("summary 为正文前缀截断时不重复拼进检索文本（记忆注入去重根因）", () => {
  const [memory] = buildDocuments({
    source_type: "memory", id: "daily:0", source_id: "daily",
    title: "近期记忆", summary: "- 2026-09-14 凌晨聊了召回",
    content: "- 2026-09-14 凌晨聊了召回", version_parts: ["daily", "daily:0"],
    document_version: "v1",
    scope: ownerScope,
  });
  // 前缀守卫：summary 与正文相同（截断拷贝）则不再拼接，正文只出现一次。
  ragAssert.equal(memory.text, "近期记忆\n- 2026-09-14 凌晨聊了召回");

  const [knowledge] = buildDocuments({
    source_type: "knowledge", id: "k-1", source_id: "k-1",
    title: "部署规范", summary: "发布时需要读",
    content: "发布前必须跑完 CI 双工作流", version_parts: ["k", "1"],
    document_version: "v1",
    scope: ownerScope,
  });
  // 真实摘要（与正文无前缀关系）照常保留 title/summary/content 三段。
  ragAssert.equal(knowledge.text, "部署规范\n发布时需要读\n发布前必须跑完 CI 双工作流");
});

// 迁入 1.7.7 原缓存和来源服务测试。
import { RagSnapshotCache } from '../../../src/agent/rag/snapshot-cache.js'
import { RagIndexCacheService } from '../../../src/agent/rag/index-cache-service.js'
import { TtlCache } from '../../../src/agent/rag/ttl-cache.js'
import { TsRagService, type RagServiceEngine } from '../../../src/agent/rag/rag-service.js'
import type { RagResponse, RagSourceBatch } from '../../../src/agent/rag/contracts.js'



it('RAG snapshot cache 在相同 scope/revision 下复用并刷新访问 TTL', () => {
  let now = 0
  let builds = 0
  const cache = new RagSnapshotCache({ ttlMs: 100, now: () => now })
  const create = () => ({ build: ++builds })

  ragAssert.deepEqual(cache.getOrCreate('owner:1', 'r1', create), {
    value: { build: 1 }, hit: false, reason: 'miss',
  })
  now = 90
  ragAssert.deepEqual(cache.getOrCreate('owner:1', 'r1', create), {
    value: { build: 1 }, hit: true, reason: 'hit',
  })
  now = 200
  ragAssert.deepEqual(cache.getOrCreate('owner:1', 'r1', create), {
    value: { build: 2 }, hit: false, reason: 'expired',
  })
  ragAssert.equal(builds, 2)
})

it('RAG snapshot cache 在 revision 改变时重建且不同 scope 不共享', () => {
  let builds = 0
  const cache = new RagSnapshotCache({ now: () => 1 })
  const create = () => ++builds

  ragAssert.equal(cache.getOrCreate('owner:1', 'r1', create).value, 1)
  ragAssert.equal(cache.getOrCreate('owner:1', 'r2', create).value, 2)
  ragAssert.equal(cache.getOrCreate('owner:2', 'r2', create).value, 3)
  ragAssert.equal(cache.size(), 2)
  cache.invalidate('owner:1')
  ragAssert.equal(cache.size(), 1)
})


it("TS RAG index cache 按 revision 和 TTL 管理索引有效性", () => {
  let now = 0;
  const cache = new RagIndexCacheService({ ttlMs: 100, now: () => now });

  ragAssert.equal(cache.lookup("owner:o1", "r1").reason, "miss");
  cache.commit("owner:o1", "r1");
  now = 90;
  ragAssert.equal(cache.lookup("owner:o1", "r1").reason, "hit");
  now = 200;
  ragAssert.equal(cache.lookup("owner:o1", "r1").reason, "expired");
  cache.commit("owner:o1", "r2");
  ragAssert.equal(cache.lookup("owner:o1", "r3").reason, "revision-changed");
  ragAssert.deepEqual(cache.stats(), { entries: 1, hits: 1, misses: 3, expired: 1, revisionChanges: 1 });
});


it("TtlCache 滑动 TTL：每次命中续期，静默期满才过期", () => {
  const minute = 60_000;
  let now = 0;
  const cache = new TtlCache<string>({ ttlMs: 30 * minute, now: () => now });

  cache.set("hot", "v");
  now = 29 * minute;
  ragAssert.equal(cache.get("hot"), "v");
  // 命中已续期到 59min：58min 仍在窗口内（固定 TTL 语义下这里会被误杀）。
  now = 58 * minute;
  ragAssert.equal(cache.get("hot"), "v");
  // 上次命中后再静默 32min → 过期。
  now = 90 * minute;
  ragAssert.equal(cache.get("hot"), undefined);

  // 从未命中的条目：满 30min 即过期。
  cache.set("cold", "v");
  now = 120 * minute + 1;
  ragAssert.equal(cache.get("cold"), undefined);
});

it("TtlCache Infinity TTL 不过期，LRU 照常驱逐", () => {
  const minute = 60_000;
  let now = 0;
  const cache = new TtlCache<string>({ ttlMs: Infinity, maxEntries: 2, now: () => now });

  cache.set("a", "1");
  cache.set("b", "2");
  now = 60 * minute;
  ragAssert.equal(cache.get("a"), "1");
  cache.set("c", "3");
  ragAssert.equal(cache.get("b"), undefined);
  ragAssert.equal(cache.get("a"), "1");
  ragAssert.equal(cache.get("c"), "3");
});


function ok<T extends Record<string, unknown>>(value: T): RagResponse {
  return { status: "ok", version: "test", revision: "r1", ...value } as unknown as RagResponse;
}

it("TS RAG service 在同一 scope/revision 复用索引并把召回交给 worker", async () => {
  let loads = 0;
  const builds: string[] = [];
  const searches: string[] = [];
  const engine: RagServiceEngine = {
    async buildAndIndex(revision: string, _batch: RagSourceBatch) {
      builds.push(revision);
      return ok({ document_count: 1 });
    },
    async unifiedSearch(revision: string, query: string) {
      searches.push(`${revision}:${query}`);
      return ok({ results: [{ id: "memory:m1:0", text: "稳定记忆", source_type: "memory", scope_type: "owner", scope_id: "o1", document_version: "1" }], has_more: false, diagnostics: { candidate_count: 1 } });
    },
  };
  const service = new TsRagService(async () => {
    loads += 1;
    return { memory: [{ id: "m1", source_type: "memory", title: "记忆", content: "稳定记忆", document_version: "1", scope: { scope_type: "owner", scope_id: "o1" } }] };
  }, engine);
  const context = { scopeKey: "owner:o1", revision: "r1" };

  ragAssert.equal((await service.search(context, "记忆")).built, true);
  ragAssert.equal((await service.search(context, "稳定")).built, false);
  ragAssert.equal(loads, 1);
  ragAssert.deepEqual(builds, ["r1"]);
  ragAssert.deepEqual(searches, ["r1:记忆", "r1:稳定"]);

  ragAssert.equal((await service.search({ ...context, revision: "r2" }, "记忆")).built, true);
  ragAssert.equal(loads, 2);
  ragAssert.equal(service.size(), 1);
});

it("TS RAG service 不接受缺少 scope 或 revision 的请求", async () => {
  const engine: RagServiceEngine = {
    async buildAndIndex() { return ok({ document_count: 0 }); },
    async unifiedSearch() { return ok({ results: [], has_more: false, diagnostics: {} }); },
  };
  const service = new TsRagService(async () => ({}), engine);
  await ragAssert.rejects(() => service.search({ scopeKey: "", revision: "r1" }, "x"), /scopeKey/);
  await ragAssert.rejects(() => service.search({ scopeKey: "o1", revision: "" }, "x"), /revision/);
});

it("TS RAG service 不因相同 revision 跨租户复用可变索引", async () => {
  let loads = 0;
  const engine: RagServiceEngine = {
    async buildAndIndex() { return ok({ document_count: 1 }); },
    async unifiedSearch() { return ok({ results: [], has_more: false, diagnostics: {} }); },
  };
  const service = new TsRagService(async () => { loads += 1; return {}; }, engine);
  await service.search({ scopeKey: "owner:a", revision: "same" }, "x");
  service.invalidate();
  await ragAssert.rejects(() => service.search({ scopeKey: "owner:b", revision: "same" }, "x"), /跨 scope/);
  ragAssert.equal(loads, 1);
});

it('并发搜索不同 revision 时不会覆盖正在使用的索引',async()=>{
 let installed=''; let release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const engine:RagServiceEngine={
  async buildAndIndex(revision){installed=revision;return ok({document_count:1})},
  async unifiedSearch(revision){if(revision==='r1')await gate;ragAssert.equal(installed,revision);return ok({results:[]})},
 }
 const service=new TsRagService(async()=>({}),engine)
 const first=service.search({scopeKey:'owner:a',revision:'r1'},'a')
 const second=service.search({scopeKey:'owner:a',revision:'r2'},'b')
 release()
 await Promise.all([first,second])
})

it('索引重建失败后再次搜索旧 revision 必须重建',async()=>{
 const builds:string[]=[]
 const engine:RagServiceEngine={
  async buildAndIndex(revision){builds.push(revision);if(revision==='r2')throw new Error('构建失败');return ok({document_count:1})},
  async unifiedSearch(){return ok({results:[]})},
 }
 const service=new TsRagService(async()=>({}),engine)
 await service.search({scopeKey:'owner:a',revision:'r1'},'a')
 await ragAssert.rejects(()=>service.search({scopeKey:'owner:a',revision:'r2'},'b'),/构建失败/)
 await service.search({scopeKey:'owner:a',revision:'r1'},'a')
 ragAssert.deepEqual(builds,['r1','r2','r1'])
})

it('旧版向量按来源、chunk 和版本匹配，拒绝非有限数并传播读取错误',async()=>{
 const {readRagDocumentVectors}=await import('../../../src/agent/rag/vector-reader.js')
 const docs=[{id:'m:1',parent_id:'m',document_version:'v1',chunk_index:1,source_type:'memory'}, {id:'k:0',parent_id:'k',document_version:'v1',chunk_index:0,source_type:'knowledge'}, {id:'p:0',source_id:'pattern',metadata:{vector_key:'pattern-key'},source_type:'memory'}] as import('../../../src/agent/rag/contracts.js').RagDocument[]
 const values={memory:JSON.stringify({'rag:m:v1:1':{t:'model-v1',v:[1,2]}}),knowledge:JSON.stringify({'rag:k:v1:0':{t:'other',v:[3]}}),pattern:JSON.stringify({'pattern-key':{t:'model-v1',v:[4]}})}
 expect(await readRagDocumentVectors(docs,'model-v1',async kind=>values[kind])).toEqual({'m:1':[1,2],'p:0':[4]})
 expect(await readRagDocumentVectors(docs,'model-v1',async kind=>kind==='memory'?' {"rag:m:v1:1":{"t":"model-v1","v":[1e999]}}':null)).toEqual({})
 await expect(readRagDocumentVectors(docs,'model-v1',async()=>{throw new Error('授权失败')})).rejects.toThrow('授权失败')
 const controller=new AbortController();controller.abort()
 await expect(readRagDocumentVectors(docs,'model-v1',async()=>null,controller.signal)).rejects.toThrow()
})

it('迁入的 RAG 排序文本与来源内分数归一保留旧版行为',async()=>{
 const {rankingText}=await import('../../../src/agent/rag/ranking/document-text.js')
 const {normalizeBySource}=await import('../../../src/agent/rag/ranking/normalize.js')
 expect(rankingText({text:'展示标题\n正文',ranking_text:'正文'})).toBe('正文')
 const scores=normalizeBySource([{id:'a',source_type:'conversation',raw_score:2},{id:'b',source_type:'conversation',raw_score:4},{id:'c',source_type:'knowledge',raw_score:3}] as import('../../../src/agent/rag/contracts.js').RagRankCandidate[])
 expect([...scores]).toEqual([['a',0],['b',1],['c',0.75]])
})

it('RAG 分词器缺少可信 Host 注入时拒绝检索，装配后不可替换',async()=>{
 const {configureRagJieba,tokenizeRaw}=await import('../../../src/agent/rag/tokenizer.js')
 expect(()=>tokenizeRaw('hello')).toThrow('RAG 分词器未装配')
 const tokenizer={cut:(text:string)=>{if(text.includes('测试分词失败'))throw new Error('分词失败');return [text]}}
 configureRagJieba(tokenizer)
 expect(tokenizeRaw('release 2026')).toEqual(['release','2026','release2026'])
 expect(()=>configureRagJieba({cut:(text:string)=>[text]})).toThrow('RAG 分词器已装配')
})

it('迁入的词法索引支持版本化重建和增量更新，并隔离 owner 与 scope',async()=>{
 const {createRagLexicalIndex}=await import('../../../src/agent/rag/lexical-index.js')
 const {buildDocuments}=await import('../../../src/agent/rag/adapters/base.js')
 const ownerScope={scope_type:'owner',scope_id:''},groupScope={scope_type:'group',scope_id:'g1',platform:'qq',bot_id:'b',group_id:'g1'}
 const make=(id:string,content:string,scope:typeof ownerScope)=>buildDocuments({source_type:'conversation',id,title:'合成',content,document_version:'v1',scope})[0]!
 const first=make('1','alpha beta',ownerScope),group=make('2','alpha group',groupScope),index=createRagLexicalIndex('owner-a')
 index.replace('owner-a','r1',[first,group])
 first.text='外部修改不能影响索引'
 const found=index.search('owner-a','alpha',10,['conversation'],ownerScope)
 expect(found.results.map(item=>item.document?.source_id)).toEqual(['1'])
 expect(()=>index.search('owner-b','alpha',10,['conversation'],ownerScope)).toThrow('owner 不匹配')
 expect(()=>index.search('owner-a','alpha',10,['conversation'],{scope_type:'group'})).toThrow('范围不完整')
 expect(()=>index.patch('owner-a','wrong','r2',[],[])).toThrow('索引版本不匹配')
 const next=make('3','gamma delta',ownerScope)
 index.patch('owner-a','r1','r2',[next],[first.id])
 expect(index.search('owner-a','alpha',10,['conversation'],ownerScope).results).toEqual([])
 expect(index.search('owner-a','gamma',10,['conversation'],ownerScope).results.map(item=>item.document?.source_id)).toEqual(['3'])
 expect(index.search('owner-a','alpha',10,['conversation'],groupScope).results.map(item=>item.document?.source_id)).toEqual(['2'])
 const replacement=make('3','omega',ownerScope)
 index.patch('owner-a','r2','r3',[next,replacement],[])
 expect(index.search('owner-a','gamma',10,['conversation'],ownerScope).results).toEqual([])
 expect(index.search('owner-a','omega',10,['conversation'],ownerScope).results).toHaveLength(1)
 const invalid={...replacement,metadata:{bad:()=>0}} as unknown as typeof replacement
 expect(()=>index.replace('owner-a','r4',[invalid])).toThrow()
 expect(index.revision()).toBe('r3')
 expect(index.search('owner-a','omega',10,['conversation'],ownerScope).results).toHaveLength(1)
 const broken=make('4','测试分词失败',ownerScope)
 expect(()=>index.replace('owner-a','r4',[next,broken])).toThrow('分词失败')
 expect(()=>index.patch('owner-a','r3','r4',[broken],[replacement.id])).toThrow('分词失败')
 expect(index.revision()).toBe('r3')
 expect(index.search('owner-a','omega',10,['conversation'],ownerScope).results).toHaveLength(1)
})

it('向量融合仅处理已授权的词法候选，模型版本变更时保留词法结果',async()=>{
 const {createRagLexicalIndex}=await import('../../../src/agent/rag/lexical-index.js')
 const {buildDocuments}=await import('../../../src/agent/rag/adapters/base.js')
 const owner={scope_type:'owner',scope_id:''},group={scope_type:'group',scope_id:'g',platform:'qq',bot_id:'b',group_id:'g'}
 const make=(id:string,scope:typeof owner)=>buildDocuments({id,source_type:'memory',title:'合成',content:'alpha beta',document_version:'v1',scope})[0]!
 const first=make('1',owner),second=make('2',owner),privateDoc=make('3',group),index=createRagLexicalIndex('owner-a')
 index.replace('owner-a','r1',[first,second,privateDoc])
 const vectors=new Map([[first.id,[1,0]],[second.id,[0,1]],[privateDoc.id,[1,0]]])
 const result=index.searchHybrid('owner-a','alpha',10,['memory'],owner,{queryVector:[0,1],vectorVersion:'v1',expectedVersion:'v1',vectors})
 expect(result.fusion).toBe('hybrid-rrf');expect(result.vectorDocCount).toBe(2)
 expect(result.results.map(row=>row.id)).toEqual([second.id,first.id])
 expect(result.results.some(row=>row.id===privateDoc.id)).toBe(false)
 expect(index.searchHybrid('owner-a','alpha',10,['memory'],owner,{queryVector:[0,1],vectorVersion:'v1',expectedVersion:'v2',vectors}).fusion).toBe('bm25')
 expect(()=>index.searchHybrid('owner-b','alpha',10,['memory'],owner,{queryVector:[1],vectorVersion:'v1',expectedVersion:'v1',vectors})).toThrow('owner 不匹配')
 expect(()=>index.searchHybrid('owner-a','alpha',10,['memory'],owner,{queryVector:[NaN],vectorVersion:'v1',expectedVersion:'v1',vectors})).toThrow('向量无效')
})

it('持久 RAG 查询限制授权范围并在 embedding 中撤权时拒绝返回',async()=>{
 const {createSqlRagPersistentIndexReader}=await import('../../../src/agent/rag/persistent-index.js')
 const {createScopedRagSearch}=await import('../../../src/agent/rag/scoped-search.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-rag-scoped-')),path=join(dir,'core.db')
 try{
  await initializeSqlite(path);const {runtime,ownerId}=await openSqliteRuntime(path)
  try{
   const owner=ownerId.replaceAll('-','')
   await sql.raw('DROP TABLE knowledge_index_entries').execute(runtime.db)
   await sql.raw(`CREATE TABLE knowledge_index_entries(id INTEGER PRIMARY KEY,owner_user_id TEXT,indexed_at TEXT,deleted_at TEXT,source_type TEXT,source_id TEXT,scope_type TEXT,scope_id TEXT,platform TEXT,bot_id TEXT,group_id TEXT,document_id TEXT,parent_document_id TEXT,document_version TEXT,chunk_index INTEGER,chunk_count INTEGER,title TEXT,summary TEXT,content TEXT,metadata_json TEXT,source_updated_at TEXT)`).execute(runtime.db)
   await sql`INSERT INTO knowledge_index_entries VALUES
    (1,${owner},'2026-01-01 00:00:00.000001',NULL,'memory','daily','owner','','','','','a','a','v1',0,1,'合成','','alpha first','{}',NULL),
    (2,${owner},'2026-01-01 00:00:00.000002',NULL,'memory','daily','group','g','qq','b','g','b','b','v1',0,1,'私有','','alpha private','{}',NULL),
    (3,${owner},'2026-01-01 00:00:00.000003',NULL,'conversation','5','owner','','','','','c','c','v1',0,1,'会话','','alpha history','{"kind":"message","message_id":5}',NULL)`.execute(runtime.db)
   let authorized=true,revoke=false,cancel:AbortController|undefined
   const search=createScopedRagSearch({index:createSqlRagPersistentIndexReader(runtime.db,'sqlite'),authorize:async()=>authorized,
    vectors:{version:'model-v1',source:async()=>async kind=>kind==='memory'?JSON.stringify({'rag:a:v1:0':{t:'model-v1',v:[1,0]},'rag:b:v1:0':{t:'model-v1',v:[1,0]}}):null,
     embed:async()=>{if(revoke)authorized=false;cancel?.abort();return [1,0]}}})
   const options={sourceTypes:['memory'],limit:5},scope={scope_type:'owner',scope_id:''}
   const result=await search(ownerId,scope,'alpha',options)
   expect(result.fusion).toBe('hybrid-rrf');expect(result.results.map(row=>row.document.content)).toEqual(['alpha first'])
   expect(JSON.stringify(result)).not.toContain('private')
   expect((await search(ownerId,scope,'alpha',{sourceTypes:['conversation'],limit:5,beforeMessageId:5})).results).toEqual([])
   expect((await search(ownerId,scope,'alpha',{sourceTypes:['conversation'],limit:5,beforeMessageId:6})).results).toHaveLength(1)
   let vectorsRead=false
   const unavailableEmbedding=createScopedRagSearch({index:createSqlRagPersistentIndexReader(runtime.db,'sqlite'),authorize:async()=>true,
    vectors:{version:'model-v1',source:async()=>{vectorsRead=true;return async()=>null},embed:async()=>[]}})
   const lexicalFallback=await unavailableEmbedding(ownerId,scope,'alpha',options)
   expect(lexicalFallback.fusion).toBe('bm25');expect(lexicalFallback.results.map(row=>row.document.content)).toEqual(['alpha first'])
   expect(vectorsRead).toBe(false)
   cancel=new AbortController();await expect(search(ownerId,scope,'alpha',options,cancel.signal)).rejects.toThrow();cancel=undefined
   revoke=true;await expect(search(ownerId,scope,'alpha',options)).rejects.toThrow('授权已撤销')
   await expect(search(ownerId,scope,'alpha',options)).rejects.toThrow('未授权')
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})

it('查询 embedding 使用受控传输、限制重定向并且不泄露凭据或异常',async()=>{
 const {embedRagQuery}=await import('../../../src/agent/rag/query-embedding.js')
 const requests:Array<{url:string;headers:Readonly<Record<string,string>>;body:unknown}>=[]
 const transport={request:async(request:{url:string;headers:Readonly<Record<string,string>>;body?:unknown})=>{
  requests.push(request)
  return {status:200,headers:{},body:(async function*(){yield new TextEncoder().encode(JSON.stringify({data:[{embedding:[0.25,-0.75]}]}))})(),cancel:async()=>{}}
 }}
 const settings={provider:'openai',baseUrl:'https://embedding.example/v1',model:'synthetic-model',apiKey:'synthetic-secret',dimensions:2}
 const result=await embedRagQuery(settings,'  合成查询  ',transport,new AbortController().signal)
 expect(result).toEqual({vector:[0.25,-0.75],outcome:'success',httpStatus:200})
 expect(requests).toMatchObject([{url:'https://embedding.example/v1/embeddings',headers:{accept:'application/json','accept-encoding':'identity',authorization:'Bearer synthetic-secret'},body:{model:'synthetic-model',input:'合成查询',dimensions:2}}])
 expect(JSON.stringify(result)).not.toContain('synthetic-secret')
 const redirect=await embedRagQuery(settings,'查询',{request:async()=>({status:302,headers:{location:'https://other.example/'},body:(async function*(){})(),cancel:async()=>{}})},new AbortController().signal)
 expect(redirect).toEqual({vector:[],outcome:'http_error',httpStatus:302})
 const fail=await embedRagQuery(settings,'查询',{request:async()=>{throw new Error('synthetic-secret 私有异常')}},new AbortController().signal)
 expect(fail).toEqual({vector:[],outcome:'network_error'})
 expect(JSON.stringify(fail)).not.toContain('synthetic-secret')
 expect((await embedRagQuery({...settings,baseUrl:'https://user:password@example.invalid'},'查询',transport,new AbortController().signal)).outcome).toBe('invalid_config')
 const abort=new AbortController();abort.abort();await expect(embedRagQuery(settings,'查询',transport,abort.signal)).rejects.toThrow()
})

it('查询 embedding 保留百炼载荷并限制响应体，取消时传播原原因',async()=>{
 const {embedRagQuery}=await import('../../../src/agent/rag/query-embedding.js')
 const settings={provider:'dashscope',baseUrl:'https://embedding.example/compatible-mode/v1',model:'synthetic-model',apiKey:'synthetic-secret',dimensions:2,multimodal:true}
 let sent:unknown,cancelled=false
 const result=await embedRagQuery(settings,'合成查询',{request:async request=>{
  sent=request
  return {status:200,headers:{},body:(async function*(){yield new TextEncoder().encode(JSON.stringify({output:{embeddings:[{embedding:[1,0]}]}}))})(),cancel:async()=>{}}
 }},new AbortController().signal)
 expect(result).toEqual({vector:[1,0],outcome:'success',httpStatus:200})
 expect(sent).toMatchObject({url:'https://embedding.example/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding',body:{model:'synthetic-model',input:{contents:[{text:'合成查询'}]},parameters:{output_type:'dense',dimension:2,enable_fusion:false}}})
 const large=await embedRagQuery(settings,'合成查询',{request:async()=>({status:200,headers:{},body:(async function*(){yield new Uint8Array(2*1024*1024+1)})(),cancel:async()=>{cancelled=true}})},new AbortController().signal)
 expect(large.outcome).toBe('response_too_large');expect(cancelled).toBe(true)
 const controller=new AbortController(),reason=new Error('合成取消')
 await expect(embedRagQuery(settings,'合成查询',{request:async()=>({status:200,headers:{},body:(async function*(){controller.abort(reason);yield new Uint8Array()})(),cancel:async()=>{}})},controller.signal)).rejects.toBe(reason)
})

it('旧版持久索引读取隔离 owner、排除文件索引并用微秒游标消费墓碑',async()=>{
 const {createSqlRagPersistentIndexReader}=await import('../../../src/agent/rag/persistent-index.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-rag-persistent-')),path=join(dir,'core.db')
 try{
  await initializeSqlite(path)
  const {runtime,ownerId}=await openSqliteRuntime(path)
  try{
   const owner=ownerId.replaceAll('-',''),other=randomUUID(),foreign=other.replaceAll('-','')
   await sql.raw('DROP TABLE knowledge_index_entries').execute(runtime.db)
   await sql.raw(`CREATE TABLE knowledge_index_entries(id INTEGER PRIMARY KEY,owner_user_id TEXT,indexed_at TEXT,deleted_at TEXT,source_type TEXT,source_id TEXT,scope_type TEXT,scope_id TEXT,platform TEXT,bot_id TEXT,group_id TEXT,document_id TEXT,parent_document_id TEXT,document_version TEXT,chunk_index INTEGER,chunk_count INTEGER,title TEXT,summary TEXT,content TEXT,metadata_json TEXT,source_updated_at TEXT)`).execute(runtime.db)
   const insert=async(id:number,user:string,kind:string,time:string,deleted:string|null,content:string)=>sql`INSERT INTO knowledge_index_entries VALUES (${id},${user},${time},${deleted},${kind},${String(id)},'owner','','','','',${String(id)},${String(id)},'v1',0,1,'合成标题','',${content},'{}',NULL)`.execute(runtime.db)
   await insert(1,owner,'conversation','2026-01-01 00:00:00.000001',null,'合成正文')
   await insert(2,owner,'conversation','2026-01-01 00:00:00.000002','2026-01-01 00:00:01.000000','已删正文')
   await insert(3,owner,'conversation','2026-01-01 00:00:00.000002',null,'同一时刻')
   await insert(4,owner,'file','2026-01-01 00:00:00.999999',null,'不应索引的文件')
   await insert(5,foreign,'conversation','2026-01-01 00:00:00.999999',null,'他人正文')
   const reader=createSqlRagPersistentIndexReader(runtime.db,'sqlite'),snapshot=await reader.snapshot(ownerId)
   expect(snapshot.documents.map(row=>row.content)).toEqual(['合成正文','同一时刻'])
   expect(snapshot.watermark).toEqual({timestamp:'2026-01-01 00:00:00.000002',id:3})
   expect(snapshot.revision).toContain('conversation:2026-01-01 00:00:00.000002')
   const page=await reader.delta(ownerId,{timestamp:'2026-01-01 00:00:00.000001',id:1},1)
   expect(page).toMatchObject({upserts:[],deletes:['conversation:2:0'],cursor:{timestamp:'2026-01-01 00:00:00.000002',id:2},hasMore:true})
   const next=await reader.delta(ownerId,page.cursor,1)
   expect(next.upserts.map(row=>row.content)).toEqual(['同一时刻'])
   expect((await reader.snapshot(other)).documents.map(row=>row.content)).toEqual(['他人正文'])
   await sql`UPDATE knowledge_index_entries SET scope_type='group',scope_id='g1',platform='qq',bot_id='bot',group_id='g1' WHERE id=3`.execute(runtime.db)
   const ownerSnapshot=await reader.snapshotForScope(ownerId,{scope_type:'owner'})
   expect(ownerSnapshot.documents.map(row=>row.content)).toEqual(['合成正文'])
   expect(ownerSnapshot).toMatchObject({revision:snapshot.revision,watermark:snapshot.watermark})
   expect((await reader.snapshotForScope(ownerId,{scope_type:'member',scope_id:'m1',platform:'qq',bot_id:'bot',group_id:'g1'})).documents.map(row=>row.content)).toEqual(['同一时刻'])
   expect((await reader.snapshotForScope(ownerId,{scope_type:'group',scope_id:'g1',platform:'qq',bot_id:'bot',group_id:'g1'})).documents.map(row=>row.content)).toEqual(['同一时刻'])
   expect((await reader.snapshotForScope(ownerId,{scope_type:'group',scope_id:'g2',platform:'qq',bot_id:'bot',group_id:'g2'})).documents).toEqual([])
   await expect(reader.snapshotForScope(ownerId,{scope_type:'group'})).rejects.toThrow('范围不完整')
   const aborted=new AbortController();aborted.abort();await expect(reader.snapshot(ownerId,aborted.signal)).rejects.toThrow()
   await expect(reader.delta(ownerId,{timestamp:'invalid',id:0})).rejects.toThrow('游标无效')
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})

it('持久索引来源替换和单文档更新保留墓碑、归属与可恢复状态',async()=>{
 const {createSqlRagPersistentIndexReader}=await import('../../../src/agent/rag/persistent-index.js')
 const {createSqlRagPersistentIndexWriter}=await import('../../../src/agent/rag/persistent-writer.js')
 const {buildDocuments}=await import('../../../src/agent/rag/adapters/base.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-rag-writes-')),path=join(dir,'core.db')
 try{
  await initializeSqlite(path);const {runtime,ownerId}=await openSqliteRuntime(path)
  try{
   await sql.raw('DROP TABLE knowledge_index_entries').execute(runtime.db)
   await sql.raw(`CREATE TABLE knowledge_index_entries(id INTEGER PRIMARY KEY,owner_user_id TEXT,indexed_at TEXT,deleted_at TEXT,source_type TEXT,source_id TEXT,scope_type TEXT,scope_id TEXT,platform TEXT,bot_id TEXT,group_id TEXT,document_id TEXT,parent_document_id TEXT,document_version TEXT,chunk_index INTEGER,chunk_count INTEGER,title TEXT,summary TEXT,content TEXT,content_hash TEXT,metadata_json TEXT,source_updated_at TEXT,UNIQUE(owner_user_id,source_type,source_id,document_version,chunk_index))`).execute(runtime.db)
   const make=(id:string,text:string)=>buildDocuments({id,source_type:'conversation',title:'合成',content:text,document_version:'v1',scope:{scope_type:'owner',scope_id:''}})
   const writer=createSqlRagPersistentIndexWriter(runtime.db,'sqlite'),reader=createSqlRagPersistentIndexReader(runtime.db,'sqlite'),other=randomUUID()
   const first=make('one','alpha'),second=make('two','beta')
   // 2.0 文件正文唯一真源是授权 FS；拒绝把文件正文写进正式 DB RAG 索引。
   const fileDocument=buildDocuments({id:'relative/path.txt',source_type:'file',title:'文件',content:'不得进入数据库的文件正文',document_version:'v1',scope:{scope_type:'owner',scope_id:''}})
   await expect(writer.replaceSource(ownerId,'file',fileDocument)).rejects.toThrow('来源无效')
   await expect(writer.replaceDocument(ownerId,'file','relative/path.txt',fileDocument)).rejects.toThrow('来源无效')
   expect((await reader.snapshot(ownerId)).documents).toEqual([])
   expect(await writer.replaceSource(ownerId,'conversation',[...first,...second])).toEqual({inserted:2,updated:0,deleted:0})
   await writer.replaceSource(other,'conversation',make('other','私有'))
   const snapshot=await reader.snapshot(ownerId)
   expect(snapshot.documents.map(x=>x.content)).toEqual(['alpha','beta'])
   expect(await writer.replaceDocument(ownerId,'conversation','one',[])).toEqual({inserted:0,updated:0,deleted:1})
   const delta=await reader.delta(ownerId,snapshot.watermark)
   expect(delta.deletes).toEqual([first[0]!.id]);expect(delta.upserts).toEqual([])
   expect(await writer.replaceDocument(ownerId,'conversation','one',first)).toEqual({inserted:0,updated:1,deleted:0})
   expect((await reader.snapshot(ownerId)).documents.map(x=>x.content)).toEqual(['alpha','beta'])
   expect((await reader.snapshot(other)).documents.map(x=>x.content)).toEqual(['私有'])
   await expect(writer.replaceSource(ownerId,'conversation',[first[0]!,first[0]!])).rejects.toThrow('重复')
   await expect(writer.replaceDocument(ownerId,'conversation','two',first)).rejects.toThrow('文档无效')
   const aborted=new AbortController();aborted.abort();await expect(writer.replaceSource(ownerId,'conversation',[],aborted.signal)).rejects.toThrow()
   expect((await reader.snapshot(ownerId)).documents).toHaveLength(2)
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})

it('历史对话来源经过真实工具链搜索 baseline 前消息并隔离群聊与其他 owner',async()=>{
 const {createSqlRagConversationSource,createSqlRagConversationSearch}=await import('../../../src/agent/rag/conversation-source.js')
 const {createSqlAgentConversationSearchSources}=await import('../../../src/agent/sessions/data.js')
 const {createConversationSearchTool}=await import('../../../src/agent/tools/conversations.js')
 const {createToolRegistry}=await import('../../../src/agent/tools/registry.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-rag-history-')),path=join(dir,'core.db')
 try{
  await initializeSqlite(path);const {runtime,ownerId}=await openSqliteRuntime(path)
  try{
   const owner=ownerId.replaceAll('-',''),other=randomUUID()
   for(const [id,user,type] of [[1,owner,'private'],[2,owner,'group'],[4,owner,'private']] as const)
    await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,chat_type,context_epoch,baseline_message_seq,created_at,updated_at) VALUES (${id},${user},'合成对话',0,'','web',${type},1,5,${stamp},${stamp})`.execute(runtime.db)
   await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,created_at) VALUES
    (1,1,1,'user','旧消息 包含 100%_完成',${stamp}),(2,1,2,'assistant','新消息',${stamp}),
    (3,2,1,'user','群聊 100%_完成',${stamp}),(5,1,3,'tool','工具 100%_完成',${stamp}),
    (6,4,1,'assistant','旧消息 和额外',${stamp})`.execute(runtime.db)
   const history=createSqlRagConversationSource(runtime.db,'sqlite'),sources=createSqlAgentConversationSearchSources(runtime.db,'sqlite')
   const registry=createToolRegistry({tools:[createConversationSearchTool({recent:(who,limit,signal)=>sources.recent(who.ownerId,limit,signal),resolve:(who,hit,signal)=>sources.resolve(who.ownerId,hit,signal),search:(who,queries,mode,limit,signal)=>history(who.ownerId,{scope_type:'owner'},queries,mode,limit,signal)})],authorize:async()=>true})
   const identity={ownerId,sessionId:'1',runId:'run'},scope={identity,roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不可执行')}}
   const found=await registry.tools.dispatch({id:'search',name:'search_conversations',input:{query:'100%_完成'}},scope)
   expect(found).toMatchObject({successful:true,value:{matches:[{session_id:1,match:{role:'你',snippet:'旧消息 包含 100%_完成'}}]}})
   expect(JSON.stringify(found)).not.toContain('群聊');expect(JSON.stringify(found)).not.toContain('他人')
   expect(await history(ownerId,{scope_type:'owner'},['100XX完成'],'OR',20)).toEqual([])
   expect((await history(ownerId,{scope_type:'owner'},['旧消息','额外'],'AND',20)).map(x=>x.session_id)).toEqual([4])
   const ranked=createSqlRagConversationSearch(runtime.db,'sqlite')
   const rankedRegistry=createToolRegistry({tools:[createConversationSearchTool({recent:(who,limit,signal)=>sources.recent(who.ownerId,limit,signal),resolve:(who,hit,signal)=>sources.resolve(who.ownerId,hit,signal),search:(who,queries,mode,limit,signal)=>ranked(who.ownerId,queries,mode,limit,signal)})],authorize:async()=>true})
   const rankedResult=await rankedRegistry.tools.dispatch({id:'ranked',name:'search_conversations',input:{query:'100%_完成'}},scope)
   expect(rankedResult).toMatchObject({successful:true,value:{matches:[{session_id:1,match:{role:'你',snippet:'合成对话\n旧消息 包含 100%_完成'}}]}})
   await expect(history(ownerId,{scope_type:'group'},['旧消息'],'OR',20)).rejects.toThrow('范围无效')
   expect(await history(other,{scope_type:'owner'},['100%_完成'],'OR',20)).toEqual([])
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})

it('持久 RAG 会话来源按 Python baseline、上下文和群聊授权投影并由 Worker 实际写入',async()=>{
 const {createConversationRagSource}=await import('../../../src/agent/rag/conversation-index-source.js')
 const {createSqlRagRebuildWorker}=await import('../../../src/agent/rag/rebuild-worker.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-rag-conversation-index-')),path=join(dir,'core.db')
 try{
  await initializeSqlite(path);const {runtime,ownerId}=await openSqliteRuntime(path)
  try{
   const owner=ownerId.replaceAll('-',''),stamp='2026-01-01 00:00:00.123456'
   await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,bot_id,chat_id,chat_type,context_epoch,baseline_message_seq,created_at,updated_at)
    VALUES (31,${owner},'私聊标题',0,'摘要','web',NULL,NULL,'private',1,1,${stamp},${stamp}),
    (32,${owner},'群聊标题',0,'群摘要','qq','bot-7','group-9','group',1,0,${stamp},${stamp})`.execute(runtime.db)
   await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,created_at,sent_at) VALUES
    (301,31,1,'user','baseline 不能索引',${stamp},${stamp}),(302,31,2,'user','前序消息',${stamp},${stamp}),
    (303,31,3,'assistant','当前答案 😀',${stamp},${stamp}),(304,31,4,'tool','工具内容不入索引',${stamp},${stamp}),
    (321,32,1,'user','群内问题',${stamp},${stamp}),(322,32,2,'assistant','群内回答',${stamp},${stamp})`.execute(runtime.db)
   await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at)
    VALUES (${owner},'conversation','',NULL,'','upsert','queued',1,0,0,${stamp},${stamp},${stamp})`.execute(runtime.db)
   const source=createConversationRagSource(runtime.db,'sqlite')
   const worker=createSqlRagRebuildWorker(runtime.db,'sqlite',{conversation:source},()=>new Date('2026-02-01T00:00:00.000Z'))
   expect(await worker()).toBe('ready')
   const indexed=await sql<{source_id:string;scope_type:string;scope_id:string;platform:string;bot_id:string;group_id:string;content:string;metadata_json:string}>`
    SELECT source_id,scope_type,scope_id,platform,bot_id,group_id,content,metadata_json FROM knowledge_index_entries WHERE owner_user_id=${owner} AND deleted_at IS NULL ORDER BY source_id`.execute(runtime.db)
   expect(indexed.rows.map(row=>row.source_id)).toEqual(['302','303','31:summary','321','322','32:summary'])
   expect(indexed.rows.find(row=>row.source_id==='301')).toBeUndefined()
   expect(JSON.parse(indexed.rows.find(row=>row.source_id==='303')!.metadata_json)).toMatchObject({context_before:'user：前序消息',context_current:'assistant：当前答案 😀'})
   expect(JSON.parse(indexed.rows.find(row=>row.source_id==='302')!.metadata_json)).toMatchObject({context_after:'assistant：当前答案 😀'})
   expect(indexed.rows.find(row=>row.source_id==='322')).toMatchObject({scope_type:'group',scope_id:'group-9',platform:'qq',bot_id:'bot-7',group_id:'group-9'})
   expect(JSON.parse(indexed.rows.find(row=>row.source_id==='322')!.metadata_json)).toMatchObject({kind:'message',session_id:'32',role:'assistant',session_updated_at:'2026-01-01T00:00:00.123456'})
   expect((await source(ownerId,'303')).map(doc=>doc.source_id)).toEqual(['303'])
   expect((await source(ownerId,'31:summary')).map(doc=>doc.source_id)).toEqual(['31:summary'])
   expect(await source(randomUUID(),'303')).toEqual([])
   await expect(source(ownerId,'0')).rejects.toThrow('来源标识无效')
   const aborted=new AbortController();aborted.abort();await expect(source(ownerId,null,aborted.signal)).rejects.toThrow()
   expect((await sql<{status:string}>`SELECT status FROM rag_index_jobs WHERE source_type='conversation'`.execute(runtime.db)).rows[0]?.status).toBe('ready')
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})

it('授权知识 Markdown 来源保留 Python record 语义并由持久 Worker 写入 owner 索引',async()=>{
 const {createKnowledgeRagSource}=await import('../../../src/agent/rag/knowledge-source.js')
 const {createSqlRagRebuildWorker}=await import('../../../src/agent/rag/rebuild-worker.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-rag-knowledge-source-')),path=join(dir,'core.db')
 try{
  await initializeSqlite(path);const {runtime,ownerId}=await openSqliteRuntime(path)
  try{
   const owner=ownerId,foreign=randomUUID(),prefix=`${owner}/.agent/knowledge/entries/`
   const knowledge=(id:string,scopeOwner=owner,active='true',content='先确认健康检查，再切换到新的 Node 入口。',version=3,scopeFields:Record<string,string>={})=>new TextEncoder().encode([
    '---',`id: ${id}`,'title: 路由切换策略','topic: 发布','keywords_json: ["Node", "蓝绿部署"]',
    'description: 何时需要切换线上路由','scope_json: '+JSON.stringify({type:'owner',owner_user_id:scopeOwner,platform:'',bot_id:'',group_id:'',scope_id:'',project_id:'',...scopeFields}),
    'source_json: '+JSON.stringify({type:'user',ref:'',label:'手动记录',checked_at:null}),
    'confidence: confirmed',`version: ${version}`,'parent_id:','created_at: 2026-01-01T00:00:00.000000+00:00',
    'updated_at: 2026-02-03T04:05:06.123456+00:00',`active: ${active}`,'---',content,'',
   ].join('\n'))
   const values=new Map<string,Uint8Array>([
    [`${owner}/.agent/knowledge/.timestamps-iso-v1`,new Uint8Array()],
    [`${prefix}k-1.md`,knowledge('k-1')],
    [`${prefix}inactive.md`,knowledge('inactive',owner,'false')],
    [`${foreign}/.agent/knowledge/entries/foreign.md`,knowledge('foreign',foreign)],
    [`${prefix}ignored.txt`,knowledge('ignored')],
   ])
   const store={
    async exists(key:string){return values.has(key)},
    async list(wanted:string,cursor:string|null){return{keys:[...values.keys()].filter(key=>key.startsWith(wanted)).sort(),nextCursor:null}},
    async read(key:string){const value=values.get(key);if(!value)throw new Error('missing');return value},
   }
   const source=createKnowledgeRagSource(store)
   const docs=await source(ownerId,null)
   expect(docs).toHaveLength(1)
   expect(docs[0]).toMatchObject({source_type:'knowledge',source_id:'k-1',parent_id:'k-1',scope_type:'owner',scope_id:'',title:'路由切换策略',summary:'发布；关键词：Node、蓝绿部署；何时需要切换线上路由',content:'先确认健康检查，再切换到新的 Node 入口。',updated_at:'2026-02-03T04:05:06.123456+00:00'})
   expect(docs[0]!.document_version).toMatch(/^3:k[0-9a-f]{12}$/u)
   expect(docs[0]!.metadata).toMatchObject({topic:'发布',keywords:'Node、蓝绿部署',description:'何时需要切换线上路由',source_type:'user',source_label:'手动记录',parent_id:''})
   const next=await source(ownerId,'k-1');expect(next).toEqual(docs)
   expect(await source(ownerId,'missing')).toEqual([])
   const emptyOwner = randomUUID()
   expect(await source(emptyOwner,null)).toEqual([])
   expect(await source(emptyOwner,'missing')).toEqual([])
   await expect(source(foreign,null)).rejects.toThrow()
   const aborted=new AbortController();aborted.abort();await expect(source(ownerId,null,aborted.signal)).rejects.toThrow()
   const worker=createSqlRagRebuildWorker(runtime.db,'sqlite',{knowledge:source},()=>new Date('2026-03-01T00:00:00.000Z'))
   const stamp='2026-01-01 00:00:00.000000',dbOwner=owner.replaceAll('-','')
   await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at)
    VALUES (${dbOwner},'knowledge','',NULL,'','upsert','queued',1,0,0,${stamp},${stamp},${stamp})`.execute(runtime.db)
   expect(await worker()).toBe('ready')
   const rows=await sql<{source_id:string;summary:string;content:string;document_version:string;metadata_json:string}>`
    SELECT source_id,summary,content,document_version,metadata_json FROM knowledge_index_entries WHERE owner_user_id=${dbOwner} AND source_type='knowledge' AND deleted_at IS NULL`.execute(runtime.db)
   expect(rows.rows).toHaveLength(1)
   expect(rows.rows[0]).toMatchObject({source_id:'k-1',summary:'发布；关键词：Node、蓝绿部署；何时需要切换线上路由',content:'先确认健康检查，再切换到新的 Node 入口。'})
   expect(JSON.parse(rows.rows[0]!.metadata_json)).toMatchObject({topic:'发布',source_type:'user'})
   expect(rows.rows[0]!.document_version).toBe(docs[0]!.document_version)
   values.set(`${prefix}group-k.md`,knowledge('group-k',owner,'true','群范围知识内容',1,{type:'group',platform:'qq',bot_id:'bot-7',group_id:'group-9',scope_id:'group-9'}))
   const scopedDocs=await source(ownerId,null)
   expect(scopedDocs.find(doc=>doc.source_id==='group-k')).toMatchObject({scope_type:'group',scope_id:'group-9',platform:'qq',bot_id:'bot-7',group_id:'group-9'})
   values.delete(`${prefix}group-k.md`)
   const originalVersion=rows.rows[0]!.document_version
   values.set(`${prefix}k-1.md`,knowledge('k-1',owner,'true','新的路由切换流程先观察健康探针，再推进流量。',4))
   await sql`UPDATE rag_index_jobs SET status='queued',generation=2,completed_generation=1,next_attempt_at=${stamp},updated_at=${stamp} WHERE user_id=${dbOwner} AND source_type='knowledge'`.execute(runtime.db)
   expect(await worker()).toBe('ready')
   const updated=await sql<{content:string;document_version:string}>`SELECT content,document_version FROM knowledge_index_entries WHERE owner_user_id=${dbOwner} AND source_type='knowledge' AND deleted_at IS NULL`.execute(runtime.db)
   expect(updated.rows).toHaveLength(1)
   expect(updated.rows[0]).toMatchObject({content:'新的路由切换流程先观察健康探针，再推进流量。'})
   expect(updated.rows[0]!.document_version).not.toBe(originalVersion)
   values.set(`${prefix}k-1.md`,knowledge('k-1',owner,'false'))
   await sql`UPDATE rag_index_jobs SET status='queued',generation=3,completed_generation=2,next_attempt_at=${stamp},updated_at=${stamp} WHERE user_id=${dbOwner} AND source_type='knowledge'`.execute(runtime.db)
   expect(await worker()).toBe('ready')
   const tombstone=await sql<{deleted_at:string|null}>`SELECT deleted_at FROM knowledge_index_entries WHERE owner_user_id=${dbOwner} AND source_type='knowledge'`.execute(runtime.db)
   expect(tombstone.rows[0]?.deleted_at).not.toBeNull()
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})

it('持久重建任务消费多个来源 ID，并在新 generation 出现时阻止旧结果提交',async()=>{
 const {createSqlRagRebuildWorker}=await import('../../../src/agent/rag/rebuild-worker.js')
 const {createSqlRagPersistentIndexReader}=await import('../../../src/agent/rag/persistent-index.js')
 const {buildDocuments}=await import('../../../src/agent/rag/adapters/base.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-rag-jobs-')),path=join(dir,'core.db')
 try{
  await initializeSqlite(path);const {runtime,ownerId}=await openSqliteRuntime(path)
  try{
   await sql.raw('DROP TABLE knowledge_index_entries').execute(runtime.db)
   await sql.raw(`CREATE TABLE knowledge_index_entries(id INTEGER PRIMARY KEY,owner_user_id TEXT,indexed_at TEXT,deleted_at TEXT,source_type TEXT,source_id TEXT,scope_type TEXT,scope_id TEXT,platform TEXT,bot_id TEXT,group_id TEXT,document_id TEXT,parent_document_id TEXT,document_version TEXT,chunk_index INTEGER,chunk_count INTEGER,title TEXT,summary TEXT,content TEXT,content_hash TEXT,metadata_json TEXT,source_updated_at TEXT)`).execute(runtime.db)
   await sql.raw('CREATE TABLE fixture_sources(id TEXT PRIMARY KEY,content TEXT NOT NULL)').execute(runtime.db)
   await sql`INSERT INTO fixture_sources VALUES ('one','第一条'),('two','第二条')`.execute(runtime.db)
   const owner=ownerId.replaceAll('-',''),now='2026-01-01 00:00:00.000000'
   await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at) VALUES (${owner},'note','two','["one","two"]','','upsert','queued',1,0,0,${now},${now},${now})`.execute(runtime.db)
   let supersede=false,fail=false,wall=new Date('2026-02-01T00:00:00Z')
   const worker=createSqlRagRebuildWorker(runtime.db,'sqlite',{note:async(who,id)=>{
    expect(who).toBe(ownerId)
    if(fail)throw new Error('不应进入日志的私有异常')
    const row=(await sql<{content:string}>`SELECT content FROM fixture_sources WHERE id=${id}`.execute(runtime.db)).rows[0]
    if(supersede)await sql`UPDATE rag_index_jobs SET generation=generation+1,status='queued',lease_until=NULL,next_attempt_at=${now} WHERE source_type='note'`.execute(runtime.db)
    return row?buildDocuments({id:id!,source_type:'note',title:'合成',content:row.content,document_version:'v1',scope:{scope_type:'owner',scope_id:''}}):[]
   }},()=>wall)
   expect(await worker()).toBe('ready');expect(await worker()).toBe('ready');expect(await worker()).toBe('idle')
   const reader=createSqlRagPersistentIndexReader(runtime.db,'sqlite')
   expect((await reader.snapshot(ownerId)).documents.map(x=>x.content)).toEqual(['第一条','第二条'])
   await sql`UPDATE fixture_sources SET content='不得提交' WHERE id='one'`.execute(runtime.db)
   await sql`UPDATE rag_index_jobs SET status='queued',generation=2,pending_source_ids='["one"]',next_attempt_at=${now} WHERE source_type='note'`.execute(runtime.db)
   supersede=true;expect(await worker()).toBe('superseded')
   expect((await reader.snapshot(ownerId)).documents.map(x=>x.content)).toEqual(['第一条','第二条'])
   supersede=false;fail=true;expect(await worker()).toBe('retrying')
   const failed=(await sql<{status:string;last_error_code:string}>`SELECT status,last_error_code FROM rag_index_jobs WHERE source_type='note'`.execute(runtime.db)).rows[0]
   expect(failed).toEqual({status:'retrying',last_error_code:'index_update_failed'})
   fail=false;expect(await worker()).toBe('idle');wall=new Date(wall.getTime()+300_000)
   expect(await worker()).toBe('ready')
   expect((await reader.snapshot(ownerId)).documents.map(x=>x.content)).toEqual(['不得提交','第二条'])
   const {dataContext}=await import('../../../src/contracts/index.js')
   const {createProjectRagSource}=await import('../../../src/agent/rag/project-source.js')
   const project=await runtime.transaction(dataContext(ownerId),data=>data.projects.create({name:'上线计划',client:'小北',status:'active',progress:40}))
   const projects=createProjectRagSource(runtime)
   expect((await projects(ownerId,String(project.id)))[0]?.content).toContain('联系人：小北')
   expect(await projects(randomUUID(),String(project.id))).toEqual([])
   await sql`UPDATE projects SET stages_json='无效 JSON' WHERE id=${project.id}`.execute(runtime.db)
   expect((await projects(ownerId,String(project.id)))[0]?.content).toContain('项目：上线计划')
   await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at) VALUES (${owner},'project',${String(project.id)},${JSON.stringify([String(project.id)])},'','upsert','queued',1,0,0,${now},${now},${now})`.execute(runtime.db)
   const projectWorker=createSqlRagRebuildWorker(runtime.db,'sqlite',{project:projects},()=>wall)
   expect(await projectWorker()).toBe('ready')
   const indexed=await reader.snapshot(ownerId)
   expect(indexed.documents.find(item=>item.source_type==='project')?.content).toContain('项目：上线计划')
   await runtime.transaction(dataContext(ownerId),data=>data.projects.update(project.id,project.version,{archived:true}))
   expect(await projects(ownerId,String(project.id))).toEqual([])
   await sql`UPDATE rag_index_jobs SET status='queued',generation=generation+1,pending_source_ids=${JSON.stringify([String(project.id)])},next_attempt_at=${now} WHERE source_type='project'`.execute(runtime.db)
   expect(await projectWorker()).toBe('ready')
   expect((await reader.snapshot(ownerId)).documents.some(item=>item.source_type==='project')).toBe(false)
   expect((await reader.delta(ownerId,indexed.watermark)).deletes).toContain(`project:project:${project.id}:0`)
   await sql`UPDATE rag_index_jobs SET status='queued',generation=generation+1,pending_source_ids='{',next_attempt_at=${now} WHERE source_type='note'`.execute(runtime.db)
   expect(await worker()).toBe('retrying')
   const {createCalendarRagSource}=await import('../../../src/agent/rag/calendar-source.js')
   const {createKyselyCalendarReadPort}=await import('../../../src/calendar/read-store.js')
   await sql`INSERT INTO calendar_events(id,user_id,title,date,time,type,description,version,created_at) VALUES (1,${owner},'合成活动','2026-03-01',NULL,'meeting','活动正文',1,${now})`.execute(runtime.db)
   const calendar=createCalendarRagSource(createKyselyCalendarReadPort(runtime.db,'sqlite'))
   expect((await calendar(ownerId,'1'))[0]?.content).toContain('时间：全天')
   expect(await calendar(randomUUID(),'1')).toEqual([])
   await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at) VALUES (${owner},'calendar','1','["1"]','','upsert','queued',1,0,0,${now},${now},${now})`.execute(runtime.db)
   const calendarWorker=createSqlRagRebuildWorker(runtime.db,'sqlite',{calendar},()=>wall)
   expect(await calendarWorker()).toBe('ready')
   expect((await reader.snapshot(ownerId)).documents.find(item=>item.source_type==='calendar')?.content).toContain('活动正文')
   await sql`UPDATE calendar_events SET deleted_at=${now} WHERE id=1`.execute(runtime.db)
   await sql`UPDATE rag_index_jobs SET status='queued',generation=generation+1,pending_source_ids='["1"]',next_attempt_at=${now} WHERE source_type='calendar'`.execute(runtime.db)
   expect(await calendarWorker()).toBe('ready')
   expect((await reader.snapshot(ownerId)).documents.some(item=>item.source_type==='calendar')).toBe(false)
   const {createSqlMindNoteReader}=await import('../../../src/mind/note-read.js')
   const {createNoteRagSource}=await import('../../../src/agent/rag/note-source.js')
   await sql`INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,indexed_hash,version,captured_at,created_at,updated_at) VALUES
    (1,${owner},'note','便签标题','# 便签标题\n正文','纯文本正文','user','hash-a',1,${now},${now},${now}),
    (2,${owner},'suggestion','建议','# 建议','建议内容','user','hash-b',2,${now},${now},${now}),
    (3,${owner},'canvas_note','画布','# 画布','不应作为便签','user','hash-c',1,${now},${now},${now})`.execute(runtime.db)
   const notes=createNoteRagSource(createSqlMindNoteReader(runtime.db,'sqlite'))
   expect((await notes(ownerId,null)).map(item=>item.source_id)).toEqual(['2','1'])
   expect((await notes(ownerId,'1'))[0]?.content).toContain('纯文本正文')
   expect(await notes(randomUUID(),'1')).toEqual([])
   await sql`UPDATE rag_index_jobs SET status='queued',generation=generation+1,source_id='1',pending_source_ids='["1"]',next_attempt_at=${now} WHERE source_type='note'`.execute(runtime.db)
   const noteWorker=createSqlRagRebuildWorker(runtime.db,'sqlite',{note:notes},()=>wall)
   expect(await noteWorker()).toBe('ready')
   expect((await reader.snapshot(ownerId)).documents.find(item=>item.source_type==='note'&&item.source_id==='1')?.content).toContain('纯文本正文')
   await sql`UPDATE mind_nodes SET deleted_at=${now} WHERE id=1`.execute(runtime.db)
   await sql`UPDATE rag_index_jobs SET status='queued',generation=generation+1,pending_source_ids='["1"]',next_attempt_at=${now} WHERE source_type='note'`.execute(runtime.db)
   expect(await noteWorker()).toBe('ready')
   expect((await reader.snapshot(ownerId)).documents.some(item=>item.source_type==='note'&&item.source_id==='1')).toBe(false)
   const {createKyselyScheduledTaskRagReader}=await import('../../../src/scheduled-tasks/task-list.js')
   const {createScheduledTaskRagSource}=await import('../../../src/agent/rag/scheduled-task-source.js')
   await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,name,payload,cron,schedule_kind,channels,enabled,created_at,updated_at) VALUES
    (1,${owner},NULL,'日常任务','合成指令','0 9 * * *','cron','',1,${now},${now}),
    (2,${owner},1,'活动提醒','提醒指令','0 8 * * *','cron','',0,${now},${now})`.execute(runtime.db)
   const tasks=createScheduledTaskRagSource(createKyselyScheduledTaskRagReader(runtime.db,'sqlite'))
   expect((await tasks(ownerId,null)).map(item=>item.source_id)).toEqual(['2','1'])
   expect((await tasks(ownerId,'2'))[0]?.content).toContain('状态：停用')
   expect(await tasks(randomUUID(),'1')).toEqual([])
   await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at) VALUES (${owner},'scheduled_task','1','["1"]','','upsert','queued',1,0,0,${now},${now},${now})`.execute(runtime.db)
   const taskWorker=createSqlRagRebuildWorker(runtime.db,'sqlite',{scheduled_task:tasks},()=>wall)
   expect(await taskWorker()).toBe('ready')
   expect((await reader.snapshot(ownerId)).documents.find(item=>item.source_type==='scheduled_task')?.content).toContain('合成指令')
   await sql`DELETE FROM scheduled_tasks WHERE id=1`.execute(runtime.db)
   await sql`UPDATE rag_index_jobs SET status='queued',generation=generation+1,pending_source_ids='["1"]',next_attempt_at=${now} WHERE source_type='scheduled_task'`.execute(runtime.db)
   expect(await taskWorker()).toBe('ready')
   expect((await reader.snapshot(ownerId)).documents.some(item=>item.source_type==='scheduled_task')).toBe(false)
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})

it('画布重建复用 Mind owner 查询、分页完整读取并把来源接入正式索引写入',async()=>{
 const {createCanvasRagSource}=await import('../../../src/agent/rag/canvas-source.js')
 const {createSqlMindCanvasReader}=await import('../../../src/mind/canvas-read.js')
 const {createSqlRagRebuildWorker}=await import('../../../src/agent/rag/rebuild-worker.js')
 const {createSqlRagPersistentIndexReader}=await import('../../../src/agent/rag/persistent-index.js')
 const dir=await mkdtemp(join(tmpdir(),'gugu-rag-canvas-')),path=join(dir,'core.db')
 try{
  await initializeSqlite(path);const {runtime,ownerId}=await openSqliteRuntime(path)
  try{
   const owner=ownerId.replaceAll('-',''),other=randomUUID().replaceAll('-',''),now='2026-01-01 00:00:00.000000'
   await sql`INSERT INTO mind_maps(id,user_id,title,project_id,data_json,created_at,updated_at) VALUES
    (1,${owner},'合成画布',NULL,'{}',${now},${now}),
    (2,${other},'他人画布',NULL,'{}',${now},${now})`.execute(runtime.db)
   await sql`INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES
    (1,${owner},'canvas_note','工作计划','# Markdown 正文','纯文本正文','user',3,${now},${now},${now}),
    (2,${other},'canvas_note','私有节点','不应读取','他人私有正文','user',1,${now},${now},${now})`.execute(runtime.db)
   await sql`INSERT INTO mind_canvas_items(id,user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at) VALUES
    (10,${owner},1,1,0,0,1,0,'{"group_path":"阶段 A"}',${now},${now}),
    (20,${other},2,2,0,0,1,0,'{}',${now},${now})`.execute(runtime.db)
   const source=createCanvasRagSource(createSqlMindCanvasReader(runtime.db,'sqlite'))
   const docs=await source(ownerId,null)
   expect(docs).toHaveLength(1)
   expect(docs[0]).toMatchObject({source_type:'canvas',source_id:'10',scope_type:'owner',title:'合成画布 · 工作计划',content:'画布：合成画布\n节点：工作计划\n类型：canvas_note\n分组：阶段 A\n纯文本正文',metadata:{canvas_id:'1',node_id:'1',node_type:'canvas_note'}})
   expect(await source(ownerId,'10')).toHaveLength(1)
   expect(await source(randomUUID(),'10')).toEqual([])
   await expect(source(ownerId,'10x')).rejects.toThrow('RAG 画布来源标识无效')
   const aborted=new AbortController();aborted.abort()
   await expect(source(ownerId,null,aborted.signal)).rejects.toThrow()
   await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at)
    VALUES(${owner},'canvas','10','["10"]','','upsert','queued',1,0,0,${now},${now},${now})`.execute(runtime.db)
   const worker=createSqlRagRebuildWorker(runtime.db,'sqlite',{canvas:source},()=>new Date('2026-02-01T00:00:00Z'))
   expect(await worker()).toBe('ready')
   const index=createSqlRagPersistentIndexReader(runtime.db,'sqlite')
   expect((await index.snapshot(ownerId)).documents.map(doc=>doc.content)).toEqual([docs[0]!.content])
   await sql`UPDATE mind_canvas_items SET deleted_at=${now} WHERE id=10`.execute(runtime.db)
   await sql`UPDATE rag_index_jobs SET status='queued',generation=2,pending_source_ids='["10"]',next_attempt_at=${now} WHERE source_type='canvas'`.execute(runtime.db)
   expect(await worker()).toBe('ready')
   expect((await index.snapshot(ownerId)).documents).toEqual([])
  }finally{await runtime.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
})
