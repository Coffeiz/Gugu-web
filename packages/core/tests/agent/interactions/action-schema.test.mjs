import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { SQLITE_INTERACTION_ACTIONS_SCHEMA as ddl, validateSqliteInteractionActions as validate } from '@gugu/database/sqlite/interaction-actions'

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.exec('CREATE TABLE interaction_prompts(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL); INSERT INTO interaction_prompts VALUES (1,\'owner\')')
  db.exec(ddl)
  return db
}
function insert(db, prompt, hash, context = '{}') {
  const time = '2026-11-14 12:00:00.123456'
  db.prepare("INSERT INTO interaction_actions(prompt_id,token_hash,action_type,option_id,context_json,status,expires_at,consumed_at,consumed_event_id,created_at) VALUES (?,?,'choice','approve',?,'pending',?,NULL,NULL,?)").run(prompt,hash,context,time,time)
}

test('真实哈希存储、JSON 与 UTC 微秒保留，提示删除级联', () => {
  const db = createDb()
  try {
    const token = 'synthetic-token', digest = createHash('sha256').update(token).digest('hex')
    insert(db, 1, digest, 'null'); validate(db)
    const row = db.prepare('SELECT token_hash,context_json,expires_at,consumed_at FROM interaction_actions').get()
    expect(row).toEqual({ token_hash: digest, context_json: 'null', expires_at: '2026-11-14 12:00:00.123456', consumed_at: null })
    expect(JSON.stringify(row)).not.toContain(token)
    expect(() => insert(db, 9, digest)).toThrow()
    db.exec('DELETE FROM interaction_prompts WHERE id=1')
    expect(db.prepare('SELECT count(*) FROM interaction_actions').pluck().get()).toBe(0)
  } finally { db.close() }
})

test('历史 SQLite 可写入非标准摘要并保留非空约束', () => {
  const db = createDb()
  try {
    insert(db, 1, '历史摘要')
    expect(db.prepare('SELECT token_hash FROM interaction_actions').pluck().get()).toBe('历史摘要')
    expect(() => insert(db, 1, null)).toThrow()
  } finally { db.close() }
})

test('缺索引、变更表结构、缺提示表和损坏外键均拒绝', () => {
  for (const fault of ['index', 'table', 'parent', 'foreign']) {
    const db = createDb()
    try {
      if (fault === 'index') db.exec('DROP INDEX ix_interaction_actions_expires_at')
      if (fault === 'table') db.exec('ALTER TABLE interaction_actions ADD COLUMN unexpected TEXT')
      if (fault === 'parent') db.exec('DROP TABLE interaction_prompts')
      if (fault === 'foreign') { db.pragma('foreign_keys=OFF'); insert(db, 2, 'digest'); db.pragma('foreign_keys=ON') }
      expect(() => validate(db), fault).toThrow()
    } finally { db.close() }
  }
})

test('模拟升级冲突回滚不覆盖旧动作数据与旧版本', () => {
  const db = new Database(':memory:')
  try {
    db.exec("CREATE TABLE interaction_prompts(id INTEGER PRIMARY KEY); CREATE TABLE meta(version INTEGER); INSERT INTO meta VALUES(11); CREATE TABLE interaction_actions(old_value TEXT); INSERT INTO interaction_actions VALUES('保留')")
    expect(() => db.transaction(() => { db.exec(ddl); db.exec('UPDATE meta SET version=12') }).immediate()).toThrow()
    expect(db.prepare('SELECT version FROM meta').pluck().get()).toBe(11)
    expect(db.prepare('SELECT old_value FROM interaction_actions').pluck().get()).toBe('保留')
  } finally { db.close() }
})
