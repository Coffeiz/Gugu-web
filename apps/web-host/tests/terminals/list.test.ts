import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { createPostgresTerminalListReader } from '../../src/modules/terminals/persistence/list.js'
import { registerTerminalListRoute } from '../../src/modules/terminals/list.js'

const owner = '00000000-0000-4000-8000-000000000121'
const coreRequire = createRequire(new URL('../../../../packages/core/package.json', import.meta.url))
const Database = coreRequire('better-sqlite3').default ?? coreRequire('better-sqlite3')
const { Kysely, SqliteDialect } = coreRequire('kysely')

test('认证终端列表经过 Host 偏好与 MXC 适配进入 Core，并返回 owner 的终端', async () => {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE terminal_events(terminal_id TEXT,sequence INTEGER);
  INSERT INTO terminal_sessions VALUES('mine','${owner}',NULL,42,NULL,'我的终端','user','interactive-pty','idle','sandbox','none',0,0,NULL,NULL,NULL,NULL,'2026-11-17T00:00:00.000Z','2026-11-17T00:00:00.000Z',NULL);`)
  const preferencesRead: string[] = []
  const pool = { async query(_query: string, values: string[]) { preferencesRead.push(values[0]!); return { rows: [{ data_json: { shell_enabled: true } }] } } }
  const app = Fastify()
  installHttpErrorHandler(app)
  const read = createPostgresTerminalListReader(pool as never, db, async () => ({
    terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false,
    fullUserSandboxAuthorizationEnabled: true,
    sandboxReady: true,
  }))
  registerTerminalListRoute(app, {
    requireUser: async (request, reply) => { if (request.headers.authorization !== 'synthetic-user') return reply.code(401).send({ detail: '未授权' }) },
    ownerIdFromRequest: () => owner,
    read,
  })
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/terminals' })
    assert.equal(unauthorized.statusCode, 401)
    assert.deepEqual(preferencesRead, [])
    const response = await app.inject({ method: 'GET', url: '/api/v1/terminals', headers: { authorization: 'synthetic-user' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      enabled: true, ptyEnabled: true,
      items: [{ id: 'mine', name: '我的终端', sessionId: null, runId: null, workspaceId: 42, source: 'user', mode: 'interactive-pty', status: 'idle', shellMode: 'sandbox', networkProfile: 'none', lastSequence: 0, outputChars: 0, ptyPid: null, ptySandboxId: null, ptyCols: null, ptyRows: null, createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z', closedAt: null }],
    })
    assert.deepEqual(preferencesRead, [owner])
  } finally { await app.close(); await db.destroy() }
})

test('Host 列表适配保留 Python 的 Shell 403 错误语义', async () => {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(id TEXT,owner_id TEXT,session_id INTEGER,workspace_id INTEGER,run_id TEXT,name TEXT,source TEXT,mode TEXT,status TEXT,shell_mode TEXT,network_profile TEXT,last_sequence INTEGER,output_chars INTEGER,pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,created_at TEXT,updated_at TEXT,closed_at TEXT); CREATE TABLE terminal_events(terminal_id TEXT,sequence INTEGER);`)
  const app = Fastify()
  installHttpErrorHandler(app)
  const read = createPostgresTerminalListReader({ async query() { return { rows: [{ data_json: { shell_enabled: false } }] } } } as never, db, async () => ({
    terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false, fullUserSandboxAuthorizationEnabled: true,
    sandboxReady: true,
  }))
  registerTerminalListRoute(app, { requireUser: async () => {}, ownerIdFromRequest: () => owner, read })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/terminals' })
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().detail, '用户未开启 Shell')
  } finally { await app.close(); await db.destroy() }
})
