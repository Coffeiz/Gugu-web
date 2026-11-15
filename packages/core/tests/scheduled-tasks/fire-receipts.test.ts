import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { tablesSql } from '../../src/data/schema.js'
import { createKyselyScheduledFireReceipts } from '../../src/scheduled-tasks/fire-receipts.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
describe.each(['sqlite', 'postgres'] as const)('定时触发收据 %s', backend => {
  it.skipIf(backend === 'postgres' && !url)('并发认领唯一、终态不能重放且只允许原租约结束', async () => {
    const schema = `fires_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const db = backend === 'postgres'
      ? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
      : new Kysely<{}>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
    try {
      await sql.raw(tablesSql(backend).scheduledFires).execute(db)
      const repo = createKyselyScheduledFireReceipts(db, backend, () => '2026-11-14T12:34:56.123Z')
      const fire = { taskId: '1', fireAt: Date.parse('2026-11-14T12:30:00.123Z') }
      const claims = await Promise.all(['owner-a', 'owner-b'].map(owner => repo.claim(fire, owner)))
      expect(claims.filter(Boolean)).toHaveLength(1)
      const winner = claims[0] ? 'owner-a' : 'owner-b'
      const loser = claims[0] ? 'owner-b' : 'owner-a'
      await expect(repo.finish(fire, loser, 'completed')).rejects.toThrow('收据已失效')
      await repo.finish(fire, winner, 'completed')
      const reopened = createKyselyScheduledFireReceipts(db, backend)
      expect(await reopened.get(fire)).toEqual({ owner: winner, state: 'completed' })
      expect(await reopened.claim(fire, loser)).toBe(false)
      await expect(reopened.finish(fire, winner, 'completed')).rejects.toThrow('收据已失效')
      const uncertain = { ...fire, fireAt: fire.fireAt + 60_000 }
      expect(await repo.claim(uncertain, winner)).toBe(true)
      await repo.finish(uncertain, winner, 'unknown')
      expect(await reopened.get(uncertain)).toEqual({ owner: winner, state: 'unknown' })
      expect(await reopened.claim(uncertain, loser)).toBe(false)
      const abandoned = { taskId: '2', fireAt: fire.fireAt }
      expect(await repo.claim(abandoned, winner)).toBe(true)
      expect(await reopened.get(abandoned)).toEqual({ owner: winner, state: 'claimed' })
      expect(await reopened.claim(abandoned, loser)).toBe(false)
      if (backend === 'sqlite') {
        const row = (await sql<{ created_at: string; updated_at: string }>`SELECT created_at,updated_at FROM scheduled_task_fires WHERE task_id=1 ORDER BY fire_at LIMIT 1`.execute(db)).rows[0]!
        expect(row).toEqual({ created_at: '2026-11-14 12:34:56.123000', updated_at: '2026-11-14 12:34:56.123000' })
      }
    } finally {
      await db.destroy()
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})
