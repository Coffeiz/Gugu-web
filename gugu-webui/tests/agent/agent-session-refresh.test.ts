import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import {
  createPostgresAgentSessionRefresher,
  registerAgentSessionRefreshRoute,
} from '../../src/domains/agent-sessions/agent-session-refresh.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('刷新上下文先认证，不读取身份或写入失效标记', async () => {
  const app = Fastify()
  registerAgentSessionRefreshRoute(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取身份') },
    async refresh() { throw new Error('未认证时不得写入') },
  })
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/agent/sessions/7/refresh-context',
    })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { detail: '未认证' })
  } finally {
    await app.close()
  }
})

test('刷新上下文使用可信 owner，并返回递增后的 epoch', async () => {
  const app = Fastify()
  const calls: Array<{ ownerId: string; sessionId: number }> = []
  const ownerId = '8f5048f4-8e16-43d0-9a8d-3c08087f5131'
  registerAgentSessionRefreshRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return ownerId },
    async refresh(requestOwner, sessionId) {
      calls.push({ ownerId: requestOwner, sessionId })
      return { id: sessionId, context_epoch: 9 }
    },
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/sessions/7/refresh-context?ownerId=00000000-0000-4000-8000-000000000000',
      headers: { 'x-user-id': '00000000-0000-4000-8000-000000000000' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { id: 7, context_epoch: 9, refresh_scheduled: true })
    assert.deepEqual(calls, [{ ownerId, sessionId: 7 }])
  } finally {
    await app.close()
  }
})

test('无效的会话 ID 返回 422，合法整数但不存在的会话返回 404', async () => {
  const app = Fastify()
  const calls: number[] = []
  registerAgentSessionRefreshRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return '8f5048f4-8e16-43d0-9a8d-3c08087f5131' },
    async refresh(_ownerId, sessionId) { calls.push(sessionId); return null },
  })
  try {
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/agent/sessions/1e0/refresh-context',
    })
    assert.equal(invalid.statusCode, 422)
    const missing = await app.inject({
      method: 'POST', url: '/api/v1/agent/sessions/0/refresh-context',
    })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: '会话不存在' })
    assert.deepEqual(calls, [0])
  } finally {
    await app.close()
  }
})

test('PostgreSQL 刷新只递增 epoch 并过期快照，不清空上下文或越权修改', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_agent_refresh_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        context_epoch integer NOT NULL,
        session_context jsonb,
        snapshot_hash varchar(64),
        session_info_hash varchar(64),
        snapshot_expires_at timestamptz,
        updated_at timestamptz NOT NULL
      )
    `)
    const ownerId = randomUUID(), otherOwnerId = randomUUID()
    const stamp = '2026-11-01T00:00:00Z'
    const context = { snapshot_context: '保留旧快照', system_prompt: '保留系统提示', context_revision: 4 }
    const { rows: ownRows } = await pool.query<{ id: number }>(
      `INSERT INTO conversation_sessions
         (user_id,context_epoch,session_context,snapshot_hash,session_info_hash,snapshot_expires_at,updated_at)
       VALUES ($1,5,$2::jsonb,'own-hash','own-session-info-hash',$3,$4) RETURNING id`,
      [ownerId, JSON.stringify(context), '2026-12-01T00:00:00Z', stamp],
    )
    const { rows: foreignRows } = await pool.query<{ id: number }>(
      `INSERT INTO conversation_sessions
         (user_id,context_epoch,session_context,snapshot_hash,session_info_hash,snapshot_expires_at,updated_at)
       VALUES ($1,3,$2::jsonb,'foreign-hash','foreign-session-info-hash',$3,$4) RETURNING id`,
      [otherOwnerId, JSON.stringify(context), '2026-12-01T00:00:00Z', stamp],
    )
    const ownId = ownRows[0]!.id, foreignId = foreignRows[0]!.id
    const invalidationEvents: Array<{ sessionId: number; contextEpoch: number }> = []
    const refresh = createPostgresAgentSessionRefresher(pool, async (event) => {
      const persisted = await pool.query('SELECT context_epoch FROM conversation_sessions WHERE id = $1', [event.sessionId])
      assert.equal(persisted.rows[0]?.context_epoch, event.contextEpoch, '旁路事件发生时主写入已提交')
      invalidationEvents.push({ sessionId: event.sessionId, contextEpoch: event.contextEpoch })
    })

    assert.deepEqual(await refresh(ownerId, ownId), { id: ownId, context_epoch: 6 })
    assert.equal(await refresh(ownerId, foreignId), null)
    const { rows } = await pool.query(
      'SELECT id,user_id,context_epoch,session_context,snapshot_hash,snapshot_expires_at,updated_at FROM conversation_sessions ORDER BY id',
    )
    assert.equal(rows[0]!.context_epoch, 6)
    assert.deepEqual(rows[0]!.session_context, context)
    assert.equal(rows[0]!.snapshot_hash, 'own-hash')
    assert.ok(new Date(rows[0]!.snapshot_expires_at).getTime() <= Date.now())
    assert.ok(new Date(rows[0]!.updated_at).getTime() > new Date(stamp).getTime())
    assert.equal(rows[1]!.context_epoch, 3)
    assert.equal(new Date(rows[1]!.snapshot_expires_at).toISOString(), '2026-12-01T00:00:00.000Z')
    assert.deepEqual(invalidationEvents, [{
      sessionId: ownId, contextEpoch: 6, snapshotHash: 'own-hash',
      sessionInfoHash: 'own-session-info-hash', expiresAt: rows[0]!.snapshot_expires_at.toISOString(),
    }])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})

test('snapshot trace 失败不回滚已完成的失效结果', async () => {
  const pool = {
    async query() {
      return {
        rows: [{
          id: 7, context_epoch: 8, snapshot_hash: 'hash', session_info_hash: 'info-hash',
          snapshot_expires_at: new Date('2026-11-13T00:00:00Z'),
        }],
        rowCount: 1,
      }
    },
  } as unknown as Pool
  const refresh = createPostgresAgentSessionRefresher(pool, () => { throw new Error('trace unavailable') })
  assert.deepEqual(await refresh('8f5048f4-8e16-43d0-9a8d-3c08087f5131', 7), {
    id: 7, context_epoch: 8,
  })
})
