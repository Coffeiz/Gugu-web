import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { createPostgresTerminalMetricsReader } from '../../src/modules/terminals/persistence/metrics.js'
import { registerTerminalMetricsRoute } from '../../src/modules/terminals/metrics.js'

const owner = '00000000-0000-4000-8000-000000000111'
const coreRequire = createRequire(new URL('../../../../packages/core/package.json', import.meta.url))
const Database = coreRequire('better-sqlite3').default ?? coreRequire('better-sqlite3')
const { Kysely, SqliteDialect } = coreRequire('kysely')

function setup(preferences: Record<string, unknown>, ready = true) {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL, closed_at TEXT, output_chars INTEGER NOT NULL);
    INSERT INTO terminal_sessions VALUES ('one','${owner}','running',NULL,21),('two','${owner}','idle',NULL,9);`)
  const owners: string[] = []
  const pool = { async query(_sql: string, values: string[]) { owners.push(values[0]!); return { rows: [{ data_json: preferences }] } } }
  const read = createPostgresTerminalMetricsReader(pool as never, db, async () => ({
    terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false,
    sandboxReady: ready, sandboxUnavailableReason: ready ? undefined : 'MXC Bubblewrap 不可用',
  }))
  const app = Fastify()
  installHttpErrorHandler(app)
  registerTerminalMetricsRoute(app, {
    requireUser: async (request, reply) => { if (request.headers.authorization !== 'synthetic-user') return reply.code(401).send({ detail: '未授权' }) },
    ownerIdFromRequest: () => owner,
    read,
  })
  return { app, db, owners }
}

test('终端指标走认证 owner、页面 Shell 授权与 Core 聚合', async () => {
  const { app, db, owners } = setup({ shell_enabled: true })
  try {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/terminals/metrics' })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(owners, [])
    const result = await app.inject({ method: 'GET', url: '/api/v1/terminals/metrics', headers: { authorization: 'synthetic-user' } })
    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.json(), { total: 2, running: 1, outputChars: 30, retentionDays: 30, outputRetentionChars: 500000 })
    assert.deepEqual(owners, [owner])
  } finally { await app.close(); await db.destroy() }
})

test('Shell 页面授权或 MXC readiness 失败时不返回终端指标', async () => {
  for (const options of [{ preferences: { shell_enabled: false }, ready: true }, { preferences: { shell_enabled: true }, ready: false }]) {
    const { app, db, owners } = setup(options.preferences, options.ready)
    try {
      const result = await app.inject({ method: 'GET', url: '/api/v1/terminals/metrics', headers: { authorization: 'synthetic-user' } })
      assert.equal(result.statusCode, 403)
      assert.deepEqual(owners, [owner])
      assert.equal(result.json().detail, options.ready ? '用户未开启 Shell' : 'MXC Bubblewrap 不可用')
    } finally { await app.close(); await db.destroy() }
  }
})
