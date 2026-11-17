import assert from 'node:assert/strict'
import test from 'node:test'
import { Kysely, SqliteDialect, sql } from 'kysely'
import Database from 'better-sqlite3'
import { createImMaintenanceSource } from '../../../src/memory/im-maintenance-source.js'

async function database() {
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: new Database(':memory:') }) })
  await sql`CREATE TABLE memory_reflection_cursors (
    owner_user_id TEXT, platform TEXT, bot_id TEXT, scope_type TEXT, scope_id TEXT,
    last_message_id INTEGER, last_reflected_message_id INTEGER, updated_at TEXT
  )`.execute(db)
  await sql`CREATE TABLE conversation_sessions (
    id INTEGER PRIMARY KEY, user_id TEXT, source TEXT, bot_id TEXT, chat_type TEXT, chat_id TEXT
  )`.execute(db)
  await sql`CREATE TABLE conversation_messages (
    id INTEGER PRIMARY KEY, session_id INTEGER, conversation_seq INTEGER, role TEXT, content TEXT,
    platform_user_id TEXT, platform_user_name TEXT, created_at TEXT
  )`.execute(db)
  await sql`CREATE TABLE memory_scope_tombstones (
    owner_user_id TEXT, platform TEXT, bot_id TEXT, scope_type TEXT, scope_id TEXT
  )`.execute(db)
  return db
}

test('maintenance source reads bounded cursors and only matching group/member messages in order', async () => {
  const db = await database()
  try {
    await sql`INSERT INTO memory_reflection_cursors VALUES
      ('owner-a','qq','bot-a','group','g1',20,8,'2026-01-02'),
      ('owner-a','qq','bot-a','platform-user','g1:u1',20,10,'2026-01-03')`.execute(db)
    await sql`INSERT INTO conversation_sessions VALUES
      (1,'owner-a','qq','bot-a','group','g1'),
      (2,'owner-a','qq','bot-a','group','g2'),
      (3,'owner-b','qq','bot-a','group','g1'),
      (4,'owner-a','qq','bot-b','group','g1'),
      (5,'owner-a','qq','bot-a','private','u1')`.execute(db)
    await sql`INSERT INTO conversation_messages VALUES
      (12,1,2,'user','群成员乙','u2','乙','2026-01-01'),
      (11,1,1,'user','群成员甲','u1','甲','2026-01-01'),
      (13,1,3,'assistant','助手消息',NULL,NULL,'2026-01-01'),
      (14,2,1,'user','另一群','u1','甲','2026-01-01'),
      (15,3,1,'user','另一 owner','u1','甲','2026-01-01'),
      (16,4,1,'user','另一 bot','u1','甲','2026-01-01'),
      (17,5,1,'user','私聊成员','u1','甲','2026-01-01')`.execute(db)

    const source = createImMaintenanceSource(db)
    assert.deepEqual(await source.listCursors(), [
      { owner_user_id: 'owner-a', platform: 'qq', bot_id: 'bot-a', scope_type: 'platform-user', scope_id: 'g1:u1', first_message_id: 11, last_message_id: 20 },
      { owner_user_id: 'owner-a', platform: 'qq', bot_id: 'bot-a', scope_type: 'group', scope_id: 'g1', first_message_id: 9, last_message_id: 20 },
    ])
    const group = await source.messages({ owner_user_id: 'owner-a', platform: 'qq', bot_id: 'bot-a', scope_type: 'group', scope_id: 'g1' }, 11, 12)
    assert.deepEqual(group.map(row => row.id), [11, 12])
    const member = await source.messages({ owner_user_id: 'owner-a', platform: 'qq', bot_id: 'bot-a', scope_type: 'platform-user', scope_id: 'g1:u1' }, 11, 20)
    assert.deepEqual(member.map(row => row.id), [11])
    const privateMember = await source.messages({ owner_user_id: 'owner-a', platform: 'qq', bot_id: 'bot-a', scope_type: 'platform-user', scope_id: 'u1' }, 11, 20)
    assert.deepEqual(privateMember.map(row => row.id), [17])
    await sql`INSERT INTO memory_scope_tombstones VALUES ('owner-a','qq','bot-a','group','g1')`.execute(db)
    assert.equal(await source.isTombstoned({ owner_user_id: 'owner-a', platform: 'qq', bot_id: 'bot-a', scope_type: 'group', scope_id: 'g1' }), true)
    assert.equal(await source.isTombstoned({ owner_user_id: 'owner-b', platform: 'qq', bot_id: 'bot-a', scope_type: 'group', scope_id: 'g1' }), false)
  } finally { await db.destroy() }
})

test('maintenance source rejects unsafe scope components and invalid ranges before querying', async () => {
  const db = await database()
  try {
    const source = createImMaintenanceSource(db)
    await assert.rejects(source.messages({ owner_user_id: 'owner', platform: 'qq', bot_id: 'bot', scope_type: 'group', scope_id: '../g' }, 1, 2), /scope_id/u)
    await assert.rejects(source.messages({ owner_user_id: 'owner', platform: 'qq', bot_id: 'bot', scope_type: 'platform-user', scope_id: 'g:' }, 1, 2), /成员作用域/u)
    await assert.rejects(source.messages({ owner_user_id: 'owner', platform: 'qq', bot_id: 'bot', scope_type: 'group', scope_id: 'g' }, 3, 2), /消息范围/u)
    await assert.rejects(source.listCursors(10_001), /上限/u)
  } finally { await db.destroy() }
})
