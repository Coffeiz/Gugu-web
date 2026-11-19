import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Pool } from 'pg'
import { createPostgresAgentOrphanRecovery } from '../../src/modules/agent/run/recovery.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000091'
const otherOwnerId = '00000000-0000-4000-8000-000000000092'
let adminPool: Pool | undefined
let pool: Pool | undefined
let schema: string | undefined

after(async () => {
  await pool?.end()
  if (adminPool && schema) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
  await adminPool?.end()
})

test('PostgreSQL orphan recovery preserves live leases, isolates owners, and clears dead run states', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL recovery integration',
}, async () => {
  schema = `gugu_agent_recovery_${randomUUID().replaceAll('-', '')}`
  adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  await pool.query(`
    CREATE TABLE conversation_sessions (
      id serial PRIMARY KEY, user_id uuid NOT NULL,
      execution_state varchar(24) NOT NULL, active_run_id varchar(64)
    );
    CREATE TABLE agent_run_leases (user_id uuid NOT NULL, session_id integer NOT NULL, expires_at timestamptz NOT NULL)
  `)
  const insert = async (userId: string, state: string, runId: string | null) => {
    const result = await pool!.query<{ id: number }>(
      'INSERT INTO conversation_sessions (user_id,execution_state,active_run_id) VALUES ($1,$2,$3) RETURNING id',
      [userId, state, runId],
    )
    return result.rows[0]!.id
  }
  const read = async (id: number) => (await pool!.query<{
    execution_state: string
    active_run_id: string | null
  }>('SELECT execution_state,active_run_id FROM conversation_sessions WHERE id=$1', [id])).rows[0]
  const liveId = await insert(ownerId, 'running', 'run-live')
  const orphanId = await insert(ownerId, 'running', 'run-dead')
  const foreignId = await insert(otherOwnerId, 'running', 'run-foreign')
  const lockedBaselineId = await insert(ownerId, 'baseline_updating', 'run-baseline')
  const orphanBaselineId = await insert(ownerId, 'baseline_updating', 'run-baseline-dead')
  const reaped: number[] = []
  const state = (probe: { redisOk: boolean; active: boolean | null; stale: boolean }, lock = false) => ({
    async probe() { return { ...probe, snapshot: '{}' } },
    async reapIfStale(id: number) { reaped.push(id); return true },
    async compressionLockExists() { return lock },
  })

  const unavailable = createPostgresAgentOrphanRecovery(pool!, state({ redisOk: false, active: null, stale: false }))
  assert.equal(await unavailable(ownerId, orphanId), false)
  assert.equal((await read(orphanId))?.execution_state, 'running')

  const active = createPostgresAgentOrphanRecovery(pool!, state({ redisOk: true, active: true, stale: false }))
  assert.equal(await active(ownerId, liveId), false)
  assert.deepEqual(await read(liveId), { execution_state: 'running', active_run_id: 'run-live' })

  const recover = createPostgresAgentOrphanRecovery(pool!, state({ redisOk: true, active: true, stale: true }))
  assert.equal(await recover(ownerId, orphanId), true)
  assert.deepEqual(await read(orphanId), { execution_state: 'idle', active_run_id: null })
  assert.equal(await recover(ownerId, foreignId), false)
  assert.deepEqual(await read(foreignId), { execution_state: 'running', active_run_id: 'run-foreign' })
  assert.deepEqual(reaped, [orphanId])

  const locked = createPostgresAgentOrphanRecovery(pool!, state({ redisOk: true, active: false, stale: false }, true))
  assert.equal(await locked(ownerId, lockedBaselineId), false)
  assert.equal((await read(lockedBaselineId))?.execution_state, 'baseline_updating')
  const unlocked = createPostgresAgentOrphanRecovery(pool!, state({ redisOk: true, active: false, stale: false }))
  assert.equal(await unlocked(ownerId, orphanBaselineId), true)
  assert.deepEqual(await read(orphanBaselineId), { execution_state: 'idle', active_run_id: null })

  // 新 run 在首次 Redis 检查之后取得租约时，不得回收它的会话。
  const racedId = await insert(ownerId, 'running', 'run-new')
  let probes = 0
  let reaps = 0
  const raced = createPostgresAgentOrphanRecovery(pool!, {
    async probe() {
      probes += 1
      return probes === 1
        ? { redisOk: true, active: true, stale: true }
        : { redisOk: true, active: true, stale: false }
    },
    async reapIfStale() { reaps += 1; return true },
    async compressionLockExists() { return false },
  })
  assert.equal(await raced(ownerId, racedId), false)
  assert.deepEqual(await read(racedId), { execution_state: 'running', active_run_id: 'run-new' })
  assert.equal(reaps, 0)

  const pgLiveId = await insert(ownerId, 'running', 'run-pg-live')
  await pool!.query("INSERT INTO agent_run_leases VALUES ($1,$2,clock_timestamp()+interval '1 minute')", [ownerId, pgLiveId])
  assert.equal(await recover(ownerId, pgLiveId), false)
  assert.deepEqual(await read(pgLiveId), { execution_state: 'running', active_run_id: 'run-pg-live' })
  assert.deepEqual(reaped, [orphanId])

  const pythonClaimId = await insert(ownerId, 'running', 'new-python-run')
  const oldSnapshot = createPostgresAgentOrphanRecovery(pool!, {
    async probe() { return { redisOk: true, active: true, stale: true, snapshot: '{"done":false,"owner_run_id":"old-run"}' } },
    async reapIfStale() { throw new Error('不得清理旧快照以覆盖新 run') },
    async compressionLockExists() { return false },
  })
  assert.equal(await oldSnapshot(ownerId, pythonClaimId), false)
  assert.equal((await read(pythonClaimId))?.active_run_id, 'new-python-run')
})
