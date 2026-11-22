import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import test from 'node:test'
import { createAgentInbox, createSubagentDeliveryStore, RunStoreRejected } from '@gugu/core/agent'
import type { Lease, RunCheckpoint, RunEvent, RunIdentity } from '@gugu/core/agent'
import type { Database } from '@gugu/core/data'
import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import { subagentDeliverySchema } from '../../../../../packages/database/src/shared/subagent-deliveries.js'
import { subagentConversations } from '../../../../../packages/database/src/postgres/migrations/0033_subagent_conversations.js'
import { subagentContinuations } from '../../../../../packages/database/src/postgres/migrations/0034_subagent_continuations.js'
import { subagentExecutions } from '../../../../../packages/database/src/postgres/migrations/0035_subagent_executions.js'
import { subagentSessions } from '../../../../../packages/database/src/postgres/migrations/0029_subagent_sessions.js'
import { agentInboxSchema } from '../../../../../packages/database/src/shared/agent-inbox.js'
import { subagentLaunches } from '../../../../../packages/database/src/postgres/migrations/0030_subagent_launches.js'
import { createPostgresAgentRunLeasePort } from '../../../src/modules/agent/run/lease.js'
import { createPostgresAgentRunStore } from '../../../src/modules/agent/run/store.js'

const ownerId = '00000000-0000-4000-8000-000000000091'
const identity: RunIdentity = { ownerId, sessionId: '91', runId: 'run-store-synthetic' }
const lease: Lease = { token: 'synthetic-lease-token', fence: 4 }

function checkpoint(version: number, sequence: number, context: unknown): RunCheckpoint<unknown> {
  return {
    identity, version, sequence, status: version === 0 ? 'running' : 'completed',
    phase: version === 0 ? 'provider' : 'idle', round: 1, context, text: '', roundTexts: [],
    displayTimeline: [], anchorMessageId: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null },
    totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null },
    usageAppliedRound: 0, providerCursor: null, sanitizerCheckpoint: { kind: 'clean' },
    mutated: false, unpersistedToolResult: null, files: [], providerRounds: [], calls: [], callIndex: 0,
    inflightCall: null, inflightCalls: [], parallelLimit: null, pending: null, queuedInteractions: [],
    replayCall: null, replayResultReady: false, toolResults: [], toolsDispatched: false,
    parallelCallIds: [], serialCallIds: [], isolatedCallIds: [], resolution: null,
    resolutionClosure: null, emptyRetries: 0, replyState: {}, overflowRetries: 0,
    overflowRecoveryPending: false, maxRounds: null, goalMode: false, replyChoice: 'disabled',
    roundRequiresTools: false, completedToolCount: 0, remoteStatusUnknown: false,
    errorCode: null, earlyExitReason: null,
  } as unknown as RunCheckpoint<unknown>
}

function event(sequence: number): RunEvent {
  return {
    id: `event-${sequence}`, identity, sequence, round: 1, type: 'token',
    payload: { text: sequence === 1 ? 'private-run-text' : 'finished' },
  }
}

function fakePool() {
  type Row = { version: number; sequence: number; status: string; phase: string; nonce: Buffer; payload: Buffer }
  const state: { checkpoint: Row | null; events: Map<string, { sequence: number; nonce: Buffer; payload: Buffer; acknowledged: boolean }>; receipts: Set<string>; history: unknown[]; leaseValid: boolean } = {
    checkpoint: null, events: new Map(), receipts: new Set(), history: [], leaseValid: true,
  }
  let snapshot: typeof state | null = null
  const copy = (): typeof state => ({
    checkpoint: state.checkpoint ? { ...state.checkpoint, nonce: Buffer.from(state.checkpoint.nonce), payload: Buffer.from(state.checkpoint.payload) } : null,
    events: new Map([...state.events].map(([key, row]) => [key, { ...row, nonce: Buffer.from(row.nonce), payload: Buffer.from(row.payload) }])),
    receipts: new Set(state.receipts), history: [...state.history], leaseValid: state.leaseValid,
  })
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql === 'BEGIN') { snapshot = copy(); return { rows: [], rowCount: null } }
      if (sql === 'COMMIT') { snapshot = null; return { rows: [], rowCount: null } }
      if (sql === 'ROLLBACK') {
        if (snapshot) {
          state.checkpoint = snapshot.checkpoint
          state.events = snapshot.events
          state.receipts = snapshot.receipts
          state.history = snapshot.history
          snapshot = null
        }
        return { rows: [], rowCount: null }
      }
      if (sql.startsWith('SELECT id FROM conversation_sessions')) return { rows: [{ id: 71 }], rowCount: 1 }
      if (sql.startsWith('SELECT 1 FROM agent_run_startups')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM agent_run_leases'))
        return { rows: state.leaseValid ? [{ '?column?': 1 }] : [], rowCount: state.leaseValid ? 1 : 0 }
      if (sql.includes('INSERT INTO agent_run_checkpoints')) {
        if (state.checkpoint) throw Object.assign(new Error('duplicate checkpoint'), { code: '23505' })
        state.checkpoint = {
          version: Number(values[3]), sequence: Number(values[4]), status: String(values[5]), phase: String(values[6]),
          nonce: Buffer.from(values[7] as Buffer), payload: Buffer.from(values[8] as Buffer),
        }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SELECT version, sequence, nonce, payload FROM agent_run_checkpoints'))
        return { rows: state.checkpoint
          ? [{ version: state.checkpoint.version, sequence: state.checkpoint.sequence, nonce: state.checkpoint.nonce, payload: state.checkpoint.payload }]
          : [], rowCount: state.checkpoint ? 1 : 0 }
      if (sql.includes('INSERT INTO agent_run_interaction_receipts')) {
        const receipt = String(values[3])
        if (state.receipts.has(receipt)) throw Object.assign(new Error('duplicate receipt'), { code: '23505' })
        state.receipts.add(receipt)
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE agent_run_checkpoints')) {
        if (!state.checkpoint || state.checkpoint.version !== Number(values[9])) return { rows: [], rowCount: 0 }
        state.checkpoint = {
          version: Number(values[3]), sequence: Number(values[4]), status: String(values[5]), phase: String(values[6]),
          nonce: Buffer.from(values[7] as Buffer), payload: Buffer.from(values[8] as Buffer),
        }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO agent_run_events')) {
        const id = String(values[3])
        if (state.events.has(id)) throw Object.assign(new Error('duplicate event'), { code: '23505' })
        state.events.set(id, {
          sequence: Number(values[4]), nonce: Buffer.from(values[5] as Buffer),
          payload: Buffer.from(values[6] as Buffer), acknowledged: false,
        })
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE agent_run_events')) {
        for (const id of values[3] as string[]) {
          const row = state.events.get(id)
          if (row) row.acknowledged = true
        }
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  const pool = {
    async connect() { return client },
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes('FROM agent_run_checkpoints')) {
        return { rows: state.checkpoint ? [{ ...state.checkpoint }] : [], rowCount: state.checkpoint ? 1 : 0 }
      }
      if (sql.includes('FROM agent_run_events')) {
        const rows = [...state.events].filter(([, row]) => sql.includes('acknowledged_at IS NULL') ? !row.acknowledged : row.sequence > Number(values[3]))
          .map(([event_id, row]) => ({ event_id, sequence: row.sequence, nonce: row.nonce, payload: row.payload }))
          .sort((left, right) => left.sequence - right.sequence)
        return { rows, rowCount: rows.length }
      }
      return client.query(sql, values)
    },
  }
  return { pool: pool as unknown as Pick<Pool, 'connect' | 'query'>, state }
}

test('PostgreSQL RunStore keeps checkpoints/events encrypted and supports ordered replay plus acknowledgement', async () => {
  const { pool, state } = fakePool()
  const store = createPostgresAgentRunStore(pool, 'synthetic-secret-key', { async writeHistory() {} })
  const initial = checkpoint(0, 1, { inflightCall: { rawArguments: 'private-run-text' } })

  await store.create(initial, lease, [event(1)])
  assert.ok(state.checkpoint)
  assert.equal(state.checkpoint.payload.includes(Buffer.from('private-run-text')), false)
  assert.deepEqual(await store.read(identity), initial)
  assert.deepEqual(await store.pendingEvents(identity), [event(1)])

  await store.acknowledgeEvents(identity, ['event-1'])
  assert.deepEqual(await store.pendingEvents(identity), [])
  assert.deepEqual(await store.readEventsAfter(identity, 0), [event(1)])
  assert.deepEqual(await store.readEventsAfter(identity, 1), [])
  await assert.rejects(store.readEventsAfter(identity, -1), /序号无效/)
})

test('RunStore binds encrypted checkpoint data to owner and fails closed on ciphertext tampering', async () => {
  const { pool, state } = fakePool()
  const store = createPostgresAgentRunStore(pool, 'synthetic-secret-key', { async writeHistory() {} })
  await store.create(checkpoint(0, 0, { secret: 'owner-bound' }), lease, [])

  await assert.rejects(store.read({ ...identity, ownerId: randomUUID() }), /无法安全解密/)
  state.checkpoint!.payload[state.checkpoint!.payload.length - 1] ^= 1
  await assert.rejects(store.read(identity), /无法安全解密/)
})

test('隔离 PostgreSQL 的跨身份密文复制及事件篡改不能通过认证', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async () => {
  const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL, schema = `codec_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid);
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,token text,fence bigint,expires_at timestamptz);
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,version bigint,sequence bigint,status text,phase text,nonce bytea,payload bytea,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_events(user_id uuid,session_id integer,run_id text,event_id text,sequence bigint,nonce bytea,payload bytea,created_at timestamptz,acknowledged_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,event_id))`)
    const otherOwner = randomUUID(), other = { ownerId: otherOwner, sessionId: '92', runId: 'other-run' }
    await pool.query("INSERT INTO conversation_sessions VALUES (91,$1),(92,$2)", [ownerId, otherOwner])
    await pool.query("INSERT INTO agent_run_leases VALUES ($1,91,$2,$3,$4,clock_timestamp()+interval '1 minute')", [ownerId, identity.runId, lease.token, lease.fence])
    const store = createPostgresAgentRunStore(pool, 'synthetic-secret-key', { async writeHistory() {} })
    await store.create(checkpoint(0, 1, null), lease, [event(1)])
    const interactionClient = await pool.connect(), concurrent = await pool.connect()
    try {
      await interactionClient.query('BEGIN')
      await interactionClient.query('SELECT id FROM conversation_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [91, ownerId])
      assert.equal((await store.readForUpdate(interactionClient, identity))?.sequence, 1)
      await concurrent.query('BEGIN')
      await concurrent.query("SET LOCAL lock_timeout='100ms'")
      await assert.rejects(concurrent.query('UPDATE agent_run_checkpoints SET version=version WHERE user_id=$1 AND session_id=91 AND run_id=$2', [ownerId, identity.runId]), (error: unknown) => (error as { code?: string }).code === '55P03')
      await concurrent.query('ROLLBACK')
      await interactionClient.query('ROLLBACK')
    } finally { interactionClient.release(); concurrent.release() }
    await pool.query(`INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,version,sequence,status,phase,nonce,payload,created_at,updated_at)
      SELECT $1,92,$2,version,sequence,status,phase,nonce,payload,created_at,updated_at FROM agent_run_checkpoints WHERE user_id=$3 AND session_id=91 AND run_id=$4`, [otherOwner, other.runId, ownerId, identity.runId])
    await assert.rejects(store.read(other), /无法安全解密/)
    await pool.query(`INSERT INTO agent_run_events(user_id,session_id,run_id,event_id,sequence,nonce,payload,created_at)
      SELECT $1,92,$2,event_id,sequence,nonce,payload,created_at FROM agent_run_events WHERE user_id=$3 AND session_id=91 AND run_id=$4`, [otherOwner, other.runId, ownerId, identity.runId])
    await assert.rejects(store.pendingEvents(other), /无法安全解密/)
    await pool.query("UPDATE agent_run_events SET event_id='altered' WHERE user_id=$1 AND session_id=91 AND run_id=$2", [ownerId, identity.runId])
    await assert.rejects(store.pendingEvents(identity), /无法安全解密/)
    await pool.query("UPDATE agent_run_checkpoints SET payload=set_byte(payload,0,get_byte(payload,0)#1) WHERE user_id=$1 AND session_id=91 AND run_id=$2", [ownerId, identity.runId])
    await assert.rejects(store.read(identity), /无法安全解密/)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('RunStore commits history, receipt, checkpoint and events atomically under the current lease and version', async () => {
  const { pool, state } = fakePool()
  let writes = 0
  const writtenCheckpoints: RunCheckpoint<unknown>[] = []
  const store = createPostgresAgentRunStore(pool, 'synthetic-secret-key', {
    async writeHistory(_client, _identity, history, committedCheckpoint) {
      writes += 1
      writtenCheckpoints.push(committedCheckpoint)
      state.history.push(history)
    },
  })
  await store.create(checkpoint(0, 1, { prompt: 'synthetic' }), lease, [event(1)])

  const usage = { input: 12, output: 3, cacheRead: 4, cacheWrite: 5, contextInput: 11 }
  const finalCheckpoint = { ...checkpoint(1, 2, { result: 'done' }), usage, totalUsage: usage }
  await store.commit({
    identity, expectedVersion: 0, lease, checkpoint: finalCheckpoint,
    events: [event(2)], history: { outcome: 'success', context: { compacted: true }, text: 'synthetic answer' },
    interactionReceipt: 'receipt-1',
  })
  assert.equal((await store.read(identity))?.version, 1)
  assert.deepEqual((await store.pendingEvents(identity)).map((item) => item.sequence), [1, 2])
  assert.equal(writes, 1)
  assert.equal(writtenCheckpoints[0]?.usage.input, 12)
  assert.equal(writtenCheckpoints[0]?.totalUsage.output, 3)
  assert.equal(writtenCheckpoints[0]?.version, 1)

  await assert.rejects(store.commit({
    identity, expectedVersion: 1, lease, checkpoint: checkpoint(2, 3, { result: 'duplicate' }),
    events: [event(3)], history: null, interactionReceipt: 'receipt-1',
  }), (error: unknown) => error instanceof RunStoreRejected && error.code === 'conflict')
  assert.equal((await store.read(identity))?.version, 1)
  assert.deepEqual((await store.pendingEvents(identity)).map((item) => item.sequence), [1, 2])
})

test('RunStore rolls back a checkpoint and outbox update when canonical history fails', async () => {
  const { pool, state } = fakePool()
  const store = createPostgresAgentRunStore(pool, 'synthetic-secret-key', {
    async writeHistory() { throw new Error('synthetic history failure') },
  })
  await store.create(checkpoint(0, 1, null), lease, [event(1)])

  await assert.rejects(store.commit({
    identity, expectedVersion: 0, lease, checkpoint: checkpoint(1, 2, { changed: true }),
    events: [event(2)], history: { outcome: 'success', context: {}, text: 'synthetic' },
    interactionReceipt: null,
  }), /synthetic history failure/)
  assert.equal((await store.read(identity))?.version, 0)
  assert.equal(state.events.has('event-2'), false)
})

test('首次准备快照失败回滚检查点与事件，成功后后续提交不重复应用', async () => {
  const { pool, state } = fakePool()
  let attempts = 0
  const store = createPostgresAgentRunStore(pool, 'synthetic-secret-key', {
    async writeHistory() {},
    async applyPreparedContext() { attempts++; if (attempts === 1) throw new Error('快照冲突') },
  })
  await store.create(checkpoint(0, 0, null), lease, [])
  const change = { identity, expectedVersion: 0, lease, checkpoint: checkpoint(1, 1, { ready: true }),
    events: [event(1)], history: null, interactionReceipt: null }
  await assert.rejects(store.commit(change), /快照冲突/)
  assert.equal((await store.read(identity))?.version, 0)
  assert.equal(state.events.size, 0)
  await store.commit(change)
  await store.commit({ ...change, expectedVersion: 1, checkpoint: checkpoint(2, 2, { ready: true }), events: [event(2)] })
  assert.equal(attempts, 2)
})

test('RunStore rejects a regressing checkpoint or an outbox sequence that does not match the committed checkpoint', async () => {
  const { pool } = fakePool()
  const store = createPostgresAgentRunStore(pool, 'synthetic-secret-key', { async writeHistory() {} })
  await store.create(checkpoint(0, 1, null), lease, [event(1)])

  await assert.rejects(store.commit({
    identity, expectedVersion: 0, lease, checkpoint: checkpoint(1, 0, null),
    events: [], history: null, interactionReceipt: null,
  }), /事件序号不能回退/)
  await assert.rejects(store.commit({
    identity, expectedVersion: 0, lease, checkpoint: checkpoint(1, 2, null),
    events: [], history: null, interactionReceipt: null,
  }), /checkpoint 序号与事件不一致/)
  await assert.rejects(store.commit({
    identity, expectedVersion: 0, lease, checkpoint: checkpoint(1, 3, null),
    events: [event(2)], history: null, interactionReceipt: null,
  }), /checkpoint 序号与事件不一致/)

  assert.equal((await store.read(identity))?.version, 0)
  assert.equal((await store.read(identity))?.sequence, 1)
  assert.deepEqual((await store.pendingEvents(identity)).map((item) => item.sequence), [1])
})

test('expired or replaced lease rejects run creation before writing a checkpoint', async () => {
  const { pool, state } = fakePool()
  const store = createPostgresAgentRunStore(pool, 'synthetic-secret-key', { async writeHistory() {} })
  state.leaseValid = false
  await assert.rejects(store.create(checkpoint(0, 0, null), lease, []),
    (error: unknown) => error instanceof RunStoreRejected && error.code === 'lease_lost')
  assert.equal(state.checkpoint, null)
})

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('PostgreSQL RunStore integration persists owner-scoped encrypted checkpoints and versioned outbox', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_agent_run_store_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const secondOwner = '00000000-0000-4000-8000-000000000092'
  try {
    await pool.query('CREATE TABLE users (id uuid PRIMARY KEY)')
    await pool.query(`CREATE TABLE conversation_sessions (
      id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
      title text, title_locked boolean, summary text, source text, context_epoch integer, last_message_seq bigint,
      created_at timestamptz, updated_at timestamptz, execution_state text NOT NULL DEFAULT 'idle', active_run_id text
    )`)
    await pool.query(`CREATE TABLE agent_run_startups (user_id uuid, session_id integer, run_id text, status text, PRIMARY KEY(user_id, session_id, run_id))`)
    await pool.query(`CREATE TABLE agent_run_leases (
      user_id uuid NOT NULL, session_id integer NOT NULL, run_id varchar(128) NOT NULL,
      token varchar(64) NOT NULL, fence bigint NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz, updated_at timestamptz,
      PRIMARY KEY (user_id, session_id)
    )`)
    await pool.query(`CREATE TABLE agent_run_checkpoints (
      user_id uuid NOT NULL, session_id integer NOT NULL, run_id varchar(128) NOT NULL,
      version bigint NOT NULL, sequence bigint NOT NULL, status varchar(20) NOT NULL,
      phase varchar(20) NOT NULL, nonce bytea NOT NULL, payload bytea NOT NULL,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      PRIMARY KEY (user_id, session_id, run_id)
    )`)
    await pool.query(`CREATE TABLE agent_run_events (
      user_id uuid NOT NULL, session_id integer NOT NULL, run_id varchar(128) NOT NULL,
      event_id varchar(128) NOT NULL, sequence bigint NOT NULL, nonce bytea NOT NULL,
      payload bytea NOT NULL, created_at timestamptz NOT NULL, acknowledged_at timestamptz,
      PRIMARY KEY (user_id, session_id, run_id, event_id),
      UNIQUE (user_id, session_id, run_id, sequence),
      FOREIGN KEY (user_id, session_id, run_id) REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    )`)
    await pool.query(`CREATE TABLE agent_run_interaction_receipts (
      user_id uuid NOT NULL, session_id integer NOT NULL, run_id varchar(128) NOT NULL,
      receipt text NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY (user_id, session_id, run_id, receipt),
      FOREIGN KEY (user_id, session_id, run_id) REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    )`)
    await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [ownerId, secondOwner])
    await pool.query('INSERT INTO conversation_sessions (id, user_id) VALUES ($1, $2)', [91, ownerId])
    await pool.query(`INSERT INTO agent_run_leases (user_id, session_id, run_id, token, fence, expires_at)
      VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '1 minute')`, [ownerId, 91, identity.runId, lease.token, lease.fence])

    let historyWrites = 0
    const deliveredParents: RunIdentity[] = []
    const store = createPostgresAgentRunStore(pool, 'synthetic-secret-key', {
      async onSubagentDeliveryCommitted(parent) {
        assert.equal((await store.readSubagentFinals?.(parent))?.length, 1)
        deliveredParents.push(parent)
        throw new Error('模拟 Redis 通知失败')
      },
      async writeHistory(client, runIdentity, history) {
        assert.equal(runIdentity.ownerId, ownerId)
        assert.equal(history.outcome, 'success')
        historyWrites += 1
        await client.query('INSERT INTO synthetic_history (owner_id, body) VALUES ($1, $2)', [runIdentity.ownerId, history.text])
      },
    })
    await pool.query('CREATE TABLE synthetic_history (owner_id uuid NOT NULL, body text NOT NULL)')
    await store.create(checkpoint(0, 1, { privateContext: 'private-run-text' }), lease, [event(1)])
    assert.equal((await store.read(identity))?.context && (await store.read(identity))?.version, 0)
    assert.deepEqual((await store.pendingEvents(identity)).map((item) => item.id), ['event-1'])
    await pool.query('CREATE TABLE conversation_messages (id integer PRIMARY KEY)')
    await pool.query(imGatewaySql.conversation)
    await pool.query(subagentDeliverySchema('bytea'))
    assert.equal(await subagentSessions.apply(pool), 'applied')
    assert.equal(await subagentLaunches.apply(pool), 'applied')
    assert.equal(await subagentConversations.apply(pool), 'applied')
    assert.equal(await subagentContinuations.apply(pool), 'applied')
    await pool.query('INSERT INTO conversation_sessions (id, user_id) VALUES ($1, $2)', [95, ownerId])
    await pool.query("INSERT INTO agent_subagent_sessions VALUES ('legacy-synthetic',95)")
    await pool.query("INSERT INTO agent_subagent_launches VALUES ('legacy-synthetic',$1,$2)", [Buffer.from([1]), Buffer.from([2])])
    await pool.query("INSERT INTO agent_subagent_continuations VALUES ('followup-synthetic',95,$1,$2)", [Buffer.from([3]), Buffer.from([4])])
    assert.equal(await subagentExecutions.apply(pool), 'applied')
    assert.deepEqual((await pool.query(`SELECT child_run_id,child_session_id,nonce,payload FROM agent_subagent_executions
      ORDER BY child_run_id`)).rows, [
      { child_run_id: 'followup-synthetic', child_session_id: 95, nonce: Buffer.from([3]), payload: Buffer.from([4]) },
      { child_run_id: 'legacy-synthetic', child_session_id: 95, nonce: Buffer.from([1]), payload: Buffer.from([2]) },
    ])
    assert.equal((await pool.query('SELECT child_run_id FROM agent_subagent_execution_sessions')).rowCount, 0)
    await pool.query(agentInboxSchema('bytea'))
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    const deliveries = createSubagentDeliveryStore(db, 'synthetic-secret-key', undefined, 'postgres')
    const launch = { input: { task: '合成输入' }, modelIdentity: '合成模型' }
    const admit = () => deliveries.admit(identity, '合成委派', '合成输入', launch)
    const [child, replay] = await Promise.all([admit(), admit()])
    assert.equal(child.runId, replay.runId)
    assert.deepEqual(await deliveries.readLaunch(identity, child.runId), launch)
    assert.equal(await deliveries.readLaunch({ ...identity, ownerId: secondOwner }, child.runId), null)
    assert.equal(Number(child.created) + Number(replay.created), 1)
    const childIdentity = await deliveries.childIdentity(identity, child.runId)
    assert.ok(childIdentity)
    assert.notEqual(childIdentity.sessionId, identity.sessionId)
    assert.equal(await deliveries.childIdentity({ ...identity, ownerId: secondOwner }, child.runId), null)
    const inbox = createAgentInbox(db, 'synthetic-secret-key')
    const message = await inbox.send(childIdentity, { parent: true }, '合成进度', '合成消息')
    assert.ok(message)
    assert.deepEqual(await store.readAgentInbox?.(identity), [{ id: message.messageId, message: '合成消息', target: { parent: true } }])
    const childLeases = createPostgresAgentRunLeasePort(pool)
    const childLease = await childLeases.acquire(childIdentity)
    assert.ok(childLease)
    try {
      const childCheckpoint = { ...checkpoint(0, 0, null), identity: childIdentity }
      await store.create(childCheckpoint, childLease, [])
      assert.deepEqual(await store.read(childIdentity), childCheckpoint)
      await store.commit({
        identity: childIdentity, lease: childLease, expectedVersion: 0, events: [], history: null, interactionReceipt: null,
        checkpoint: { ...childCheckpoint, version: 1, status: 'completed', text: '合成结果' },
        subagentTerminalDelivery: { parent: identity, outcome: { status: 'completed', finalMessage: '合成结果' } },
      })
    } finally { await childLeases.release(childIdentity, childLease) }
    assert.deepEqual(deliveredParents, [identity])
    assert.deepEqual(await store.readSubagentFinals?.(identity), [
      { childId: child.childId, status: 'completed', finalMessage: '合成结果' },
    ])
    // 租约释放按 session → lease 加锁；并发终态提交不得先持有 lease 等待 session。
    const competing = await pool.connect()
    await competing.query('BEGIN')
    await competing.query("SET LOCAL lock_timeout = '2s'")
    await competing.query('SELECT id FROM conversation_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [91, ownerId])
    const commit = store.commit({
      identity, expectedVersion: 0, lease, checkpoint: checkpoint(1, 2, { final: true }),
      events: [event(2)], history: { outcome: 'success', context: { final: true }, text: 'synthetic history' },
      interactionReceipt: 'receipt-1', subagentFinalIds: [child.childId], inboxMessageIds: [message.messageId],
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      await competing.query('UPDATE agent_run_leases SET expires_at=expires_at WHERE user_id=$1 AND session_id=$2', [ownerId, 91])
      await competing.query('COMMIT')
    } finally { competing.release() }
    await commit
    assert.deepEqual(await store.readSubagentFinals?.(identity), [])
    assert.deepEqual(await store.readAgentInbox?.(identity), [])
    assert.equal((await deliveries.read(identity, child.childId))?.consumed, true)
    assert.equal((await store.read(identity))?.version, 1)
    assert.equal(historyWrites, 1)
    assert.equal((await pool.query('SELECT body FROM synthetic_history')).rows[0]?.body, 'synthetic history')
    assert.equal((await store.pendingEvents(identity)).length, 2)

    assert.equal(await store.read({ ...identity, ownerId: secondOwner }), null)
    await pool.query(`INSERT INTO agent_run_checkpoints
      (user_id, session_id, run_id, version, sequence, status, phase, nonce, payload, created_at, updated_at)
      SELECT $1, session_id, run_id, version, sequence, status, phase, nonce, payload, created_at, updated_at
      FROM agent_run_checkpoints WHERE user_id = $2 AND session_id = $3 AND run_id = $4`,
    [secondOwner, ownerId, identity.sessionId, identity.runId])
    await assert.rejects(store.read({ ...identity, ownerId: secondOwner }), /无法安全解密/)
    await store.acknowledgeEvents(identity, ['event-1'])
    assert.deepEqual((await store.pendingEvents(identity)).map((item) => item.id), ['event-2'])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
