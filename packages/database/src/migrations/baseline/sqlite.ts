import { randomUUID } from 'node:crypto'
import type SQLite from 'better-sqlite3'
import { SCHEMA_VERSION } from '../../schema.js'
import { sqliteBaselineSql } from './sqlite-schema.js'

export const SQLITE_INITIAL_REVISION = '0000_baseline'

export const SMTP_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_smtp_owner_${action.toLowerCase()} BEFORE ${action} ON user_smtp_configs WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
export const ONBOARDING_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_onboarding_owner_${action.toLowerCase()} BEFORE ${action} ON onboarding_state WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
export const FEEDBACK_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_feedback_owner_${action.toLowerCase()} BEFORE ${action} ON feedbacks WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
export const PREFERENCES_OWNER_TRIGGERS = ['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER validate_preferences_owner_${action.toLowerCase()} BEFORE ${action} ON user_preferences WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`)
export const MCP_OWNER_TRIGGERS = ['user_mcp_servers','user_mcp_tool_schema_snapshots'].flatMap(table => ['INSERT','UPDATE'].map(action => `CREATE TRIGGER validate_${table}_owner_${action.toLowerCase()} BEFORE ${action} ON ${table} WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END`))

export function initializeSchema(db: SQLite.Database): void {
  db.exec(sqliteBaselineSql)
  const insert = db.prepare('INSERT INTO core_runtime_meta(key,value) VALUES (?,?)')
  insert.run('schema_version', SCHEMA_VERSION)
  insert.run('owner_id', randomUUID())
  insert.run('migration_revision', SQLITE_INITIAL_REVISION)
}
