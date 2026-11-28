import type SQLite from 'better-sqlite3'
import { DatabaseError } from '../shared/error.js'

/** 提示表 DDL；由升级器在已有会话与元数据的事务中调用。 */
export const SQLITE_INTERACTION_PROMPTS_SCHEMA = `
-- 必须在已有 Core 单 owner 元数据及会话表的事务中执行。
CREATE TABLE interaction_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL CHECK(length(user_id)=32 AND user_id NOT GLOB '*[^0-9a-f]*'),
  session_id INTEGER NOT NULL,
  kind VARCHAR(20) NOT NULL,
  title VARCHAR(300) NOT NULL,
  body TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id,user_id) REFERENCES conversation_sessions(id,user_id) ON DELETE CASCADE
);
CREATE INDEX ix_interaction_prompts_user_id ON interaction_prompts(user_id);
CREATE INDEX ix_interaction_prompts_session_id ON interaction_prompts(session_id);
CREATE INDEX ix_interaction_prompts_status ON interaction_prompts(status);
CREATE INDEX ix_interaction_prompts_expires_at ON interaction_prompts(expires_at);
CREATE TRIGGER validate_interaction_prompts_owner_insert
BEFORE INSERT ON interaction_prompts
WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
CREATE TRIGGER validate_interaction_prompts_owner_update
BEFORE UPDATE ON interaction_prompts
WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
`

/** 比较完整 SQL 对象并验证行归属和 FK；绝不创建或修复用户数据库。 */
export function validateSqliteInteractionPrompts(db: SQLite.Database): void {
  const Driver = db.constructor as typeof SQLite
  const expected = new Driver(':memory:')
  try {
    expected.exec('CREATE TABLE core_runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,UNIQUE(id,user_id))')
    expected.exec(SQLITE_INTERACTION_PROMPTS_SCHEMA)
    const objects = expected.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (name='interaction_prompts' OR name LIKE 'ix_interaction_prompts_%' OR name LIKE 'validate_interaction_prompts_owner_%') ORDER BY type,name").all() as { type: string; name: string; sql: string }[]
    const lookup = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?')
    for (const object of objects) {
      const actual = lookup.get(object.type, object.name) as { sql: string } | undefined
      if (!actual || actual.sql !== object.sql) throw new DatabaseError('storage_error', '交互提示表结构不兼容，已拒绝自动修复')
    }
    if (db.prepare("SELECT 1 FROM interaction_prompts WHERE user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') LIMIT 1").get())
      throw new DatabaseError('storage_error', '交互提示数据身份不匹配')
    if ((db.pragma('foreign_key_check(interaction_prompts)') as unknown[]).length)
      throw new DatabaseError('storage_error', '交互提示外键校验失败')
  } finally { expected.close() }
}
