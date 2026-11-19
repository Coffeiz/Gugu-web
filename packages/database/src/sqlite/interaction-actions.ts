import type SQLite from 'better-sqlite3'
import { DatabaseError } from '../shared/error.js'

/** 候选 action 表；正式升级器须在可信提示表就绪后的写事务中调用。 */
export const SQLITE_INTERACTION_ACTIONS_SCHEMA = `
CREATE TABLE interaction_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id INTEGER NOT NULL REFERENCES interaction_prompts(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  action_type VARCHAR(30) NOT NULL,
  option_id VARCHAR(100) NOT NULL,
  context_json TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_event_id VARCHAR(200),
  created_at TEXT NOT NULL
);
CREATE INDEX ix_interaction_actions_prompt_id ON interaction_actions(prompt_id);
CREATE INDEX ix_interaction_actions_token_hash ON interaction_actions(token_hash);
CREATE INDEX ix_interaction_actions_status ON interaction_actions(status);
CREATE INDEX ix_interaction_actions_expires_at ON interaction_actions(expires_at);
`

/** 校验完整表及索引定义和数据外键，不自动修复或更改当前数据库。 */
export function validateSqliteInteractionActions(db: SQLite.Database): void {
  const Driver = db.constructor as typeof SQLite
  const expected = new Driver(':memory:')
  try {
    expected.exec('CREATE TABLE interaction_prompts(id INTEGER PRIMARY KEY)')
    expected.exec(SQLITE_INTERACTION_ACTIONS_SCHEMA)
    const objects = expected.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (name='interaction_actions' OR name LIKE 'ix_interaction_actions_%') ORDER BY type,name").all() as { type: string; name: string; sql: string }[]
    const lookup = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?')
    for (const object of objects) {
      const actual = lookup.get(object.type, object.name) as { sql: string } | undefined
      if (!actual || actual.sql !== object.sql) throw new DatabaseError('storage_error', '交互动作表结构不兼容，已拒绝自动修复')
    }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='interaction_prompts'").get())
      throw new DatabaseError('storage_error', '交互提示表不存在')
    if ((db.pragma('foreign_key_check(interaction_actions)') as unknown[]).length)
      throw new DatabaseError('storage_error', '交互动作外键校验失败')
  } finally { expected.close() }
}
