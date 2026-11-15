import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Pool } from 'pg'
import { withPostgresTransaction } from '../../src/adapters/postgres-transaction.js'
import { enqueueConversationRagRebuild } from '../../src/domains/agent-sessions/persistence/conversation-rag-job-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const schema = `gugu_conversation_rag_${randomUUID().replaceAll('-', '')}`
let admin: Pool | undefined
let pool: Pool | undefined

after(async () => {
  await pool?.end()
  if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
  await admin?.end()
})

test('conversation writes coalesce into an owner-wide rebuild and fence an earlier lease', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL 队列回归',
}, async () => {
  admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  await pool.query(`CREATE TABLE rag_index_jobs (
    id bigserial PRIMARY KEY, user_id uuid NOT NULL, source_type text NOT NULL, source_id text NOT NULL,
    version text NOT NULL, operation text NOT NULL, status text NOT NULL, generation integer NOT NULL,
    completed_generation integer NOT NULL, attempts integer NOT NULL, next_attempt_at timestamptz,
    lease_until timestamptz, last_started_at timestamptz, last_succeeded_at timestamptz,
    last_error_code text, pending_source_ids json NOT NULL, created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL, UNIQUE(user_id, source_type)
  )`)

  const ownerId = randomUUID()
  await withPostgresTransaction(pool, client => enqueueConversationRagRebuild(client, ownerId))
  await pool.query(`UPDATE rag_index_jobs SET status='running', generation=2, pending_source_ids='["old-message"]',
    lease_until=CURRENT_TIMESTAMP + interval '1 minute' WHERE user_id=$1 AND source_type='conversation'`, [ownerId])
  await withPostgresTransaction(pool, client => enqueueConversationRagRebuild(client, ownerId))

  const row = await pool.query<{ source_id: string; operation: string; generation: number; status: string; lease_until: Date | null; pending_source_ids: string[] }>(
    `SELECT source_id,operation,generation,status,lease_until,pending_source_ids FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'`, [ownerId])
  assert.deepEqual(row.rows[0], {
    source_id: '', operation: 'refresh', generation: 3, status: 'queued', lease_until: null, pending_source_ids: [],
  })
})

test('conversation RAG enqueue rolls back with the history transaction', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL 事务回归',
}, async () => {
  assert.ok(pool)
  const ownerId = randomUUID()
  await assert.rejects(withPostgresTransaction(pool, async client => {
    await enqueueConversationRagRebuild(client, ownerId)
    throw new Error('synthetic transaction failure')
  }), /synthetic transaction failure/u)
  const row = await pool.query(`SELECT 1 FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'`, [ownerId])
  assert.equal(row.rowCount, 0)
})
