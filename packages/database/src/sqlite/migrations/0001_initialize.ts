import { randomUUID } from 'node:crypto'
import type SQLite from 'better-sqlite3'
import { SCHEMA_VERSION, SQLITE_AGENT_SCHEMA, tablesSql } from '../../schema.js'
import { SQLITE_INTERACTION_PROMPTS_SCHEMA } from '../interaction-prompts.js'
import { SQLITE_INTERACTION_ACTIONS_SCHEMA } from '../interaction-actions.js'

export const SQLITE_INITIAL_REVISION = '0001_initialize'

export const SMTP_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_smtp_owner_${action.toLowerCase()} BEFORE ${action} ON user_smtp_configs WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
export const ONBOARDING_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_onboarding_owner_${action.toLowerCase()} BEFORE ${action} ON onboarding_state WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
export const FEEDBACK_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_feedback_owner_${action.toLowerCase()} BEFORE ${action} ON feedbacks WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
export const PREFERENCES_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_preferences_owner_${action.toLowerCase()} BEFORE ${action} ON user_preferences WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
export const MCP_OWNER_TRIGGERS = ['user_mcp_servers','user_mcp_tool_schema_snapshots'].flatMap(table => ['INSERT','UPDATE'].map(action => `CREATE TRIGGER validate_${table}_owner_${action.toLowerCase()} BEFORE ${action} ON ${table} WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`))

function createIndexes(db: SQLite.Database): void {
  db.exec(
    'CREATE INDEX ix_projects_user_id ON projects(user_id); CREATE INDEX ix_projects_deleted_at ON projects(deleted_at); CREATE INDEX ix_clients_user_id ON clients(user_id)',
  )
}
function createUndoIndexes(db: SQLite.Database): void {
  db.exec('CREATE INDEX ix_undo_operations_context_status_created ON undo_operations(user_id,undo_context_id,status,created_at); CREATE INDEX ix_undo_operations_group ON undo_operations(user_id,group_id)')
}
function createMindIndexes(db: SQLite.Database): void {
  db.exec('CREATE INDEX ix_mind_nodes_user_id ON mind_nodes(user_id); CREATE INDEX ix_mind_nodes_captured_at ON mind_nodes(captured_at); CREATE INDEX ix_mind_nodes_deleted_at ON mind_nodes(deleted_at)')
}
function createCanvasIndexes(db: SQLite.Database): void {
  db.exec('CREATE INDEX ix_mind_maps_user_id ON mind_maps(user_id); CREATE INDEX ix_mind_maps_deleted_at ON mind_maps(deleted_at)')
}
function createCalendarIndexes(db: SQLite.Database): void {
  db.exec('CREATE INDEX ix_calendar_events_user_id ON calendar_events(user_id); CREATE INDEX ix_calendar_events_deleted_at ON calendar_events(deleted_at); CREATE INDEX ix_rag_index_jobs_user_id ON rag_index_jobs(user_id); CREATE INDEX ix_rag_index_jobs_due ON rag_index_jobs(status,next_attempt_at)')
}
function createRagIndexIndexes(db: SQLite.Database): void {
  db.exec(tablesSql('sqlite').ragIndexIndexes.join(';'))
}
function createMindRelationIndexes(db: SQLite.Database): void {
  db.exec('CREATE INDEX ix_mind_canvas_items_user_id ON mind_canvas_items(user_id); CREATE INDEX ix_mind_canvas_items_canvas_id ON mind_canvas_items(canvas_id); CREATE INDEX ix_mind_canvas_items_node_id ON mind_canvas_items(node_id); CREATE INDEX ix_mind_canvas_items_deleted_at ON mind_canvas_items(deleted_at); CREATE INDEX ix_mind_relations_user_id ON mind_relations(user_id); CREATE INDEX ix_mind_relations_canvas_id ON mind_relations(canvas_id); CREATE INDEX ix_mind_relations_src_node_id ON mind_relations(src_node_id); CREATE INDEX ix_mind_relations_dst_node_id ON mind_relations(dst_node_id); CREATE INDEX ix_mind_relations_deleted_at ON mind_relations(deleted_at); CREATE UNIQUE INDEX uq_mind_relation_legacy ON mind_relations(user_id,src_node_id,dst_node_id,rel_type,edge_key) WHERE canvas_id IS NULL')
}
function createScheduledTaskIndexes(db: SQLite.Database): void {
  db.exec('CREATE INDEX ix_scheduled_tasks_user_id ON scheduled_tasks(user_id); CREATE INDEX ix_scheduled_tasks_event_id ON scheduled_tasks(event_id); CREATE INDEX ix_scheduled_tasks_workspace_id ON scheduled_tasks(workspace_id); CREATE INDEX ix_scheduled_tasks_filesystem_authorization_grant_id ON scheduled_tasks(filesystem_authorization_grant_id); CREATE INDEX ix_scheduled_tasks_schedule_kind ON scheduled_tasks(schedule_kind); CREATE INDEX ix_scheduled_tasks_end_at ON scheduled_tasks(end_at); CREATE UNIQUE INDEX uq_scheduled_tasks_event_fire ON scheduled_tasks(user_id,event_id,cron) WHERE event_id IS NOT NULL')
}
function createNotificationIndexes(db: SQLite.Database): void {
  db.exec('CREATE INDEX ix_notification_reads_user_id ON notification_reads(user_id); CREATE INDEX ix_notification_reads_notification_id ON notification_reads(notification_id); CREATE INDEX ix_notification_dismissals_user_id ON notification_dismissals(user_id); CREATE INDEX ix_notification_dismissals_notification_id ON notification_dismissals(notification_id)')
}
function createMcpIndexes(db: SQLite.Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS ix_user_mcp_servers_user_id ON user_mcp_servers(user_id)')
  for (const trigger of MCP_OWNER_TRIGGERS) db.exec(trigger.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS '))
}
export function initializeSchema(db: SQLite.Database): void {
  const schema = tablesSql('sqlite')
  db.exec(
    `${schema.projects}; ${schema.clients}; ${schema.receipts}; ${schema.undo}; ${schema.mindNodes}; ${schema.mindMaps}; ${schema.calendarEvents}; ${schema.ragJobs}; ${schema.ragIndexEntries}; ${schema.mindItems}; ${schema.mindRelations}; ${schema.scheduledTasks}; ${schema.scheduledFires}; ${schema.siteNotifications}; ${schema.notificationReads}; ${schema.notificationDismissals}; ${schema.userSmtp}; ${schema.onboarding}; ${schema.feedback}; ${schema.userPreferences}; ${schema.mcpServers}; ${schema.mcpSnapshots}; CREATE TABLE core_runtime_meta (key VARCHAR(50) PRIMARY KEY NOT NULL,value VARCHAR(100) NOT NULL);`,
  )
  createIndexes(db)
  createUndoIndexes(db)
  createMindIndexes(db)
  createCanvasIndexes(db)
  createCalendarIndexes(db)
  createRagIndexIndexes(db)
  createMindRelationIndexes(db)
  createScheduledTaskIndexes(db)
  createNotificationIndexes(db)
  const insert = db.prepare('INSERT INTO core_runtime_meta (key,value) VALUES (?,?)')
  insert.run('schema_version', SCHEMA_VERSION)
  insert.run('owner_id', randomUUID())
  insert.run('migration_revision', SQLITE_INITIAL_REVISION)
  db.exec('CREATE INDEX ix_user_smtp_configs_enabled ON user_smtp_configs(enabled)')
  createMcpIndexes(db)
  for (const trigger of SMTP_OWNER_TRIGGERS) db.exec(trigger)
  for (const trigger of ONBOARDING_OWNER_TRIGGERS) db.exec(trigger)
  for (const trigger of FEEDBACK_OWNER_TRIGGERS) db.exec(trigger)
  for (const trigger of PREFERENCES_OWNER_TRIGGERS) db.exec(trigger)
  db.exec(SQLITE_AGENT_SCHEMA)
  db.exec(SQLITE_INTERACTION_PROMPTS_SCHEMA)
  db.exec(SQLITE_INTERACTION_ACTIONS_SCHEMA)
}
