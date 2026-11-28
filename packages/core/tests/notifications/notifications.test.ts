import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { databaseTime } from '../../src/data/codec.js'
import { tablesSql } from '../../src/data/schema.js'
import { createKyselyNotificationOperations } from '../../src/notifications/notifications.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
describe.each(['sqlite', 'postgres'] as const)('通知中心 %s', backend => {
  it.skipIf(backend === 'postgres' && !url)('按 owner 和注册时间过滤、持久已读清除并保障并发幂等', async () => {
    const schema = `notifications_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const sqlite = backend === 'sqlite' ? new SQLite(':memory:') : undefined
    sqlite?.pragma('foreign_keys = ON')
    const db = backend === 'postgres'
      ? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
      : new Kysely<{}>({ dialect: new SqliteDialect({ database: sqlite! }) })
    try {
      const schemaSql = tablesSql(backend)
      for (const statement of [schemaSql.siteNotifications, schemaSql.notificationReads, schemaSql.notificationDismissals])
        await sql.raw(statement).execute(db)
      const a = randomUUID(), b = randomUUID()
      const entries = [
        [1, '旧广播', 'all', '2026-01-01T00:00:00Z', true, true, null],
        [2, '边界广播', 'all', '2026-01-02T00:00:00Z', true, true, null],
        [3, '仅乙', b, '2026-01-03T00:00:00Z', true, true, null],
        [4, '过期气泡', 'all', '2026-01-04T00:00:00Z', true, true, '2026-01-10T00:00:00Z'],
        [5, '临时气泡', a, '2026-01-05T00:00:00Z', true, false, null],
        [6, '新广播', 'all', '2026-01-06T00:00:00.123456Z', false, true, null],
      ] as const
      for (const [id, title, target, created, bubble, persist, expires] of entries) {
        const boolean = (value: boolean) => backend === 'sqlite' ? Number(value) : value
        await sql`INSERT INTO site_notifications(id,title,content,color,target,bubble,persist,bubble_expire_at,created_by,created_at)
          VALUES(${id},${title},'内容','#abc',${target},${boolean(bubble)},${boolean(persist)},${expires ? databaseTime(expires, backend) : null},'admin',${databaseTime(created, backend)})`.execute(db)
      }
      const ops = createKyselyNotificationOperations(db, backend, () => '2026-01-10T00:00:00Z')
      const registered = '2026-01-02T00:00:00Z'
      const visible = await ops.list(a, registered, 30)
      expect(visible.map(row => row.id)).toEqual([6, 4, 2])
      expect(visible.map(row => row.time)).toEqual(['2026-01-06T00:00:00.123456+00:00', '2026-01-04T00:00:00+00:00', '2026-01-02T00:00:00+00:00'])
      expect((await ops.list(a, registered, 1)).map(row => row.id)).toEqual([6])
      expect((await ops.latestBubble(a, registered)).bubble?.id).toBe(5)
      await expect(ops.markRead(a, registered, [5, 999])).rejects.toThrow()
      expect((await sql`SELECT id FROM notification_reads`.execute(db)).rows).toHaveLength(0)
      const read = await Promise.all([ops.markRead(a, registered, [5, 5]), ops.markRead(a, registered, [5])])
      expect(read.reduce((sum, value) => sum + value, 0)).toBe(1)
      expect((await ops.latestBubble(a, registered)).bubble?.id).toBe(2)
      const dismissed = await Promise.all([ops.clear(a, registered), ops.clear(a, registered)])
      expect(dismissed.reduce((sum, value) => sum + value, 0)).toBe(3)
      expect(await ops.list(a, registered, 30)).toEqual([])
      expect((await ops.latestBubble(a, registered)).bubble).toBeNull()
      expect((await ops.list(b, registered, 30)).map(row => row.id)).toEqual([6, 4, 3, 2])
      expect(await ops.markRead(b, registered, null)).toBe(4)
      expect(await ops.markRead(b, registered, [])).toBe(0)
      // 显式 ID 保持 Python 兼容，写入的是调用者自己的 read 行。
      expect(await ops.markRead(a, registered, [3])).toBe(1)
      expect((await ops.list(b, registered, 30)).every(row => !row.unread)).toBe(true)
      expect((await sql`SELECT id FROM site_notifications`.execute(db)).rows).toHaveLength(6)
    } finally {
      await db.destroy()
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})
