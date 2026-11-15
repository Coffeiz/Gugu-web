import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { agentQueueContract } from '../../fixtures/agent-queue-contract.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
agentQueueContract('隔离 PostgreSQL 待发送队列契约', async () => {
  const schema = `gugu_queue_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), other = randomUUID()
  const admin = new pg.Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
  await pool.query('CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid); CREATE TABLE conversation_pending_queues(id bigserial PRIMARY KEY,user_id uuid,queue_id text,session_id integer,items jsonb,updated_at timestamptz,UNIQUE(user_id,queue_id))')
  await pool.query('INSERT INTO conversation_sessions VALUES (1,$1)', [owner])
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) })
  return { db, owner, other, async close() { await db.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() } }
}, 'postgres')
