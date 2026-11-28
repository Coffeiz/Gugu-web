import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { applyAgentBaseMigration, checkAgentBaseMigration } from '@gugu/database/postgres/migrations/0001_initialize'
import { PostgresMigrationError } from '@gugu/database/postgres'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const integration = { skip: !url && '需要隔离 PostgreSQL' }
const incompatible = (error: unknown) => error instanceof PostgresMigrationError && error.code === 'incompatible'

async function withSchema(run: (pool: Pool) => Promise<void>) {
  const admin = new Pool({ connectionString: url })
  const schema = `agent_base_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await run(pool)
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
}

test('Node 基础迁移并发初始化一次，约束保护会话归属、历史去重和删除语义', integration, async () => withSchema(async pool => {
  assert.equal(await checkAgentBaseMigration(pool), 'pending')
  assert.equal((await pool.query("SELECT to_regclass('users') AS users")).rows[0].users, null)
  assert.deepEqual((await Promise.all([applyAgentBaseMigration(pool), applyAgentBaseMigration(pool)])).sort(),
    ['applied', 'unchanged'])
  assert.equal(await checkAgentBaseMigration(pool), 'applied')

  const owner = randomUUID(), other = randomUUID()
  await pool.query(`INSERT INTO users(id,username,email,hashed_password)
    VALUES($1,'小北','north@example.test','synthetic'),($2,'小南','south@example.test','synthetic')`, [owner, other])
  await pool.query('INSERT INTO conversation_sessions(user_id) VALUES($1),($2)', [owner, other])
  await pool.query("INSERT INTO conversation_batches(session_id,digest) VALUES(1,'north'),(2,'south')")
  await pool.query("INSERT INTO conversation_messages(session_id,conversation_seq,role,client_message_id,canonical_batch_id) VALUES(1,1,'user','client-1',1)")
  await assert.rejects(pool.query("INSERT INTO conversation_messages(session_id,conversation_seq,role,canonical_batch_id) VALUES(1,2,'user',2)"), { code: '23503' })
  await assert.rejects(pool.query("INSERT INTO conversation_messages(session_id,conversation_seq,role) VALUES(1,1,'user')"), { code: '23505' })
  await assert.rejects(pool.query("INSERT INTO conversation_messages(session_id,conversation_seq,role,client_message_id) VALUES(1,2,'user','client-1')"), { code: '23505' })

  const prompt = (id: string) => pool.query('INSERT INTO interaction_prompts(user_id,session_id,expires_at) VALUES($1,1,now())', [id])
  const queue = (id: string) => pool.query("INSERT INTO conversation_pending_queues(user_id,queue_id,session_id) VALUES($1,'session-1',1)", [id])
  const usage = (id: string) => pool.query("INSERT INTO agent_usage(user_id,session_id,model,provider) VALUES($1,1,'model','local')", [id])
  for (const insert of [prompt, queue, usage]) {
    await assert.rejects(insert(other), { code: '23503' })
    await insert(owner)
  }
  await assert.rejects(pool.query("INSERT INTO chat_attachments(user_id,attach_id,storage_key,state) VALUES($1,'attachment-1','synthetic','attached')", [owner]), { code: '23514' })
  await pool.query("INSERT INTO chat_attachments(user_id,attach_id,storage_key,message_id,state) VALUES($1,'attachment-1','synthetic',1,'attached')", [owner])
  await pool.query('DELETE FROM conversation_batches WHERE id=1')
  assert.deepEqual((await pool.query('SELECT session_id,canonical_batch_id FROM conversation_messages')).rows,
    [{ session_id: 1, canonical_batch_id: null }])
  await pool.query('DELETE FROM conversation_sessions WHERE id=1')
  assert.deepEqual((await pool.query('SELECT user_id,session_id FROM agent_usage')).rows, [{ user_id: owner, session_id: null }])
  for (const table of ['conversation_messages', 'interaction_prompts', 'conversation_pending_queues', 'chat_attachments'])
    assert.equal((await pool.query(`SELECT 1 FROM ${table}`)).rowCount, 0)
}))

test('Node 基础迁移拒绝接管未登记的表和漂移后的结构', integration, async () => withSchema(async pool => {
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)')
  await assert.rejects(applyAgentBaseMigration(pool), incompatible)
  assert.equal((await pool.query("SELECT to_regclass('conversation_sessions') AS sessions")).rows[0].sessions, null)
  await pool.query('DROP TABLE users')
  assert.equal(await applyAgentBaseMigration(pool), 'applied')
  await pool.query('ALTER TABLE conversation_pending_queues ALTER COLUMN items DROP NOT NULL')
  await assert.rejects(checkAgentBaseMigration(pool), incompatible)
}))
