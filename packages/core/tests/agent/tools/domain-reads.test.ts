import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, Kysely, SqliteDialect } from 'kysely'
import Database from 'better-sqlite3'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createAgentCalendarReader } from '../../../src/calendar/application/event-read.js'
import { createKyselyCalendarAgentReadPort } from '../../../src/calendar/read-store.js'
import { createAgentWorkspaceQueries } from '../../../src/workspaces/workspace-list.js'
import { createKyselyAgentWorkspaceReader } from '../../../src/data/workspace-list.js'
import { createKyselyDashboardCounter } from '../../../src/overview.js'
import { createListEventsTool } from '../../../src/agent/tools/calendar.js'
import { createWorkspaceReadTools } from '../../../src/agent/tools/workspaces.js'
import { createDashboardStatsTool } from '../../../src/agent/tools/overview.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect, fixture } from '../run/fixtures.js'

let folder: string, core: SqlDataRuntime, owner: string, other: string, allowed: boolean
let registry: ReturnType<typeof createToolRegistry>
let workspaceDb: Kysely<any>
let counts: ReturnType<typeof createKyselyDashboardCounter>
const identity = () => ({ ownerId: owner, sessionId: '1', runId: 'reads' })
const scope = () => ({ identity: identity(), roundId: '1', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不执行宿主进程') } })
const dispatch = (name: string, input: unknown = {}) => registry.tools.dispatch({ id: name, name, input }, scope())
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-agent-domain-'))
  const filename = join(folder, 'core.db'); await initializeSqlite(filename)
  const opened = await openSqliteRuntime(filename); core = opened.runtime; owner = opened.ownerId; other = randomUUID(); allowed = true
  // 工作区/文件库暂未纳入正式SQLite schema；用显式合同表验证真实查询，不假称已安装升级器。
  await sql`CREATE TABLE files(id INTEGER PRIMARY KEY,user_id TEXT,deleted_at TEXT)`.execute(core.db)
  workspaceDb = new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) })
  await sql`CREATE TABLE projects(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT)`.execute(workspaceDb)
  await sql`CREATE TABLE folders(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT)`.execute(workspaceDb)
  await sql`CREATE TABLE workspace_directories(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT)`.execute(workspaceDb)
  await sql`CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT,kind TEXT,enabled INTEGER,is_default INTEGER,project_id INTEGER,folder_id INTEGER,directory_id INTEGER,updated_at TEXT)`.execute(workspaceDb)
  await sql`CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT,workspace_id INTEGER)`.execute(workspaceDb)
  const own = owner.replaceAll('-', ''), foreign = other.replaceAll('-', '')
  await core.transaction(dataContext(owner), async data => {
    await data.projects.create({ name: '项目甲', status: 'active' }); await data.projects.create({ name: '项目乙', status: 'done' })
    await data.projects.create({ name: '归档项目', archived: true }); await data.clients.create({ name: '联系人', notes: '' })
  })
  await core.transaction(dataContext(other), data => data.projects.create({ name: '他人项目' }))
  await sql`INSERT INTO files VALUES(1,${own},NULL),(2,${own},NULL),(3,${own},'2026-01-01'),(4,${foreign},NULL)`.execute(core.db)
  await sql`INSERT INTO projects VALUES(1,${own},'项目甲'),(4,${foreign},'他人项目')`.execute(workspaceDb)
  await sql`INSERT INTO folders VALUES(1,${own},'自有文件夹'),(2,${foreign},'他人文件夹')`.execute(workspaceDb)
  await sql`INSERT INTO workspace_directories VALUES(7,${own},'自有顶层目录')`.execute(workspaceDb)
  await sql`INSERT INTO workspaces VALUES
    (1,${own},'停用项目绑定','project',0,0,1,NULL,NULL,'2026-11-01'),
    (2,${own},'顶层目录绑定','directory',1,1,NULL,NULL,7,'2026-11-01'),
    (3,${own},'错误关联','folder',1,0,NULL,2,NULL,'2026-10-01'),
    (4,${foreign},'他人声明','folder',1,0,NULL,2,NULL,'2026-11-01')`.execute(workspaceDb)
  await sql`INSERT INTO conversation_sessions VALUES(1,${own},2),(2,${own},2),(3,${foreign},2)`.execute(workspaceDb)
  for (const [id, user, date, type, deleted] of [[1,own,'2026-11-15','event',null],[2,own,'2026-11-16','deadline',null],
    [3,foreign,'2026-11-15','event',null],[4,own,'2026-11-15','event','2026-11-01'],[5,own,'2030-01-01','event',null]] as const)
    await sql`INSERT INTO calendar_events(id,user_id,title,date,time,type,version,created_at,deleted_at) VALUES(${id},${user},${'活动'+id},${date},'09:00',${type},1,'2026-11-01',${deleted})`.execute(core.db)
  for (const [id, user, lead, start, channels, targets] of [[1,own,15,null,'web,qq','{"qq":{"chat_type":"group"}}'],
    [2,own,null,'2026-11-15 00:59:30.000000','qq',null],[3,own,null,'2026-11-15 00:58:30.000000','web',null],
    [4,own,null,'2026-11-15 00:59:29.999999','web',null],[5,foreign,99,null,'web',null]] as const)
    await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,reminder_lead_minutes,name,payload,cron,schedule_kind,start_at,channels,enabled,delivery_targets,created_at,updated_at)
      VALUES(${id},${user},1,${lead},'提醒','正文',${'@once:synthetic-'+id},'once',${start},${channels},0,${targets},'2026-11-01','2026-11-01')`.execute(core.db)
  counts = createKyselyDashboardCounter(core.db, 'sqlite')
  registry = createToolRegistry({ groups: [
    { id: 'calendar', name: '日历', tools: [createListEventsTool(createAgentCalendarReader(createKyselyCalendarAgentReadPort(core.db, 'sqlite')))] },
    { id: 'workspaces', name: '工作区', tools: createWorkspaceReadTools(createAgentWorkspaceQueries(createKyselyAgentWorkspaceReader(workspaceDb, 'sqlite'))) },
    { id: 'overview', name: '总览', tools: [createDashboardStatsTool({ counts, time: { now: () => new Date('2026-11-14T16:30:00Z'), timezone: async () => 'Asia/Shanghai' } })] },
  ], authorize: async () => allowed })
})
afterEach(async () => { await workspaceDb?.destroy(); await core?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

it('日历范围/type/limit与提醒聚合按owner隔离，保留停用提醒、QQ投递及half-even微秒边界', async () => {
  const before = await sql`SELECT * FROM scheduled_tasks ORDER BY id`.execute(core.db)
  const result = await dispatch('list_events', { from: '2026-11-15', to: '2026-11-15', type: '' })
  expect(result).toMatchObject({ successful: true, mutated: false, value: [{ id: 1, title: '活动1', reminders: [
    { lead_minutes: 15, channels: ['web','qq'], enabled: false, delivery_mode: 'current_group' },
    { lead_minutes: 0, channels: ['qq'], enabled: false, delivery_mode: 'owner_private' },
    { lead_minutes: 2 }, { lead_minutes: 1 },
  ] }] })
  expect(await dispatch('list_events', { type: 'deadline' })).toMatchObject({ value: [{ id: 2 }] })
  expect(await dispatch('list_events', { from: '2027-01-01', to: '2026-01-01' })).toMatchObject({ value: [] })
  expect(await dispatch('list_events', { limit: 0 })).toMatchObject({ value: [] })
  expect(await dispatch('list_events', { limit: '\u001c０_１ ' })).toMatchObject({ value: [{id:1}] })
  expect(await dispatch('list_events', { limit: '1__0' })).toMatchObject({successful:false})
  await sql`UPDATE calendar_events SET time='9:0' WHERE id=1`.execute(core.db)
  expect(await dispatch('list_events', {limit:1})).toMatchObject({value:[{time:'9:0',reminders:[{lead_minutes:15},{lead_minutes:0},{lead_minutes:2},{lead_minutes:1}]}]})
  expect(await dispatch('list_events', { from: 'wrong' })).toMatchObject({ successful: false })
  expect(await sql`SELECT * FROM scheduled_tasks ORDER BY id`.execute(core.db)).toEqual(before)
})

it('工作区含停用项、同时间按ID倒序，关联名称与会话计数不跨owner，ID命名空间明确', async () => {
  expect(await dispatch('list_workspaces')).toMatchObject({ value: [
    { workspace_id: 2, directory_id: 7, directory_name: '自有顶层目录', bound_session_count: 2 },
    { workspace_id: 1, enabled: false, project_name: '项目甲' },
    { workspace_id: 3, folder_name: null },
  ] })
  expect(await dispatch('get_workspace', { workspace_id: 2 })).toMatchObject({ value: { workspace_id: 2, directory_id: 7 } })
  expect(await dispatch('get_workspace', { workspace_id: 7 })).toMatchObject({ successful: false, value: { error: '工作区不存在；workspace_id 不是 directory_id、project_id 或 folder_id' } })
  expect(await dispatch('get_workspace', { workspace_id: 4 })).toMatchObject({ successful: false })
  expect(await dispatch('list_workspaces', { owner_id: other })).toMatchObject({ successful: false })
})

it('总览统计所有存活文件与无限上界未来事件，排除归档项目，不采用上下文限额', async () => {
  expect(await dispatch('get_dashboard_stats', { owner_id: other, timezone: 'UTC' })).toMatchObject({ value: {
    projects: { pending: 0, active: 1, done: 1, total: 2 }, upcoming_events: 3, files: 2, clients: 1,
    ignored_fields:['owner_id','timezone'],
  } })
})

it('撤权/组禁用/前后取消拒绝发布，缺表错误脱敏；只读工具不产生收据', async () => {
  await registry.capabilities(identity()); allowed = false
  expect(await dispatch('list_events')).toMatchObject({ successful: false, executed: false }); allowed = true
  registry.configure({ groups: { workspaces: false } })
  expect(await dispatch('list_workspaces')).toMatchObject({ successful: false, executed: false })
  const controller = new AbortController(); controller.abort()
  await expect(registry.tools.dispatch({ id:'pre',name:'get_dashboard_stats',input:{} }, { ...scope(), signal: controller.signal })).rejects.toThrow()
  const after = new AbortController(), read = counts.count.bind(counts)
  vi.spyOn(counts,'count').mockImplementationOnce(async (...args) => { const result = await read(...args); after.abort(); return result })
  await expect(registry.tools.dispatch({ id:'during',name:'get_dashboard_stats',input:{} }, { ...scope(), signal: after.signal })).rejects.toThrow()
  expect((await sql<{ n:number }>`SELECT count(*) AS n FROM core_operation_receipts`.execute(core.db)).rows[0]!.n).toBe(0)
  await sql`DROP TABLE files`.execute(core.db)
  const failed = await dispatch('get_dashboard_stats')
  expect(failed).toMatchObject({ successful:false,value:{error:'工具执行失败'} })
  expect(JSON.stringify(failed)).not.toMatch(/SELECT|no such table/)
})

it('四个工具经过实际Agent循环和SQLite，结果进入Provider续轮而不泄露外部资源', async () => {
  const calls = [{id:'events',name:'list_events',input:{type:'deadline'}},{id:'workspace',name:'get_workspace',input:{workspace_id:2}},
    {id:'all',name:'list_workspaces',input:{}},{id:'counts',name:'get_dashboard_stats',input:{}}]
  const f = fixture([[{type:'complete',text:'',calls}],[{type:'complete',text:'已读取',calls:[]}]])
  f.ports.tools=registry.tools
  f.ports.context.afterTool=async(context,_call,result)=>[...context,result.kind==='completed'?JSON.stringify(result.value):'unknown']
  expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
  const wire=vi.mocked(f.ports.provider.stream).mock.calls[1]![0].context.join('\n')
  expect(wire).toContain('自有顶层目录'); expect(wire).toContain('活动2'); expect(wire).toContain('upcoming_events')
  expect(wire).not.toContain('他人声明');expect(wire).not.toContain('他人文件夹')
})
