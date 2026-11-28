import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sql } from 'kysely'
import { dataContext } from '../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import type { Database } from '../../src/data/schema.js'
import { desktopScheduleImConnection, desktopScheduleImReminderVersion, type DesktopScheduleImTarget } from '../../src/runtime/desktop-schedules/desktop-im.js'
import { readDesktopScheduledGroups } from '../../src/runtime/desktop-schedules/desktop-group-targets.js'
import { admitDesktopImEvent, prepareDesktopImEvent } from '../../src/im/desktop-inbox.js'
import { desktopScheduledTasks } from '../../src/runtime/desktop-schedules/desktop.js'

it('桌面定时提醒使用同一 SQLite 事务写入，且一次性提醒只认领一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-local-schedules-'))
  const path = join(root, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const context = dataContext(ownerId)
      const due = Date.now() + 60_000
      const fields = { name: '本地提醒', schedule_kind: 'once', start_at: new Date(due).toISOString() }
      const save = (id: string) => runtime.operationWithTransaction(context, id, 'schedules.create', { fields },
        (tx, owner) => desktopScheduledTasks<Database>(tx, owner).create(fields))
      const id = randomUUID()
      const { result: task } = await save(id)
      expect(await save(id)).toMatchObject({ result: { id: task.id }, replayed: true })
      const service = desktopScheduledTasks(runtime.db, ownerId)
      expect(await desktopScheduledTasks(runtime.db, randomUUID()).list()).toEqual({ tasks: [], nextBefore: null })
      const silent = await service.create({ ...fields, channels: [] })
      expect(silent.channels).toEqual([])
      await expect(service.update(task.id, { channels: ['email'] })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(service.update(task.id, { channels: [] })).resolves.toMatchObject({ channels: [] })
      await expect(service.claim(due)).resolves.toEqual([])
      await expect(service.update(task.id, { channels: ['web'] })).resolves.toMatchObject({ channels: ['web'] })
      await expect(service.claim(due - 1)).resolves.toEqual([])
      await expect(service.claim(due)).resolves.toEqual([{ id: task.id, mode: 'reminder', name: fields.name, payload: '' }])
      await expect(service.claim(due + 30_000)).resolves.toEqual([])
      const completed = await service.get(task.id)
      expect(completed.enabled).toBe(false)
      expect(Date.parse(completed.last_run_at ?? '')).toBe(due)
      await expect(service.update(task.id, { enabled: true })).rejects.toMatchObject({ code: 'invalid_request' })
      const owner = ownerId.replaceAll('-', '')
      const { rows: [event] } = await sql<{ id: number }>`INSERT INTO calendar_events
        (user_id,title,date,type,version,created_at)
        VALUES (${owner},'读书会','2027-01-05','event',1,CURRENT_TIMESTAMP) RETURNING id`.execute(runtime.db)
      const eventId = event!.id
      const standalone = await service.create({ ...fields, execution_mode: 'instruction', payload: '独立任务指令' })
      expect(standalone.execution_mode).toBe('instruction')
      await expect(service.claim(due - 1)).resolves.toEqual([])
      await expect(service.claim(due, new Set([standalone.id]))).resolves.toEqual([])
      await expect(service.claim(due)).resolves.toEqual([{ id: standalone.id, mode: 'instruction', fireAt: due }])
      await expect(service.assertInstructionCurrent(standalone.id, standalone, due)).resolves.toBeUndefined()
      await expect(service.assertInstructionCurrent(standalone.id, standalone, due + 1000)).rejects.toMatchObject({ code: 'conflict' })
      await service.finishInstruction(standalone.id, due, true)
      await expect(service.get(standalone.id)).resolves.toMatchObject({ enabled: false, last_run_failed: true })
      await service.update(standalone.id, { payload: '已修改任务指令' })
      await expect(service.assertInstructionCurrent(standalone.id, standalone, due)).rejects.toMatchObject({ code: 'conflict' })
      const group: DesktopScheduleImTarget = { platform: 'qq', chatType: 'group', botId: 'bot-synthetic',
        boundUserId: 'owner-synthetic', recipient: 'group-synthetic' }
      const receipt = { platform: group.platform, connectionId: desktopScheduleImConnection(group),
        eventKey: '合成收件', sealedEvent: 'AQ==' }
      await admitDesktopImEvent(runtime.db, ownerId, receipt)
      await prepareDesktopImEvent(runtime.db, ownerId, { ...receipt, chatType: 'group', ownerPlatformUserId: group.boundUserId })
      await expect(readDesktopScheduledGroups<Database>(runtime.db, ownerId, 'qq', async () => group))
        .resolves.toEqual([{ target: group, title: '即时通讯' }])
      await expect(readDesktopScheduledGroups<Database>(runtime.db, ownerId, 'qq',
        async () => ({ ...group, recipient: 'unrelated-group' }))).resolves.toEqual([])
      await expect(readDesktopScheduledGroups<Database>(runtime.db, randomUUID(), 'qq', async () => group)).resolves.toEqual([])
      const imFields = { ...fields, channels: ['web', 'qq'], execution_mode: 'reminder', payload: '本群提醒正文' }
      await expect(service.create(imFields)).rejects.toMatchObject({ code: 'invalid_request' })
      const imTask = await service.create(imFields, null, [group])
      expect(imTask.delivery_targets).toEqual({ qq: group })
      await expect(service.claim(due)).resolves.toEqual([{
        id: imTask.id, mode: 'reminder', name: imTask.name, payload: imTask.payload,
        imDelivery: { fireAt: due, desktop: true, version: desktopScheduleImReminderVersion(imTask, [group]) },
      }])
      await expect(service.claim(due + 1)).resolves.toEqual([])
      const activity = await service.create({ ...fields, execution_mode: 'instruction', payload: '整理议题' }, eventId)
      await expect(service.get(activity.id)).rejects.toMatchObject({ code: 'not_found' })
      await expect(service.list(undefined, eventId)).resolves.toMatchObject({ tasks: [{ id: activity.id, execution_mode: 'reminder' }] })
      await expect(service.update(activity.id, { execution_mode: 'instruction', payload: '不应投递的指令' }, eventId))
        .resolves.toMatchObject({ execution_mode: 'reminder', event_id: eventId, payload: '提醒：读书会（2027-01-05）' })
      await sql`UPDATE calendar_events SET deleted_at=CURRENT_TIMESTAMP WHERE id=${eventId}`.execute(runtime.db)
      await expect(service.claim(due)).resolves.toEqual([])
      await sql`UPDATE calendar_events SET deleted_at=NULL WHERE id=${eventId}`.execute(runtime.db)
      await expect(service.claim(due)).resolves.toEqual([{ id: activity.id, mode: 'reminder', name: fields.name, payload: '提醒：读书会（2027-01-05）' }])
    } finally {
      await runtime.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
