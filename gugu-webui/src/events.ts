import type { Pool } from 'pg'

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
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    endTime: event.end_time,
    type: event.type,
    client: event.client,
    projectId: event.project_id,
    description: event.description,
    version: event.version || 1,
  }
}

const eventColumns = `id, title, date, time, end_time, type,
  contact_name AS client, project_id, description, version`

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
