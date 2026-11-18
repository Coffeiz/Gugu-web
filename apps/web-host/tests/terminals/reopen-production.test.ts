import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createPostgresTerminalReopener } from '../../src/modules/terminals/reopen-operation.js'

const coreRequire = createRequire(new URL('../../../../packages/core/package.json', import.meta.url))
const Database = coreRequire('better-sqlite3').default ?? coreRequire('better-sqlite3')
const { Kysely, SqliteDialect } = coreRequire('kysely')
const owner = '00000000-0000-4000-8000-000000000191'
const secret = 'synthetic-terminal-reopen-secret'

test('createApp authenticated reopen commits the Core state and publishes update; unauthenticated request has no side effects', async () => {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL);
  INSERT INTO conversation_sessions VALUES(71,'${owner}');
  INSERT INTO terminal_sessions VALUES('term-reopen','${owner}',71,NULL,NULL,'可重开终端','user','interactive-pty','terminated','sandbox','none',3,18,321,'pty-handle',110,28,'2026-11-01T00:00:00+00:00','2026-11-02T00:00:00+00:00','2026-11-02T00:00:00+00:00');`)
  const events: unknown[] = []
  const reopener = createPostgresTerminalReopener({
    pool: { async query(_query: string, values: string[]) {
      assert.equal(values[0], owner)
      return { rows: [{ data_json: { shell_enabled: true } }] }
    } } as never,
    db: db as never,
    publisher: { async publishResourceChanged(event: unknown) { events.push(event); return true } },
    workspaceRuntime: { terminalMode: 'auto', shellSystemEnabled: false, fullUserSandboxAuthorizationEnabled: true },
    async readRuntime() { return { shellEnabled: true, filesystemAuthorizationEnabled: true } },
    async readSandboxReadiness() { return { ready: true } },
    now: () => new Date('2026-11-17T12:00:00.000Z'),
  })
  const app = createApp({
    appName: '测试应用', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id: string) {
        return id === owner ? {
          id: owner, isActive: true, accountStatus: 'active', securityVersion: 1,
          username: 'synthetic', displayName: '合成用户', email: 'synthetic@example.invalid', avatarUrl: null,
          createdAt: null, timezone: 'UTC', emailSubscribed: false, imChannels: [],
        } : null
      },
    },
    terminalReopen: { reopen: reopener },
  })
  try {
    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/terminals/term-reopen/reopen' })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(native.prepare('SELECT status FROM terminal_sessions').get()?.status, 'terminated')
    assert.deepEqual(events, [])

    const response = await app.inject({
      method: 'POST', url: '/api/v1/terminals/term-reopen/reopen',
      headers: { authorization: `Bearer ${createUserToken(owner, 1, secret)}`, 'x-client-id': 'client-8' },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().status, 'idle')
    assert.equal(response.json().closedAt, null)
    assert.equal(response.json().lastSequence, 3)
    assert.equal(response.json().ptySandboxId, 'pty-handle')
    assert.equal(native.prepare('SELECT status,closed_at,last_sequence,pty_sandbox_id FROM terminal_sessions').get()?.status, 'idle')
    assert.deepEqual(events, [{ ownerId: owner, resource: 'terminals', operation: 'update', entityId: 'term-reopen', origin: 'client-8' }])
  } finally { await app.close(); await db.destroy(); native.close() }
})
