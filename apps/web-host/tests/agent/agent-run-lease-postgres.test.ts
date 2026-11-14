import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { RunStoreRejected, type RunIdentity } from '@gugu/core/harness'
import { createPostgresAgentRunLeasePort } from '../../src/domains/agent-sessions/persistence/agent-run-lease-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000081'
const identity: RunIdentity = { ownerId, sessionId: '71', runId: 'run-lease-synthetic' }

function fakePool(options: { acquired?: boolean; valid?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql.includes('INSERT INTO agent_run_leases'))
        return { rows: options.acquired === false ? [] : [{ fence: '4' }], rowCount: options.acquired === false ? 0 : 1 }
      if (sql.includes('SELECT 1'))
        return { rows: options.valid === false ? [] : [{ '?column?': 1 }], rowCount: options.valid === false ? 0 : 1 }
      return { rows: [], rowCount: 1 }
    },
  }
  return { pool, calls }
}

test('acquire scopes by owner/session, returns a fence, asserts it and releases without resetting the fence', async () => {
  const { pool, calls } = fakePool()
  const leases = createPostgresAgentRunLeasePort(pool as unknown as Pick<Pool, 'query'>, {
    leaseTtlMs: 60_000, renewIntervalMs: 30_000,
  })

  const lease = await leases.acquire(identity)
  assert.deepEqual(lease, { token: lease?.token, fence: 4 })
  assert.ok(lease?.token)
  await leases.assert(identity, lease!)
  await leases.release(identity, lease!)

  assert.match(calls[0]!.sql, /session\.id = \$2 AND session\.user_id = \$1/)
  assert.match(calls[0]!.sql, /fence = agent_run_leases\.fence \+ 1/)
  assert.match(calls[2]!.sql, /SET expires_at = clock_timestamp\(\)/)
  assert.deepEqual(calls.map((call) => call.values?.slice(0, 3)), [
    [ownerId, 71, identity.runId],
    [ownerId, 71, identity.runId],
    [ownerId, 71, identity.runId],
  ])
})

test('an occupied lease returns null and a lost fencing token fails closed', async () => {
  const occupied = fakePool({ acquired: false })
  const leases = createPostgresAgentRunLeasePort(occupied.pool as unknown as Pick<Pool, 'query'>, {
    leaseTtlMs: 60_000, renewIntervalMs: 30_000,
  })
  assert.equal(await leases.acquire(identity), null)

  const lost = fakePool({ valid: false })
  const lostLeasePort = createPostgresAgentRunLeasePort(lost.pool as unknown as Pick<Pool, 'query'>)
  await assert.rejects(lostLeasePort.assert(identity, { token: 'stale-token', fence: 3 }),
    (error: unknown) => error instanceof RunStoreRejected && error.code === 'lease_lost')
})

test('invalid session identities never reach PostgreSQL', async () => {
  const { pool, calls } = fakePool()
  const leases = createPostgresAgentRunLeasePort(pool as unknown as Pick<Pool, 'query'>)
  await assert.rejects(leases.acquire({ ...identity, sessionId: '71x' }), /Agent 会话身份无效/)
  assert.deepEqual(calls, [])
})

async function withDatabase(work: (pool: Pool) => Promise<void>) {
  const schema = `gugu_agent_lease_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query('CREATE TABLE users (id uuid PRIMARY KEY)')
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
      )
    `)
    await pool.query(`
      CREATE TABLE agent_run_leases (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        run_id varchar(128) NOT NULL,
        token varchar(64) NOT NULL,
        fence bigint NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (user_id, session_id)
      )
    `)
    await pool.query('INSERT INTO users (id) VALUES ($1)', [ownerId])
    await pool.query('INSERT INTO conversation_sessions (id, user_id) VALUES ($1, $2)', [71, ownerId])
    await work(pool)
  } finally {
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
}

test('PostgreSQL serializes competing sessions and advances the fence after release', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => withDatabase(async (pool) => {
  const leases = createPostgresAgentRunLeasePort(pool, { leaseTtlMs: 3000, renewIntervalMs: 1000 })
  const [left, right] = await Promise.all([leases.acquire(identity), leases.acquire(identity)])
  const first = left ?? right
  assert.ok(first)
  assert.equal(Number(!!left) + Number(!!right), 1)
  await leases.assert(identity, first)
  await leases.release(identity, first)

  const next = await leases.acquire({ ...identity, runId: 'run-lease-next' })
  assert.equal(next?.fence, first.fence + 1)
  await leases.release({ ...identity, runId: 'run-lease-next' }, next!)
}))
