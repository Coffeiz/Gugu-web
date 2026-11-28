import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createCalendarEventCreatePort, createCalendarEventCreateTool } from '../../../src/agent/tools/calendar/index.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolCall } from '../../../src/agent/models.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'

let core: SqlDataRuntime, folder: string, owner: string, published: unknown[]
const now = Date.parse('2026-11-17T00:00:00.000Z')
const call = (input: unknown, id = 'create-call'): ToolCall => ({ id, name: 'create_event', input })
const scope = () => ({
  identity: { ownerId: owner, sessionId: '77', runId: 'calendar-create' },
  roundId: 'round-1', signal: new AbortController().signal, resolution: null,
  execute: async () => { throw new Error('不执行宿主 Shell') },
})

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-calendar-create-'))
  await initializeSqlite(join(folder, 'core.db'))
  const opened = await openSqliteRuntime(join(folder, 'core.db'))
  core = opened.runtime; owner = opened.ownerId; published = []
})
afterEach(async () => { await core?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

function registry() {
  const port = createCalendarEventCreatePort(core, async event => { published.push(event) }, {
    async resolve(_identity, reminders) {
      return { ok: true, reminders: reminders.map(reminder => ({
        channels: reminder.channels ?? ['web'],
        deliveryTargets: reminder.delivery_mode === 'current_group' ? { qq: { chat_type: 'group', chat_id: 'synthetic-group' } } : null,
        enabled: reminder.enabled ?? true,
      })) }
    },
  }, () => now)
  const tool = createCalendarEventCreateTool(port)
  return createToolRegistry({ tools: [tool], authorize: async identity => identity.ownerId === owner })
}

it('全天/定时事件保留结果形状；内联提醒同事务持久化且调用重放不重复副作用', async () => {
  const tools = registry()
  const allDay = await tools.tools.dispatch(call({ title: '截止', date: '2026-12-10', all_day: true }, 'all-day'), scope())
  expect(allDay).toMatchObject({ kind: 'completed', successful: true, mutated: true,
    value: { success: true, title: '截止', date: '2026-12-10', time: null, end_time: null, reminders: [] } })

  const input = { title: '评审', date: '2026-12-12', all_day: false, time: '10:00', end_time: '11:30', type: 'deadline', description: '检查评审事项',
    reminders: [{ lead_minutes: 30, channels: ['qq', 'web'], delivery_mode: 'current_group' }] }
  const created = await tools.tools.dispatch(call(input), scope())
  expect(created).toMatchObject({ kind: 'completed', successful: true, mutated: true,
    value: { success: true, title: '评审', date: '2026-12-12', time: '10:00', end_time: '11:30',
      reminders: [{ lead_minutes: 30, channels: ['qq', 'web'], enabled: true, delivery_mode: 'current_group' }] } })
  const eventId = (created.value as { event_id: number }).event_id
  const rows = await sql<{ user_id: string; event_id: number | null; channels: string; enabled: number; delivery_targets: string | null }>`
    SELECT user_id,event_id,channels,enabled,delivery_targets,execution_mode,payload FROM scheduled_tasks WHERE event_id=${eventId}`.execute(core.db)
  expect(rows.rows).toHaveLength(1)
  expect(rows.rows[0]).toMatchObject({ user_id: owner.replaceAll('-', ''), event_id: eventId, channels: 'qq,web', enabled: 1, execution_mode: 'reminder', payload: '提醒：评审（2026-12-12 10:00）' })
  expect(JSON.parse(rows.rows[0]!.delivery_targets ?? 'null')).toEqual({ qq: { chat_type: 'group', chat_id: 'synthetic-group' } })
  expect((await sql`SELECT id FROM undo_operations`.execute(core.db)).rows).toHaveLength(2)
  expect(published).toHaveLength(2)

  const replay = await tools.tools.dispatch(call(input), scope())
  expect(replay).toMatchObject({ kind: 'completed', successful: true, mutated: false,
    value: { event_id: eventId, idempotent_replay: true, reminders: [{ channels: ['qq', 'web'] }] } })
  expect((await sql`SELECT id FROM calendar_events`.execute(core.db)).rows).toHaveLength(2)
  expect((await sql`SELECT id FROM scheduled_tasks WHERE event_id=${eventId}`.execute(core.db)).rows).toHaveLength(1)
  expect(published).toHaveLength(2)
})

it('无效/过期提醒、重复渠道和不存在的项目失败且不创建部分数据', async () => {
  const tools = registry()
  for (const [id, input] of [
    ['past', { title: '过期提醒', date: '2026-11-17', all_day: false, time: '08:00', reminders: [{ lead_minutes: 30 }] }],
    ['duplicate-channel', { title: '重复渠道', date: '2026-12-17', all_day: false, time: '09:00', reminders: [{ lead_minutes: 30, channels: ['web', 'web'] }] }],
    ['missing-project', { title: '缺失项目', date: '2026-12-17', all_day: true, project_id: 987654 }],
  ] as const) {
    const result = await tools.tools.dispatch(call(input, id), scope())
    expect(result).toMatchObject({ kind: 'completed', successful: false, mutated: false })
    if (id === 'missing-project') expect(result.value).toMatchObject({ error: '项目不存在' })
  }
  expect((await sql`SELECT id FROM calendar_events`.execute(core.db)).rows).toHaveLength(0)
  expect((await sql`SELECT id FROM scheduled_tasks`.execute(core.db)).rows).toHaveLength(0)
  expect((await sql`SELECT id FROM undo_operations`.execute(core.db)).rows).toHaveLength(0)
  expect(published).toHaveLength(0)
})

it('另一owner不能用本工具写入；请求取消时不留下收据或事件', async () => {
  const tools = registry()
  const denied = { ...scope(), identity: { ...scope().identity, ownerId: randomUUID() } }
  expect(await tools.tools.dispatch(call({ title: '越权', date: '2026-12-17', all_day: true }, 'other'), denied))
    .toMatchObject({ successful: false, mutated: false })

  const controller = new AbortController(); controller.abort(new Error('取消'))
  await expect(tools.tools.dispatch(call({ title: '取消', date: '2026-12-17', all_day: true }, 'cancel'), {
    ...scope(), signal: controller.signal,
  })).rejects.toThrow('取消')
  expect((await sql`SELECT id FROM calendar_events`.execute(core.db)).rows).toHaveLength(0)
  expect((await sql`SELECT operation_id FROM core_operation_receipts`.execute(core.db)).rows).toHaveLength(0)
})

it('全天与定时约束在工具回执中指出要补齐或移除的时间字段', async () => {
  const tools = registry()
  const base = { title: '评审', date: '2026-12-12' }
  expect(await tools.tools.dispatch(call({ ...base, all_day: false }, 'missing-time'), scope()))
    .toMatchObject({ successful: false, value: { issues: [
      { path: 'time', rule: 'required', message: 'all_day=false 时必须提供开始时间 time。' },
    ] } })
  expect(await tools.tools.dispatch(call({ ...base, all_day: true, time: '09:00', end_time: '10:00' }, 'all-day-times'), scope()))
    .toMatchObject({ successful: false, value: { issues: [
      { path: 'end_time', rule: 'forbidden', message: 'all_day=true 时请移除 end_time。' },
      { path: 'time', rule: 'forbidden', message: 'all_day=true 时请移除 time。' },
    ] } })
})
