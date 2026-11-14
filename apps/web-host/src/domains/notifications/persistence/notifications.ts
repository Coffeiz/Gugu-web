import type { Pool } from 'pg'

interface NotificationRow {
  id: number
  title: string
  content: string
  color: string
  time: string
  unread?: boolean
}

function timestampExpression(column: string) {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') ||
    CASE WHEN date_trunc('second', ${column}) = ${column}
         THEN '' ELSE '.' || to_char(${column} AT TIME ZONE 'UTC', 'US') END || '+00:00'`
}

const notificationColumns = `notification.id, notification.title, notification.content, notification.color,
  ${timestampExpression('notification.created_at')} AS time`
const notificationViewerScope = `
  FROM site_notifications AS notification
  LEFT JOIN notification_reads AS read
    ON read.notification_id = notification.id AND read.user_id = $1
  LEFT JOIN notification_dismissals AS dismissal
    ON dismissal.notification_id = notification.id AND dismissal.user_id = $1
  WHERE (notification.target = 'all' OR notification.target = $2)
    AND notification.created_at >= $3`

export function createNotificationOperations(pool: Pool) {
  return {
    async list(ownerId: string, userCreatedAt: Date | string, requestedLimit: number) {
      const limit = Math.max(1, Math.min(requestedLimit, 100))
      const result = await pool.query<NotificationRow>(
        `SELECT ${notificationColumns}, (read.id IS NULL) AS unread
         ${notificationViewerScope}
           AND notification.persist IS TRUE
           AND dismissal.id IS NULL
         ORDER BY notification.created_at DESC LIMIT $4`,
        [ownerId, ownerId, userCreatedAt, limit],
      )
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        content: row.content,
        color: row.color,
        time: row.time,
        unread: row.unread,
      }))
    },

    async latestBubble(ownerId: string, userCreatedAt: Date | string) {
      const result = await pool.query<NotificationRow>(
        `SELECT ${notificationColumns}
         ${notificationViewerScope}
           AND notification.bubble IS TRUE
           AND (notification.bubble_expire_at IS NULL OR notification.bubble_expire_at > $4)
           AND read.id IS NULL
           AND dismissal.id IS NULL
         ORDER BY notification.created_at DESC
         LIMIT 1`,
        [ownerId, ownerId, userCreatedAt, new Date()],
      )
      const row = result.rows[0]
      return {
        bubble: row
          ? { id: row.id, title: row.title, content: row.content, color: row.color }
          : null,
      }
    },

    async markRead(ownerId: string, userCreatedAt: Date | string, ids: number[] | null) {
      const now = new Date()
      const result = ids?.length
        ? await pool.query(
          `INSERT INTO notification_reads (user_id, notification_id, read_at)
           SELECT $1, target.id, $3 FROM unnest($2::integer[]) AS target(id)
           ON CONFLICT (user_id, notification_id) DO NOTHING
           RETURNING id`,
          [ownerId, ids, now],
        )
        : await pool.query(
          `INSERT INTO notification_reads (user_id, notification_id, read_at)
           SELECT $1, notification.id, $3
           FROM site_notifications AS notification
           WHERE (notification.target = 'all' OR notification.target = $4)
             AND notification.created_at >= $2
           ON CONFLICT (user_id, notification_id) DO NOTHING
           RETURNING id`,
          [ownerId, userCreatedAt, now, ownerId],
        )
      return result.rows.length
    },

    async clear(ownerId: string, userCreatedAt: Date | string) {
      const result = await pool.query(
        `INSERT INTO notification_dismissals (user_id, notification_id, dismissed_at)
         SELECT $1, notification.id, $3
         FROM site_notifications AS notification
         WHERE (notification.target = 'all' OR notification.target = $4)
           AND notification.created_at >= $2
           AND notification.persist IS TRUE
         ON CONFLICT (user_id, notification_id) DO NOTHING
         RETURNING id`,
        [ownerId, userCreatedAt, new Date(), ownerId],
      )
      return result.rows.length
    },
  }
}
