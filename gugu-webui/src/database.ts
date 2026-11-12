export type DatabaseReadinessQuery = (statement: string) => Promise<unknown>

const requiredSchemaQueries = [
  'SELECT 1',
  `SELECT id, username, display_name, email, is_active, account_status,
          security_version, avatar, created_at, timezone, email_subscribed,
          last_active_at
   FROM users LIMIT 0`,
  'SELECT user_id, platform, enabled FROM user_bots LIMIT 0',
  `SELECT id, user_id, name, summary, contact_name, status, start_date, deadline,
          color, progress, stages_json, current_stage, priority, version, archived,
          done_at, created_at, updated_at, deleted_at, idempotency_key,
          idempotency_fingerprint FROM projects LIMIT 0`,
  'SELECT project_id, file_count FROM project_file_counts LIMIT 0',
  `SELECT id, user_id, title, date, time, end_time, type, contact_name, project_id,
          description, version, deleted_at FROM calendar_events LIMIT 0`,
  'SELECT id, user_id, name, contact, email, phone, notes, created_at FROM clients LIMIT 0',
  `SELECT id, title, content, color, target, bubble, persist, bubble_expire_at, created_at
   FROM site_notifications LIMIT 0`,
  'SELECT id, user_id, notification_id, read_at FROM notification_reads LIMIT 0',
  'SELECT id, user_id, notification_id, dismissed_at FROM notification_dismissals LIMIT 0',
  'SELECT id, user_id, event, properties, created_at FROM frontend_events LIMIT 0',
] as const

export async function checkDatabaseReadiness(query: DatabaseReadinessQuery): Promise<void> {
  for (const statement of requiredSchemaQueries) await query(statement)
}
