import type { Pool } from 'pg'

export function createTrackOperations(pool: Pool) {
  return {
    async track(ownerId: string, event: string, properties: Record<string, unknown> | null) {
      await pool.query(
        `INSERT INTO frontend_events (user_id, event, properties, created_at)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [ownerId, event, JSON.stringify(properties), new Date()],
      )
    },
  }
}
