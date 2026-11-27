import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '#core-source/data/sqlite.js'
import { createToolRegistry } from '#core-source/agent/tools/registry.js'
import { desktopScheduledTasks } from '#core-source/runtime/desktop-schedules/desktop.js'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '#core-source/tasks/task-list.js'
import { createDesktopScheduleTools } from '../src/main/agent/runtime/schedule-tools.js'

it('桌面会话可以恢复指令任务，改渠道时保留模式和原指令', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-schedule-'))
  const path = join(directory, 'core.db')
  await initializeSqlite(path)
  const { runtime: core, ownerId } = await openSqliteRuntime(path)
  try {
    const tasks = desktopScheduledTasks(core.db, ownerId)
    const task = await tasks.create({
      name: '合成任务', payload: '合成指令', schedule_kind: 'cron', cron: '0 9 * * *',
      execution_mode: 'reminder', channels: ['web'], enabled: false,
    }, null)
    const scheduledTasks = createScheduledTaskQueries(createKyselyScheduledTaskReader(core.db, 'sqlite'),
      () => ({ workspaceSupported: false, filesystemAuthorizationEnabled: false }), () => new Date().toISOString())
    const { scheduleWrites } = createDesktopScheduleTools({
      core, ownerId, imPlatform: undefined, hasImSession: false, groupChat: false,
      hostRequest: async () => { throw new Error('本机渠道无需访问外部服务') },
      currentScheduledIm: async () => false, scheduledTasks, authorizeWrite: async () => true,
    })
    const registry = createToolRegistry({ tools: scheduleWrites, authorize: async () => true })
    const scope = {
      identity: { ownerId, sessionId: '1', runId: 'schedule-run' },
      roundId: 'schedule-round', signal: new AbortController().signal, resolution: null,
      async execute() { throw new Error('定时任务工具不调用 Shell') },
    }
    const update = (id: string, input: object) => registry.tools.dispatch({
      id, name: 'update_scheduled_task', input: { task_id: task.id, ...input },
    }, scope)

    expect(await update('restore', { execution_mode: 'instruction', channels: ['web'] }))
      .toMatchObject({ successful: true, value: { execution_mode: 'instruction' } })
    expect(await update('channels', { channels: ['web'] })).toMatchObject({
      successful: true, value: { execution_mode: 'instruction' },
    })
    expect(await tasks.get(task.id)).toMatchObject({
      execution_mode: 'instruction', payload: '合成指令', enabled: false, channels: ['web'],
    })
  } finally {
    await core.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('重新打开基线数据库后保留私聊目标、群目标和任务状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-schedule-migration-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const group = { platform: 'feishu', chatType: 'group', botId: 'group-bot', boundUserId: 'group-owner', recipient: 'group-chat' }
    let taskId: number
    try {
      const task = await desktopScheduledTasks(runtime.db, ownerId).create({
        name: '合成迁移任务', payload: '合成指令', schedule_kind: 'cron', cron: '0 9 * * *',
        execution_mode: 'instruction', channels: ['web'], enabled: false,
      }, null)
      taskId = task.id
      await runtime.db.updateTable('scheduled_tasks').where('id', '=', task.id).set({
        channels: 'qq,feishu',
        delivery_targets: JSON.stringify({
          qq: { platform: 'qq', chatType: 'c2c' },
          feishu: group,
        }),
      }).execute()
    } finally { await runtime.close() }
    const upgraded = await openSqliteRuntime(path)
    try {
      expect(await desktopScheduledTasks(upgraded.runtime.db, ownerId).get(taskId)).toMatchObject({
        name: '合成迁移任务', payload: '合成指令', cron: '0 9 * * *',
        execution_mode: 'instruction', enabled: false, channels: ['qq', 'feishu'],
        delivery_targets: { qq: { platform: 'qq', chatType: 'c2c' }, feishu: group },
      })
      const updated = await upgraded.runtime.db.selectFrom('scheduled_tasks').select('delivery_targets')
        .where('id', '=', taskId).executeTakeFirstOrThrow()
      expect(JSON.parse(String(updated.delivery_targets)).qq).toEqual({ platform: 'qq', chatType: 'c2c' })
    } finally { await upgraded.runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
