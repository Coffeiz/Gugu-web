import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { after, test } from 'node:test'
import { Pool } from 'pg'
import { createApp } from '../../../../src/app.js'
import { createUserToken } from '../../../../src/modules/auth/session/token.js'
import { createPostgresAgentSessionRenamer } from '../../../../src/modules/agent/sessions/update.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000091'
const foreignOwnerId = '00000000-0000-4000-8000-000000000092'
const secret = 'synthetic-agent-session-rename-vite-secret'
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

test('Vite→Node Host→随机 PostgreSQL schema 认证改名并持久锁定手动标题', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL HTTP 集成',
}, async () => {
  schema = `gugu_agent_rename_http_${randomUUID().replaceAll('-', '')}`
  adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  pools.push(pool)
  await pool.query(`
    CREATE TABLE conversation_sessions (
      id integer PRIMARY KEY, user_id uuid NOT NULL, title varchar(300) NOT NULL,
      title_locked boolean NOT NULL DEFAULT false
    )
  `)
  await pool.query(`
    INSERT INTO conversation_sessions (id,user_id,title) VALUES
      (7,$1,'旧标题'), (8,$2,'他人标题')
  `, [ownerId, foreignOwnerId])

  const app = createApp({
    appName: '合成会话改名 Host',
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
    renameAgentSession: createPostgresAgentSessionRenamer(pool),
  })
  apps.push(app)
  const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
  const previousTarget = process.env.VITE_API_PROXY_TARGET
  process.env.VITE_API_PROXY_TARGET = hostAddress

  try {
    const frontendRoot = resolve(process.cwd(), '../ui')
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

    const unauthenticated = await fetch(`${base}/api/v1/agent/sessions/7`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '未授权改名' }),
    })
    assert.equal(unauthenticated.status, 401)
    const headers = {
      authorization: `Bearer ${createUserToken(ownerId, 1, secret)}`,
      'content-type': 'application/json',
    }
    const invalid = await fetch(`${base}/api/v1/agent/sessions/7`, {
      method: 'PATCH', headers, body: JSON.stringify({ title: '   ' }),
    })
    assert.equal(invalid.status, 422)
    const foreign = await fetch(`${base}/api/v1/agent/sessions/8`, {
      method: 'PATCH', headers, body: JSON.stringify({ title: '不应改名' }),
    })
    assert.equal(foreign.status, 404)

    const renamed = await fetch(`${base}/api/v1/agent/sessions/7?owner_id=${foreignOwnerId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ title: '  新标题  ' }),
    })
    assert.equal(renamed.status, 200)
    assert.deepEqual(await renamed.json(), { id: 7, title: '新标题', title_locked: true })
    const persisted = await pool.query<{ title: string; title_locked: boolean; user_id: string }>(
      'SELECT title,title_locked,user_id FROM conversation_sessions WHERE id=7',
    )
    assert.deepEqual(persisted.rows[0], { title: '新标题', title_locked: true, user_id: ownerId })
    const untouched = await pool.query<{ title: string; title_locked: boolean }>(
      'SELECT title,title_locked FROM conversation_sessions WHERE id=8',
    )
    assert.deepEqual(untouched.rows[0], { title: '他人标题', title_locked: false })
  } finally {
    if (previousTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousTarget
  }
})
