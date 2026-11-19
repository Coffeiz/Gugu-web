import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'

import { SQLITE_INTERACTION_PROMPTS_SCHEMA as ddl, validateSqliteInteractionPrompts as validate } from '@gugu/database/sqlite/interaction-prompts'
const rawOwner = 'ABCDEF12-3456-7890-ABCD-EF1234567890'
const owner = rawOwner.replaceAll('-', '').toLowerCase()
function legacy(db) {
  db.pragma('foreign_keys = ON')
  db.exec("CREATE TABLE core_runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,UNIQUE(id,user_id)); CREATE TABLE legacy_data(value TEXT NOT NULL); INSERT INTO legacy_data VALUES ('保留'); INSERT INTO core_runtime_meta VALUES ('schema_version','10');")
  db.prepare("INSERT INTO core_runtime_meta VALUES ('owner_id',?)").run(rawOwner)
  db.prepare('INSERT INTO conversation_sessions VALUES (1,?)').run(owner)
}
function insert(db, user, session, schema) {
  return db.prepare("INSERT INTO interaction_prompts(user_id,session_id,kind,title,body,schema_json,status,expires_at,resolved_at,created_at) VALUES (?,?,'form','','',?,'active','2026-11-14 12:00:00.123456',NULL,'2026-11-14 12:00:00.123456')").run(user,session,schema)
}

test('提示草案验证 owner、会话关联、JSON 和级联', () => {
  const db = new Database(':memory:')
  try {
    legacy(db); db.transaction(() => db.exec(ddl)).immediate(); validate(db)
    insert(db, owner, 1, 'null'); insert(db, owner, 1, '"{}"')
    expect(db.prepare('SELECT schema_json,expires_at,resolved_at FROM interaction_prompts ORDER BY id').all()).toEqual([
      { schema_json: 'null', expires_at: '2026-11-14 12:00:00.123456', resolved_at: null },
      { schema_json: '"{}"', expires_at: '2026-11-14 12:00:00.123456', resolved_at: null },
    ])
    expect(() => insert(db, 'f'.repeat(32), 1, '{}')).toThrow()
    expect(() => insert(db, owner, 2, '{}')).toThrow()
    expect(() => db.prepare("UPDATE interaction_prompts SET user_id=? WHERE id=1").run('f'.repeat(32))).toThrow()
    expect(() => db.prepare('UPDATE interaction_prompts SET session_id=2 WHERE id=1').run()).toThrow()
    expect(db.pragma('foreign_key_check(interaction_prompts)')).toEqual([])
    db.exec('DELETE FROM conversation_sessions WHERE id=1')
    expect(db.prepare('SELECT count(*) FROM interaction_prompts').pluck().get()).toBe(0)
  } finally { db.close() }
})

test('模拟 v10 显式升级：冲突回滚并保留一致备份', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-interaction-draft-')), backup = join(folder, 'backup.db')
  const db = new Database(join(folder, 'source.db'))
  try {
    legacy(db); db.exec("CREATE TABLE interaction_prompts(old_value TEXT); INSERT INTO interaction_prompts VALUES ('原有数据')")
    await db.backup(backup)
    expect(() => db.transaction(() => { db.exec(ddl); db.exec("UPDATE core_runtime_meta SET value='11' WHERE key='schema_version'") }).immediate()).toThrow()
    expect(db.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('10')
    expect(db.prepare('SELECT old_value FROM interaction_prompts').pluck().get()).toBe('原有数据')
    const copy = new Database(backup, { readonly: true })
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(copy.prepare('SELECT old_value FROM interaction_prompts').pluck().get()).toBe('原有数据')
      expect(copy.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).toBe(rawOwner)
    } finally { copy.close() }
  } finally { db.close(); await rm(folder, { recursive: true, force: true }) }
})

test('模拟 v10 成功升级在事务中保留旧数据及身份', () => {
  const db = new Database(':memory:')
  try {
    legacy(db)
    db.transaction(() => { db.exec(ddl); db.exec("UPDATE core_runtime_meta SET value='11' WHERE key='schema_version'") }).immediate()
    expect(db.prepare('SELECT value FROM legacy_data').pluck().get()).toBe('保留')
    expect(db.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).toBe(rawOwner)
    expect(db.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('11')
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally { db.close() }
})


test('校验器拒绝缺索引、触发器以及已损坏的 owner 或外键', () => {
  for (const fault of ['index', 'trigger', 'owner', 'foreign']) {
    const db = new Database(':memory:')
    try {
      legacy(db); db.exec(ddl)
      if (fault === 'index') db.exec('DROP INDEX ix_interaction_prompts_expires_at')
      if (fault === 'trigger') db.exec('DROP TRIGGER validate_interaction_prompts_owner_update')
      if (fault === 'owner') {
        const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='validate_interaction_prompts_owner_insert'").pluck().get()
        db.exec('DROP TRIGGER validate_interaction_prompts_owner_insert')
        db.pragma('foreign_keys = OFF'); insert(db, 'f'.repeat(32), 1, '{}'); db.pragma('foreign_keys = ON')
        db.exec(trigger)
      }
      if (fault === 'foreign') {
        db.pragma('foreign_keys = OFF'); insert(db, owner, 99, '{}'); db.pragma('foreign_keys = ON')
      }
      expect(() => validate(db), fault).toThrow()
    } finally { db.close() }
  }
})
