import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'

type Backend = 'sqlite' | 'postgres'
type Notice = { id: number; title: string; content: string; color: string; created_at: string; unread?: boolean | number }
const columns = sql`n.id,n.title,n.content,n.color`
const iso = (value: string) => utc(value).replace(' ', 'T')

/** 用户可见通知及个人已读、清除状态；身份与注册时间由 Host 提供。 */
export function createKyselyNotificationOperations<DB>(db: Kysely<DB>, backend: Backend, clock: Clock = nowUtc) {
  function viewer(rawOwner: string, registered: Date | string) {
    const owner = dataContext(rawOwner).ownerId
    return { owner, storedOwner: backend === 'sqlite' ? owner.replaceAll('-', '') : owner,
      registered: databaseTime(registered instanceof Date ? registered.toISOString() : registered, backend) }
  }
  const now = () => databaseTime(clock(), backend)
  // PG 驱动默认将 timestamptz 转成 Date，会丢失毫秒之后的精度。
  const createdAt = backend === 'postgres'
    ? sql`to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`
    : sql`n.created_at`
  return {
    async list(rawOwner: string, registered: Date | string, limit: number) {
      const v = viewer(rawOwner, registered)
      const result = await sql<Notice>`SELECT ${columns},${createdAt} AS created_at,(r.id IS NULL) AS unread FROM site_notifications n
        LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=${v.storedOwner}
        LEFT JOIN notification_dismissals d ON d.notification_id=n.id AND d.user_id=${v.storedOwner}
        WHERE (n.target='all' OR n.target=${v.owner}) AND n.created_at>=${v.registered} AND n.persist=TRUE AND d.id IS NULL
        ORDER BY n.created_at DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`.execute(db)
      return result.rows.map(row => ({ id: Number(row.id), title: row.title, content: row.content, color: row.color, time: iso(row.created_at), unread: Boolean(row.unread) }))
    },
    async latestBubble(rawOwner: string, registered: Date | string) {
      const v = viewer(rawOwner, registered)
      const result = await sql<Notice>`SELECT ${columns} FROM site_notifications n
        LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=${v.storedOwner}
        LEFT JOIN notification_dismissals d ON d.notification_id=n.id AND d.user_id=${v.storedOwner}
        WHERE (n.target='all' OR n.target=${v.owner}) AND n.created_at>=${v.registered} AND n.bubble=TRUE
          AND (n.bubble_expire_at IS NULL OR n.bubble_expire_at>${now()}) AND r.id IS NULL AND d.id IS NULL
        ORDER BY n.created_at DESC LIMIT 1`.execute(db)
      const row = result.rows[0]
      return { bubble: row ? { id: Number(row.id), title: row.title, content: row.content, color: row.color } : null }
    },
    async markRead(rawOwner: string, registered: Date | string, ids: number[] | null) {
      const v = viewer(rawOwner, registered), timestamp = now()
      // 兼容既有 Python/Host：显式 ID 只约束当前用户的 read 行，不筛选通知可见性。
      const result = ids?.length
        ? await sql`INSERT INTO notification_reads(user_id,notification_id,read_at) VALUES ${sql.join(ids.map(id => sql`(${v.storedOwner},${id},${timestamp})`))} ON CONFLICT(user_id,notification_id) DO NOTHING RETURNING id`.execute(db)
        : await sql`INSERT INTO notification_reads(user_id,notification_id,read_at)
          SELECT ${v.storedOwner},n.id,${timestamp} FROM site_notifications n WHERE (n.target='all' OR n.target=${v.owner}) AND n.created_at>=${v.registered}
          ON CONFLICT(user_id,notification_id) DO NOTHING RETURNING id`.execute(db)
      return result.rows.length
    },
    async clear(rawOwner: string, registered: Date | string) {
      const v = viewer(rawOwner, registered)
      const result = await sql`INSERT INTO notification_dismissals(user_id,notification_id,dismissed_at)
        SELECT ${v.storedOwner},n.id,${now()} FROM site_notifications n WHERE (n.target='all' OR n.target=${v.owner}) AND n.created_at>=${v.registered} AND n.persist=TRUE
        ON CONFLICT(user_id,notification_id) DO NOTHING RETURNING id`.execute(db)
      return result.rows.length
    },
  }
}
