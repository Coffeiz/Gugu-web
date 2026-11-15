import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createCalendarEvent } from '../../src/calendar/application/event-create.js'
import { createKyselyCalendarCreateStore } from '../../src/calendar/create-store.js'
import { tablesSql } from '../../src/data/schema.js'

const pgUrl = process.env.GUGU_CORE_TEST_POSTGRES_URL
describe.each(['sqlite', 'postgres'] as const)('日历创建事务 %s', (backend) => {
  it.skipIf(backend === 'postgres' && !pgUrl)('保持 owner、幂等、Undo、索引和失败回滚', async () => {
    const schema = `calendar_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: pgUrl }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const db = backend === 'postgres'
      ? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` }) }) })
      : new Kysely<{}>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
    try {
      const schemaSql = tablesSql(backend)
      for (const statement of [schemaSql.projects, schemaSql.undo, schemaSql.calendarEvents, schemaSql.ragJobs])
        await sql.raw(statement).execute(db)
      const owner = randomUUID(), other = randomUUID()
      const storedOwner = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
      await sql`INSERT INTO projects(id,user_id,name,status,color,progress,stages_json,version,archived,created_at,updated_at) VALUES(1,${storedOwner},'合成项目','active','',0,'[]',1,false,'2026-11-14 00:00:00.000000','2026-11-14 00:00:00.000000')`.execute(db)
      let events = 0
      const store = createKyselyCalendarCreateStore(db, backend, async () => { events++ }, () => '2026-11-14T12:34:56.123Z')
      const input = { title: '合成活动', date: '2026-11-14', projectId: 1 }
      const first = await createCalendarEvent(store, { ownerId: owner, input, idempotencyKey: 'key', undoContextId: 'tab' })
      const repeated = await createCalendarEvent(store, { ownerId: owner, input, idempotencyKey: 'key', undoContextId: 'tab' })
      expect(first.created).toBe(true)
      if (backend === 'sqlite') {
        const times = (await sql<{ event_time: string; next_attempt_at: string; created_at: string; updated_at: string }>`
          SELECT e.created_at AS event_time, j.next_attempt_at, j.created_at, j.updated_at
          FROM calendar_events e CROSS JOIN rag_index_jobs j
        `.execute(db)).rows[0]!
        expect(Object.values(times)).toEqual(Array(4).fill('2026-11-14 12:34:56.123000'))
      }
      expect(repeated.created).toBe(false)
      await expect(createCalendarEvent(store, { ownerId: other, input })).rejects.toMatchObject({ statusCode: 400 })
      await expect(createCalendarEvent(store, { ownerId: owner, input: { ...input, title: '不同' }, idempotencyKey: 'key' })).rejects.toMatchObject({ statusCode: 409 })
      await createCalendarEvent(store, { ownerId: owner, input: { title: '第二项', date: '2026-11-15' }, undoContextId: 'tab' })
      const jobs = await sql<{ generation: number; pending_source_ids: unknown }>`SELECT generation,pending_source_ids FROM rag_index_jobs`.execute(db)
      expect(Number(jobs.rows[0]!.generation)).toBe(2)
      const pending = jobs.rows[0]!.pending_source_ids
      expect(typeof pending === 'string' ? JSON.parse(pending) : pending).toEqual([String(first.event.id), String(first.event.id + 1)])
      expect((await sql`SELECT id FROM undo_operations`.execute(db)).rows).toHaveLength(2)
      expect(events).toBe(2)
      const concurrent = await Promise.all([1, 2].map(() => createCalendarEvent(store, {
        ownerId: owner, input: { title: '并发活动', date: '2026-11-16' }, idempotencyKey: 'concurrent', undoContextId: 'tab',
      })))
      expect(concurrent.map(result => result.created).sort()).toEqual([false, true])
      expect(concurrent[0]!.event.id).toBe(concurrent[1]!.event.id)
      expect(events).toBe(3)
      const distinct = await Promise.all(['并发甲', '并发乙'].map(title => createCalendarEvent(store, {
        ownerId: owner, input: { title, date: '2026-11-17' }, undoContextId: 'tab',
      })))
      const merged = (await sql<{ generation: number; pending_source_ids: unknown }>`SELECT generation,pending_source_ids FROM rag_index_jobs`.execute(db)).rows[0]!
      const mergedIds = typeof merged.pending_source_ids === 'string' ? JSON.parse(merged.pending_source_ids) : merged.pending_source_ids
      expect(Number(merged.generation)).toBe(5)
      expect(new Set(mergedIds as string[])).toEqual(new Set([String(first.event.id), String(first.event.id + 1), String(concurrent[0]!.event.id), ...distinct.map(result => String(result.event.id))]))
      expect(events).toBe(5)
      await sql`DROP TABLE undo_operations`.execute(db)
      await expect(createCalendarEvent(store, { ownerId: owner, input, undoContextId: 'tab' })).rejects.toThrow()
      expect((await sql`SELECT id FROM calendar_events`.execute(db)).rows).toHaveLength(5)
    } finally {
      await db.destroy()
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})
