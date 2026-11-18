import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { CoreError } from '../../src/contracts/index.js'
import { createTerminalCreator } from '../../src/terminals/create.js'

const owner = '00000000-0000-4000-8000-000000000161'
const other = '00000000-0000-4000-8000-000000000162'

function setup() {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL);
  CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,enabled INTEGER NOT NULL);`)
  native.prepare('INSERT INTO conversation_sessions VALUES(?,?)').run(71, owner.replaceAll('-', ''))
  native.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(41, owner.replaceAll('-', ''), 1)
  return { native, db }
}

const allowed = {
  preferences: { shell_enabled: true },
  settings: { sandboxReady: true, terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false, fullUserSandboxAuthorizationEnabled: true },
}

test('终端创建按 owner 校验绑定、权限和模式，持久化 Python DTO 并发布事件', async () => {
  const state = setup()
  const events: unknown[][] = []
  try {
    const create = createTerminalCreator(state.db, 'sqlite', async (...args) => { events.push(args) }, {
      now: () => new Date('2026-11-17T12:00:00.000Z'), id: () => 'term-test-id', workspaceSupported: true,
    })
    const result = await create(owner, { name: '  新终端  ', sessionId: 71, workspaceId: 41, mode: 'interactive-pty', ...allowed, ptyEnabled: true, origin: 'client-1' })
    assert.deepEqual(result, {
      id: 'term-test-id', name: '新终端', sessionId: 71, runId: null, workspaceId: 41,
      source: 'user', mode: 'interactive-pty', status: 'idle', shellMode: 'sandbox', networkProfile: 'none',
      lastSequence: 0, outputChars: 0, ptyPid: null, ptySandboxId: null, ptyCols: null, ptyRows: null,
      createdAt: '2026-11-17T12:00:00.000+00:00', updatedAt: '2026-11-17T12:00:00.000+00:00', closedAt: null,
    })
    assert.deepEqual(events, [[owner.replaceAll('-', ''), 'term-test-id', 'client-1']])
    assert.equal(state.native.prepare('SELECT count(*) AS n FROM terminal_sessions WHERE owner_id=?').get(owner.replaceAll('-', ''))?.n, 1)
  } finally { await state.db.destroy(); state.native.close() }
})

test('终端创建拒绝跨 owner 会话/工作区、停用工作区和缺少 Shell/PTY 权限', async () => {
  const state = setup()
  try {
    state.native.prepare('INSERT INTO conversation_sessions VALUES(?,?)').run(72, other.replaceAll('-', ''))
    state.native.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(42, other.replaceAll('-', ''), 1)
    state.native.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(43, owner.replaceAll('-', ''), 0)
    const create = createTerminalCreator(state.db, 'sqlite', async () => {}, { workspaceSupported: true })
    const input = { name: '终端', mode: 'agent-events', ...allowed, ptyEnabled: false, origin: null }
    await assert.rejects(create(owner, { ...input, sessionId: 72 }), (e: unknown) => e instanceof CoreError && e.code === 'not_found')
    await assert.rejects(create(owner, { ...input, workspaceId: 42 }), (e: unknown) => e instanceof CoreError && e.code === 'not_found')
    await assert.rejects(create(owner, { ...input, workspaceId: 43 }), (e: unknown) => e instanceof CoreError && e.code === 'not_found')
    await assert.rejects(create(owner, { ...input, preferences: { shell_enabled: false } }), (e: unknown) => (e as { statusCode?: number }).statusCode === 403)
    await assert.rejects(create(owner, { ...input, mode: 'interactive-pty' }), (e: unknown) => (e as { statusCode?: number }).statusCode === 403)
    assert.equal(state.native.prepare('SELECT count(*) AS n FROM terminal_sessions').get()?.n, 0)
  } finally { await state.db.destroy(); state.native.close() }
})

test('OSS 模式拒绝工作区绑定，但可创建无绑定的 agent-events 终端', async () => {
  const state = setup()
  try {
    const create = createTerminalCreator(state.db, 'sqlite', async () => {}, { workspaceSupported: false })
    const input = { name: '  ', sessionId: null, workspaceId: null, mode: 'agent-events', ...allowed, ptyEnabled: false, origin: null }
    await assert.rejects(create(owner, { ...input, workspaceId: 41 }), (e: unknown) => (e as { statusCode?: number }).statusCode === 409)
    const result = await create(owner, input)
    assert.equal(result.name, '终端')
    assert.equal(result.workspaceId, null)
    assert.equal(result.mode, 'agent-events')
  } finally { await state.db.destroy(); state.native.close() }
})
