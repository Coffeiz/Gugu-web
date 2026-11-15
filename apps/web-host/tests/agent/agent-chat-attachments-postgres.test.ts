import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { withPostgresTransaction } from '../../src/adapters/postgres-transaction.js'
import { claimOwnedChatAttachments, readOwnedChatAttachments } from '../../src/domains/agent-sessions/persistence/agent-chat-attachments.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('附件按 owner 读取、重复 ID 只认领一次，任一冲突回滚此前认领', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `attachment_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE chat_attachments (user_id uuid NOT NULL,attach_id text NOT NULL,name text NOT NULL,ext text NOT NULL,mime text,size bigint NOT NULL,storage_key text NOT NULL,kind text NOT NULL,duration float,img_width integer,img_height integer,extra jsonb,state text NOT NULL,message_id integer,attached_at timestamptz,UNIQUE(user_id,attach_id))`)
    const owner = randomUUID(), other = randomUUID()
    await pool.query("INSERT INTO chat_attachments(user_id,attach_id,name,ext,size,storage_key,kind,state) VALUES ($1,'a','合成','','1','a','text','draft'),($1,'b','合成','','1','b','text','attached'),($2,'private','私有','','1','c','text','draft')", [owner, other])
    await withPostgresTransaction(pool, async client => {
      const rows = await readOwnedChatAttachments(client, owner, ['a','private','missing','a'])
      assert.deepEqual(rows.map(row => row.attach_id), ['a','a'])
    })
    await assert.rejects(withPostgresTransaction(pool, client => claimOwnedChatAttachments(client, owner, 10, ['a','b'])))
    assert.equal((await pool.query("SELECT state FROM chat_attachments WHERE user_id=$1 AND attach_id='a'", [owner])).rows[0].state, 'draft')
    await withPostgresTransaction(pool, client => claimOwnedChatAttachments(client, owner, 10, ['a','a']))
    await assert.rejects(withPostgresTransaction(pool, client => claimOwnedChatAttachments(client, owner, 11, ['a'])))
    await assert.rejects(withPostgresTransaction(pool, client => claimOwnedChatAttachments(client, owner, 11, ['private'])))
    assert.equal((await pool.query("SELECT state FROM chat_attachments WHERE user_id=$1 AND attach_id='private'", [other])).rows[0].state, 'draft')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
