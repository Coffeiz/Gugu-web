import type { Pool } from 'pg'
import type { AdminFeedbackOperations } from '../feedback.js'

export function createPostgresFeedbackOperations(pool: Pool) {
  return {
    async submit(ownerId: string, username: string, category: string, content: string): Promise<void> {
      await pool.query(
        `INSERT INTO feedbacks (user_id, username, category, content)
         VALUES ($1, $2, $3, $4)`,
        [ownerId, username, category, content],
      )
    },
    async list(page: number, pageSize: number, category: string) {
      const values: unknown[] = []
      const where = category ? (values.push(category), `WHERE category = $${values.length}`) : ''
      const total = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM feedbacks ${where}`,
        values,
      )
      values.push(pageSize, (page - 1) * pageSize)
      const rows = await pool.query<{
        id: number
        username: string
        category: string
        content: string
        created_at: Date
      }>(
        `SELECT id, username, category, content, created_at
         FROM feedbacks ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )
      return {
        total: Number(total.rows[0]?.total ?? 0),
        items: rows.rows.map((row) => ({
          id: row.id,
          username: row.username,
          category: row.category,
          content: row.content,
          createdAt: row.created_at.toISOString(),
        })),
      }
    },
  } satisfies { submit(ownerId: string, username: string, category: string, content: string): Promise<void> } & AdminFeedbackOperations
}
