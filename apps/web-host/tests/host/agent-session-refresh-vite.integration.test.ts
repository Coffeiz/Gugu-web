import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { after, test } from 'node:test'
import { Pool } from 'pg'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'
import { createPostgresAgentSessionRefresher } from '../../src/modules/agent-sessions/agent-session-refresh.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000101'
const foreignOwnerId = '00000000-0000-4000-8000-000000000102'
const secret = 'synthetic-agent-session-refresh-vite-secret'
const apps: Array<{ close(): Promise<void> }> = []
const viteServers: Array<{ close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } }> = []
const pools: Pool[] = []
let adminPool: Pool | undefined
let schema: string | undefined

after(async () => {
  await Promise.all(viteServers.splice(0).map(server => server.close()))
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(pools.splice(0).map(pool => pool.end()))
  if (adminPool && schema) await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
  await adminPool?.end()
})

test('Vite→Node Host→随机 PostgreSQL schema 认证刷新 owner 会话快照', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL HTTP 集成',
}, async () => {
  schema = `gugu_agent_refresh_http_${randomUUID().replaceAll('-', '')}`
  adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  pools.push(pool)
  await pool.query(`
    CREATE TABLE conversation_sessions (
      id integer PRIMARY KEY, user_id uuid NOT NULL, context_epoch integer NOT NULL,
      session_context jsonb, snapshot_hash varchar(64), session_info_hash varchar(64),
      snapshot_expires_at timestamptz, updated_at timestamptz NOT NULL
    )
  `)
  const context = { snapshot_context: '旧快照正文保留', system_prompt: '系统提示保留', context_revision: 6 }
  await pool.query(`
    INSERT INTO conversation_sessions
      (id,user_id,context_epoch,session_context,snapshot_hash,session_info_hash,snapshot_expires_at,updated_at)
    VALUES
      (7,$1,4,$2::jsonb,'own-snapshot','own-info','2026-12-01T00:00:00Z','2026-11-01T00:00:00Z'),
      (8,$3,2,$2::jsonb,'foreign-snapshot','foreign-info','2026-12-01T00:00:00Z','2026-11-01T00:00:00Z')
  `, [ownerId, JSON.stringify(context), foreignOwnerId])

  const app = createApp({
    appName: '合成会话上下文刷新 Host',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId || id === foreignOwnerId ? {
          id, username: 'sample-user', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    refreshAgentSession: createPostgresAgentSessionRefresher(pool),
  })
  apps.push(app)
  const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
  const previousTarget = process.env.VITE_API_PROXY_TARGET
  process.env.VITE_API_PROXY_TARGET = hostAddress

  try {
    const frontendRoot = resolve(process.cwd(), '../web')
    const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
    const viteModule = requireFrontend('vite') as {
      createServer(options: Record<string, unknown>): Promise<{
        listen(): Promise<void>
        close(): Promise<void>
        httpServer?: { address(): string | { port: number } | null }
      }>
    }
    const vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'), root: frontendRoot, logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    viteServers.push(vite)
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const unauthenticated = await fetch(`${base}/api/v1/agent/sessions/7/refresh-context`, { method: 'POST' })
    assert.equal(unauthenticated.status, 401)
    const headers = { authorization: `Bearer ${createUserToken(ownerId, 1, secret)}` }

    const foreign = await fetch(`${base}/api/v1/agent/sessions/8/refresh-context`, { method: 'POST', headers })
    assert.equal(foreign.status, 404)
    const refreshed = await fetch(`${base}/api/v1/agent/sessions/7/refresh-context?owner_id=${foreignOwnerId}`, {
      method: 'POST', headers,
    })
    assert.equal(refreshed.status, 200)
    assert.deepEqual(await refreshed.json(), { id: 7, context_epoch: 5, refresh_scheduled: true })

    const rows = await pool.query<{
      id: number; user_id: string; context_epoch: number; session_context: unknown
      snapshot_hash: string; snapshot_expires_at: Date; updated_at: Date
    }>(`SELECT id,user_id,context_epoch,session_context,snapshot_hash,snapshot_expires_at,updated_at
        FROM conversation_sessions ORDER BY id`)
    assert.equal(rows.rows[0]?.user_id, ownerId)
    assert.equal(rows.rows[0]?.context_epoch, 5)
    assert.deepEqual(rows.rows[0]?.session_context, context)
    assert.equal(rows.rows[0]?.snapshot_hash, 'own-snapshot')
    assert.ok(rows.rows[0]!.snapshot_expires_at.getTime() <= Date.now())
    assert.ok(rows.rows[0]!.updated_at.getTime() > Date.parse('2026-11-01T00:00:00Z'))
    assert.deepEqual(rows.rows[1], {
      id: 8, user_id: foreignOwnerId, context_epoch: 2, session_context: context,
      snapshot_hash: 'foreign-snapshot', snapshot_expires_at: new Date('2026-12-01T00:00:00.000Z'),
      updated_at: new Date('2026-11-01T00:00:00.000Z'),
    })
  } finally {
    if (previousTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousTarget
  }
})
