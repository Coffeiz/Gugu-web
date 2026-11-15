import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { tablesSql } from '../../src/data/schema.js'
import { databaseTime } from '../../src/data/codec.js'
import { createKyselyOnceTaskRepository } from '../../src/scheduled-tasks/once-repository.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
const now = Date.parse('2026-11-14T12:34:56.123Z')
describe.each(['sqlite', 'postgres'] as const)('一次性任务仓储 %s', backend => {
  it.skipIf(backend === 'postgres' && !url)('原子认领、失败重试、owner 隔离和崩溃候选', async () => {
    const schema = `once_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const db = backend === 'postgres'
      ? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
      : new Kysely<{}>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
    try {
      await sql.raw(tablesSql(backend).scheduledTasks).execute(db)
      await sql.raw(tablesSql(backend).ragJobs).execute(db)
      const owner = randomUUID(), other = randomUUID()
      const stored = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
      for (const [id, start, enabled, kind] of [[1, '2026-11-14 12:34:00.000000', true, 'once'], [2, '2026-11-14 12:30:00.000000', true, 'once'], [3, '2026-11-14 12:34:00.000000', false, 'once'], [4, '2026-11-14 12:34:00.000000', true, 'cron']] as const)
        await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,start_at,channels,enabled,created_at,updated_at) VALUES(${id},${stored},'合成任务','','*',${kind},${databaseTime(start, backend)},'web',${backend === 'sqlite' ? Number(enabled) : enabled},'2026-11-14 00:00:00','2026-11-14 00:00:00')`.execute(db)
      const repo = createKyselyOnceTaskRepository(db, backend)
      expect(await repo.listDue(now)).toEqual(['1'])
      expect(await repo.getOnce('1')).toMatchObject({ id: '1', userId: owner, lastRunAt: null, lastRunFailed: false })
      expect(await repo.getOnce('4')).toBeNull()
      const claims = await Promise.all([repo.markStarted('1', now), repo.markStarted('1', now)])
      expect(claims.sort()).toEqual([false, true])
      expect((await repo.getOnce('1'))?.lastRunAt).toBe(now)
      expect(await repo.listDue(now)).toEqual([])
      expect((await repo.findStartedOnceBefore(now + 1)).map(item => item.id)).toEqual(['1'])
      expect(await repo.findStartedOnceBefore(now)).toEqual([])
      await repo.markFailed('1')
      expect((await repo.getOnce('1'))?.lastRunFailed).toBe(true)
      expect(await repo.findStartedOnceBefore(now + 1)).toEqual([])
      expect(await repo.markStarted('1', now + 1)).toBe(true)
      await sql`INSERT INTO rag_index_jobs(user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at)
        VALUES(${stored},'scheduled_task','legacy','[]','','upsert','queued',1,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`.execute(db)
      await repo.deleteCompleted('1', other)
      expect(await repo.getOnce('1')).not.toBeNull()
      await repo.deleteCompleted('1', owner)
      expect(await repo.getOnce('1')).toBeNull()
      const indexJob = (await sql<{ source_id: string; generation: number; pending_source_ids: unknown }>`SELECT source_id,generation,pending_source_ids FROM rag_index_jobs WHERE user_id=${stored} AND source_type='scheduled_task'`.execute(db)).rows[0]!
      expect(indexJob.source_id).toBe('1')
      expect(Number(indexJob.generation)).toBe(2)
      expect(typeof indexJob.pending_source_ids === 'string' ? JSON.parse(indexJob.pending_source_ids) : indexJob.pending_source_ids).toEqual(['legacy', '1'])
      expect(await repo.markStarted('3', now)).toBe(false)
    } finally {
      await db.destroy()
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})
