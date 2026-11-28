import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { withPostgresTransaction } from '../../../src/adapters/database/postgres-transaction.js'
import { bindAgentChatPendingQueue } from '../../../src/modules/agent/chat/draft.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('待发队列绑定与消费按 owner 隔离，claim 冲突回滚且并发只消费一次', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `queue_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid NOT NULL);
      CREATE TABLE conversation_pending_queues (user_id uuid NOT NULL,queue_id text NOT NULL,session_id integer,items jsonb NOT NULL,updated_at timestamptz NOT NULL, UNIQUE(user_id,queue_id));`)
    const owner = randomUUID(), other = randomUUID()
    await pool.query('INSERT INTO conversation_sessions VALUES (7,$1),(8,$2)', [owner, other])
    await pool.query("INSERT INTO conversation_pending_queues VALUES ($1,'draft',NULL,$2,now()),($3,'draft',NULL,$4,now())", [owner, JSON.stringify([{ key: 1, text: 'draft' }]), other, JSON.stringify([{ key: 1, text: 'other' }])])
    await withPostgresTransaction(pool, client => bindAgentChatPendingQueue(client, owner, 7, true, { message: '', pending_queue_id: 'draft' }))
    let result = await pool.query('SELECT user_id,queue_id,items FROM conversation_pending_queues ORDER BY queue_id')
    assert.equal(result.rows.length, 2)
    assert.equal(result.rows.find(row => row.queue_id === 'session-7').items[0].text, 'draft')
    assert.equal(result.rows.find(row => row.queue_id === 'draft').user_id, other)
    await pool.query("UPDATE conversation_pending_queues SET items=$1 WHERE user_id=$2 AND queue_id='session-7'", [JSON.stringify([{ key: 1, _claim_token: 'correct' }, { key: 2, text: 'keep' }]), owner])
    const input = { message: '', pending_queue_id: 'session-7', pending_queue_item_key: 1, pending_queue_claim_token: 'wrong' }
    await assert.rejects(withPostgresTransaction(pool, client => bindAgentChatPendingQueue(client, owner, 7, false, input)))
    result = await pool.query("SELECT items FROM conversation_pending_queues WHERE user_id=$1 AND queue_id='session-7'", [owner])
    assert.equal(result.rows[0].items.length, 2)
    const consume = () => withPostgresTransaction(pool, client => bindAgentChatPendingQueue(client, owner, 7, false, { ...input, pending_queue_claim_token: 'correct' }))
    const settled = await Promise.allSettled([consume(), consume()])
    assert.equal(settled.filter(value => value.status === 'fulfilled').length, 1)
    result = await pool.query("SELECT items FROM conversation_pending_queues WHERE user_id=$1 AND queue_id='session-7'", [owner])
    assert.deepEqual(result.rows[0].items, [{ key: 2, text: 'keep' }])
    await assert.rejects(withPostgresTransaction(pool, client => bindAgentChatPendingQueue(client, other, 7, false, { ...input, pending_queue_claim_token: 'correct' })))
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
