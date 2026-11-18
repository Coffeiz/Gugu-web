import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { withPostgresTransaction } from '../../src/adapters/postgres-transaction.js'
import { claimOwnedChatAttachments, readOwnedChatAttachments } from '../../src/domains/agent-sessions/persistence/agent-chat-attachments.js'
import { applyAgentBaseMigration } from '../../src/migrations/agent-base-migrate.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('附件按 owner 读取、重复 ID 只认领一次，任一冲突回滚此前认领', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `attachment_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await applyAgentBaseMigration(pool)
    const owner = randomUUID(), other = randomUUID()
    await pool.query(`INSERT INTO users(id,username,email,hashed_password)
      VALUES($1,'小北','north@example.test','synthetic'),($2,'小南','south@example.test','synthetic')`, [owner, other])
    await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES(1,$1),(2,$2)', [owner, other])
    await pool.query("INSERT INTO conversation_messages(id,session_id,conversation_seq,role) VALUES(10,1,1,'user'),(11,1,2,'user'),(20,2,1,'user')")
    await pool.query(`INSERT INTO chat_attachments(user_id,attach_id,name,ext,size,storage_key,kind,state,message_id)
      VALUES ($1,'a','合成','','1','a','text','draft',NULL),($1,'b','合成','','1','b','text','attached',11),
        ($2,'private','私有','','1','c','text','draft',NULL)`, [owner, other])
    await withPostgresTransaction(pool, async client => {
      const rows = await readOwnedChatAttachments(client, owner, ['a','private','missing','a'])
      assert.deepEqual(rows.map(row => row.attach_id), ['a','a'])
    })
    await assert.rejects(withPostgresTransaction(pool, client => claimOwnedChatAttachments(client, owner, 20, ['a'])))
    await assert.rejects(withPostgresTransaction(pool, client => claimOwnedChatAttachments(client, owner, 10, ['a','b'])))
    assert.equal((await pool.query("SELECT state FROM chat_attachments WHERE user_id=$1 AND attach_id='a'", [owner])).rows[0].state, 'draft')
    await withPostgresTransaction(pool, client => claimOwnedChatAttachments(client, owner, 10, ['a','a']))
    await assert.rejects(withPostgresTransaction(pool, client => claimOwnedChatAttachments(client, owner, 11, ['a'])))
    await assert.rejects(withPostgresTransaction(pool, client => claimOwnedChatAttachments(client, owner, 11, ['private'])))
    assert.equal((await pool.query("SELECT state FROM chat_attachments WHERE user_id=$1 AND attach_id='private'", [other])).rows[0].state, 'draft')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
