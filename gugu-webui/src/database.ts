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
] as const

export async function checkDatabaseReadiness(query: DatabaseReadinessQuery): Promise<void> {
  for (const statement of requiredSchemaQueries) await query(statement)
}
