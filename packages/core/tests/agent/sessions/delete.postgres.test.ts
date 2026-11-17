import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test } from 'vitest'
import { createPostgresAgentSessionDeleteRepository } from '../../../src/agent/sessions/delete-data.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
test('会话删除在 PostgreSQL 同事务关闭 Agent 终端并显式删除附件和消息', { skip: !url && 'requires isolated GUGU_CORE_TEST_POSTGRES_URL' }, async () => {
  const schema = `agent_session_delete_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer NOT NULL REFERENCES conversation_sessions(id));
      CREATE TABLE chat_attachments(id integer PRIMARY KEY,user_id uuid NOT NULL,message_id integer NOT NULL REFERENCES conversation_messages(id),storage_key text NOT NULL);
      CREATE TABLE terminal_sessions(id text PRIMARY KEY,session_id integer REFERENCES conversation_sessions(id) ON DELETE SET NULL,source text NOT NULL,status text NOT NULL,closed_at timestamptz,updated_at timestamptz NOT NULL);
    `)
    const owner = randomUUID(), foreignOwner = randomUUID()
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1),(2,$2)', [owner, foreignOwner])
    await pool.query('INSERT INTO conversation_messages VALUES (11,1),(22,2)')
    await pool.query("INSERT INTO chat_attachments VALUES (1,$1,11,'shared'),(2,$1,11,'orphan')", [owner])
    await pool.query("INSERT INTO terminal_sessions VALUES ('agent-1',1,'agent','running',NULL,now()),('manual-1',1,'user','running',NULL,now())")
    const repository = createPostgresAgentSessionDeleteRepository(pool)

    assert.deepEqual(await repository.delete(owner, 1), { storageKeys: ['orphan', 'shared'] })
    assert.equal((await pool.query('SELECT id FROM conversation_sessions WHERE id=1')).rowCount, 0)
    assert.equal((await pool.query('SELECT id FROM conversation_messages WHERE session_id=1')).rowCount, 0)
    assert.equal((await pool.query('SELECT id FROM chat_attachments WHERE message_id=11')).rowCount, 0)
    const terminals = await pool.query<{ id: string; status: string; closed_at: Date | null; session_id: number | null }>('SELECT id,status,closed_at,session_id FROM terminal_sessions ORDER BY id')
    assert.deepEqual(terminals.rows.map(row => [row.id,row.status,row.closed_at !== null,row.session_id]), [
      ['agent-1','terminated',true,null], ['manual-1','running',false,null],
    ])
    assert.equal(await repository.delete(owner, 2), null)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
