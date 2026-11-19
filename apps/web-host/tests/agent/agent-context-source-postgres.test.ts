import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createPostgresCurrentTurnReader, createPostgresSnapshotReader } from '../../src/modules/agent/context/source.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('来源快照与当前消息仅允许 owner 读取并绑定实际消息锚点', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `context_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions (id integer PRIMARY KEY,user_id uuid NOT NULL,context_epoch integer NOT NULL,session_context jsonb,snapshot_hash text,session_info_hash text,snapshot_expires_at timestamptz,baseline_message_seq bigint NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer NOT NULL,role text NOT NULL,content text NOT NULL,content_json jsonb,files jsonb,references_json jsonb)`)
    const owner = randomUUID(), other = randomUUID(), identity = { ownerId: owner, sessionId: '1', runId: 'run' }
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,2,NULL,NULL,NULL,'2026-01-01T00:00:00Z',3)", [owner])
    await pool.query("INSERT INTO conversation_messages VALUES (9,1,'user','合成',NULL,NULL,NULL)")
    const read = createPostgresSnapshotReader(pool)
    assert.equal((await read(identity))?.baselineMessageSeq, 3)
    assert.equal((await read(identity))?.snapshotExpiresAt, Date.parse('2026-01-01T00:00:00Z'))
    assert.equal(await read({ ...identity, ownerId: other }), null)
    const current = createPostgresCurrentTurnReader(pool, '9', async (_identity, row) => ({ currentUser: { persistedMessageId: row.id, message: { role: 'user', content: row.content } } }))
    assert.equal((await current(identity)).currentUser?.message.content, '合成')
    await assert.rejects(current({ ...identity, ownerId: other }), /用户消息不存在/)
    const bad = createPostgresCurrentTurnReader(pool, '9', async () => ({ currentUser: { persistedMessageId: '10', message: { role: 'user', content: '' } } }))
    await assert.rejects(bad(identity), /锚点不一致/)
    const user = (persistedMessageId: string) => ({ persistedMessageId, message: { role: 'user' as const, content: `合成批次${persistedMessageId}` } })
    const batch = createPostgresCurrentTurnReader(pool, '9', async () => ({ currentUsers: [user('8'), user('9')] }))
    assert.deepEqual((await batch(identity)).currentUsers?.map(item => item.persistedMessageId), ['8', '9'])
    for (const value of [{ currentUsers: [user('9'), user('8')] }, { currentUsers: [user('9'), user('9')] },
      { currentUsers: [user('8'), user('9')], currentUser: user('9') }]) {
      await assert.rejects(createPostgresCurrentTurnReader(pool, '9', async () => value)(identity), /锚点不一致/)
    }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
