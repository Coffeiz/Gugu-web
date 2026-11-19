import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { createPostgresTerminalEventStream } from '../../src/modules/terminals/persistence/events.js'
import { registerTerminalEventsRoute } from '../../src/modules/terminals/events.js'

const owner = '00000000-0000-4000-8000-000000000181'
const coreRequire = createRequire(new URL('../../../../packages/core/package.json', import.meta.url))
const Database = coreRequire('better-sqlite3').default ?? coreRequire('better-sqlite3')
const { Kysely, SqliteDialect } = coreRequire('kysely')

function setup() {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE terminal_events(
    terminal_id TEXT,sequence INTEGER,event_type TEXT,source TEXT,run_id TEXT,command TEXT,stdout TEXT,stderr TEXT,exit_code INTEGER,occurred_at TEXT
  );
  INSERT INTO terminal_sessions VALUES('done','${owner}',NULL,NULL,NULL,'终端','agent','agent-events','terminated','sandbox','none',2,2,NULL,NULL,NULL,NULL,'2026-11-17T00:00:00.000Z','2026-11-17T00:00:01.000Z','2026-11-17T00:00:02.000Z');
  INSERT INTO terminal_sessions VALUES('active','${owner}',NULL,NULL,NULL,'活动终端','agent','agent-events','running','sandbox','none',0,0,NULL,NULL,NULL,NULL,'2026-11-17T00:00:00.000Z','2026-11-17T00:00:01.000Z',NULL);
  INSERT INTO terminal_events VALUES('done',1,'command','agent','run-1','echo 1','一','',0,'2026-11-17T00:00:00.000Z'),('done',2,'command','agent','run-1','echo 2','二','',0,'2026-11-17T00:00:01.000Z');`)
  const pool = { async query() { return { rows: [{ data_json: { shell_enabled: true } }] } } }
  const stream = createPostgresTerminalEventStream(pool as never, db, async () => ({
    terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false,
    sandboxReady: true,
  }))
  const app = Fastify()
  installHttpErrorHandler(app)
  let waits = 0
  registerTerminalEventsRoute(app, {
    requireUser: async (request, reply) => { if (request.headers.authorization !== 'synthetic-user') return reply.code(401).send({ detail: '未授权' }) },
    ownerIdFromRequest: () => owner,
    ...stream,
    sleep: async milliseconds => { assert.equal(milliseconds, 500); waits += 1 },
  })
  return { app, db, get waits() { return waits } }
}

test('认证 SSE 事件流从 after 游标读取 Core 持久记录并在关闭后发送 end', async () => {
  const { app, db } = setup()
  try {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/terminals/done/events?after=1' })
    assert.equal(denied.statusCode, 401)
    const response = await app.inject({ method: 'GET', url: '/api/v1/terminals/done/events?after=1', headers: { authorization: 'synthetic-user' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.match(response.body, /data: \{"event":\{"sequence":2,"type":"command"/)
    assert.match(response.body, /event: end\ndata: \{\}/)
    assert.doesNotMatch(response.body, /"sequence":1/)
  } finally { await app.close(); await db.destroy() }
})

test('SSE after cursor 不是非负整数或 owner 不匹配时按请求错误处理', async () => {
  const { app, db } = setup()
  try {
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/terminals/done/events?after=-1', headers: { authorization: 'synthetic-user' } })
    assert.equal(invalid.statusCode, 422)
    const missing = await app.inject({ method: 'GET', url: '/api/v1/terminals/missing/events', headers: { authorization: 'synthetic-user' } })
    assert.equal(missing.statusCode, 404)
  } finally { await app.close(); await db.destroy() }
})

test('未关闭终端空闲时按 Python 有界轮询 30 次后发送结束帧', async () => {
  const state = setup()
  try {
    const response = await state.app.inject({ method: 'GET', url: '/api/v1/terminals/active/events', headers: { authorization: 'synthetic-user' } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /event: end\ndata: \{\}/)
    assert.equal(state.waits, 30)
  } finally { await state.app.close(); await state.db.destroy() }
})
