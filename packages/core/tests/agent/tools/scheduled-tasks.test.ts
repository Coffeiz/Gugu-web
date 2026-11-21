import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, type Transaction } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '../../../src/scheduled-tasks/task-list.js'
import { createListScheduledTasksTool, createScheduledTaskWriteTools } from '../../../src/agent/tools/scheduled-tasks.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { normalizeSchedule, scheduleTimestamp } from '../../../src/scheduled-tasks/normalize-schedule.js'
import type { ScheduledTaskCreateInput, ScheduledTaskPatch } from '../../../src/scheduled-tasks/task-write.js'

it('真实注册器经正式SQLite只读定时任务，隔离owner和提醒并在撤权、取消时拒绝', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-agent-scheduled-'))
  const path = join(folder, 'core.db')
  await initializeSqlite(path)
  const { runtime, ownerId } = await openSqliteRuntime(path)
  try {
    const owner = ownerId.replaceAll('-', ''), other = randomUUID()
    for (const [id, event, kind, enabled] of [[1, null, 'cron', 1], [2, 7, 'once', 1], [3, null, 'interval', 0]] as const)
      await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,name,payload,cron,schedule_kind,interval_minutes,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,created_at,updated_at)
        VALUES(${id},${owner},${event},'合成任务','指令','0 9 * * *',${kind},10,'web,qq',${enabled},'{"qq":"private"}','["send_email"]','[5]','2026-01-01 00:00:00','2026-01-01 00:00:00')`.execute(runtime.db)
    const query = createScheduledTaskQueries(createKyselyScheduledTaskReader(runtime.db, 'sqlite'), () => ({ workspaceSupported: false, filesystemAuthorizationEnabled: false }), () => '2026-01-02T00:00:00Z')
    let authorized = true
    const registry = createToolRegistry({ tools: [createListScheduledTasksTool({ list: (identity, signal) => query.agent(identity.ownerId, signal) })], authorize: async () => authorized })
    const identity = { ownerId, sessionId: '1', runId: 'run' }
    const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不可执行进程') } }
    const call = { id: 'list', name: 'list_scheduled_tasks', input: {} }
    const before = await sql`SELECT * FROM scheduled_tasks ORDER BY id`.execute(runtime.db)
    expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(['list_scheduled_tasks'])
    const result = await registry.tools.dispatch(call, scope)
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false, value: [
      { id: 3, name: '合成任务', when: '每 10 分钟', schedule_kind: 'interval', cron: '0 9 * * *', interval_minutes: 10, start_at: null, end_at: null, schedule_status: 'disabled', instruction: '指令', execution_mode: 'reminder', channels: ['web', 'qq'], enabled: false, last_run_at: null, delivery_targets: { qq: 'private' }, authorized_tools: ['send_email'], email_attachment_file_ids: [5], workspace_id: null, filesystem_authorized: false },
      { id: 1, when: '每天 09:00', schedule_status: 'active' },
    ] })
    expect((await registry.tools.dispatch(call, { ...scope, identity: { ...identity, ownerId: other } }))).toMatchObject({ successful: true, value: [] })
    authorized = false
    expect(await registry.tools.dispatch(call, scope)).toMatchObject({ successful: false, executed: false })
    authorized = true
    const controller = new AbortController(); controller.abort()
    await expect(registry.tools.dispatch(call, { ...scope, signal: controller.signal })).rejects.toThrow()
    expect(await sql`SELECT * FROM scheduled_tasks ORDER BY id`.execute(runtime.db)).toEqual(before)
    await sql`DROP TABLE scheduled_tasks`.execute(runtime.db)
    const failed = await registry.tools.dispatch(call, scope)
    expect(failed).toMatchObject({ successful: false, value: { error: '工具执行失败' } })
    expect(JSON.stringify(failed)).not.toContain('no such table')
  } finally { await runtime.close(); await rm(folder, { recursive: true, force: true }) }
})

it('create/update 经注册器保存精确时间窗、保留省略字段并按原调用收据重放', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-agent-scheduled-write-'))
  await initializeSqlite(join(folder, 'core.db'))
  const { runtime: core, ownerId } = await openSqliteRuntime(join(folder, 'core.db'))
  try {
    const owner = ownerId.replaceAll('-', ''), other = randomUUID().replaceAll('-', '')
    const published: Array<[string, number]> = []
    const fixedNow = Date.parse('2026-09-05T00:00:00Z')
    let allowed = true, creates = 0, updates = 0
    const runtime = {
      capabilities: { workspaceSupported: false, filesystemAuthorizationEnabled: false },
      async authorize(_tx: Transaction<import('../../../src/data/schema.js').Database>, identity: { ownerId: string }) {
        return allowed && identity.ownerId === ownerId
      },
      async delivery(_tx: Transaction<import('../../../src/data/schema.js').Database>, _identity: unknown,
        intent: { channels?: readonly string[] }) {
        return { channels: (intent.channels ?? ['web']).join(','), delivery_targets: null }
      },
      async create(tx: Transaction<import('../../../src/data/schema.js').Database>, rawOwner: string, input: ScheduledTaskCreateInput) {
        creates++
        const schedule = normalizeSchedule(input, () => {}, fixedNow)
        const row = await tx.insertInto('scheduled_tasks').values({
          user_id: rawOwner.replaceAll('-', ''), event_id: null, reminder_lead_minutes: null, workspace_id: null,
          filesystem_authorization_grant_id: null, execution_mode: input.execution_mode === 'reminder' ? 'reminder' : 'instruction', name: String(input.name), payload: String(input.payload ?? ''),
          cron: schedule.cron, schedule_kind: schedule.schedule_kind, interval_minutes: schedule.interval_minutes,
          start_at: scheduleTimestamp(schedule.start_at), end_at: scheduleTimestamp(schedule.end_at),
          channels: String(input.channels ?? 'web'), enabled: input.enabled === false ? 0 : 1,
          delivery_targets: input.delivery_targets == null ? null : JSON.stringify(input.delivery_targets),
          authorized_tools: JSON.stringify([]), email_attachment_file_ids: JSON.stringify([]), last_run_at: null,
          last_run_failed: null, created_at: '2026-09-05 00:00:00', updated_at: '2026-09-05 00:00:00',
        }).returning('id').executeTakeFirstOrThrow()
        return Number(row.id)
      },
      async update(tx: Transaction<import('../../../src/data/schema.js').Database>, rawOwner: string, id: number, patch: ScheduledTaskPatch) {
        updates++
        const fields: Record<string, unknown> = {}
        if (patch.name !== undefined) fields.name = patch.name
        if (patch.payload !== undefined) fields.payload = patch.payload
        if (patch.execution_mode !== undefined) fields.execution_mode = patch.execution_mode
        if (patch.start_at !== undefined) fields.start_at = patch.start_at
        if (patch.end_at !== undefined) fields.end_at = patch.end_at
        if (patch.schedule_kind !== undefined) fields.schedule_kind = patch.schedule_kind
        await tx.updateTable('scheduled_tasks').set(fields as never).where('user_id', '=', rawOwner.replaceAll('-', ''))
          .where('id', '=', id).execute()
      },
      async publish(_owner: string, operation: 'create' | 'update', id: number) { published.push([operation, id]) },
    }
    const tools = createToolRegistry({ tools: createScheduledTaskWriteTools(core as SqlDataRuntime, runtime),
      authorize: async identity => identity.ownerId === ownerId })
    const scope = (currentOwner = ownerId) => ({ identity: { ownerId: currentOwner, sessionId: 'task-session', runId: 'task-run' },
      roundId: 'task-round', signal: new AbortController().signal, resolution: null,
      async execute() { throw new Error('定时任务工具不调用 Shell') } })
    const dispatch = (id: string, name: string, input: unknown, currentOwner = ownerId) =>
      tools.tools.dispatch({ id, name, input }, scope(currentOwner))
    const input = { schedule_name: '  精确窗口\u00a0', execution_mode: 'instruction', instruction: ' 执行一次 ', schedule_kind: 'interval', interval_minutes: 10,
      start_at: '2099-09-05T18:30:00', end_at: '2099-09-05T19:30:00', channels: ['web'] }
    const created = await dispatch('create-once', 'create_scheduled_task', input)
    expect(created).toMatchObject({ successful: true, mutated: true, value: {
      success: true, task_id: 1, name: '精确窗口', execution_mode: 'instruction', instruction: '执行一次', schedule_kind: 'interval', interval_minutes: 10,
      cron: '*/10 * * * *', schedule_status: 'active', start_at: '2099-09-05T10:30:00Z',
      end_at: '2099-09-05T11:30:00Z',
    } })
    expect(await dispatch('create-once', 'create_scheduled_task', input)).toMatchObject({ successful: true, mutated: false, value: created.value })
    const updated = await dispatch('update-once', 'update_scheduled_task', { task_id: 1, schedule_name: '更新窗口', execution_mode: 'reminder', start_at: null })
    expect(updated).toMatchObject({ successful: true, mutated: true, value: {
      success: true, id: 1, name: '更新窗口', execution_mode: 'reminder', start_at: null, end_at: '2099-09-05T11:30:00Z',
    } })
    expect(await dispatch('foreign-update', 'update_scheduled_task', { task_id: 1, schedule_name: '越权' }, other))
      .toMatchObject({ successful: false, value: { error: '没有权限使用此工具' } })
    allowed = false
    expect(await dispatch('revoked-create', 'create_scheduled_task', { ...input, schedule_name: '撤权后' }))
      .toMatchObject({ successful: false, mutated: false, value: { error: '定时任务写入或投递权限不可用' } })
    expect(await dispatch('unsafe-filesystem', 'create_scheduled_task', { ...input, filesystem_authorized: true }))
      .toMatchObject({ successful: false, value: { error: '本平台尚未提供定时任务沙箱的持久授权交互' } })
    const stored = await sql<{ name: string; payload: string; cron: string; start_at: string | null; end_at: string | null }>`
      SELECT name,payload,cron,start_at,end_at FROM scheduled_tasks WHERE user_id=${owner}`.execute(core.db)
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0]).toMatchObject({ name: '更新窗口', payload: '执行一次', cron: '*/10 * * * *', start_at: null })
    expect(new Date(stored.rows[0]!.end_at!).toISOString()).toBe('2099-09-05T11:30:00.000Z')
    expect(creates).toBe(1)
    expect(updates).toBe(1)
    expect(published).toEqual([['create', 1], ['update', 1]])
  } finally { await core.close(); await rm(folder, { recursive: true, force: true }) }
})
