import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'

const ddl = await readFile(new URL('../../../../../docs/refactor/agent/agent-tables.sql', import.meta.url), 'utf8')
const owner = '0123456789abcdef0123456789abcdef'
function dependencies(db: Database.Database) {
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE workspaces(id INTEGER PRIMARY KEY); CREATE TABLE conversation_batches(id INTEGER PRIMARY KEY);')
  db.prepare('INSERT INTO users VALUES (?)').run(owner)
}

test('空库创建保留 JSON、UTC 微秒、唯一约束和级联删除', () => {
  const db = new Database(':memory:')
  try {
    dependencies(db); db.transaction(() => db.exec(ddl)).immediate()
    db.prepare("INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,session_context,created_at,updated_at) VALUES (?, '对话', 0, '', 'web', 1, ?, ?, ?)").run(owner, '{"ok":true}', '2026-11-14 01:02:03.123456', '2026-11-14 01:02:03.123456')
    db.prepare("INSERT INTO conversation_messages(session_id,conversation_seq,role,content,created_at) VALUES (1,1,'user','示例',?)").run('2026-11-14 01:02:03.123456')
    expect(db.prepare('SELECT session_context,created_at FROM conversation_sessions').get()).toEqual({ session_context: '{"ok":true}', created_at: '2026-11-14 01:02:03.123456' })
    expect(() => db.exec("INSERT INTO conversation_messages(session_id,conversation_seq,role,content,created_at) VALUES (1,1,'user','', '2026-11-14')")).toThrow()
    expect(() => db.exec("INSERT INTO conversation_pending_queues(user_id,queue_id,session_id,items,updated_at) VALUES ('missing','q',1,'[]','2026-11-14')")).toThrow()
    db.prepare("INSERT INTO conversation_pending_queues(user_id,queue_id,session_id,items,updated_at) VALUES (?,'q',1,'[]',?)").run(owner, '2026-11-14 01:02:03.123456')
    db.exec('DELETE FROM conversation_sessions WHERE id=1')
    expect(db.prepare('SELECT count(*) AS n FROM conversation_pending_queues').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT count(*) AS n FROM conversation_messages').get()).toEqual({ n: 0 })
  } finally { db.close() }
})

test('模拟 v5 显式迁入：冲突回滚，旧数据和在线备份保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-agent-draft-'))
  const db = new Database(join(dir, 'data.sqlite')), backup = join(dir, 'backup.sqlite')
  try {
    dependencies(db)
    db.exec("CREATE TABLE core_runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO core_runtime_meta VALUES ('schema_version','5'); CREATE TABLE conversation_messages(old_data TEXT); INSERT INTO conversation_messages VALUES ('old');")
    await db.backup(backup)
    expect(() => db.transaction(() => { db.exec(ddl); db.exec("UPDATE core_runtime_meta SET value='6' WHERE key='schema_version'") }).immediate()).toThrow()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='conversation_sessions'").get()).toBeUndefined()
    expect(db.prepare('SELECT old_data FROM conversation_messages').get()).toEqual({ old_data: 'old' })
    expect(db.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").get()).toEqual({ value: '5' })
    const copy = new Database(backup, { readonly: true })
    try { expect(copy.prepare('SELECT old_data FROM conversation_messages').get()).toEqual({ old_data: 'old' }); expect(copy.pragma('integrity_check', { simple: true })).toBe('ok') } finally { copy.close() }
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})

test('模拟 v5 显式迁入：事务提交并保留无关数据', () => {
  const db = new Database(':memory:')
  try {
    dependencies(db)
    db.exec("CREATE TABLE core_runtime_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO core_runtime_meta VALUES ('schema_version','5'); CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES ('preserved');")
    db.transaction(() => { db.exec(ddl); db.exec("UPDATE core_runtime_meta SET value='6' WHERE key='schema_version'") }).immediate()
    expect(db.prepare('SELECT value FROM legacy').get()).toEqual({ value: 'preserved' })
    expect(db.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").get()).toEqual({ value: '6' })
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally { db.close() }
})
