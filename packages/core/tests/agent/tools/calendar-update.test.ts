import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createCalendarEventUpdatePort, createCalendarEventUpdateTool } from '../../../src/agent/tools/calendar.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolCall } from '../../../src/agent/models.js'
import { createKyselyCalendarAgentReadPort } from '../../../src/calendar/read-store.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'

let core: SqlDataRuntime, folder: string, owner: string, published: unknown[], allowed: boolean
const now = Date.parse('2026-11-17T00:00:00.000Z')
const call = (input: unknown, id = 'update-call'): ToolCall => ({ id, name: 'update_event', input })
const scope = (ownerId = owner) => ({ identity: { ownerId, sessionId: '77', runId: 'calendar-update' }, roundId: 'round-1', signal: new AbortController().signal, resolution: null })

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-calendar-update-'))
  await initializeSqlite(join(folder, 'core.db'))
  const opened = await openSqliteRuntime(join(folder, 'core.db'))
  core = opened.runtime; owner = opened.ownerId; published = []; allowed = true
  const user = owner.replaceAll('-', '')
  for (const [id, title, date] of [[1, '评审', '2099-01-02'], [2, '周报评审', '2099-01-09']] as const)
    await sql`INSERT INTO calendar_events(id,user_id,title,date,time,type,version,created_at) VALUES(${id},${user},${title},${date},'10:00','event',1,'2026-11-17 00:00:00')`.execute(core.db)
  await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,reminder_lead_minutes,name,payload,cron,schedule_kind,start_at,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,created_at,updated_at)
    VALUES(1,${user},1,30,'评审 提醒','提醒：评审（2099-01-02 10:00）','@once:2099-01-02T01:30:00+00:00','once','2099-01-02 01:30:00','web',1,NULL,'[]','[]','2026-11-17 00:00:00','2026-11-17 00:00:00')`.execute(core.db)
  await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,reminder_lead_minutes,name,payload,cron,schedule_kind,start_at,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,created_at,updated_at)
    VALUES(2,${user},2,30,'周报评审 提醒','提醒：周报评审（2099-01-09 10:00）','@once:2099-01-09T01:30:00+00:00','once','2099-01-09 01:30:00','web',1,NULL,'[]','[]','2026-11-17 00:00:00','2026-11-17 00:00:00')`.execute(core.db)
})
afterEach(async () => { await core?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

function registry(targetPort = createKyselyCalendarAgentReadPort(core.db, 'sqlite')) {
  const port = createCalendarEventUpdatePort(core, async event => { published.push(event) }, targetPort, {
    async resolve(_identity, reminders) {
      return { ok: true, reminders: reminders.map(reminder => ({ channels: reminder.channels ?? ['web'],
        deliveryTargets: null, enabled: reminder.enabled ?? true })) }
    },
  }, () => now)
  return createToolRegistry({ tools: [createCalendarEventUpdateTool(port)], authorize: async identity => allowed && identity.ownerId === owner })
}

it('标题/日期解析后CAS更新；省略提醒时保留任务ID并随事件时间同步，重放不重复通知', async () => {
  const tools = registry()
  expect(await tools.tools.dispatch(call({ event: '评审' }, 'ambiguous'), scope())).toMatchObject({
    kind: 'completed', successful: false, value: { error: '有多个匹配「评审」的事件，请加 on_date 指明日期或用 event_id', candidates: [
      { id: 1, title: '评审', date: '2099-01-02' }, { id: 2, title: '周报评审', date: '2099-01-09' },
    ] },
  })
  const input = { event: '评审', on_date: '2099-01-02', title: '复盘', date: '2099-01-03', time: '11:00' }
  const result = await tools.tools.dispatch(call(input), scope())
  expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: true,
    value: { success: true, event_id: 1, reminders: [{ lead_minutes: 30, channels: ['web'], enabled: true }] } })
  expect((await sql<{ title: string; date: string; time: string; version: number }>`SELECT title,date,time,version FROM calendar_events WHERE id=1`.execute(core.db)).rows[0])
    .toEqual({ title: '复盘', date: '2099-01-03', time: '11:00', version: 2 })
  expect((await sql<{ id: number; cron: string; payload: string }>`SELECT id,cron,payload FROM scheduled_tasks WHERE event_id=1`.execute(core.db)).rows)
    .toEqual([{ id: 1, cron: '@once:2099-01-03T02:30:00+00:00', payload: '提醒：复盘（2099-01-03 11:00）' }])
  expect((await sql`SELECT id FROM undo_operations`.execute(core.db)).rows).toHaveLength(1)
  expect(published).toHaveLength(1)
  expect(await tools.tools.dispatch(call(input), scope())).toMatchObject({ kind: 'completed', successful: true, mutated: false,
    value: { event_id: 1, idempotent_replay: true } })
  expect(published).toHaveLength(1)
})

it('显式提醒数组整体替换、空数组清除；无字段、缺失项目和过期改期均不留部分写入', async () => {
  const tools = registry()
  const replaced = await tools.tools.dispatch(call({ event_id: 1, reminders: [{ lead_minutes: 60, channels: ['feishu'] }] }, 'replace'), scope())
  expect(replaced).toMatchObject({ successful: true, mutated: true, value: { event_id: 1, reminders: [{ lead_minutes: 60, channels: ['feishu'] }] } })
  const reminders = await sql<{ id: number; channels: string; reminder_lead_minutes: number }>`SELECT id,channels,reminder_lead_minutes FROM scheduled_tasks WHERE event_id=1`.execute(core.db)
  expect(reminders.rows).toHaveLength(1)
  expect(reminders.rows[0]).toMatchObject({ id: 3, channels: 'feishu', reminder_lead_minutes: 60 })
  expect(await tools.tools.dispatch(call({ event_id: 1 }, 'noop'), scope())).toMatchObject({ successful: false,
    value: { error: '没提供要修改的字段（title/date/time/end_time/type/project_id/description/reminders），未改动。' } })
  const before = (await sql<{ date: string; version: number }>`SELECT date,version FROM calendar_events WHERE id=1`.execute(core.db)).rows[0]
  expect(await tools.tools.dispatch(call({ event_id: 1, project_id: 987654 }, 'project'), scope())).toMatchObject({ successful: false, value: { error: '关联的项目不存在' } })
  expect(await tools.tools.dispatch(call({ event_id: 1, date: '2026-11-17', time: '08:00' }, 'past'), scope())).toMatchObject({ successful: false, mutated: false })
  expect((await sql<{ date: string; version: number }>`SELECT date,version FROM calendar_events WHERE id=1`.execute(core.db)).rows[0]).toEqual(before)
  expect(await tools.tools.dispatch(call({ event_id: 1, reminders: [] }, 'clear'), scope())).toMatchObject({ successful: true, value: { reminders: [] } })
  expect((await sql`SELECT id FROM scheduled_tasks WHERE event_id=1`.execute(core.db)).rows).toHaveLength(0)
})

it('owner隔离、schema约束和并发版本冲突都拒绝且不广播', async () => {
  const target = createKyselyCalendarAgentReadPort(core.db, 'sqlite')
  const stale = await target.getById!(owner, 1)
  await sql`UPDATE calendar_events SET version=version+1 WHERE id=1`.execute(core.db)
  const tools = registry({ ...target, async getById() { return stale } })
  expect(await tools.tools.dispatch(call({ event_id: 1, title: '越权' }, 'owner'), scope('00000000-0000-4000-8000-000000000099')))
    .toMatchObject({ successful: false, mutated: false })
  expect(await tools.tools.dispatch(call({ event_id: 1, all_day: false }, 'all-day'), scope())).toMatchObject({ successful: false })
  expect(stale?.version).toBe(1)
  expect(await tools.tools.dispatch(call({ event_id: 1, title: '并发修改' }, 'stale'), scope())).toMatchObject({ successful: false, mutated: false })
  expect((await sql`SELECT id FROM undo_operations`.execute(core.db)).rows).toHaveLength(0)
  expect(published).toHaveLength(0)
  allowed = false
  expect(await tools.tools.dispatch(call({ event_id: 1, title: '撤权' }, 'revoked'), scope())).toMatchObject({ successful: false, mutated: false })
})
