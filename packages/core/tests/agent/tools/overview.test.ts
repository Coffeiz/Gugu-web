import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createKyselyCalendarReadPort } from '../../../src/calendar/read-store.js'
import { createUpcomingTool } from '../../../src/agent/tools/overview.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect, fixture } from '../run/fixtures.js'

let folder: string, core: SqlDataRuntime, owner: string, other: string, allowed: boolean
let registry: ReturnType<typeof createToolRegistry>
let events: ReturnType<typeof createKyselyCalendarReadPort>
const identity = () => ({ ownerId: owner, sessionId: '1', runId: 'upcoming' })
const scope = () => ({ identity: identity(), signal: new AbortController().signal, roundId: '1', resolution: null,
  execute: async () => { throw new Error('只读工具不可执行进程') } })
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-upcoming-'))
  const filename = join(folder, 'core.db'); await initializeSqlite(filename)
  const opened = await openSqliteRuntime(filename); core = opened.runtime; owner = opened.ownerId; other = randomUUID(); allowed = true
  await core.transaction(dataContext(owner), async data => {
    await data.projects.create({ name: '范围起点', deadline: '2026-12-31', status: 'active' })
    await data.projects.create({ name: '范围终点', deadline: '2027-01-07' })
    await data.projects.create({ name: '范围之外', deadline: '2027-01-08' })
    await data.projects.create({ name: '已完成', deadline: '2027-01-01', status: 'done' })
    await data.projects.create({ name: '归档', deadline: '2027-01-01', archived: true })
    await data.projects.create({ name: '无截止' })
  })
  await core.transaction(dataContext(other), data => data.projects.create({ name: '他人项目', deadline: '2027-01-01' }))
  for (const [id, user, title, date, deleted] of [[1, owner, '起点事件', '2026-12-31', null], [2, owner, '终点事件', '2027-01-07', null],
    [3, other, '他人事件', '2027-01-01', null], [4, owner, '已删事件', '2027-01-01', '2026-12-01 00:00:00']] as const)
    await sql`INSERT INTO calendar_events(id,user_id,title,date,type,version,created_at,deleted_at) VALUES(${id},${user.replaceAll('-', '')},${title},${date},'event',1,'2026-12-01 00:00:00',${deleted})`.execute(core.db)
  events = createKyselyCalendarReadPort(core.db, 'sqlite')
  registry = createToolRegistry({ tools: [createUpcomingTool({ core, events,
    time: { now: () => new Date('2027-01-01T02:00:00Z'), timezone: async () => 'UTC-03:30' } })], authorize: async () => allowed })
})
afterEach(async () => { await core?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

it('可信时区跨年、默认7日含首尾，合并活跃项目和未删事件且不泄露owner或修改数据', async () => {
  const before = await sql`SELECT * FROM projects ORDER BY id`.execute(core.db)
  const result = await registry.tools.dispatch({ id: 'upcoming', name: 'get_upcoming', input: { owner_id: other, timezone: 'Asia/Shanghai' } }, scope())
  expect(result).toMatchObject({ successful: true, mutated: false, value: { from: '2026-12-31', to: '2027-01-07', count: 4, items: [
    { kind: 'project_deadline', date: '2026-12-31', title: '范围起点' }, { kind: 'event', title: '起点事件' },
    { kind: 'project_deadline', date: '2027-01-07', title: '范围终点' }, { kind: 'event', title: '终点事件' },
  ] } })
  expect(await sql`SELECT * FROM projects ORDER BY id`.execute(core.db)).toEqual(before)
  const foreign = await registry.tools.dispatch({ id: 'foreign', name: 'get_upcoming', input: {} }, { ...scope(), identity: { ...identity(), ownerId: other } })
  expect(foreign).toMatchObject({ value: { count: 2, items: [{ title: '他人项目' }, { title: '他人事件' }] } })
})

it('非法days、撤权和预取消拒绝，查询后取消与SQL失败保持安全结果', async () => {
  const reads = vi.spyOn(events, 'list')
  for (const days of [0, 367, 1.5, 'bad']) expect(await registry.tools.dispatch({ id: 'bad', name: 'get_upcoming', input: { days } }, scope())).toMatchObject({ successful: false })
  allowed = false
  expect(await registry.tools.dispatch({ id: 'denied', name: 'get_upcoming', input: {} }, scope())).toMatchObject({ successful: false, executed: false })
  allowed = true
  const controller = new AbortController(); controller.abort()
  await expect(registry.tools.dispatch({ id: 'cancel', name: 'get_upcoming', input: {} }, { ...scope(), signal: controller.signal })).rejects.toThrow()
  expect(reads).not.toHaveBeenCalled()
  await sql`DROP TABLE calendar_events`.execute(core.db)
  const failed = await registry.tools.dispatch({ id: 'sql', name: 'get_upcoming', input: {} }, scope())
  expect(failed).toMatchObject({ successful: false, value: { error: '工具执行失败' } })
  expect(JSON.stringify(failed)).not.toMatch(/no such table|SELECT|calendar_events/)
})

it('真实Agent循环获得聚合结果并续轮，天数接受schema既有数字字符串归一', async () => {
  const call = { id: 'upcoming', name: 'get_upcoming', input: { days: '1' } }
  const f = fixture([[{ type: 'complete', text: '', calls: [call] }], [{ type: 'complete', text: '近期安排', calls: [] }]])
  f.ports.tools = registry.tools
  f.ports.context.afterTool = async (context, _call, result) => [...context, result.kind === 'completed' ? JSON.stringify(result.value) : '未完成']
  expect((await collect(f.harness.start(identity()))).state.status).toBe('completed')
  const input = vi.mocked(f.ports.provider.stream).mock.calls[1]![0].context.join('\n')
  expect(input).toContain('范围起点'); expect(input).not.toContain('范围终点'); expect(input).not.toContain('他人')
})
