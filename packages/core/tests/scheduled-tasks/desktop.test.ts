import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sql } from 'kysely'
import { dataContext } from '../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import type { Database } from '../../src/data/schema.js'
import { desktopScheduledTasks } from '../../src/scheduled-tasks/desktop.js'

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
      await expect(service.claim(due)).resolves.toEqual([{ id: task.id, name: fields.name, payload: '' }])
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
      const activity = await service.create({ ...fields, execution_mode: 'instruction', payload: '整理议题' }, eventId)
      await expect(service.get(activity.id)).rejects.toMatchObject({ code: 'not_found' })
      await expect(service.list(undefined, eventId)).resolves.toMatchObject({ tasks: [{ id: activity.id, execution_mode: 'reminder' }] })
      await expect(service.update(activity.id, { execution_mode: 'instruction', payload: '不应投递的指令' }, eventId))
        .resolves.toMatchObject({ execution_mode: 'reminder', event_id: eventId, payload: '提醒：读书会（2027-01-05）' })
      await sql`UPDATE calendar_events SET deleted_at=CURRENT_TIMESTAMP WHERE id=${eventId}`.execute(runtime.db)
      await expect(service.claim(due)).resolves.toEqual([])
      await sql`UPDATE calendar_events SET deleted_at=NULL WHERE id=${eventId}`.execute(runtime.db)
      await expect(service.claim(due)).resolves.toEqual([{ id: activity.id, name: fields.name, payload: '提醒：读书会（2027-01-05）' }])
    } finally {
      await runtime.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
