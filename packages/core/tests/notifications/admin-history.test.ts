import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { tablesSql } from '../../src/data/schema.js'
import { createNotificationAdminHistory } from '../../src/notifications/admin-history.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
describe.each(['sqlite', 'postgres'] as const)('管理员通知历史 %s', backend => {
it.skipIf(backend === 'postgres' && !url)('管理员历史排除任务通知，限制条数且删除不会影响非管理员记录', async () => {
  const schema = `notification_admin_${randomUUID().replaceAll('-', '')}`
  const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : null
  if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
  const db = backend === 'postgres'
    ? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
    : new Kysely<{}>({ dialect: new SqliteDialect({ database: new SQLite(':memory:') }) })
  try {
    await sql.raw(tablesSql(backend).siteNotifications).execute(db)
    for (const [id, creator, day] of [[1, 'admin', '01'], [2, 'scheduled_task', '03'], [3, 'admin', '02']] as const)
      await sql`INSERT INTO site_notifications(id,title,content,color,target,bubble,persist,created_by,created_at)
        VALUES(${id},'合成通知','内容','#abc','all',${backend === 'sqlite' ? 1 : true},${backend === 'sqlite' ? 1 : true},${creator},${`2026-01-${day} 00:00:00.123456+00:00`})`.execute(db)
    const ops = createNotificationAdminHistory(db, backend)
    expect((await ops.history(0)).map(r => r.id)).toEqual([3])
    expect((await ops.history(200)).map(r => r.id)).toEqual([3, 1])
    expect((await ops.history(50))[0]).toEqual({ id: 3, title: '合成通知', content: '内容', color: '#abc', target: 'all', created_at: '2026-01-02T00:00:00.123456+00:00' })
    expect(await ops.deleteRecord(2)).toEqual({ ok: true })
    expect(await ops.deleteRecord(3)).toEqual({ ok: true })
    expect(await ops.deleteRecord(3)).toEqual({ ok: true })
    expect((await sql<{id: number}>`SELECT id FROM site_notifications ORDER BY id`.execute(db)).rows.map(r => r.id)).toEqual([1, 2])
  } finally {
    await db.destroy()
    if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
  }
})
})
