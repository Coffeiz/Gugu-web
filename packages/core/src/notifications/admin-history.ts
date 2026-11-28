import { sql, type Kysely } from 'kysely'
import { utc } from '../data/codec.js'

export interface AdminNotificationHistoryRow {
  id: number
  title: string
  content: string
  color: string
  target: string
  created_at: string
}

/** 管理员发送记录：任务生成的通知不属于后台历史，也不可由此入口删除。 */
export function createNotificationAdminHistory<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres') {
  const createdAt = backend === 'postgres'
    ? sql`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00:00'`
    : sql`created_at`
  return {
    async history(limit = 50): Promise<AdminNotificationHistoryRow[]> {
      const rows = await sql<AdminNotificationHistoryRow>`SELECT id,title,content,color,target,${createdAt} AS created_at
        FROM site_notifications WHERE created_by='admin' ORDER BY created_at DESC
        LIMIT ${Math.max(1, Math.min(limit, 100))}`.execute(db)
      return rows.rows.map(row => ({ ...row, id: Number(row.id), created_at: utc(row.created_at).replace(' ', 'T') }))
    },
    async deleteRecord(id: number): Promise<{ ok: true }> {
      await sql`DELETE FROM site_notifications WHERE id=${id} AND created_by='admin'`.execute(db)
      return { ok: true }
    },
  }
}
