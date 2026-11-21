import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCalendarDeletePort, createCalendarDeleteTool, describeCalendarDeleteTargets, type CalendarDeleteConfirmationPort } from '../../../src/agent/tools/calendar.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolCall } from '../../../src/agent/models.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { DESKTOP_CALENDAR_UNDO_CONTEXT } from '../../../src/contracts/desktop.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'

let core: SqlDataRuntime, folder: string, owner: string, other: string
let published: unknown[], allowed: boolean, claims: number
const identity = () => ({ ownerId: owner, sessionId: '77', runId: 'calendar-delete' })
const call = (input: unknown, id = 'delete-call'): ToolCall => ({ id, name: 'delete_event', input })
const scope = (resolution: null | { interactionId: string; receiptId: string; status: 'confirmed'; value: unknown } = null) => ({
  identity: identity(), roundId: 'round-1', signal: new AbortController().signal, resolution,
  execute: async () => { throw new Error('不执行宿主 Shell') },
})

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-calendar-delete-'))
  await initializeSqlite(join(folder, 'core.db'))
  const opened = await openSqliteRuntime(join(folder, 'core.db'))
  core = opened.runtime; owner = opened.ownerId; other = randomUUID()
  published = []; allowed = true; claims = 0
  const key = owner.replaceAll('-', '')
  for (const [id, user, title, date] of [[1, key, '评审', '2026-12-01'], [2, key, '周报评审', '2026-12-08'], [3, other.replaceAll('-', ''), '他人活动', '2026-12-01']] as const)
    await sql`INSERT INTO calendar_events(id,user_id,title,date,time,type,version,created_at) VALUES(${id},${user},${title},${date},'09:00','event',1,'2026-11-17 00:00:00')`.execute(core.db)
  for (const [id, eventId] of [[1, 1], [2, 2]] as const)
    await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,reminder_lead_minutes,name,payload,cron,schedule_kind,start_at,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,created_at,updated_at)
      VALUES(${id},${key},${eventId},30,'活动提醒','提醒正文','@once:2026-12-01T00:00:00+00:00','once','2026-12-01 00:00:00','web',1,NULL,'[]','[]','2026-11-17 00:00:00','2026-11-17 00:00:00')`.execute(core.db)
})
afterEach(async () => { await core?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

function registry(claim = true, capture?: (targets: unknown) => void, mutate?: (tx: Parameters<CalendarDeleteConfirmationPort['claim']>[0]) => Promise<void>, undoContextId?: string) {
  let preparedDigest: string | null = null, preparedTargets: unknown = null
  const gate = {
    async prepare(toolCall: ToolCall, _scope: unknown, inputDigest: string, targets: unknown) {
      preparedDigest = inputDigest; preparedTargets = structuredClone(targets); capture?.(preparedTargets)
      return { ok: true as const, value: { id: 'interaction', kind: 'confirmation' as const, toolCall } }
    },
    async verify(_toolCall: ToolCall, _scope: unknown, inputDigest: string, targets: unknown) {
      return preparedDigest === inputDigest && JSON.stringify(preparedTargets) === JSON.stringify(targets)
        ? { ok: true as const, value: { intentId: 'intent', operationId: 'operation' } }
        : { ok: false as const, code: 'confirmation_rejected' as const }
    },
  } as unknown as CalendarDeleteConfirmationPort['gate']
  const confirmation: CalendarDeleteConfirmationPort = { gate, async claim(tx) { claims++; await mutate?.(tx); return claim } }
  const tool = createCalendarDeleteTool(createCalendarDeletePort(core, async event => { published.push(event) }, confirmation, undoContextId))
  return createToolRegistry({ tools: [tool], authorize: async () => allowed })
}

it('标题候选先冻结目标；确认后同一事务软删事件、停用提醒并记录可撤销快照', async () => {
  const tools = registry()
  await sql`INSERT INTO calendar_events(id,user_id,title,date,time,type,version,created_at) VALUES(4,${owner.replaceAll('-', '')},'评审','2026-12-15','09:00','event',1,'2026-11-17 00:00:00')`.execute(core.db)
  const input = { event: '评审', on_date: '2026-12-01' }
  expect(await tools.tools.dispatch(call({ event: '评审' }, 'ambiguous'), scope())).toMatchObject({
    kind: 'completed', successful: false, mutated: false,
    value: { error: '有多个匹配「评审」的事件，请加 on_date 指明日期或用 event_id', candidates: [
      { id: 1, title: '评审', date: '2026-12-01' }, { id: 4, title: '评审', date: '2026-12-15' },
    ] },
  })
  const waiting = await tools.tools.dispatch(call(input), scope())
  expect(waiting.kind).toBe('waiting')
  expect((await sql`SELECT deleted_at FROM calendar_events WHERE id=1`.execute(core.db)).rows[0]!.deleted_at).toBeNull()

  const confirmed = scope({ interactionId: 'interaction', receiptId: 'receipt', status: 'confirmed', value: null })
  expect(await tools.tools.dispatch(call(input), confirmed)).toMatchObject({
    kind: 'completed', successful: true, mutated: true,
    value: { success: true, deleted_event_id: 1, title: '评审', deleted_reminders: 1 },
  })
  const deleted = (await sql<{ deleted_at: string | null; version: number }>`SELECT deleted_at,version FROM calendar_events WHERE id=1`.execute(core.db)).rows[0]!
  expect(deleted.version).toBe(2); expect(deleted.deleted_at).not.toBeNull()
  expect((await sql<{ enabled: number }>`SELECT enabled FROM scheduled_tasks WHERE id=1`.execute(core.db)).rows[0]!.enabled).toBe(0)
  expect((await sql`SELECT id FROM undo_operations`.execute(core.db)).rows).toHaveLength(1)
  expect(published).toHaveLength(2)
  const replay = await tools.tools.dispatch(call(input), confirmed)
  expect(replay, JSON.stringify(replay)).toMatchObject({ kind: 'completed', successful: true, mutated: false })
  expect(claims).toBe(1)
  expect(published).toHaveLength(2)
})

it('批量目标按 ID 排序并原子提交；越权、缺失目标、未确认和撤权不产生副作用', async () => {
  let resolved: unknown
  const tools = registry(true, targets => { resolved = targets })
  const missing = await tools.tools.dispatch(call({ event_ids: [1, 999] }, 'missing'), scope())
  expect(missing).toMatchObject({ kind: 'completed', successful: false })
  expect(await tools.tools.dispatch(call({ event_id: 3 }, 'other-owner'), scope())).toMatchObject({ kind: 'completed', successful: false, value: { error: '事件不存在' } })
  expect((await sql`SELECT deleted_at FROM calendar_events WHERE user_id=${owner.replaceAll('-', '')} ORDER BY id`.execute(core.db)).rows.every(row => row.deleted_at === null)).toBe(true)
  const waiting = await tools.tools.dispatch(call({ event_ids: [2, 1] }), scope())
  expect(waiting.kind).toBe('waiting')
  expect(resolved).toMatchObject({ targetIds: { eventIds: [1, 2], reminderIds: [1, 2] } })
  expect(published).toHaveLength(0)
  const confirmed = scope({ interactionId: 'interaction', receiptId: 'receipt', status: 'confirmed', value: null })
  expect(await tools.tools.dispatch(call({ event_ids: [2, 1] }), confirmed)).toMatchObject({
    kind: 'completed', successful: true, mutated: true,
    value: { success: true, deleted_count: 2, results: [
      { deleted_event_id: 1, title: '评审', deleted_reminders: 1 },
      { deleted_event_id: 2, title: '周报评审', deleted_reminders: 1 },
    ] },
  })
  expect((await sql`SELECT deleted_at FROM calendar_events WHERE user_id=${other.replaceAll('-', '')}`.execute(core.db)).rows[0]!.deleted_at).toBeNull()
  expect((await sql`SELECT id FROM undo_operations`.execute(core.db)).rows).toHaveLength(1)
  expect(published).toHaveLength(3)
  allowed = false
  expect(await tools.tools.dispatch(call({ event_id: 3 }, 'revoked'), confirmed)).toMatchObject({ successful: false })
  expect(claims).toBe(1)
})

it('确认 claim 拒绝时事务、事件、提醒与通知全部保持未变', async () => {
  const tools = registry(false)
  const input = { event_id: 1 }
  expect((await tools.tools.dispatch(call(input), scope())).kind).toBe('waiting')
  const confirmed = scope({ interactionId: 'interaction', receiptId: 'receipt', status: 'confirmed', value: null })
  expect(await tools.tools.dispatch(call(input), confirmed)).toMatchObject({ kind: 'completed', successful: false, mutated: false })
  expect((await sql`SELECT deleted_at FROM calendar_events WHERE id=1`.execute(core.db)).rows[0]!.deleted_at).toBeNull()
  expect((await sql`SELECT enabled FROM scheduled_tasks WHERE id=1`.execute(core.db)).rows[0]!.enabled).toBe(1)
  expect((await sql`SELECT id FROM undo_operations`.execute(core.db)).rows).toHaveLength(0)
  expect(published).toHaveLength(0)
})

it('事务内 claim 期间提醒发生变化时拒绝删除并回滚 claim 副作用', async () => {
  const tools = registry(true, undefined, async tx => {
    await sql`UPDATE scheduled_tasks SET name='并发变化' WHERE id=1`.execute(tx)
  })
  const input = { event_id: 1 }
  expect((await tools.tools.dispatch(call(input), scope())).kind).toBe('waiting')
  const confirmed = scope({ interactionId: 'interaction', receiptId: 'receipt', status: 'confirmed', value: null })
  expect(await tools.tools.dispatch(call(input), confirmed)).toMatchObject({ successful: false, mutated: false,
    value: { error: '日历事件删除确认已使用或目标已变化' } })
  expect((await sql`SELECT name,enabled FROM scheduled_tasks WHERE id=1`.execute(core.db)).rows[0]).toMatchObject({ name: '活动提醒', enabled: 1 })
  expect((await sql`SELECT deleted_at FROM calendar_events WHERE id=1`.execute(core.db)).rows[0]!.deleted_at).toBeNull()
  expect((await sql`SELECT id FROM undo_operations`.execute(core.db)).rows).toHaveLength(0)
  expect(published).toHaveLength(0)
})

it('确认等待期间事件版本变化后拒绝执行', async () => {
  const tools = registry()
  const input = { event_id: 1 }
  expect((await tools.tools.dispatch(call(input), scope())).kind).toBe('waiting')
  await sql`UPDATE calendar_events SET title='并发改名',version=version+1 WHERE id=1`.execute(core.db)
  const confirmed = scope({ interactionId: 'interaction', receiptId: 'receipt', status: 'confirmed', value: null })
  expect(await tools.tools.dispatch(call(input), confirmed)).toMatchObject({ kind: 'completed', successful: false, mutated: false,
    value: { error: '日历事件删除确认无效或已过期' } })
  expect(claims).toBe(0); expect(published).toHaveLength(0)
  expect((await sql`SELECT deleted_at FROM calendar_events WHERE id=1`.execute(core.db)).rows[0]!.deleted_at).toBeNull()
  expect((await sql`SELECT id FROM undo_operations`.execute(core.db)).rows).toHaveLength(0)
})


it('桌面确认文案显示冻结的事件和提醒，目标变更后拒绝继续', async () => {
  let snapshot!: { targetsDigest: string; versionsDigest: string }
  const tools = registry(true, value => { snapshot = value as typeof snapshot })
  const input = { event_id: 1 }
  expect(await tools.tools.dispatch(call(input), scope())).toMatchObject({ kind: 'waiting' })
  await expect(describeCalendarDeleteTargets(core, owner, input, snapshot))
    .resolves.toContain('「评审」，以及 1 个关联提醒')
  await sql`UPDATE calendar_events SET version=version+1 WHERE id=1`.execute(core.db)
  await expect(describeCalendarDeleteTargets(core, owner, input, snapshot))
    .rejects.toMatchObject({ code: 'conflict' })
})


it('桌面日历能够找到聊天工具删除后的撤销记录', async () => {
  const tools = registry(true, undefined, undefined, DESKTOP_CALENDAR_UNDO_CONTEXT)
  const input = { event_id: 1 }
  await tools.tools.dispatch(call(input), scope())
  const resolution = { interactionId: 'interaction', receiptId: 'receipt', status: 'confirmed' as const, value: null }
  expect(await tools.tools.dispatch(call(input), scope(resolution))).toMatchObject({ successful: true, mutated: true })
  const records = await core.db.selectFrom('undo_operations').select('undo_context_id')
    .where('undo_context_id', '=', DESKTOP_CALENDAR_UNDO_CONTEXT).execute()
  expect(records).toHaveLength(1)
})
