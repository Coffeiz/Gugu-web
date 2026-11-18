import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { tablesSql } from '../../src/data/schema.js'
import { databaseTime } from '../../src/data/codec.js'
import { createKyselyScheduledFireReceipts } from '../../src/scheduled-tasks/fire-receipts.js'
import { createKyselyRepeatingTaskRepository } from '../../src/scheduled-tasks/repeating-repository.js'

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

  it.skipIf(backend === 'postgres' && !url)('改期后旧回调无法执行，另一 owner 也无法启动任务', async () => {
    const schema = `repeat_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const db = backend === 'postgres'
      ? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
      : new Kysely<{}>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
    try {
      await sql.raw(tablesSql(backend).scheduledTasks).execute(db)
      const userId = randomUUID()
      const storedOwner = backend === 'sqlite' ? userId.replaceAll('-', '') : userId
      const updatedAt = databaseTime('2026-11-14T12:00:00.123000Z', backend)
      const rescheduledAt = databaseTime('2026-11-14T12:00:00.123001Z', backend)
      const now = Date.parse('2026-11-14T12:05:00Z')
      await sql`INSERT INTO scheduled_tasks
        (id,user_id,name,payload,cron,schedule_kind,interval_minutes,channels,enabled,created_at,updated_at)
        VALUES (1,${storedOwner},'计划','测试','','interval',5,'web',TRUE,${updatedAt},${updatedAt})`.execute(db)
      const repo = createKyselyRepeatingTaskRepository(db, backend)
      const [original] = await repo.list(now)
      expect(original).toMatchObject({ userId, intervalMinutes: 5 })
      expect(await repo.isCurrent(original!, now)).toBe(true)
      await sql`UPDATE scheduled_tasks SET interval_minutes=10,updated_at=${rescheduledAt} WHERE id=1`.execute(db)
      expect(await repo.isCurrent(original!, now)).toBe(false)
      expect(await repo.markStarted(original!, now)).toBe(false)
      const [current] = await repo.list(now)
      expect(current).toMatchObject({ userId, intervalMinutes: 10 })
      expect(await repo.markStarted({ ...current!, userId: randomUUID() }, now)).toBe(false)
      expect(await repo.markStarted(current!, now)).toBe(true)
      expect(await repo.isCurrent(current!, now)).toBe(true)
      const confirmations: string[] = []
      const effects = {
        async revokeConfirmation(_owner: string, _summary: string, identity: string) { confirmations.push(identity) },
        fingerprint: () => 'synthetic-fingerprint',
      }
      expect(await repo.stopAfterRun(original!, effects)).toBe(false)
      expect(await repo.stopAfterRun({ ...current!, userId: randomUUID() }, effects)).toBe(false)
      await sql`UPDATE scheduled_tasks SET event_id=42 WHERE id=1`.execute(db)
      expect(await repo.stopAfterRun(current!, effects)).toBe(false)
      expect(confirmations).toEqual([])
      await sql`UPDATE scheduled_tasks SET event_id=NULL WHERE id=1`.execute(db)
      await expect(repo.stopAfterRun(current!, effects, async () => { throw new Error('租约已失效') }))
        .rejects.toThrow('租约已失效')
      expect(await repo.isCurrent(current!, now)).toBe(true)
      if (backend === 'postgres') {
        await sql`CREATE TABLE filesystem_authorization_grants
          (id integer PRIMARY KEY,user_id uuid,revoked_at timestamptz,updated_at timestamptz)`.execute(db)
        await sql`INSERT INTO filesystem_authorization_grants(id,user_id) VALUES (3,${storedOwner})`.execute(db)
        await sql`UPDATE scheduled_tasks SET filesystem_authorization_grant_id=3 WHERE id=1`.execute(db)
        // 审计写入失败时，停用状态和授权必须一同回滚。
        await expect(repo.stopAfterRun(current!, effects)).rejects.toThrow('security_events')
        const task = await sql`SELECT enabled,filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=1`.execute(db)
        expect(task.rows).toEqual([{ enabled: true, filesystem_authorization_grant_id: 3 }])
        const grants = await sql`SELECT revoked_at FROM filesystem_authorization_grants WHERE id=3`.execute(db)
        expect(grants.rows).toEqual([{ revoked_at: null }])
        await sql`CREATE TABLE security_events(user_id uuid,event_type text,resource_type text,resource_fingerprint text,
          owner_fingerprint text,client_fingerprint text,ip_fingerprint text,user_agent_fingerprint text,action text,
          reason_code text,metadata_json json,occurred_at timestamptz,expires_at timestamptz)`.execute(db)
      }
      expect(await repo.stopAfterRun(current!, effects)).toBe(true)
      expect(await repo.stopAfterRun(current!, effects)).toBe(false)
      expect(await repo.list(now)).toEqual([])
      if (backend === 'postgres') {
        const grants = await sql`SELECT revoked_at FROM filesystem_authorization_grants WHERE id=3`.execute(db)
        expect(grants.rows).toEqual([{ revoked_at: expect.any(Date) }])
        const events = await sql`SELECT reason_code,resource_fingerprint FROM security_events`.execute(db)
        expect(events.rows).toEqual([{ reason_code: 'revoked', resource_fingerprint: 'synthetic-fingerprint' }])
      }
    } finally {
      await db.destroy()
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})
