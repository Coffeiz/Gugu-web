import type { Pool, PoolClient } from 'pg'
import { calendarEventRecord, calendarEventResponse } from '../event-projection.js'

interface CalendarEventRow {
  id: number
  title: string
  date: string
  time: string | null
  end_time: string | null
  type: string
  client: string | null
  project_id: number | null
  description: string | null
  version: number
}

function eventResponse(event: CalendarEventRow) {
  return calendarEventResponse(event)
}

const eventColumns = `id, title, date, time, end_time, type,
  contact_name AS client, project_id, description, version`

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

export function createEventOperations(pool: Pool) {
  return {
    async list(ownerId: string, year?: number, month?: number): Promise<unknown[]> {
      const parameters: Array<string | number> = [ownerId]
      let statement = `SELECT ${eventColumns}
                       FROM calendar_events
                       WHERE user_id = $1 AND deleted_at IS NULL`
      if (year && month) {
        parameters.push(`${year}-${String(month).padStart(2, '0')}%`)
        statement += ` AND date LIKE $${parameters.length}`
      }
      statement += ' ORDER BY date'
      const result = await pool.query<CalendarEventRow>(statement, parameters)
      return result.rows.map(eventResponse)
    },
    async get(ownerId: string, eventId: number): Promise<unknown | null> {
      const result = await pool.query<CalendarEventRow>(
        `SELECT ${eventColumns}
         FROM calendar_events
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [eventId, ownerId],
      )
      const event = result.rows[0]
      return event ? eventResponse(event) : null
    },
  }
}
