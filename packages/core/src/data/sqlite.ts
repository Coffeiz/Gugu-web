import { CompiledQuery, Kysely, SqliteDialect } from 'kysely'
import type { Driver } from 'kysely'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { CoreError, dataContext } from '../contracts/index.js'
import type { Clock } from './codec.js'
import { SqlDataRuntime } from './runtime.js'
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
  tablesSql,
} from './schema.js'
import type { Database } from './schema.js'
import type SQLite from 'better-sqlite3'
import { SQLITE_INTERACTION_PROMPTS_SCHEMA, validateSqliteInteractionPrompts } from '../agent/interactions/schema.js'
import { SQLITE_INTERACTION_ACTIONS_SCHEMA, validateSqliteInteractionActions } from '../agent/interactions/action-schema.js'

async function driver(): Promise<typeof SQLite> {
  try {
    return (await import('better-sqlite3')).default
  } catch {
    throw new CoreError('storage_error', 'SQLite 驱动不可用，请检查匹配的运行时制品')
  }
}
class ImmediateDialect extends SqliteDialect {
  override createDriver(): Driver {
    const backend = super.createDriver()
    backend.beginTransaction = async (connection) => {
      await connection.executeQuery(CompiledQuery.raw('BEGIN IMMEDIATE'))
    }
    return backend
  }
}
function columns(db: SQLite.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[])
    .map((row) => row.name)
    .sort()
}
function matchColumns(db: SQLite.Database, table: string, expected: string[]): void {
  if (JSON.stringify(columns(db, table)) !== JSON.stringify([...expected].sort()))
    throw new CoreError('storage_error', '本地表结构不兼容，已拒绝自动修复')
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
  if (!found) throw new CoreError('storage_error', '本地唯一约束缺失，已拒绝自动修复')
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
      if (!actual || actual.sql !== object.sql) throw new CoreError('storage_error', 'Agent 本地表结构不兼容，已拒绝自动修复')
    }
    for (const table of ['conversation_sessions', 'conversation_pending_queues']) {
      const invalid = db.prepare(`SELECT 1 FROM ${table} WHERE user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') LIMIT 1`).get()
      if (invalid) throw new CoreError('storage_error', 'Agent 本地数据身份不匹配')
    }
    for (const table of ['conversation_sessions', 'conversation_batches', 'conversation_messages', 'conversation_pending_queues']) {
      if ((db.pragma(`foreign_key_check(${table})`) as unknown[]).length) throw new CoreError('storage_error', 'Agent 本地外键校验失败')
    }
  } finally { expected.close() }
}
const SMTP_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_smtp_owner_${action.toLowerCase()} BEFORE ${action} ON user_smtp_configs WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
function validateSmtpSchema(db: SQLite.Database, owner: string): void {
  matchColumns(db, 'user_smtp_configs', USER_SMTP_COLUMNS)
  uniqueColumns(db, 'user_smtp_configs', ['user_id'])
  for (const [index, name] of ['validate_smtp_owner_insert', 'validate_smtp_owner_update'].entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    if (row?.sql !== SMTP_OWNER_TRIGGERS[index]) throw new CoreError('storage_error', 'SMTP 归属约束缺失，已拒绝打开')
  }
  if (db.prepare('SELECT 1 FROM user_smtp_configs WHERE user_id <> ? LIMIT 1').get(owner.replaceAll('-', '')))
    throw new CoreError('storage_error', 'SMTP 归属数据不一致，已拒绝打开')
}
const ONBOARDING_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_onboarding_owner_${action.toLowerCase()} BEFORE ${action} ON onboarding_state WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
function validateOnboardingSchema(db: SQLite.Database, owner: string): void {
  matchColumns(db, 'onboarding_state', ['user_id', 'state', 'created_at', 'updated_at'])
  const columns = db.pragma('table_info(onboarding_state)') as { name: string; notnull: number }[]
  if (['user_id', 'state', 'created_at', 'updated_at'].some(name => !columns.some(column => column.name === name && column.notnull === 1)))
    throw new CoreError('storage_error', '引导状态非空约束缺失，已拒绝打开')
  uniqueColumns(db, 'onboarding_state', ['user_id'])
  for (const [index, name] of ['validate_onboarding_owner_insert', 'validate_onboarding_owner_update'].entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    if (row?.sql !== ONBOARDING_OWNER_TRIGGERS[index]) throw new CoreError('storage_error', '引导状态归属约束缺失，已拒绝打开')
  }
  if (db.prepare('SELECT 1 FROM onboarding_state WHERE user_id <> ? LIMIT 1').get(owner.replaceAll('-', '')))
    throw new CoreError('storage_error', '引导状态归属数据不一致，已拒绝打开')
}
const FEEDBACK_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_feedback_owner_${action.toLowerCase()} BEFORE ${action} ON feedbacks WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
const PREFERENCES_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_preferences_owner_${action.toLowerCase()} BEFORE ${action} ON user_preferences WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
function validatePreferencesSchema(db: SQLite.Database, owner: string): void {
  matchColumns(db, 'user_preferences', ['id', 'user_id', 'data_json', 'updated_at'])
  uniqueColumns(db, 'user_preferences', ['user_id'])
  const columns = db.pragma('table_info(user_preferences)') as { name: string; notnull: number; pk: number }[]
  if (!columns.find(column => column.name === 'id')?.pk || ['user_id', 'data_json', 'updated_at'].some(name => !columns.find(column => column.name === name)?.notnull))
    throw new CoreError('storage_error', '用户偏好表约束缺失，已拒绝打开')
  for (const [index, name] of ['validate_preferences_owner_insert', 'validate_preferences_owner_update'].entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    if (row?.sql !== PREFERENCES_OWNER_TRIGGERS[index]) throw new CoreError('storage_error', '用户偏好归属约束缺失，已拒绝打开')
  }
  if (db.prepare('SELECT 1 FROM user_preferences WHERE user_id IS NOT ? LIMIT 1').get(owner.replaceAll('-', '')))
    throw new CoreError('storage_error', '用户偏好归属数据不匹配，已拒绝打开')
}
function validateFeedbackSchema(db: SQLite.Database, owner: string): void {
  matchColumns(db, 'feedbacks', ['id', 'user_id', 'username', 'category', 'content', 'created_at'])
  const columns = db.pragma('table_info(feedbacks)') as { name: string; notnull: number; pk: number }[]
  if (['username', 'category', 'content', 'created_at'].some(name => !columns.some(column => column.name === name && column.notnull === 1))
      || !columns.some(column => column.name === 'id' && column.pk === 1))
    throw new CoreError('storage_error', '反馈表约束缺失，已拒绝打开')
  for (const [index, name] of ['validate_feedback_owner_insert', 'validate_feedback_owner_update'].entries()) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined
    if (row?.sql !== FEEDBACK_OWNER_TRIGGERS[index]) throw new CoreError('storage_error', '反馈归属约束缺失，已拒绝打开')
  }
  if (db.prepare('SELECT 1 FROM feedbacks WHERE user_id IS NOT ? LIMIT 1').get(owner.replaceAll('-', '')))
    throw new CoreError('storage_error', '反馈归属数据不一致，已拒绝打开')
}
function metadata(db: SQLite.Database): { owner: string; version: string } {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string
    }[]
  ).map((row) => row.name)
  if (!tables.includes('core_runtime_meta') || !tables.includes('projects'))
    throw new CoreError('storage_error', '此文件不是已初始化的 Core 数据库')
  const rows = db.prepare('SELECT key,value FROM core_runtime_meta').all() as {
    key: string
    value: string
  }[]
  if (
    ['owner_id', 'schema_version'].some(
      (key) => rows.filter((row) => row.key === key).length !== 1,
    )
  )
    throw new CoreError('storage_error', '本地数据库元数据缺失或重复')
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]))
  let owner: string
  try {
    owner = dataContext(values.owner_id!).ownerId
  } catch {
    throw new CoreError('storage_error', '本地数据库身份缺失或损坏')
  }
  matchColumns(db, 'projects', PROJECT_COLUMNS)
  uniqueColumns(db, 'projects', ['user_id', 'idempotency_key'])
  if (values.schema_version !== '1') matchColumns(db, 'clients', CLIENT_COLUMNS)
  if (['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) {
    matchColumns(db, 'core_operation_receipts', RECEIPT_COLUMNS)
    uniqueColumns(db, 'core_operation_receipts', ['owner_id', 'operation_id'])
  }
  if (['4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) {
    matchColumns(db, 'undo_operations', UNDO_COLUMNS)
    uniqueColumns(db, 'undo_operations', ['id'])
  }
  if (['5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) {
    matchColumns(db, 'mind_nodes', MIND_NODE_COLUMNS)
    uniqueColumns(db, 'mind_nodes', ['user_id', 'ref_type', 'ref_id'])
  }
  if (['6', '7', '8', '9', '10', '11', '12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) validateAgentSchema(db)
  if (['7', '8', '9', '10', '11', '12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) {
    matchColumns(db, 'mind_maps', MIND_CANVAS_COLUMNS)
    const keys = db.pragma('foreign_key_list(mind_maps)') as { table: string; from: string; to: string; on_delete: string }[]
    if (!keys.some(key => key.table === 'projects' && key.from === 'project_id' && key.to === 'id' && key.on_delete === 'SET NULL'))
      throw new CoreError('storage_error', '画布项目外键缺失，已拒绝打开')
  }
  if (['8', '9', '10', '11', '12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) {
    matchColumns(db, 'calendar_events', CALENDAR_EVENT_COLUMNS)
    uniqueColumns(db, 'calendar_events', ['user_id', 'idempotency_key'])
    matchColumns(db, 'rag_index_jobs', RAG_JOB_COLUMNS)
    uniqueColumns(db, 'rag_index_jobs', ['user_id', 'source_type'])
    const keys = db.pragma('foreign_key_list(calendar_events)') as { table: string; from: string; to: string; on_delete: string }[]
    if (!keys.some(key => key.table === 'projects' && key.from === 'project_id' && key.to === 'id' && key.on_delete === 'SET NULL'))
      throw new CoreError('storage_error', '日历项目外键缺失，已拒绝打开')
  }
  if (values.schema_version === SCHEMA_VERSION) {
    matchColumns(db, 'knowledge_index_entries', RAG_INDEX_COLUMNS)
    uniqueColumns(db, 'knowledge_index_entries', ['owner_user_id', 'source_type', 'source_id', 'document_version', 'chunk_index'])
    for (const [name, expected] of [
      ['ix_knowledge_index_scope_source', ['owner_user_id', 'scope_type', 'scope_id', 'source_type']],
      ['ix_knowledge_index_owner_source_indexed', ['owner_user_id', 'source_type', 'indexed_at']],
    ] as const) {
      if (!indexColumns(db, name, [...expected]))
        throw new CoreError('storage_error', 'RAG 检索索引缺失或不兼容，已拒绝打开')
    }
  }
  if (['9', '10', '11', '12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) {
    matchColumns(db, 'mind_canvas_items', MIND_ITEM_COLUMNS)
    uniqueColumns(db, 'mind_canvas_items', ['canvas_id', 'node_id'])
    matchColumns(db, 'mind_relations', MIND_RELATION_COLUMNS)
    uniqueColumns(db, 'mind_relations', ['user_id', 'canvas_id', 'src_node_id', 'dst_node_id', 'rel_type', 'edge_key'])
    const indexes = db.pragma('index_list(mind_relations)') as { name: string; unique: number; partial: number }[]
    const legacy = indexes.find(index => index.name === 'uq_mind_relation_legacy' && index.unique === 1 && index.partial === 1)
    const legacyColumns = (db.pragma('index_info(uq_mind_relation_legacy)') as { name: string }[]).map(column => column.name).sort()
    const legacySql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_mind_relation_legacy'").get() as { sql?: string } | undefined)?.sql ?? ''
    if (!legacy || JSON.stringify(legacyColumns) !== JSON.stringify(['user_id', 'src_node_id', 'dst_node_id', 'rel_type', 'edge_key'].sort()) || !/\bWHERE\s+canvas_id\s+IS\s+NULL\s*$/i.test(legacySql))
      throw new CoreError('storage_error', '画布关系唯一约束缺失，已拒绝打开')
    for (const [table, required] of [
      ['mind_canvas_items', [['canvas_id', 'mind_maps'], ['node_id', 'mind_nodes']]],
      ['mind_relations', [['canvas_id', 'mind_maps'], ['src_node_id', 'mind_nodes'], ['dst_node_id', 'mind_nodes']]],
    ] as const) {
      const keys = db.pragma(`foreign_key_list(${table})`) as { table: string; from: string; to: string; on_delete: string }[]
      if (required.some(([from, target]) => !keys.some(key => key.from === from && key.table === target && key.to === 'id' && key.on_delete === 'CASCADE')))
        throw new CoreError('storage_error', '画布关联外键缺失，已拒绝打开')
    }
  }
  if (['10', '11', '12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) {
    matchColumns(db, 'scheduled_tasks', SCHEDULED_TASK_COLUMNS)
    matchColumns(db, 'scheduled_task_fires', SCHEDULED_FIRE_COLUMNS)
    uniqueColumns(db, 'scheduled_task_fires', ['task_id', 'fire_at'])
    const indexes = db.pragma('index_list(scheduled_tasks)') as { name: string; unique: number; partial: number }[]
    const index = indexes.find(item => item.name === 'uq_scheduled_tasks_event_fire' && item.unique === 1 && item.partial === 1)
    const columns = (db.pragma('index_info(uq_scheduled_tasks_event_fire)') as { name: string }[]).map(item => item.name).sort()
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_scheduled_tasks_event_fire'").get() as { sql?: string } | undefined)?.sql ?? ''
    if (!index || JSON.stringify(columns) !== JSON.stringify(['user_id', 'event_id', 'cron'].sort()) || !/\bWHERE\s+event_id\s+IS\s+NOT\s+NULL\s*$/i.test(sql))
      throw new CoreError('storage_error', '提醒触发唯一约束缺失，已拒绝打开')
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'").get() as { sql?: string } | undefined)?.sql ?? ''
    if (!/CHECK\s*\(\s*workspace_id\s+IS\s+NULL\s+AND\s+filesystem_authorization_grant_id\s+IS\s+NULL\s*\)/i.test(tableSql))
      throw new CoreError('storage_error', '定时任务工作区授权边界缺失，已拒绝打开')
  }
  if (['11', '12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) {
    matchColumns(db, 'site_notifications', SITE_NOTIFICATION_COLUMNS)
    for (const [table, expected] of [['notification_reads', NOTIFICATION_READ_COLUMNS], ['notification_dismissals', NOTIFICATION_DISMISSAL_COLUMNS]] as const) {
      matchColumns(db, table, expected)
      uniqueColumns(db, table, ['user_id', 'notification_id'])
      const keys = db.pragma(`foreign_key_list(${table})`) as { table: string; from: string; to: string; on_delete: string }[]
      if (!keys.some(key => key.table === 'site_notifications' && key.from === 'notification_id' && key.to === 'id' && key.on_delete === 'CASCADE'))
        throw new CoreError('storage_error', '通知关联外键缺失，已拒绝打开')
    }
    validateSqliteInteractionPrompts(db)
  }
  if (['12', '13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) validateSqliteInteractionActions(db)
  if (['13', '14', '15', SCHEMA_VERSION].includes(values.schema_version!)) validateSmtpSchema(db, owner)
  if (['14', '15', SCHEMA_VERSION].includes(values.schema_version!)) validateOnboardingSchema(db, owner)
  if (['15', SCHEMA_VERSION].includes(values.schema_version!)) validateFeedbackSchema(db, owner)
  if (values.schema_version === SCHEMA_VERSION) validatePreferencesSchema(db, owner)
  return { owner, version: values.schema_version! }
}
function pragmas(db: SQLite.Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
}
export async function openSqliteRuntime(
  path: string,
  options: {
    allowLegacySchema?: boolean
    clock?: Clock
    exclusive?: boolean
  } = {},
): Promise<{
  runtime: SqlDataRuntime
  ownerId: string
  schemaVersion: string
}> {
  const Driver = await driver(),
    db = new Driver(resolve(path), { fileMustExist: true })
  try {
    pragmas(db)
    if (options.exclusive) {
      try {
        db.pragma('locking_mode = EXCLUSIVE')
        db.exec('BEGIN EXCLUSIVE; COMMIT')
      } catch {
        throw new CoreError('database_in_use', '数据库正由其他运行时使用，请先关闭其他实例')
      }
    }
    const info = metadata(db)
    if (
      info.version !== SCHEMA_VERSION &&
      !(options.allowLegacySchema && info.version === '2')
    )
      throw new CoreError(
        'schema_upgrade_required',
        '本地数据库需要显式迁移，请先备份并运行 migrate',
      )
    // Kysely 驱动延迟初始化；从未查询也要关闭预先打开的原生句柄。
    const runtime = new SqlDataRuntime(
      new Kysely<Database>({ dialect: new ImmediateDialect({ database: db }) }),
      'sqlite',
      options.clock,
      info.version === SCHEMA_VERSION,
      () => {
        if (db.open) db.close()
      },
    )
    return { runtime, ownerId: info.owner, schemaVersion: info.version }
  } catch (error) {
    db.close()
    throw error
  }
}
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
export async function initializeSqlite(path: string): Promise<void> {
  const target = resolve(path),
    parent = dirname(target),
    Driver = await driver()
  if (existsSync(target)) throw new CoreError('storage_error', '数据库已存在，已拒绝覆盖')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, '.core-initialize-')),
    temporary = join(directory, 'core.db')
  let db: SQLite.Database | undefined
  try {
    closeSync(openSync(temporary, 'wx', 0o600))
    db = new Driver(temporary)
    pragmas(db)
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal')
      throw new CoreError('storage_error', '本地数据库无法启用 WAL')
    db.exec('BEGIN IMMEDIATE')
    const schema = tablesSql('sqlite')
    db.exec(
      `${schema.projects}; ${schema.clients}; ${schema.receipts}; ${schema.undo}; ${schema.mindNodes}; ${schema.mindMaps}; ${schema.calendarEvents}; ${schema.ragJobs}; ${schema.ragIndexEntries}; ${schema.mindItems}; ${schema.mindRelations}; ${schema.scheduledTasks}; ${schema.scheduledFires}; ${schema.siteNotifications}; ${schema.notificationReads}; ${schema.notificationDismissals}; ${schema.userSmtp}; ${schema.onboarding}; ${schema.feedback}; ${schema.userPreferences}; CREATE TABLE core_runtime_meta (key VARCHAR(50) PRIMARY KEY NOT NULL,value VARCHAR(100) NOT NULL);`,
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
    db.exec('CREATE INDEX ix_user_smtp_configs_enabled ON user_smtp_configs(enabled)')
    for (const trigger of SMTP_OWNER_TRIGGERS) db.exec(trigger)
    for (const trigger of ONBOARDING_OWNER_TRIGGERS) db.exec(trigger)
    for (const trigger of FEEDBACK_OWNER_TRIGGERS) db.exec(trigger)
    for (const trigger of PREFERENCES_OWNER_TRIGGERS) db.exec(trigger)
    db.exec(SQLITE_AGENT_SCHEMA)
    validateAgentSchema(db)
    db.exec(SQLITE_INTERACTION_PROMPTS_SCHEMA)
    validateSqliteInteractionPrompts(db)
    db.exec(SQLITE_INTERACTION_ACTIONS_SCHEMA)
    validateSqliteInteractionActions(db)
    db.exec('COMMIT')
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    db = undefined
    // 完整文件发布前目标不可见；硬链接不覆盖已出现的用户文件。
    linkSync(temporary, target)
  } finally {
    db?.close()
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(temporary + suffix)) unlinkSync(temporary + suffix)
    rmdirSync(directory)
  }
}
export async function migrateSqlite(path: string): Promise<string> {
  const target = resolve(path),
    Driver = await driver(),
    db = new Driver(target, { fileMustExist: true })
  let backup: string | undefined
  try {
    pragmas(db)
    db.exec('BEGIN IMMEDIATE')
    const info = metadata(db)
    if (!['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16'].includes(info.version))
      throw new CoreError('schema_upgrade_required', '只支持版本 1 至 16 的显式升级')
    if (info.version === '1' && columns(db, 'clients').length)
      throw new CoreError('storage_error', '本地表结构不兼容，已拒绝自动修复')
    backup = join(
      dirname(target),
      `${basename(target)}.backup-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID()}.db`,
    )
    const source = new Driver(target, { readonly: true, fileMustExist: true })
    try {
      await source.backup(backup)
    } finally {
      source.close()
    }
    const checked = new Driver(backup, { fileMustExist: true })
    try {
      if (checked.pragma('integrity_check', { simple: true }) !== 'ok')
        throw new CoreError('storage_error', '数据库备份完整性验证失败')
      pragmas(checked)
      const backupInfo = metadata(checked)
      if (backupInfo.version !== info.version || backupInfo.owner !== info.owner || (checked.pragma('foreign_key_check') as unknown[]).length)
        throw new CoreError('storage_error', '数据库备份身份或外键验证失败')
      // 备份必须可独立恢复，不能遗留依赖其 WAL/SHM 的备份制品。
      checked.pragma('journal_mode = DELETE')
    } finally {
      checked.close()
    }
    const schema = tablesSql('sqlite')
    if (info.version === '1') {
      db.exec(schema.clients)
      db.exec('CREATE INDEX ix_clients_user_id ON clients(user_id)')
    }
    if (info.version === '1' || info.version === '2') db.exec(schema.receipts)
    if (['1', '2', '3'].includes(info.version)) {
      db.exec(schema.undo)
      createUndoIndexes(db)
    }
    if (!['5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16'].includes(info.version)) {
      db.exec(schema.mindNodes)
      createMindIndexes(db)
    }
    if (!['6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16'].includes(info.version)) {
      db.exec(SQLITE_AGENT_SCHEMA)
      validateAgentSchema(db)
    }
    if (!['7', '8', '9', '10', '11', '12', '13', '14', '15', '16'].includes(info.version)) {
      db.exec(schema.mindMaps)
      createCanvasIndexes(db)
    }
    if (!['8', '9', '10', '11', '12', '13', '14', '15', '16'].includes(info.version)) {
      db.exec(schema.calendarEvents)
      db.exec(schema.ragJobs)
      createCalendarIndexes(db)
    }
    if (!['9', '10', '11', '12', '13', '14', '15', '16'].includes(info.version)) {
      db.exec(schema.mindItems)
      db.exec(schema.mindRelations)
      createMindRelationIndexes(db)
    }
    if (!['10', '11', '12', '13', '14', '15', '16'].includes(info.version)) {
      db.exec(schema.scheduledTasks)
      db.exec(schema.scheduledFires)
      createScheduledTaskIndexes(db)
    }
    if (!['11', '12', '13', '14', '15', '16'].includes(info.version)) {
      db.exec(schema.siteNotifications)
      db.exec(schema.notificationReads)
      db.exec(schema.notificationDismissals)
      createNotificationIndexes(db)
      db.exec(SQLITE_INTERACTION_PROMPTS_SCHEMA)
      validateSqliteInteractionPrompts(db)
    }
    if (!['12', '13', '14', '15', '16'].includes(info.version)) {
      db.exec(SQLITE_INTERACTION_ACTIONS_SCHEMA)
      validateSqliteInteractionActions(db)
    }
    if (!['13', '14', '15', '16'].includes(info.version)) {
      db.exec(schema.userSmtp)
      db.exec('CREATE INDEX ix_user_smtp_configs_enabled ON user_smtp_configs(enabled)')
      for (const trigger of SMTP_OWNER_TRIGGERS) db.exec(trigger)
    }
    validateSmtpSchema(db, info.owner)
    if (!['14', '15', '16'].includes(info.version)) {
      db.exec(schema.onboarding)
      for (const trigger of ONBOARDING_OWNER_TRIGGERS) db.exec(trigger)
    }
    validateOnboardingSchema(db, info.owner)
    if (!['15', '16'].includes(info.version)) {
      db.exec(schema.feedback)
      for (const trigger of FEEDBACK_OWNER_TRIGGERS) db.exec(trigger)
    }
    validateFeedbackSchema(db, info.owner)
    if (info.version !== '16') {
      db.exec(schema.userPreferences)
      for (const trigger of PREFERENCES_OWNER_TRIGGERS) db.exec(trigger)
    }
    validatePreferencesSchema(db, info.owner)
    db.exec(schema.ragIndexEntries)
    createRagIndexIndexes(db)
    matchColumns(db, 'knowledge_index_entries', RAG_INDEX_COLUMNS)
    uniqueColumns(db, 'knowledge_index_entries', ['owner_user_id', 'source_type', 'source_id', 'document_version', 'chunk_index'])
    db.prepare("UPDATE core_runtime_meta SET value=? WHERE key='schema_version'").run(
      SCHEMA_VERSION,
    )
    db.exec('COMMIT')
    return backup
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
