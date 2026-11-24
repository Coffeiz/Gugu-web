import type { ColumnType, Generated } from 'kysely'
import { CORE_SCHEMA_VERSION } from './version.js'

export interface ProjectTable {
  id: Generated<number>
  user_id: string
  name: string
  summary: string | null
  contact_name: string | null
  status: string
  start_date: string | null
  deadline: string | null
  color: string
  progress: number
  stages_json: string
  current_stage: string | null
  priority: string | null
  version: number
  archived: boolean | number
  done_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  idempotency_key: string | null
  idempotency_fingerprint: string | null
}
export interface ClientTable {
  id: Generated<number>
  user_id: string
  name: string
  contact: string | null
  email: string | null
  phone: string | null
  notes: string
  created_at: string
}
export interface ReceiptTable {
  owner_id: string
  operation_id: string
  fingerprint: string
  method: string
  result_json: string
  created_at: string
}
export interface UndoTable {
  id: string
  user_id: string
  undo_context_id: string
  group_id: string
  resource: string
  action: string
  target_refs: ColumnType<unknown, string, string>
  before_state: ColumnType<unknown, string, string>
  after_state: ColumnType<unknown, string, string>
  base_versions: ColumnType<unknown, string, string>
  artifact_refs: ColumnType<unknown, string, string>
  actor_type: string
  status: string
  created_at: string
  undone_at: string | null
  expires_at: string | null
  failure_code: string | null
}
export interface MindNodeTable {
  id: Generated<number>; user_id: string; kind: string; title: string | null
  content_md: string; content_plain: string; color: string | null
  ref_type: string | null; ref_id: number | null; ref_snapshot: string | null
  origin: string; indexed_at: string | null; indexed_hash: string | null
  version: number; captured_at: string; created_at: string; updated_at: string; deleted_at: string | null
}
export interface MindCanvasTable {
  id: Generated<number>; user_id: string; title: string; project_id: number | null
  data_json: string; created_at: string; updated_at: string; deleted_at: string | null
}
export interface MindCanvasItemTable {
  id: Generated<number>; user_id: string; canvas_id: number; node_id: number
  x: number; y: number; w: number | null; h: number | null; z: number
  collapsed: boolean | number; data_json: string; created_at: string; updated_at: string; deleted_at: string | null
}
export interface MindRelationTable {
  id: Generated<number>; user_id: string; canvas_id: number | null; src_node_id: number; dst_node_id: number
  rel_type: string; edge_key: string; origin: string; status: string; note: string | null
  created_at: string; updated_at: string; deleted_at: string | null
}
/** 可重建的 RAG 投影；事实正文仍由对应领域来源提供。 */
export interface RagIndexEntryTable {
  id: Generated<number>; owner_user_id: string; source_type: string; source_id: string
  scope_type: string; scope_id: string; platform: string; bot_id: string; group_id: string
  document_id: string; parent_document_id: string | null; document_version: string
  chunk_index: number; chunk_count: number; title: string; summary: string; content: string
  content_hash: string; metadata_json: ColumnType<unknown, string, string>
  source_updated_at: string | null; indexed_at: string; deleted_at: string | null
}
export interface SiteNotificationTable {
  id: Generated<number>; title: string; content: string; color: string; target: string
  bubble: boolean | number; persist: boolean | number; bubble_expire_at: string | null
  created_by: string; created_at: string
}
export interface NotificationReadTable { id: Generated<number>; user_id: string; notification_id: number; read_at: string }
export interface NotificationDismissalTable { id: Generated<number>; user_id: string; notification_id: number; dismissed_at: string }
export interface UserSmtpConfigTable {
  id: Generated<number>; user_id: string; host: string; port: number; user: string; password: string
  from_addr: string; use_ssl: boolean | number; enabled: boolean | number; updated_at: string
}
export interface UserMcpServerTable {
  id: string; user_id: string | null; scope: string; name: string; transport: string
  endpoint: string; encrypted_endpoint: string; endpoint_nonce: string; encrypted_endpoint_key: string
  endpoint_key_version: number; command: string; auth_mode: string; encrypted_headers: string
  headers_nonce: string; encrypted_headers_key: string; headers_key_version: number
  encrypted_query_params: string; query_params_nonce: string; encrypted_query_params_key: string
  query_params_key_version: number; credential_slots: ColumnType<unknown, string, string>
  encrypted_credentials: string; credentials_nonce: string; encrypted_credentials_key: string
  credentials_key_version: number; enabled: boolean | number; confirm_mode: string; timeout_seconds: number
  tool_allowlist: ColumnType<unknown, string, string>; created_at: string; updated_at: string
}
export interface McpToolSchemaSnapshotTable {
  user_id: string; config_digest: string; schemas: ColumnType<unknown, string, string>; refreshed_at: string
}
export interface CalendarEventTable {
  id: Generated<number>; user_id: string; title: string; date: string; time: string | null; end_time: string | null
  type: string; contact_name: string | null; project_id: number | null; description: string | null; version: number
  created_at: string; deleted_at: string | null; idempotency_key: string | null; idempotency_fingerprint: string | null
}
export interface ScheduledTaskTable {
  execution_mode: Generated<'reminder' | 'instruction'>
  id: Generated<number>; user_id: string; event_id: number | null; reminder_lead_minutes: number | null
  workspace_id: number | null; filesystem_authorization_grant_id: number | null; name: string; payload: string; cron: string
  schedule_kind: string; interval_minutes: number | null; start_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  end_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>; channels: string; enabled: boolean | number
  delivery_targets: ColumnType<unknown, string, string>; authorized_tools: ColumnType<unknown, string, string>
  email_attachment_file_paths: ColumnType<unknown, string, string>; last_run_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  last_run_failed: boolean | number | null; created_at: string; updated_at: string
}
export interface Database {
  projects: ProjectTable
  clients: ClientTable
  core_runtime_meta: { key: string; value: string }
  core_operation_receipts: ReceiptTable
  undo_operations: UndoTable
  mind_nodes: MindNodeTable
  mind_maps: MindCanvasTable
  mind_canvas_items: MindCanvasItemTable
  mind_relations: MindRelationTable
  knowledge_index_entries: RagIndexEntryTable
  site_notifications: SiteNotificationTable
  notification_reads: NotificationReadTable
  notification_dismissals: NotificationDismissalTable
  user_smtp_configs: UserSmtpConfigTable
  user_mcp_servers: UserMcpServerTable
  user_mcp_tool_schema_snapshots: McpToolSchemaSnapshotTable
  calendar_events: CalendarEventTable
  scheduled_tasks: ScheduledTaskTable
}
export const PROJECT_COLUMNS = [
  'id',
  'user_id',
  'name',
  'summary',
  'contact_name',
  'status',
  'start_date',
  'deadline',
  'color',
  'progress',
  'stages_json',
  'current_stage',
  'priority',
  'version',
  'archived',
  'done_at',
  'created_at',
  'updated_at',
  'deleted_at',
  'idempotency_key',
  'idempotency_fingerprint',
]
export const CLIENT_COLUMNS = [
  'id',
  'user_id',
  'name',
  'contact',
  'email',
  'phone',
  'notes',
  'created_at',
]
export const RECEIPT_COLUMNS = [
  'owner_id',
  'operation_id',
  'fingerprint',
  'method',
  'result_json',
  'created_at',
]
export const UNDO_COLUMNS = [
  'id', 'user_id', 'undo_context_id', 'group_id', 'resource', 'action', 'target_refs',
  'before_state', 'after_state', 'base_versions', 'artifact_refs', 'actor_type', 'status',
  'created_at', 'undone_at', 'expires_at', 'failure_code',
]
export const MIND_NODE_COLUMNS = [
  'id', 'user_id', 'kind', 'title', 'content_md', 'content_plain', 'color', 'ref_type', 'ref_id',
  'ref_snapshot', 'origin', 'indexed_at', 'indexed_hash', 'version', 'captured_at', 'created_at', 'updated_at', 'deleted_at',
]
export const MIND_CANVAS_COLUMNS = ['id', 'user_id', 'title', 'project_id', 'data_json', 'created_at', 'updated_at', 'deleted_at']
export const CALENDAR_EVENT_COLUMNS = ['id', 'user_id', 'title', 'date', 'time', 'end_time', 'type', 'contact_name', 'project_id', 'description', 'version', 'created_at', 'deleted_at', 'idempotency_key', 'idempotency_fingerprint']
export const RAG_JOB_COLUMNS = ['id', 'user_id', 'source_type', 'source_id', 'pending_source_ids', 'version', 'operation', 'status', 'generation', 'completed_generation', 'attempts', 'next_attempt_at', 'lease_until', 'last_error_code', 'last_started_at', 'last_succeeded_at', 'created_at', 'updated_at']
export const RAG_INDEX_COLUMNS = ['id', 'owner_user_id', 'source_type', 'source_id', 'scope_type', 'scope_id', 'platform', 'bot_id', 'group_id', 'document_id', 'parent_document_id', 'document_version', 'chunk_index', 'chunk_count', 'title', 'summary', 'content', 'content_hash', 'metadata_json', 'source_updated_at', 'indexed_at', 'deleted_at']
export const MIND_ITEM_COLUMNS = ['id', 'user_id', 'canvas_id', 'node_id', 'x', 'y', 'w', 'h', 'z', 'collapsed', 'data_json', 'created_at', 'updated_at', 'deleted_at']
export const MIND_RELATION_COLUMNS = ['id', 'user_id', 'canvas_id', 'src_node_id', 'dst_node_id', 'rel_type', 'edge_key', 'origin', 'status', 'note', 'created_at', 'updated_at', 'deleted_at']
export const SCHEDULED_TASK_COLUMNS = ['id', 'user_id', 'event_id', 'reminder_lead_minutes', 'workspace_id', 'filesystem_authorization_grant_id', 'name', 'payload', 'cron', 'schedule_kind', 'interval_minutes', 'start_at', 'end_at', 'channels', 'enabled', 'delivery_targets', 'authorized_tools', 'email_attachment_file_paths', 'last_run_at', 'last_run_failed', 'created_at', 'updated_at']
export const SCHEDULED_FIRE_COLUMNS = ['task_id', 'fire_at', 'lease_owner', 'status', 'created_at', 'updated_at']
export const SITE_NOTIFICATION_COLUMNS = ['id', 'title', 'content', 'color', 'target', 'bubble', 'persist', 'bubble_expire_at', 'created_by', 'created_at']
export const NOTIFICATION_READ_COLUMNS = ['id', 'user_id', 'notification_id', 'read_at']
export const NOTIFICATION_DISMISSAL_COLUMNS = ['id', 'user_id', 'notification_id', 'dismissed_at']
export const USER_SMTP_COLUMNS = ['id', 'user_id', 'host', 'port', 'user', 'password', 'from_addr', 'use_ssl', 'enabled', 'updated_at']
export const SCHEMA_VERSION = String(CORE_SCHEMA_VERSION)
export function tablesSql(backend: 'sqlite' | 'postgres'): {
  projects: string
  clients: string
  receipts: string
  undo: string
  mindNodes: string
  mindMaps: string
  calendarEvents: string
  ragJobs: string
  ragIndexEntries: string
  ragIndexIndexes: string[]
  mindItems: string
  mindRelations: string
  scheduledTasks: string
  scheduledFires: string
  siteNotifications: string
  notificationReads: string
  notificationDismissals: string
  userSmtp: string
  onboarding: string
  feedback: string
  userPreferences: string
  mcpServers: string
  mcpSnapshots: string
} {
  const id = backend === 'sqlite' ? 'INTEGER PRIMARY KEY NOT NULL' : 'SERIAL PRIMARY KEY'
  const owner = backend === 'sqlite' ? 'CHAR(32)' : 'UUID'
  const timestamp = backend === 'sqlite' ? 'DATETIME' : 'TIMESTAMPTZ'
  return {
    projects: `CREATE TABLE projects (id ${id}, user_id ${owner} NOT NULL, name VARCHAR(200) NOT NULL, summary VARCHAR(200), contact_name VARCHAR(200), status VARCHAR(20) NOT NULL, start_date VARCHAR(10), deadline VARCHAR(10), color VARCHAR(300) NOT NULL, progress INTEGER NOT NULL, stages_json TEXT NOT NULL, current_stage VARCHAR(100), priority VARCHAR(20), version INTEGER NOT NULL, archived BOOLEAN NOT NULL, done_at ${timestamp}, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL, deleted_at ${timestamp}, idempotency_key VARCHAR(64), idempotency_fingerprint VARCHAR(64), CONSTRAINT uq_projects_user_idempotency_key UNIQUE (user_id,idempotency_key))`,
    clients: `CREATE TABLE clients (id ${id}, user_id ${owner} NOT NULL, name VARCHAR(200) NOT NULL, contact VARCHAR(200), email VARCHAR(300), phone VARCHAR(50), notes TEXT NOT NULL, created_at ${timestamp} NOT NULL)`,
    receipts: `CREATE TABLE core_operation_receipts (owner_id ${owner} NOT NULL, operation_id VARCHAR(36) NOT NULL, fingerprint VARCHAR(64) NOT NULL, method VARCHAR(100) NOT NULL, result_json TEXT NOT NULL, created_at ${timestamp} NOT NULL, PRIMARY KEY (owner_id, operation_id))`,
    undo: `CREATE TABLE undo_operations (id VARCHAR(80) PRIMARY KEY NOT NULL, user_id ${owner} NOT NULL, undo_context_id VARCHAR(128) NOT NULL, group_id VARCHAR(80) NOT NULL, resource VARCHAR(32) NOT NULL, action VARCHAR(32) NOT NULL, target_refs ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL, before_state ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL, after_state ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL, base_versions ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL, artifact_refs ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL, actor_type VARCHAR(32) NOT NULL, status VARCHAR(24) NOT NULL, created_at ${timestamp} NOT NULL, undone_at ${timestamp}, expires_at ${timestamp}, failure_code VARCHAR(80))`,
    mindNodes: `CREATE TABLE mind_nodes (id ${id}, user_id ${owner} NOT NULL, kind VARCHAR(20) NOT NULL, title VARCHAR(300), content_md TEXT NOT NULL, content_plain TEXT NOT NULL, color VARCHAR(300), ref_type VARCHAR(20), ref_id INTEGER, ref_snapshot ${backend === 'sqlite' ? 'TEXT' : 'JSON'}, origin VARCHAR(10) NOT NULL, indexed_at ${timestamp}, indexed_hash VARCHAR(64), version INTEGER NOT NULL, captured_at ${timestamp} NOT NULL, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL, deleted_at ${timestamp}, CONSTRAINT uq_mind_node_ref UNIQUE (user_id, ref_type, ref_id), CONSTRAINT ck_mind_node_ref_shape CHECK ((kind = 'ref' AND ref_type IS NOT NULL AND ref_id IS NOT NULL) OR (kind <> 'ref' AND ref_type IS NULL AND ref_id IS NULL)))`,
    mindMaps: `CREATE TABLE mind_maps (id ${id}, user_id ${owner} NOT NULL, title VARCHAR(300) NOT NULL, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, data_json TEXT NOT NULL, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL, deleted_at ${timestamp})`,
    calendarEvents: `CREATE TABLE calendar_events (id ${id}, user_id ${owner} NOT NULL, title VARCHAR(300) NOT NULL, date VARCHAR(10) NOT NULL, time VARCHAR(5), end_time VARCHAR(5), type VARCHAR(50) NOT NULL, contact_name VARCHAR(200), project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, description TEXT, version INTEGER NOT NULL, created_at ${timestamp} NOT NULL, deleted_at ${timestamp}, idempotency_key VARCHAR(64), idempotency_fingerprint VARCHAR(64), CONSTRAINT uq_calendar_events_user_idempotency_key UNIQUE(user_id,idempotency_key))`,
    ragJobs: `CREATE TABLE rag_index_jobs (id ${id}, user_id ${owner} NOT NULL, source_type VARCHAR(32) NOT NULL, source_id VARCHAR(255) NOT NULL, pending_source_ids ${backend === 'sqlite' ? 'TEXT' : 'JSON'}, version VARCHAR(64) NOT NULL, operation VARCHAR(24) NOT NULL, status VARCHAR(16) NOT NULL, generation INTEGER NOT NULL, completed_generation INTEGER NOT NULL, attempts INTEGER NOT NULL, next_attempt_at ${timestamp}, lease_until ${timestamp}, last_error_code VARCHAR(64), last_started_at ${timestamp}, last_succeeded_at ${timestamp}, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL, CONSTRAINT uq_rag_index_job_user_source UNIQUE(user_id,source_type))`,
    ragIndexEntries: `CREATE TABLE IF NOT EXISTS knowledge_index_entries (id ${id}, owner_user_id ${owner} NOT NULL, source_type VARCHAR(32) NOT NULL, source_id VARCHAR(255) NOT NULL, scope_type VARCHAR(32) NOT NULL DEFAULT 'owner', scope_id VARCHAR(255) NOT NULL DEFAULT '', platform VARCHAR(32) NOT NULL DEFAULT '', bot_id VARCHAR(128) NOT NULL DEFAULT '', group_id VARCHAR(255) NOT NULL DEFAULT '', document_id VARCHAR(255) NOT NULL, parent_document_id VARCHAR(255), document_version VARCHAR(64) NOT NULL, chunk_index INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 1, title VARCHAR(300) NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', content_hash VARCHAR(64) NOT NULL, metadata_json ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL DEFAULT ${backend === 'sqlite' ? "'{}'" : "'{}'::json"}, source_updated_at ${timestamp}, indexed_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at ${timestamp}, CONSTRAINT uq_knowledge_index_entry_chunk UNIQUE(owner_user_id,source_type,source_id,document_version,chunk_index))`,
    ragIndexIndexes: [
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_entries_owner_user_id ON knowledge_index_entries(owner_user_id)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_entries_source_type ON knowledge_index_entries(source_type)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_entries_source_id ON knowledge_index_entries(source_id)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_entries_scope_type ON knowledge_index_entries(scope_type)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_entries_scope_id ON knowledge_index_entries(scope_id)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_entries_document_id ON knowledge_index_entries(document_id)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_entries_content_hash ON knowledge_index_entries(content_hash)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_entries_indexed_at ON knowledge_index_entries(indexed_at)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_entries_deleted_at ON knowledge_index_entries(deleted_at)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_scope_source ON knowledge_index_entries(owner_user_id,scope_type,scope_id,source_type)`,
      `CREATE INDEX IF NOT EXISTS ix_knowledge_index_owner_source_indexed ON knowledge_index_entries(owner_user_id,source_type,indexed_at)`,
    ],
    mindItems: `CREATE TABLE mind_canvas_items (id ${id}, user_id ${owner} NOT NULL, canvas_id INTEGER NOT NULL REFERENCES mind_maps(id) ON DELETE CASCADE, node_id INTEGER NOT NULL REFERENCES mind_nodes(id) ON DELETE CASCADE, x FLOAT NOT NULL, y FLOAT NOT NULL, w FLOAT, h FLOAT, z INTEGER NOT NULL, collapsed BOOLEAN NOT NULL, data_json TEXT NOT NULL, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL, deleted_at ${timestamp}, CONSTRAINT uq_canvas_node UNIQUE(canvas_id,node_id))`,
    mindRelations: `CREATE TABLE mind_relations (id ${id}, user_id ${owner} NOT NULL, canvas_id INTEGER REFERENCES mind_maps(id) ON DELETE CASCADE, src_node_id INTEGER NOT NULL REFERENCES mind_nodes(id) ON DELETE CASCADE, dst_node_id INTEGER NOT NULL REFERENCES mind_nodes(id) ON DELETE CASCADE, rel_type VARCHAR(20) NOT NULL, edge_key VARCHAR(32) NOT NULL, origin VARCHAR(10) NOT NULL, status VARCHAR(10) NOT NULL, note TEXT, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL, deleted_at ${timestamp}, CONSTRAINT uq_mind_relation UNIQUE(user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key), CONSTRAINT ck_mind_relation_no_self CHECK(src_node_id <> dst_node_id))`,
    scheduledTasks: `CREATE TABLE scheduled_tasks (id ${id}, user_id ${owner}, event_id INTEGER, reminder_lead_minutes INTEGER, workspace_id INTEGER, filesystem_authorization_grant_id INTEGER, name VARCHAR(100) NOT NULL, payload TEXT NOT NULL, cron VARCHAR(60) NOT NULL, schedule_kind VARCHAR(16) NOT NULL DEFAULT 'cron', interval_minutes INTEGER, start_at ${timestamp}, end_at ${timestamp}, channels VARCHAR(40) NOT NULL, enabled BOOLEAN NOT NULL, delivery_targets ${backend === 'sqlite' ? 'TEXT' : 'JSON'}, authorized_tools ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL DEFAULT '[]', email_attachment_file_paths ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL DEFAULT '[]', last_run_at ${timestamp}, last_run_failed BOOLEAN, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL${backend === 'sqlite' ? ', CHECK(workspace_id IS NULL AND filesystem_authorization_grant_id IS NULL)' : ''})`,
    scheduledFires: `CREATE TABLE scheduled_task_fires (task_id INTEGER NOT NULL, fire_at ${timestamp} NOT NULL, lease_owner VARCHAR(128) NOT NULL, status VARCHAR(16) NOT NULL, created_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(task_id,fire_at))`,
    siteNotifications: `CREATE TABLE site_notifications (id ${id}, title VARCHAR(200) NOT NULL, content TEXT NOT NULL, color VARCHAR(50) NOT NULL, target VARCHAR(50) NOT NULL, bubble BOOLEAN NOT NULL, persist BOOLEAN NOT NULL, bubble_expire_at ${timestamp}, created_by VARCHAR(100) NOT NULL, created_at ${timestamp} NOT NULL)`,
    notificationReads: `CREATE TABLE notification_reads (id ${id}, user_id ${owner} NOT NULL, notification_id INTEGER NOT NULL REFERENCES site_notifications(id) ON DELETE CASCADE, read_at ${timestamp} NOT NULL, CONSTRAINT uq_notif_read UNIQUE(user_id,notification_id))`,
    notificationDismissals: `CREATE TABLE notification_dismissals (id ${id}, user_id ${owner} NOT NULL, notification_id INTEGER NOT NULL REFERENCES site_notifications(id) ON DELETE CASCADE, dismissed_at ${timestamp} NOT NULL, CONSTRAINT uq_notif_dismissal UNIQUE(user_id,notification_id))`,
    userSmtp: `CREATE TABLE user_smtp_configs (id ${id}, user_id ${owner} NOT NULL UNIQUE, host VARCHAR(255) NOT NULL, port INTEGER NOT NULL, "user" VARCHAR(300) NOT NULL, password TEXT NOT NULL, from_addr VARCHAR(300) NOT NULL, use_ssl BOOLEAN NOT NULL, enabled BOOLEAN NOT NULL, updated_at ${timestamp} NOT NULL)`,
    onboarding: `CREATE TABLE onboarding_state (user_id ${owner} PRIMARY KEY NOT NULL, state ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL)`,
    feedback: `CREATE TABLE feedbacks (id ${id}, user_id ${owner}, username VARCHAR(64) NOT NULL, category VARCHAR(32) NOT NULL, content TEXT NOT NULL, created_at ${timestamp} NOT NULL)`,
    userPreferences: `CREATE TABLE user_preferences (id ${id}, user_id ${owner} NOT NULL UNIQUE, data_json TEXT NOT NULL, updated_at ${timestamp} NOT NULL)`,
    mcpServers: `CREATE TABLE IF NOT EXISTS user_mcp_servers (id ${backend === 'sqlite' ? 'TEXT' : 'UUID'} PRIMARY KEY NOT NULL, user_id ${owner}, scope VARCHAR(16) NOT NULL DEFAULT 'user', name VARCHAR(64) NOT NULL, transport VARCHAR(16) NOT NULL DEFAULT 'http', endpoint VARCHAR(1000) NOT NULL DEFAULT '', encrypted_headers TEXT NOT NULL DEFAULT '', headers_nonce VARCHAR(64) NOT NULL DEFAULT '', encrypted_headers_key TEXT NOT NULL DEFAULT '', headers_key_version INTEGER NOT NULL DEFAULT 1, enabled BOOLEAN NOT NULL DEFAULT TRUE, confirm_mode VARCHAR(16) NOT NULL DEFAULT 'confirm_all', timeout_seconds INTEGER NOT NULL DEFAULT 30, tool_allowlist ${backend === 'sqlite' ? 'TEXT' : 'JSON'}, created_at ${timestamp} NOT NULL, updated_at ${timestamp} NOT NULL, command VARCHAR(1000) NOT NULL DEFAULT '', auth_mode VARCHAR(16) NOT NULL DEFAULT 'headers', encrypted_query_params TEXT NOT NULL DEFAULT '', query_params_nonce VARCHAR(64) NOT NULL DEFAULT '', encrypted_query_params_key TEXT NOT NULL DEFAULT '', query_params_key_version INTEGER NOT NULL DEFAULT 1, encrypted_endpoint TEXT NOT NULL DEFAULT '', endpoint_nonce VARCHAR(64) NOT NULL DEFAULT '', encrypted_endpoint_key TEXT NOT NULL DEFAULT '', endpoint_key_version INTEGER NOT NULL DEFAULT 1, credential_slots ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL DEFAULT ${backend === 'sqlite' ? "'[]'" : "'[]'::json"}, encrypted_credentials TEXT NOT NULL DEFAULT '', credentials_nonce VARCHAR(64) NOT NULL DEFAULT '', encrypted_credentials_key TEXT NOT NULL DEFAULT '', credentials_key_version INTEGER NOT NULL DEFAULT 1, CONSTRAINT uq_user_mcp_servers_scope_name UNIQUE(user_id,scope,name))`,
    mcpSnapshots: `CREATE TABLE IF NOT EXISTS user_mcp_tool_schema_snapshots (user_id ${owner} PRIMARY KEY NOT NULL, config_digest VARCHAR(64) NOT NULL, schemas ${backend === 'sqlite' ? 'TEXT' : 'JSON'} NOT NULL DEFAULT ${backend === 'sqlite' ? "'[]'" : "'[]'::json"}, refreshed_at ${timestamp} NOT NULL)`,
  }
}

/** SQLite Agent 基础表；工作区和授权能力尚未接入。 */
export const SQLITE_AGENT_SCHEMA = `
CREATE UNIQUE INDEX uq_core_runtime_meta_key_value ON core_runtime_meta(key,value);
CREATE TABLE conversation_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL CHECK(length(user_id)=32 AND user_id NOT GLOB '*[^0-9a-f]*'),
  title TEXT NOT NULL, title_locked INTEGER NOT NULL, summary TEXT NOT NULL, source TEXT,
  bot_id TEXT, chat_id TEXT, platform_user_id TEXT, chat_type TEXT,
  workspace_id INTEGER CHECK(workspace_id IS NULL),
  context_epoch INTEGER NOT NULL, session_context TEXT, session_info_hash TEXT, snapshot_hash TEXT,
  snapshot_expires_at TEXT, baseline_message_seq INTEGER NOT NULL DEFAULT 0, baseline_message_hash TEXT,
  last_message_seq INTEGER NOT NULL DEFAULT 0, execution_state TEXT NOT NULL DEFAULT 'idle',
  active_run_id TEXT, pending_message_count INTEGER NOT NULL DEFAULT 0,
  history_provider TEXT, history_api_format TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ix_conversation_sessions_user_id ON conversation_sessions(user_id);
CREATE INDEX ix_conversation_sessions_bot_id ON conversation_sessions(bot_id);
CREATE INDEX ix_conversation_sessions_chat_id ON conversation_sessions(chat_id);
CREATE INDEX ix_conversation_sessions_platform_user_id ON conversation_sessions(platform_user_id);
CREATE INDEX ix_conversation_sessions_workspace_id ON conversation_sessions(workspace_id);
CREATE INDEX ix_conversation_sessions_session_info_hash ON conversation_sessions(session_info_hash);
CREATE INDEX ix_conversation_sessions_snapshot_hash ON conversation_sessions(snapshot_hash);
CREATE INDEX ix_conversation_sessions_snapshot_expires_at ON conversation_sessions(snapshot_expires_at);
CREATE INDEX ix_conversation_sessions_baseline_message_seq ON conversation_sessions(baseline_message_seq);
CREATE INDEX ix_conversation_sessions_execution_state ON conversation_sessions(execution_state);
CREATE UNIQUE INDEX uq_conversation_sessions_id_owner ON conversation_sessions(id,user_id);
CREATE TABLE conversation_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  version TEXT NOT NULL, run_id TEXT, round_id TEXT, digest TEXT NOT NULL,
  state_summary TEXT, created_at TEXT NOT NULL,
  CONSTRAINT uq_conversation_batches_session_digest UNIQUE(session_id,digest)
);
CREATE INDEX ix_conversation_batches_session_id ON conversation_batches(session_id);
CREATE INDEX ix_conversation_batches_session_round ON conversation_batches(session_id,round_id);
CREATE TABLE conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  conversation_seq INTEGER NOT NULL, history_anchor_seq INTEGER, role TEXT NOT NULL, content TEXT NOT NULL,
  client_message_id TEXT, content_json TEXT, provider_image_content TEXT, display_timeline TEXT, files TEXT,
  quoted_text TEXT, references_json TEXT, platform_user_id TEXT, platform_user_name TEXT, platform_bot_user_id TEXT,
  im_platform_message_id TEXT, im_reply_to_message_id TEXT, im_reply_target_sender_id TEXT,
  im_reply_target_is_bot INTEGER, im_sender_is_bot INTEGER, im_event_received_ms INTEGER, im_platform_sent_ms INTEGER,
  im_media_kinds TEXT, im_media_processable INTEGER, im_mention_facts TEXT, chat_type TEXT, sent_at TEXT,
  created_at TEXT NOT NULL, canonical_batch_id INTEGER REFERENCES conversation_batches(id) ON DELETE SET NULL,
  run_id TEXT, round_id TEXT, run_outcome TEXT, covers_until_seq INTEGER
);
CREATE UNIQUE INDEX uq_conversation_messages_session_client_message_id ON conversation_messages(session_id,client_message_id);
CREATE UNIQUE INDEX uq_conversation_messages_session_sequence ON conversation_messages(session_id,conversation_seq);
CREATE INDEX ix_conversation_messages_session_id ON conversation_messages(session_id);
CREATE INDEX ix_conversation_messages_platform_user_id ON conversation_messages(platform_user_id);
CREATE INDEX ix_conversation_messages_platform_bot_user_id ON conversation_messages(platform_bot_user_id);
CREATE INDEX ix_conversation_messages_im_platform_message_id ON conversation_messages(im_platform_message_id);
CREATE INDEX ix_conversation_messages_im_event_received_ms ON conversation_messages(im_event_received_ms);
CREATE INDEX ix_conversation_messages_sent_at ON conversation_messages(sent_at);
CREATE INDEX ix_conversation_messages_canonical_batch_id ON conversation_messages(canonical_batch_id);
CREATE INDEX ix_conversation_messages_run_id ON conversation_messages(run_id);
CREATE TABLE conversation_pending_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL CHECK(length(user_id)=32 AND user_id NOT GLOB '*[^0-9a-f]*'),
  queue_id TEXT NOT NULL, session_id INTEGER,
  items TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id,user_id) REFERENCES conversation_sessions(id,user_id) ON DELETE CASCADE,
  CONSTRAINT uq_conversation_pending_queue_owner_key UNIQUE(user_id,queue_id)
);
CREATE INDEX ix_conversation_pending_queues_user_id ON conversation_pending_queues(user_id);
CREATE INDEX ix_conversation_pending_queues_session_id ON conversation_pending_queues(session_id);

CREATE TRIGGER validate_conversation_sessions_owner_insert BEFORE INSERT ON conversation_sessions WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
CREATE TRIGGER validate_conversation_sessions_owner_update BEFORE UPDATE ON conversation_sessions WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
CREATE TRIGGER validate_conversation_pending_queues_owner_insert BEFORE INSERT ON conversation_pending_queues WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
CREATE TRIGGER validate_conversation_pending_queues_owner_update BEFORE UPDATE ON conversation_pending_queues WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
CREATE TRIGGER validate_message_batch_insert BEFORE INSERT ON conversation_messages WHEN NEW.canonical_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_batches WHERE id=NEW.canonical_batch_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT, '消息批次与会话不匹配'); END;
CREATE TRIGGER validate_message_batch_update BEFORE UPDATE OF canonical_batch_id,session_id ON conversation_messages WHEN NEW.canonical_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_batches WHERE id=NEW.canonical_batch_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT, '消息批次与会话不匹配'); END;
CREATE TRIGGER validate_batch_session_update BEFORE UPDATE OF session_id ON conversation_batches WHEN EXISTS (SELECT 1 FROM conversation_messages WHERE canonical_batch_id=OLD.id AND session_id<>NEW.session_id) BEGIN SELECT RAISE(ABORT, '消息批次与会话不匹配'); END;
CREATE TRIGGER protect_core_owner_update BEFORE UPDATE ON core_runtime_meta WHEN OLD.key='owner_id' BEGIN SELECT RAISE(ABORT, 'owner 不可修改'); END;
CREATE TRIGGER protect_core_owner_delete BEFORE DELETE ON core_runtime_meta WHEN OLD.key='owner_id' BEGIN SELECT RAISE(ABORT, 'owner 不可删除'); END;
`
