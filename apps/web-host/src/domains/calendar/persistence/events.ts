import type { PoolClient } from 'pg'
import { calendarEventRecord } from '@gugu/core/calendar'

/** 在指定 owner 的事务中查找尚未删除的日历事件。 */
export async function findOwnedActiveEvent(client: PoolClient, ownerId: string, eventId: number) {
  const result = await client.query<Record<string, unknown>>(
    `SELECT id, title, date, time, end_time, type, contact_name AS client,
            project_id, description, version, deleted_at
     FROM calendar_events
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [eventId, ownerId],
  )
  const row = result.rows[0]
  return row ? calendarEventRecord(row, Number(row.version || 1)) : null
}
