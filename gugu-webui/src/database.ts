export type DatabaseReadinessQuery = (statement: string) => Promise<unknown>

const requiredSchemaQueries = [
  'SELECT 1',
  `SELECT id, username, hashed_password, display_name, email, is_active, account_status,
          security_version, avatar, created_at, timezone, email_subscribed,
          last_active_at
   FROM users LIMIT 0`,
  'SELECT user_id, platform, enabled FROM user_bots LIMIT 0',
  'SELECT id, user_id, tokens_in, tokens_out, created_at, is_byok FROM agent_usage LIMIT 0',
  'SELECT user_id, size_bytes FROM files LIMIT 0',
  'SELECT user_id, category, used_bytes FROM storage_quota_ledgers LIMIT 0',
  `SELECT id, user_id, name, summary, contact_name, status, start_date, deadline,
          color, progress, stages_json, current_stage, priority, version, archived,
          done_at, created_at, updated_at, deleted_at, idempotency_key,
          idempotency_fingerprint FROM projects LIMIT 0`,
  'SELECT project_id, file_count FROM project_file_counts LIMIT 0',
  `SELECT id, user_id, title, date, time, end_time, type, contact_name, project_id,
          description, version, deleted_at, idempotency_key, idempotency_fingerprint
   FROM calendar_events LIMIT 0`,
  'SELECT id, user_id, name, contact, email, phone, notes, created_at FROM clients LIMIT 0',
  `SELECT id, title, content, color, target, bubble, persist, bubble_expire_at, created_at
   FROM site_notifications LIMIT 0`,
  'SELECT id, user_id, notification_id, read_at FROM notification_reads LIMIT 0',
  'SELECT id, user_id, notification_id, dismissed_at FROM notification_dismissals LIMIT 0',
  'SELECT id, user_id, event, properties, created_at FROM frontend_events LIMIT 0',
  `SELECT id, user_id, event_id, reminder_lead_minutes, name, payload, cron,
          schedule_kind, start_at, channels, enabled, delivery_targets
   FROM scheduled_tasks LIMIT 0`,
  `SELECT id, user_id, undo_context_id, group_id, resource, action, target_refs,
          before_state, after_state, base_versions, artifact_refs, actor_type,
          status, created_at, undone_at, expires_at, failure_code
   FROM undo_operations LIMIT 0`,
  `SELECT id, user_id, name, kind, folder_id, project_id, directory_id, enabled,
          is_default, created_at, updated_at FROM workspaces LIMIT 0`,
  `SELECT id, user_id, name, directory_name, is_default, is_system, deleted_at,
          created_at, updated_at FROM workspace_directories LIMIT 0`,
  'SELECT id, user_id FROM folders LIMIT 0',
  'SELECT id, username, action, description, ip, created_at FROM audit_logs LIMIT 0',
  'SELECT category, taken_at, object_count, total_bytes FROM storage_category_snapshots LIMIT 0',
] as const

export async function checkDatabaseReadiness(query: DatabaseReadinessQuery): Promise<void> {
  for (const statement of requiredSchemaQueries) await query(statement)
}
