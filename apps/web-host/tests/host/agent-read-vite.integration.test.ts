import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { after, test } from 'node:test'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createAgentSessionLister } from '../../src/domains/agent-sessions/agent-sessions.js'
import { createAgentMessageHistory } from '../../src/domains/agent-sessions/persistence/agent-message-history.js'
import { createPostgresAgentOrphanRecovery } from '../../src/domains/agent-sessions/persistence/agent-run-recovery.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000081'
const foreignOwnerId = '00000000-0000-4000-8000-000000000082'
const secret = 'synthetic-agent-read-vite-secret'
const apps: Array<{ close(): Promise<void> }> = []
const viteServers: Array<{ close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } }> = []
const pools: Pool[] = []
let adminPool: Pool | undefined
let schema: string | undefined

after(async () => {
  await Promise.all(viteServers.splice(0).map((server) => server.close()))
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(pools.splice(0).map((pool) => pool.end()))
  if (adminPool && schema) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
  await adminPool?.end()
})

test('Vite→Node Host→随机 PostgreSQL schema 认证读取 owner 会话与消息', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL HTTP 集成',
}, async () => {
  schema = `gugu_agent_read_http_${randomUUID().replaceAll('-', '')}`
  adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  pools.push(pool)
  await pool.query(`
    CREATE TABLE workspaces (id integer PRIMARY KEY, name text NOT NULL);
    CREATE TABLE conversation_sessions (
      id integer PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL,
      source text, chat_type text, workspace_id integer, session_context jsonb,
      updated_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
      execution_state text, active_run_id text,
      pending_message_count integer NOT NULL DEFAULT 0, bot_id integer
    );
    CREATE TABLE conversation_messages (
      id integer PRIMARY KEY, session_id integer NOT NULL REFERENCES conversation_sessions(id),
      role text NOT NULL, content text NOT NULL DEFAULT '', content_json jsonb,
      client_message_id text, quoted_text text, references_json jsonb,
      platform_user_id text, platform_user_name text, platform_bot_user_id text,
      run_outcome text, im_platform_sent_ms bigint, im_event_received_ms bigint,
      display_timeline jsonb, files jsonb, conversation_seq bigint NOT NULL,
      run_id text, round_id text, created_at timestamptz NOT NULL
    );
    CREATE TABLE conversation_pending_queues (
      user_id uuid NOT NULL, queue_id text NOT NULL, items jsonb NOT NULL DEFAULT '[]'::jsonb
    );
  `)
  const stamp = new Date().toISOString()
  await pool.query(
    `INSERT INTO conversation_sessions (
       id,user_id,title,source,updated_at,created_at,execution_state,active_run_id
     ) VALUES (41,$1,'我的会话',NULL,$3,$3,'running','dead-run'),
              (42,$2,'他人会话',NULL,$3,$3,'idle',NULL)`,
    [ownerId, foreignOwnerId, stamp],
  )
  await pool.query(
    `INSERT INTO conversation_messages (id,session_id,role,content,conversation_seq,created_at)
     VALUES (101,41,'user','你好',1,$1),(102,42,'user','不应返回',1,$1)`, [stamp],
  )

  const app = createApp({
    appName: '合成 Agent 读取 Host',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    listAgentSessions: createAgentSessionLister(pool, {
      activeStatuses: async () => new Map(),
      filesystemAuthorizationEnabled: () => false,
      workspaceShellSupported: () => false,
    }),
    listAgentMessages: createAgentMessageHistory(pool, {
      filesystemAuthorizationEnabled: () => false,
      listInteractions: async () => [],
      recoverOrphanedSession: createPostgresAgentOrphanRecovery(pool, {
        async probe() { return { redisOk: true, active: false, stale: false } },
        async reap() {},
        async compressionLockExists() { return false },
      }),
    }).list,
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
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    viteServers.push(vite)
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const token = createUserToken(ownerId, 1, secret)
    const unauthenticated = await fetch(`${base}/api/v1/agent/sessions`)
    assert.equal(unauthenticated.status, 401)

    const headers = { authorization: `Bearer ${token}` }
    const sessions = await fetch(`${base}/api/v1/agent/sessions?owner_id=${foreignOwnerId}`, { headers })
    assert.equal(sessions.status, 200)
    const sessionRows = await sessions.json() as Array<Record<string, unknown>>
    assert.equal(sessionRows.length, 1)
    assert.equal(sessionRows[0]?.id, 41)
    assert.equal(sessionRows[0]?.title, '我的会话')

    const history = await fetch(
      `${base}/api/v1/agent/sessions/41/messages?owner_id=${foreignOwnerId}`,
      { headers },
    )
    assert.equal(history.status, 200)
    const page = await history.json() as {
      session: { id: number }
      executionState: string
      messages: Array<{ id: number; content: string }>
    }
    assert.equal(page.session.id, 41)
    assert.equal(page.executionState, 'idle')
    assert.deepEqual(page.messages.map(({ id, content }) => ({ id, content })), [{ id: 101, content: '你好' }])
    const recovered = await pool.query<{ execution_state: string; active_run_id: string | null }>(
      'SELECT execution_state,active_run_id FROM conversation_sessions WHERE id=41',
    )
    assert.deepEqual(recovered.rows[0], { execution_state: 'idle', active_run_id: null })

    const foreignHistory = await fetch(`${base}/api/v1/agent/sessions/42/messages`, { headers })
    assert.equal(foreignHistory.status, 404)
  } finally {
    if (previousTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousTarget
  }
})
