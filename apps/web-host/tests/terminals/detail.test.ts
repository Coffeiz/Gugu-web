import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { createPostgresTerminalDetailReader } from '../../src/modules/terminals/persistence/detail.js'
import { registerTerminalDetailRoute } from '../../src/modules/terminals/detail.js'

const owner = '00000000-0000-4000-8000-000000000141'
const other = '00000000-0000-4000-8000-000000000142'
const coreRequire = createRequire(new URL('../../../../packages/core/package.json', import.meta.url))
const Database = coreRequire('better-sqlite3').default ?? coreRequire('better-sqlite3')
const { Kysely, SqliteDialect } = coreRequire('kysely')

function setup(preferences = { shell_enabled: true }) {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL);
  INSERT INTO conversation_sessions VALUES(61,'${owner}');
  INSERT INTO terminal_sessions VALUES('mine','${owner}',61,81,NULL,'详情','user','interactive-pty','idle','sandbox','none',0,0,NULL,NULL,NULL,NULL,'2026-11-17T00:00:00.000Z','2026-11-17T01:00:00.000Z',NULL);
  INSERT INTO terminal_sessions VALUES('other','${other}',61,NULL,NULL,'foreign','user','interactive-pty','idle','sandbox','none',0,0,NULL,NULL,NULL,NULL,'2026-11-17T00:00:00.000Z','2026-11-17T01:00:00.000Z',NULL);`)
  const preferenceOwners: string[] = []
  const pool = { async query(_query: string, values: string[]) { preferenceOwners.push(values[0]!); return { rows: [{ data_json: preferences }] } } }
  const app = Fastify()
  installHttpErrorHandler(app)
  const read = createPostgresTerminalDetailReader(pool as never, db, async () => ({
    terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false,
    sandboxReady: true,
  }))
  registerTerminalDetailRoute(app, {
    requireUser: async (request, reply) => { if (request.headers.authorization !== 'synthetic-user') return reply.code(401).send({ detail: '未授权' }) },
    ownerIdFromRequest: () => owner,
    read,
  })
  return { app, db, preferenceOwners }
}

test('认证终端详情沿用 Python DTO 和 owner/session 边界', async () => {
  const { app, db, preferenceOwners } = setup()
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/terminals/mine' })
    assert.equal(unauthorized.statusCode, 401)
    assert.deepEqual(preferenceOwners, [])
    const result = await app.inject({ method: 'GET', url: '/api/v1/terminals/mine', headers: { authorization: 'synthetic-user' } })
    assert.equal(result.statusCode, 200)
    assert.equal(result.json().workspaceId, 81)
    assert.equal(result.json().name, '详情')
    assert.deepEqual(preferenceOwners, [owner])
  } finally { await app.close(); await db.destroy() }
})

test('终端详情对其他 owner 隐藏记录并映射 Shell 授权错误', async () => {
  const { app, db } = setup({ shell_enabled: false })
  try {
    const result = await app.inject({ method: 'GET', url: '/api/v1/terminals/other', headers: { authorization: 'synthetic-user' } })
    assert.equal(result.statusCode, 404)
    const denied = await app.inject({ method: 'GET', url: '/api/v1/terminals/mine', headers: { authorization: 'synthetic-user' } })
    assert.equal(denied.statusCode, 403)
    assert.equal(denied.json().detail, '用户未开启 Shell')
  } finally { await app.close(); await db.destroy() }
})
