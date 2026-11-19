import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'
import { createPostgresTerminalLifecycle } from '../../src/modules/terminals/lifecycle-operation.js'

const coreRequire = createRequire(new URL('../../../../packages/core/package.json', import.meta.url))
const Database = coreRequire('better-sqlite3').default ?? coreRequire('better-sqlite3')
const { Kysely, SqliteDialect } = coreRequire('kysely')
const owner = '00000000-0000-4000-8000-000000000231'
const secret = 'synthetic-terminal-lifecycle-secret'

function setup() {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL);
  CREATE TABLE terminal_events(id INTEGER PRIMARY KEY AUTOINCREMENT,terminal_id TEXT,run_id TEXT,sequence INTEGER,
    event_type TEXT,source TEXT,command TEXT,stdout TEXT,stderr TEXT,exit_code INTEGER,occurred_at TEXT);
  INSERT INTO conversation_sessions VALUES(71,'${owner}');
  INSERT INTO terminal_sessions VALUES
    ('term-reset','${owner}',71,41,'run-1','重置终端','user','interactive-pty','running','sandbox','none',4,27,321,'term-reset:321',120,32,'2026-11-01T00:00:00+00:00','2026-11-02T00:00:00+00:00',NULL),
    ('term-stop','${owner}',71,NULL,'run-2','停止终端','user','interactive-pty','running','sandbox','none',2,9,322,'term-stop:322',100,24,'2026-11-01T00:00:00+00:00','2026-11-02T00:00:00+00:00',NULL);
  INSERT INTO terminal_events(terminal_id,run_id,sequence,event_type,source,command,stdout,stderr,exit_code,occurred_at)
    VALUES('term-reset','run-1',4,'command','user','echo keep','kept output','',0,'2026-11-02T00:00:00+00:00'),
      ('term-stop','run-2',2,'command','user','echo keep','kept','',0,'2026-11-02T00:00:00+00:00');`)
  return { native, db }
}

function authOptions() {
  return {
    secret,
    async lookupUser(id: string) {
      return id === owner ? {
        id: owner, isActive: true, accountStatus: 'active', securityVersion: 1,
        username: 'synthetic', displayName: '合成用户', email: 'synthetic@example.invalid', avatarUrl: null,
        createdAt: null, timezone: 'UTC', emailSubscribed: false, imChannels: [],
      } : null
    },
  }
}

test('认证 reset/terminate 先停止实际 PTY，再经 Core 持久化各自 Python 生命周期语义', async () => {
  const state = setup()
  const stopped: string[] = []
  const published: unknown[] = []
  const active = new Set(['term-reset', 'term-stop'])
  const lifecycle = createPostgresTerminalLifecycle({
    db: state.db as never,
    manager: {
      get(id) { return active.has(id) ? {} : undefined },
      async terminate(id) { stopped.push(id); active.delete(id) },
    },
    publisher: { async publishResourceChanged(event: unknown) { published.push(event); return true } },
    now: () => new Date('2026-11-17T12:00:00.000Z'),
  })
  const app = createApp({ appName: '测试应用', isReady: async () => true, userAuth: authOptions(), terminalLifecycle: lifecycle })
  try {
    const headers = { authorization: `Bearer ${createUserToken(owner, 1, secret)}`, 'x-client-id': 'client-9' }
    const reset = await app.inject({ method: 'POST', url: '/api/v1/terminals/term-reset/reset', headers })
    assert.equal(reset.statusCode, 200)
    assert.equal(reset.json().status, 'idle')
    assert.equal(reset.json().closedAt, null)
    assert.equal(reset.json().workspaceId, 41)
    assert.equal(reset.json().ptySandboxId, null)
    assert.equal(reset.json().lastSequence, 4)
    assert.equal(state.native.prepare('SELECT count(*) AS n FROM terminal_events WHERE terminal_id=?').get('term-reset')?.n, 1)

    const terminate = await app.inject({ method: 'POST', url: '/api/v1/terminals/term-stop/terminate', headers })
    assert.equal(terminate.statusCode, 200)
    assert.equal(terminate.json().status, 'terminated')
    assert.equal(terminate.json().closedAt, '2026-11-17T12:00:00.000+00:00')
    assert.equal(terminate.json().lastSequence, 3)
    assert.equal(state.native.prepare('SELECT event_type,source,sequence FROM terminal_events WHERE terminal_id=? ORDER BY sequence DESC LIMIT 1').get('term-stop')?.event_type, 'status')
    assert.deepEqual(stopped, ['term-reset', 'term-stop'])
    assert.deepEqual(published, [
      { ownerId: owner, resource: 'terminals', operation: 'update', entityId: 'term-reset', origin: 'client-9', payload: { terminal: reset.json(), reset: true } },
      { ownerId: owner, resource: 'terminals', operation: 'append', entityId: 'term-stop', origin: 'client-9', payload: { terminal_id: 'term-stop', terminal: terminate.json() } },
    ])
  } finally { await app.close(); await state.db.destroy(); state.native.close() }
})

test('本机无法定位数据库仍标 running 的 PTY 时返回 503 且不谎报已停止', async () => {
  const state = setup()
  const published: unknown[] = []
  const lifecycle = createPostgresTerminalLifecycle({
    db: state.db as never,
    manager: { get() { return undefined }, async terminate() {} },
    publisher: { async publishResourceChanged(event: unknown) { published.push(event); return true } },
  })
  const app = createApp({ appName: '测试应用', isReady: async () => true, userAuth: authOptions(), terminalLifecycle: lifecycle })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/terminals/term-stop/terminate',
      headers: { authorization: `Bearer ${createUserToken(owner, 1, secret)}` } })
    assert.equal(response.statusCode, 503)
    assert.equal(state.native.prepare('SELECT status FROM terminal_sessions WHERE id=?').get('term-stop')?.status, 'running')
    assert.deepEqual(published, [])
  } finally { await app.close(); await state.db.destroy(); state.native.close() }
})
