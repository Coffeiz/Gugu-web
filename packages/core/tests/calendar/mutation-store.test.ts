import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { tablesSql, type Database } from '../../src/data/schema.js'
import { createKyselyCalendarMutationStores } from '../../src/calendar/mutation-store.js'
import { createCalendarUndoAdapter } from '../../src/calendar/undo-adapter.js'
import type { UndoAdapterContext } from '../../src/undo/state-machine.js'
import { updateCalendarEvent } from '../../src/calendar/application/event-update.js'
import { deleteCalendarEvent } from '../../src/calendar/application/event-delete.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
describe.each(['sqlite', 'postgres'] as const)('日历更新和删除事务 %s', backend => {
  it.skipIf(backend === 'postgres' && !url)('保证隔离、版本竞争、提醒重排、Undo 与回滚', async () => {
    const schema = `calendar_mutation_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const db = backend === 'postgres'
      ? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
      : new Kysely<{}>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
    try {
      const definitions = tablesSql(backend)
      for (const statement of [definitions.projects, definitions.undo, definitions.calendarEvents, definitions.ragJobs, definitions.scheduledTasks, definitions.scheduledFires]) await sql.raw(statement).execute(db)
      await sql`CREATE UNIQUE INDEX uq_scheduled_tasks_event_fire ON scheduled_tasks(user_id,event_id,cron) WHERE event_id IS NOT NULL`.execute(db)
      const owner = randomUUID(), other = randomUUID()
      const stored = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
      await sql`INSERT INTO calendar_events(id,user_id,title,date,time,type,version,created_at) VALUES(1,${stored},'原活动','2099-11-14','10:00','event',1,'2026-11-14 00:00:00')`.execute(db)
      for (const [id, lead, cron] of [[1, 5, '@once:original-a'], [2, 10, '@once:original-b']] as const)
        await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,reminder_lead_minutes,name,payload,cron,schedule_kind,start_at,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,created_at,updated_at) VALUES(${id},${stored},1,${lead},'原提醒','原内容',${cron},'once','2099-11-14 01:55:00','web',${backend === 'sqlite' ? 1 : true},NULL,'[]','[]','2026-11-14 00:00:00','2026-11-14 00:00:00')`.execute(db)
      const publications: unknown[] = []
      const stores = createKyselyCalendarMutationStores(db, backend, async event => { publications.push(event) }, () => '2026-11-14T12:34:56.123Z')
      await expect(updateCalendarEvent(stores.update, { ownerId: other, eventId: 1, body: { version: 1, title: '越权' } })).rejects.toMatchObject({ statusCode: 404 })
      await expect(deleteCalendarEvent(stores.delete, { ownerId: owner, eventId: 1, version: 0 })).rejects.toMatchObject({ statusCode: 409 })
      const updated = await updateCalendarEvent(stores.update, { ownerId: owner, eventId: 1, body: { version: 1, title: '新活动', date: '2099-11-15' }, undoContextId: 'tab' })
      expect(updated.version).toBe(2)
      const tasks = (await sql<{ name: string; cron: string; enabled: boolean | number }>`SELECT name,cron,enabled FROM scheduled_tasks ORDER BY id`.execute(db)).rows
      expect(tasks.map(task => task.name)).toEqual(['新活动 提醒', '新活动 提醒'])
      expect(tasks.map(task => task.cron)).toEqual(['@once:2099-11-15T01:55:00+00:00', '@once:2099-11-15T01:50:00+00:00'])
      const reminderJob = (await sql<{ generation: number; pending_source_ids: unknown }>`SELECT generation,pending_source_ids FROM rag_index_jobs WHERE user_id=${stored} AND source_type='scheduled_task'`.execute(db)).rows[0]!
      expect(Number(reminderJob.generation)).toBe(2)
      expect(typeof reminderJob.pending_source_ids === 'string' ? JSON.parse(reminderJob.pending_source_ids) : reminderJob.pending_source_ids).toEqual(['1', '2'])
      const calendarJob = (await sql<{ generation: number; pending_source_ids: unknown }>`SELECT generation,pending_source_ids FROM rag_index_jobs WHERE user_id=${stored} AND source_type='calendar'`.execute(db)).rows[0]!
      expect(Number(calendarJob.generation)).toBe(1)
      expect(typeof calendarJob.pending_source_ids === 'string' ? JSON.parse(calendarJob.pending_source_ids) : calendarJob.pending_source_ids).toEqual(['1'])
      expect((await sql`SELECT id FROM undo_operations`.execute(db)).rows).toHaveLength(1)
      const concurrent = await Promise.allSettled([1, 2].map(() => updateCalendarEvent(stores.update, { ownerId: owner, eventId: 1, body: { version: 2, description: '并发' }, undoContextId: 'tab' })))
      expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(concurrent.find(result => result.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } })
      const beforeFailure = (await sql`SELECT * FROM calendar_events`.execute(db)).rows
      await sql`DROP TABLE undo_operations`.execute(db)
      await expect(updateCalendarEvent(stores.update, { ownerId: owner, eventId: 1, body: { version: 3, title: '必须回滚' }, undoContextId: 'tab' })).rejects.toThrow()
      expect((await sql`SELECT * FROM calendar_events`.execute(db)).rows).toEqual(beforeFailure)
      expect((await sql<{ name: string }>`SELECT name FROM scheduled_tasks`.execute(db)).rows.map(row => row.name)).toEqual(['新活动 提醒', '新活动 提醒'])
      expect(Number((await sql<{ generation: number }>`SELECT generation FROM rag_index_jobs WHERE user_id=${stored} AND source_type='scheduled_task'`.execute(db)).rows[0]!.generation)).toBe(2)
      expect(Number((await sql<{ generation: number }>`SELECT generation FROM rag_index_jobs WHERE user_id=${stored} AND source_type='calendar'`.execute(db)).rows[0]!.generation)).toBe(2)
      await expect(deleteCalendarEvent(stores.delete, { ownerId: owner, eventId: 1, version: 3, undoContextId: 'tab' })).rejects.toThrow()
      expect((await sql`SELECT * FROM calendar_events`.execute(db)).rows).toEqual(beforeFailure)
      expect((await sql<{ enabled: boolean | number }>`SELECT enabled FROM scheduled_tasks`.execute(db)).rows.every(row => Boolean(row.enabled))).toBe(true)
      expect(publications).toHaveLength(2)
      await sql.raw(definitions.undo).execute(db)
      await deleteCalendarEvent(stores.delete, { ownerId: owner, eventId: 1, version: 3, undoContextId: 'tab' })
      expect(Number((await sql<{ generation: number }>`SELECT generation FROM rag_index_jobs WHERE user_id=${stored} AND source_type='calendar'`.execute(db)).rows[0]!.generation)).toBe(3)
      const undo = (await sql<{ action: string; after_state: unknown }>`SELECT action,after_state FROM undo_operations`.execute(db)).rows[0]!
      expect(undo.action).toBe('delete')
      const snapshot = typeof undo.after_state === 'string' ? JSON.parse(undo.after_state) : undo.after_state
      expect(snapshot).toMatchObject({ items: { 'task:1': { enabled: false }, 'task:2': { enabled: false } } })
      expect((await sql<{ enabled: boolean | number }>`SELECT enabled FROM scheduled_tasks`.execute(db)).rows.every(row => !row.enabled)).toBe(true)
      expect(Number((await sql<{ generation: number }>`SELECT generation FROM rag_index_jobs WHERE user_id=${stored} AND source_type='scheduled_task'`.execute(db)).rows[0]!.generation)).toBe(4)
      const undoRow = {
        id: 'undo-task', action: 'update',
        before_state: { items: { 'task:1': { enabled: true, name: '恢复提醒' } } },
        after_state: { items: { 'task:1': { enabled: false, name: '新活动 提醒' } } },
      } as unknown as UndoAdapterContext['row']
      const calendarUndo = createCalendarUndoAdapter(backend)
      await db.transaction().execute(tx => calendarUndo.apply({ tx: tx as Kysely<Database>, owner, row: undoRow, mode: 'undo' }))
      expect(Boolean((await sql<{ enabled: boolean | number }>`SELECT enabled FROM scheduled_tasks WHERE id=1`.execute(db)).rows[0]!.enabled)).toBe(true)
      expect(Number((await sql<{ generation: number }>`SELECT generation FROM rag_index_jobs WHERE user_id=${stored} AND source_type='scheduled_task'`.execute(db)).rows[0]!.generation)).toBe(5)
      expect(publications).toHaveLength(4)
    } finally {
      await db.destroy()
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})
