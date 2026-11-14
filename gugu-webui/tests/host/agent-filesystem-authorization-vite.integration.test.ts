import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import {
  createAgentSessionFilesystemAuthorization,
  type FilesystemAuthorizationConfirmationPort,
} from '../../src/domains/agent-sessions/agent-filesystem-authorization.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-filesystem-vite-secret'

function confirmationPort(): FilesystemAuthorizationConfirmationPort {
  let pendingCode: string | null = null
  let grant: string | null = null
  let identityKey = ''
  return {
    async revoke(ownerId, summary, identity) {
      if (identityKey === `${ownerId}\0${summary}\0${identity}`) {
        pendingCode = null
        grant = null
      }
      return true
    },
    async createPending(ownerId, summary, identity) {
      identityKey = `${ownerId}\0${summary}\0${identity}`
      pendingCode = 'feedc0de1234'
      return pendingCode
    },
    async redeem(ownerId, code) {
      if (!pendingCode || code !== pendingCode) return false
      grant = identityKey
      pendingCode = null
      return true
    },
    async hasGrant(ownerId, summary, identity) {
      return grant === `${ownerId}\0${summary}\0${identity}`
    },
  }
}

test('Vite→Node Host→隔离 PostgreSQL 完成会话授权申请、确认、撤销和 owner 隔离', {
  skip: !databaseUrl && '需要显式隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_filesystem_auth_vite_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const ownerId = randomUUID()
  const foreignOwnerId = randomUUID()
  const terminated: string[] = []
  let vite: { listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } } | undefined
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    await pool.query(`
      CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid NOT NULL, title varchar(300));
      CREATE TABLE filesystem_authorization_grants (
        id serial PRIMARY KEY, user_id uuid NOT NULL, subject_type varchar(24) NOT NULL,
        subject_id varchar(64) NOT NULL, scope varchar(32) NOT NULL, permission varchar(32) NOT NULL,
        granted_by varchar(16) NOT NULL, granted_at timestamptz NOT NULL, expires_at timestamptz,
        revoked_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE security_events (
        id serial PRIMARY KEY, user_id uuid NOT NULL, event_type varchar(80) NOT NULL,
        resource_type varchar(120) NOT NULL, resource_fingerprint varchar(64) NOT NULL,
        owner_fingerprint varchar(64), client_fingerprint varchar(64), ip_fingerprint varchar(64),
        user_agent_fingerprint varchar(64), action varchar(32) NOT NULL, reason_code varchar(80) NOT NULL,
        metadata_json jsonb NOT NULL, occurred_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE TABLE terminal_sessions (
        id serial PRIMARY KEY, owner_id uuid NOT NULL, session_id integer NOT NULL, mode varchar(32) NOT NULL,
        status varchar(32) NOT NULL, pty_pid integer, pty_sandbox_id varchar(128), pty_cols integer,
        pty_rows integer, closed_at timestamptz, updated_at timestamptz NOT NULL
      );
    `)
    await pool.query(
      `INSERT INTO conversation_sessions (id,user_id,title) VALUES (42,$1,'我的授权会话'),(43,$2,'他人会话')`,
      [ownerId, foreignOwnerId],
    )
    app = createApp({
      appName: '合成会话授权 Host',
      isReady: async () => true,
      userAuth: {
        secret,
        async lookupUser(id) {
          if (id !== ownerId) return null
          return {
            id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
            avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
            imChannels: [], isActive: true, securityVersion: 1,
          }
        },
      },
      agentFilesystemAuthorization: {
        operations: createAgentSessionFilesystemAuthorization(pool, confirmationPort(), {
          enabled: () => true,
          secretKey: 'synthetic-filesystem-authorization-secret',
          async terminateActivePty(id) { terminated.push(id) },
        }),
      },
    })
    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../frontend')
    const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
    const viteModule = requireFrontend('vite') as {
      createServer(options: Record<string, unknown>): Promise<{
        listen(): Promise<void>
        close(): Promise<void>
        httpServer?: { address(): string | { port: number } | null }
      }>
    }
    vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const unauthenticated = await fetch(`${base}/api/v1/agent/sessions/42/filesystem-authorization/request`, {
      method: 'POST',
    })
    assert.equal(unauthenticated.status, 401)
    const headers = {
      authorization: `Bearer ${createUserToken(ownerId, 1, secret)}`,
      'content-type': 'application/json',
    }

    const foreign = await fetch(`${base}/api/v1/agent/sessions/43/filesystem-authorization/request`, {
      method: 'POST', headers,
    })
    assert.equal(foreign.status, 404)
    const request = await fetch(`${base}/api/v1/agent/sessions/42/filesystem-authorization/request`, {
      method: 'POST', headers,
    })
    assert.equal(request.status, 200)
    const pending = await request.json() as Record<string, unknown>
    assert.equal(pending.status, 'waiting_confirmation')
    assert.equal(pending.confirm_code, 'feedc0de1234')
    assert.equal(pending.authorization_ttl_minutes, 10)
    assert.equal((await pool.query('SELECT id FROM filesystem_authorization_grants')).rowCount, 0)

    const invalid = await fetch(`${base}/api/v1/agent/sessions/42/filesystem-authorization`, {
      method: 'POST', headers, body: JSON.stringify({ confirm_code: 'invalid' }),
    })
    assert.equal(invalid.status, 400)
    const confirm = await fetch(`${base}/api/v1/agent/sessions/42/filesystem-authorization`, {
      method: 'POST', headers, body: JSON.stringify({ confirm_code: pending.confirm_code }),
    })
    assert.equal(confirm.status, 200)
    const granted = await confirm.json() as Record<string, unknown>
    assert.equal(granted.status, 'authorized')
    assert.equal(granted.session_id, 42)
    assert.equal((await pool.query('SELECT id FROM filesystem_authorization_grants WHERE user_id=$1', [ownerId])).rowCount, 1)

    await pool.query(
      `INSERT INTO terminal_sessions (owner_id,session_id,mode,status,pty_pid,pty_sandbox_id,pty_cols,pty_rows,updated_at)
       VALUES ($1,42,'interactive-pty','running',12,'synthetic-container',80,24,now())`, [ownerId],
    )
    const revoke = await fetch(`${base}/api/v1/agent/sessions/42/filesystem-authorization`, {
      method: 'DELETE', headers,
    })
    assert.equal(revoke.status, 200)
    assert.deepEqual(await revoke.json(), { status: 'revoked', session_id: 42, revoked: true })
    assert.deepEqual(terminated, ['1'])
    assert.equal((await pool.query("SELECT id FROM security_events WHERE reason_code='requested'")).rowCount, 1)
    assert.equal((await pool.query("SELECT id FROM security_events WHERE reason_code='granted'")).rowCount, 1)
    assert.equal((await pool.query("SELECT id FROM security_events WHERE reason_code='revoked'")).rowCount, 1)
  } finally {
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
    await vite?.close()
    await app?.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
