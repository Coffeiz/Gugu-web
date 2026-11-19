import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'
import { createPostgresTerminalCreator } from '../../src/modules/terminals/create-operation.js'

const coreRequire = createRequire(new URL('../../../../packages/core/package.json', import.meta.url))
const Database = coreRequire('better-sqlite3').default ?? coreRequire('better-sqlite3')
const { Kysely, SqliteDialect } = coreRequire('kysely')
const owner = '00000000-0000-4000-8000-000000000171'
const secret = 'synthetic-terminal-create-secret'

test('createApp authenticated POST commits the Core terminal record and publishes owner event', async () => {
  const native = new Database(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL);
  CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,enabled INTEGER NOT NULL);
  INSERT INTO conversation_sessions VALUES(71,'${owner}'); INSERT INTO workspaces VALUES(41,'${owner}',1);`)
  const events: unknown[] = []
  const creator = createPostgresTerminalCreator({
    pool: { async query(_query: string, values: string[]) { assert.equal(values[0], owner); return { rows: [{ data_json: { shell_enabled: true } }] } } } as never,
    db: db as never,
    publisher: { async publishResourceChanged(event: unknown) { events.push(event); return true } },
    async readRuntime() {
      return { terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false,
        fullUserSandboxAuthorizationEnabled: true, sandboxReady: true }
    },
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
    terminalCreate: { create: creator },
  })
  try {
    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/terminals', payload: { name: '未授权' } })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(native.prepare('SELECT count(*) AS n FROM terminal_sessions').get()?.n, 0)

    const response = await app.inject({
      method: 'POST', url: '/api/v1/terminals',
      headers: { authorization: `Bearer ${createUserToken(owner, 1, secret)}`, 'x-client-id': 'client-7' },
      payload: { name: '  新终端 ', sessionId: 71, workspaceId: 41, mode: 'interactive-pty' },
    })
    assert.equal(response.statusCode, 201)
    assert.deepEqual(response.json(), {
      id: response.json().id, name: '新终端', sessionId: 71, runId: null, workspaceId: 41,
      source: 'user', mode: 'interactive-pty', status: 'idle', shellMode: 'sandbox', networkProfile: 'none',
      lastSequence: 0, outputChars: 0, ptyPid: null, ptySandboxId: null, ptyCols: null, ptyRows: null,
      createdAt: '2026-11-17T12:00:00.000+00:00', updatedAt: '2026-11-17T12:00:00.000+00:00', closedAt: null,
    })
    assert.match(response.json().id, /^term-[0-9a-f]{32}$/)
    assert.deepEqual(events, [{ ownerId: owner, resource: 'terminals', operation: 'create', entityId: response.json().id, origin: 'client-7' }])
    assert.deepEqual(native.prepare('SELECT owner_id,session_id,workspace_id,status FROM terminal_sessions').get(), {
      owner_id: owner, session_id: 71, workspace_id: 41, status: 'idle',
    })
  } finally { await app.close(); await db.destroy(); native.close() }
})
