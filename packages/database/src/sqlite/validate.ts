import type SQLite from 'better-sqlite3'
import { DatabaseError } from '../shared/error.js'
import { validateSqliteInteractionPrompts } from './interaction-prompts.js'
import { validateSqliteInteractionActions } from './interaction-actions.js'
import {
  CLIENT_COLUMNS,
  CALENDAR_EVENT_COLUMNS,
  MIND_CANVAS_COLUMNS,
  MIND_ITEM_COLUMNS,
  MIND_NODE_COLUMNS,
  MIND_RELATION_COLUMNS,
  NOTIFICATION_DISMISSAL_COLUMNS,
  NOTIFICATION_READ_COLUMNS,
  PROJECT_COLUMNS,
  RECEIPT_COLUMNS,
  RAG_JOB_COLUMNS,
  RAG_INDEX_COLUMNS,
  SCHEDULED_FIRE_COLUMNS,
  SCHEDULED_TASK_COLUMNS,
  SITE_NOTIFICATION_COLUMNS,
  USER_SMTP_COLUMNS,
  SCHEMA_VERSION,
  SQLITE_AGENT_SCHEMA,
  UNDO_COLUMNS,
} from '../schema.js'
import {
  SQLITE_INITIAL_REVISION,
  SMTP_OWNER_TRIGGERS,
  ONBOARDING_OWNER_TRIGGERS,
  FEEDBACK_OWNER_TRIGGERS,
  PREFERENCES_OWNER_TRIGGERS,
  MCP_OWNER_TRIGGERS,
} from '../migrations/baseline/sqlite.js'

function columns(db: SQLite.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[])
    .map((row) => row.name)
    .sort()
}
function matchColumns(db: SQLite.Database, table: string, expected: string[]): void {
  if (JSON.stringify(columns(db, table)) !== JSON.stringify([...expected].sort()))
    throw new DatabaseError('storage_error', '本地表结构不兼容，已拒绝自动修复')
}
function uniqueColumns(db: SQLite.Database, table: string, expected: string[]): void {
  const indexes = db.pragma(`index_list(${table})`) as {
    name: string
    unique: number
    partial: number
  }[]
  const found = indexes.some(
    (index) =>
      index.unique === 1 &&
      index.partial === 0 &&
      JSON.stringify(
        (
          db.pragma(`index_info("${index.name.replaceAll('"', '""')}")`) as {
            name: string
          }[]
        )
          .map((column) => column.name)
          .sort(),
      ) === JSON.stringify([...expected].sort()),
  )
  if (!found) throw new DatabaseError('storage_error', '本地唯一约束缺失，已拒绝自动修复')
}
function indexColumns(db: SQLite.Database, name: string, expected: string[]): boolean {
  const actual = (db.pragma(`index_info(${name})`) as { name: string | null }[])
    .map(column => column.name)
  return JSON.stringify(actual) === JSON.stringify(expected)
}
function validateAgentSchema(db: SQLite.Database): void {
  const Driver = db.constructor as typeof SQLite
  const expected = new Driver(':memory:')
  try {
    expected.exec('CREATE TABLE core_runtime_meta (key VARCHAR(50) PRIMARY KEY NOT NULL,value VARCHAR(100) NOT NULL)')
    expected.exec(SQLITE_AGENT_SCHEMA)
    const objects = expected.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name <> 'core_runtime_meta' ORDER BY type,name").all() as { type: string; name: string; sql: string }[]
    const lookup = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?')
    for (const object of objects) {
      const actual = lookup.get(object.type, object.name) as { sql: string } | undefined
      if (!actual || actual.sql !== object.sql) throw new DatabaseError('storage_error', 'Agent 本地表结构不兼容，已拒绝自动修复')
    }
    for (const table of ['conversation_sessions', 'conversation_pending_queues']) {
      const invalid = db.prepare(`SELECT 1 FROM ${table} WHERE user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') LIMIT 1`).get()
      if (invalid) throw new DatabaseError('storage_error', 'Agent 本地数据身份不匹配')
    }
    for (const table of ['conversation_sessions', 'conversation_batches', 'conversation_messages', 'conversation_pending_queues']) {
      if ((db.pragma(`foreign_key_check(${table})`) as unknown[]).length) throw new DatabaseError('storage_error', 'Agent 本地外键校验失败')
    }
  } finally { expected.close() }
}
function validateSmtpSchema(db: SQLite.Database, owner: string): void {
  matchColumns(db, 'user_smtp_configs', USER_SMTP_COLUMNS)
  uniqueColumns(db, 'user_smtp_configs', ['user_id'])
  for (const [index, name] of ['validate_smtp_owner_insert', 'validate_smtp_owner_update'].entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    if (row?.sql !== SMTP_OWNER_TRIGGERS[index]) throw new DatabaseError('storage_error', 'SMTP 归属约束缺失，已拒绝打开')
  }
  if (db.prepare('SELECT 1 FROM user_smtp_configs WHERE user_id <> ? LIMIT 1').get(owner.replaceAll('-', '')))
    throw new DatabaseError('storage_error', 'SMTP 归属数据不一致，已拒绝打开')
}
function validateOnboardingSchema(db: SQLite.Database, owner: string): void {
  matchColumns(db, 'onboarding_state', ['user_id', 'state', 'created_at', 'updated_at'])
  const columns = db.pragma('table_info(onboarding_state)') as { name: string; notnull: number }[]
  if (['user_id', 'state', 'created_at', 'updated_at'].some(name => !columns.some(column => column.name === name && column.notnull === 1)))
    throw new DatabaseError('storage_error', '引导状态非空约束缺失，已拒绝打开')
  uniqueColumns(db, 'onboarding_state', ['user_id'])
  for (const [index, name] of ['validate_onboarding_owner_insert', 'validate_onboarding_owner_update'].entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    if (row?.sql !== ONBOARDING_OWNER_TRIGGERS[index]) throw new DatabaseError('storage_error', '引导状态归属约束缺失，已拒绝打开')
  }
  if (db.prepare('SELECT 1 FROM onboarding_state WHERE user_id <> ? LIMIT 1').get(owner.replaceAll('-', '')))
    throw new DatabaseError('storage_error', '引导状态归属数据不一致，已拒绝打开')
}
function validatePreferencesSchema(db: SQLite.Database, owner: string): void {
  matchColumns(db, 'user_preferences', ['id', 'user_id', 'data_json', 'updated_at'])
  uniqueColumns(db, 'user_preferences', ['user_id'])
  const columns = db.pragma('table_info(user_preferences)') as { name: string; notnull: number; pk: number }[]
  if (!columns.find(column => column.name === 'id')?.pk || ['user_id', 'data_json', 'updated_at'].some(name => !columns.find(column => column.name === name)?.notnull))
    throw new DatabaseError('storage_error', '用户偏好表约束缺失，已拒绝打开')
  for (const [index, name] of ['validate_preferences_owner_insert', 'validate_preferences_owner_update'].entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    if (row?.sql !== PREFERENCES_OWNER_TRIGGERS[index]) throw new DatabaseError('storage_error', '用户偏好归属约束缺失，已拒绝打开')
  }
  if (db.prepare('SELECT 1 FROM user_preferences WHERE user_id IS NOT ? LIMIT 1').get(owner.replaceAll('-', '')))
    throw new DatabaseError('storage_error', '用户偏好归属数据不匹配，已拒绝打开')
}
function validateFeedbackSchema(db: SQLite.Database, owner: string): void {
  matchColumns(db, 'feedbacks', ['id', 'user_id', 'username', 'category', 'content', 'created_at'])
  const columns = db.pragma('table_info(feedbacks)') as { name: string; notnull: number; pk: number }[]
  if (['username', 'category', 'content', 'created_at'].some(name => !columns.some(column => column.name === name && column.notnull === 1))
      || !columns.some(column => column.name === 'id' && column.pk === 1))
    throw new DatabaseError('storage_error', '反馈表约束缺失，已拒绝打开')
  for (const [index, name] of ['validate_feedback_owner_insert', 'validate_feedback_owner_update'].entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    if (row?.sql !== FEEDBACK_OWNER_TRIGGERS[index]) throw new DatabaseError('storage_error', '反馈归属约束缺失，已拒绝打开')
  }
  if (db.prepare('SELECT 1 FROM feedbacks WHERE user_id IS NOT ? LIMIT 1').get(owner.replaceAll('-', '')))
    throw new DatabaseError('storage_error', '反馈归属数据不一致，已拒绝打开')
}
const MCP_SERVER_COLUMNS = ['id','user_id','scope','name','transport','endpoint','encrypted_headers','headers_nonce','encrypted_headers_key','headers_key_version','enabled','confirm_mode','timeout_seconds','tool_allowlist','created_at','updated_at','command','auth_mode','encrypted_query_params','query_params_nonce','encrypted_query_params_key','query_params_key_version','encrypted_endpoint','endpoint_nonce','encrypted_endpoint_key','endpoint_key_version','credential_slots','encrypted_credentials','credentials_nonce','encrypted_credentials_key','credentials_key_version']
function validateMcpSchema(db: SQLite.Database, owner: string): void {
  matchColumns(db, 'user_mcp_servers', MCP_SERVER_COLUMNS)
  matchColumns(db, 'user_mcp_tool_schema_snapshots', ['user_id','config_digest','schemas','refreshed_at'])
  uniqueColumns(db, 'user_mcp_servers', ['id'])
  uniqueColumns(db, 'user_mcp_servers', ['user_id','scope','name'])
  uniqueColumns(db, 'user_mcp_tool_schema_snapshots', ['user_id'])
  for (const [index, name] of ['validate_user_mcp_servers_owner_insert','validate_user_mcp_servers_owner_update','validate_user_mcp_tool_schema_snapshots_owner_insert','validate_user_mcp_tool_schema_snapshots_owner_update'].entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    if (row?.sql !== MCP_OWNER_TRIGGERS[index]) throw new DatabaseError('storage_error', 'MCP 归属约束缺失，已拒绝打开')
  }
  if (db.prepare('SELECT 1 FROM user_mcp_servers WHERE user_id IS NOT ? LIMIT 1').get(owner.replaceAll('-',''))
      || db.prepare('SELECT 1 FROM user_mcp_tool_schema_snapshots WHERE user_id IS NOT ? LIMIT 1').get(owner.replaceAll('-','')))
    throw new DatabaseError('storage_error', 'MCP 本地数据身份不匹配')
}
export function validateSqliteBaseline(db: SQLite.Database): { owner: string; version: string } {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string
    }[]
  ).map((row) => row.name)
  if (!tables.includes('core_runtime_meta') || !tables.includes('projects'))
    throw new DatabaseError('storage_error', '此文件不是已初始化的 Core 数据库')
  const rows = db.prepare('SELECT key,value FROM core_runtime_meta').all() as {
    key: string
    value: string
  }[]
  if (
    ['owner_id', 'schema_version'].some(
      (key) => rows.filter((row) => row.key === key).length !== 1,
    )
  )
    throw new DatabaseError('storage_error', '本地数据库元数据缺失或重复')
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  const ownerId = values.owner_id
  if (!ownerId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId))
    throw new DatabaseError('storage_error', '本地数据库身份缺失或损坏')
  const owner = ownerId.toLowerCase()
  // 基线重命名没有改变版本 18 的结构，旧标记仍需通过下方的完整校验。
  const knownBaseline = values.migration_revision === SQLITE_INITIAL_REVISION
    || values.migration_revision === '0001_initialize'
  if (values.schema_version !== SCHEMA_VERSION || !knownBaseline)
    throw new DatabaseError('schema_upgrade_required', '本地数据库版本与当前迁移基线不兼容')
  matchColumns(db, 'projects', PROJECT_COLUMNS)
  uniqueColumns(db, 'projects', ['user_id', 'idempotency_key'])
  matchColumns(db, 'clients', columns(db, 'clients').includes('address') ? [...CLIENT_COLUMNS, 'address'] : CLIENT_COLUMNS)
  matchColumns(db, 'core_operation_receipts', RECEIPT_COLUMNS)
  uniqueColumns(db, 'core_operation_receipts', ['owner_id', 'operation_id'])
  matchColumns(db, 'undo_operations', UNDO_COLUMNS)
  uniqueColumns(db, 'undo_operations', ['id'])
  matchColumns(db, 'mind_nodes', MIND_NODE_COLUMNS)
  uniqueColumns(db, 'mind_nodes', ['user_id', 'ref_type', 'ref_id'])
  validateAgentSchema(db)
  {
    matchColumns(db, 'mind_maps', MIND_CANVAS_COLUMNS)
    const keys = db.pragma('foreign_key_list(mind_maps)') as { table: string; from: string; to: string; on_delete: string }[]
    if (!keys.some(key => key.table === 'projects' && key.from === 'project_id' && key.to === 'id' && key.on_delete === 'SET NULL'))
      throw new DatabaseError('storage_error', '画布项目外键缺失，已拒绝打开')
  }
  {
    matchColumns(db, 'calendar_events', CALENDAR_EVENT_COLUMNS)
    uniqueColumns(db, 'calendar_events', ['user_id', 'idempotency_key'])
    matchColumns(db, 'rag_index_jobs', RAG_JOB_COLUMNS)
    uniqueColumns(db, 'rag_index_jobs', ['user_id', 'source_type'])
    const keys = db.pragma('foreign_key_list(calendar_events)') as { table: string; from: string; to: string; on_delete: string }[]
    if (!keys.some(key => key.table === 'projects' && key.from === 'project_id' && key.to === 'id' && key.on_delete === 'SET NULL'))
      throw new DatabaseError('storage_error', '日历项目外键缺失，已拒绝打开')
  }
  {
    matchColumns(db, 'knowledge_index_entries', RAG_INDEX_COLUMNS)
    uniqueColumns(db, 'knowledge_index_entries', ['owner_user_id', 'source_type', 'source_id', 'document_version', 'chunk_index'])
    for (const [name, expected] of [
      ['ix_knowledge_index_scope_source', ['owner_user_id', 'scope_type', 'scope_id', 'source_type']],
      ['ix_knowledge_index_owner_source_indexed', ['owner_user_id', 'source_type', 'indexed_at']],
    ] as const) {
      if (!indexColumns(db, name, [...expected]))
        throw new DatabaseError('storage_error', 'RAG 检索索引缺失或不兼容，已拒绝打开')
    }
  }
  {
    matchColumns(db, 'mind_canvas_items', MIND_ITEM_COLUMNS)
    uniqueColumns(db, 'mind_canvas_items', ['canvas_id', 'node_id'])
    matchColumns(db, 'mind_relations', MIND_RELATION_COLUMNS)
    uniqueColumns(db, 'mind_relations', ['user_id', 'canvas_id', 'src_node_id', 'dst_node_id', 'rel_type', 'edge_key'])
    const indexes = db.pragma('index_list(mind_relations)') as { name: string; unique: number; partial: number }[]
    const legacy = indexes.find(index => index.name === 'uq_mind_relation_legacy' && index.unique === 1 && index.partial === 1)
    const legacyColumns = (db.pragma('index_info(uq_mind_relation_legacy)') as { name: string }[]).map(column => column.name).sort()
    const legacySql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_mind_relation_legacy'").get() as { sql?: string } | undefined)?.sql ?? ''
    if (!legacy || JSON.stringify(legacyColumns) !== JSON.stringify(['user_id', 'src_node_id', 'dst_node_id', 'rel_type', 'edge_key'].sort()) || !/\bWHERE\s+canvas_id\s+IS\s+NULL\s*$/i.test(legacySql))
      throw new DatabaseError('storage_error', '画布关系唯一约束缺失，已拒绝打开')
    for (const [table, required] of [
      ['mind_canvas_items', [['canvas_id', 'mind_maps'], ['node_id', 'mind_nodes']]],
      ['mind_relations', [['canvas_id', 'mind_maps'], ['src_node_id', 'mind_nodes'], ['dst_node_id', 'mind_nodes']]],
    ] as const) {
      const keys = db.pragma(`foreign_key_list(${table})`) as { table: string; from: string; to: string; on_delete: string }[]
      if (required.some(([from, target]) => !keys.some(key => key.from === from && key.table === target && key.to === 'id' && key.on_delete === 'CASCADE')))
        throw new DatabaseError('storage_error', '画布关联外键缺失，已拒绝打开')
    }
  }
  {
    matchColumns(db, 'scheduled_tasks', columns(db, 'scheduled_tasks').includes('execution_mode') ? [...SCHEDULED_TASK_COLUMNS, 'execution_mode'] : SCHEDULED_TASK_COLUMNS)
    matchColumns(db, 'scheduled_task_fires', SCHEDULED_FIRE_COLUMNS)
    uniqueColumns(db, 'scheduled_task_fires', ['task_id', 'fire_at'])
    const indexes = db.pragma('index_list(scheduled_tasks)') as { name: string; unique: number; partial: number }[]
    const index = indexes.find(item => item.name === 'uq_scheduled_tasks_event_fire' && item.unique === 1 && item.partial === 1)
    const indexedColumns = (db.pragma('index_info(uq_scheduled_tasks_event_fire)') as { name: string }[]).map(item => item.name).sort()
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_scheduled_tasks_event_fire'").get() as { sql?: string } | undefined)?.sql ?? ''
    if (!index || JSON.stringify(indexedColumns) !== JSON.stringify(['user_id', 'event_id', 'cron'].sort()) || !/\bWHERE\s+event_id\s+IS\s+NOT\s+NULL\s*$/i.test(sql))
      throw new DatabaseError('storage_error', '提醒触发唯一约束缺失，已拒绝打开')
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'").get() as { sql?: string } | undefined)?.sql ?? ''
    if (!/CHECK\s*\(\s*workspace_id\s+IS\s+NULL\s+AND\s+filesystem_authorization_grant_id\s+IS\s+NULL\s*\)/i.test(tableSql))
      throw new DatabaseError('storage_error', '定时任务工作区授权边界缺失，已拒绝打开')
  }
  {
    matchColumns(db, 'site_notifications', SITE_NOTIFICATION_COLUMNS)
    for (const [table, expected] of [['notification_reads', NOTIFICATION_READ_COLUMNS], ['notification_dismissals', NOTIFICATION_DISMISSAL_COLUMNS]] as const) {
      matchColumns(db, table, expected)
      uniqueColumns(db, table, ['user_id', 'notification_id'])
      const keys = db.pragma(`foreign_key_list(${table})`) as { table: string; from: string; to: string; on_delete: string }[]
      if (!keys.some(key => key.table === 'site_notifications' && key.from === 'notification_id' && key.to === 'id' && key.on_delete === 'CASCADE'))
        throw new DatabaseError('storage_error', '通知关联外键缺失，已拒绝打开')
    }
    validateSqliteInteractionPrompts(db)
  }
  validateSqliteInteractionActions(db)
  validateSmtpSchema(db, owner)
  validateOnboardingSchema(db, owner)
  validateFeedbackSchema(db, owner)
  validatePreferencesSchema(db, owner)
  validateMcpSchema(db, owner)
  return { owner, version: values.schema_version! }
}
