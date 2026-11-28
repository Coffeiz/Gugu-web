import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { createTerminalDetailReader } from '../../src/terminals/detail.js'
import { CoreError } from '../../src/contracts/index.js'

const owner = '00000000-0000-4000-8000-000000000131'
const other = '00000000-0000-4000-8000-000000000132'

function database() {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL);`)
  native.prepare('INSERT INTO conversation_sessions VALUES(?,?)').run(51, owner.replaceAll('-', ''))
  native.prepare('INSERT INTO terminal_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'term-owned', owner.replaceAll('-', ''), 51, 77, 'run-1', '终端详情', 'user', 'interactive-pty', 'running',
    'sandbox', 'none', 3, 12, 4321, 'sandbox-1', 100, 30,
    '2026-11-17T00:00:00.000Z', '2026-11-17T01:00:00.000Z', null,
  )
  native.prepare('INSERT INTO terminal_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'term-foreign', other.replaceAll('-', ''), 51, null, null, 'foreign', 'user', 'interactive-pty', 'running',
    'sandbox', 'none', 0, 0, null, null, null, null,
    '2026-11-17T00:00:00.000Z', '2026-11-17T01:00:00.000Z', null,
  )
  return { db, native, close: () => native.close() }
}

const input = {
  preferences: { shell_enabled: true },
  settings: { sandboxReady: true, terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false, fullUserSandboxAuthorizationEnabled: true },
}

test('终端详情返回 owner DTO 并验证关联会话', async () => {
  const state = database()
  try {
    const read = createTerminalDetailReader(state.db, 'sqlite', { workspaceSupported: true })
    assert.deepEqual(await read(owner, 'term-owned', input), {
      id: 'term-owned', name: '终端详情', sessionId: 51, runId: 'run-1', workspaceId: 77,
      source: 'user', mode: 'interactive-pty', status: 'running', shellMode: 'sandbox', networkProfile: 'none',
      lastSequence: 3, outputChars: 12, ptyPid: 4321, ptySandboxId: 'sandbox-1', ptyCols: 100, ptyRows: 30,
      createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T01:00:00.000Z', closedAt: null,
    })
    await assert.rejects(read(other, 'term-owned', input), (error: unknown) => error instanceof CoreError && error.code === 'not_found')
  } finally { await state.db.destroy(); state.close() }
})

test('Shell 页面拒绝详情，已删除关联会话按 Python 返回 403', async () => {
  const state = database()
  try {
    const read = createTerminalDetailReader(state.db, 'sqlite')
    await assert.rejects(read(owner, 'term-owned', { ...input, preferences: { shell_enabled: false } }),
      (error: unknown) => (error as Error).message === '用户未开启 Shell' && (error as { statusCode?: number }).statusCode === 403)
    state.native.prepare('DELETE FROM conversation_sessions WHERE id=?').run(51)
    const noSession = createTerminalDetailReader(state.db, 'sqlite')
    await assert.rejects(noSession(owner, 'term-owned', input),
      (error: unknown) => (error as Error).message === '终端会话不存在' && (error as { statusCode?: number }).statusCode === 403)
  } finally { await state.db.destroy() }
})
