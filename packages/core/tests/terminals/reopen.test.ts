import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { createTerminalReopener } from '../../src/terminals/reopen.js'

const owner = '00000000-0000-4000-8000-000000000181'
const other = '00000000-0000-4000-8000-000000000182'

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
  INSERT INTO conversation_sessions VALUES(71,'${owner.replaceAll('-', '')}');
  INSERT INTO conversation_sessions VALUES(72,'${other.replaceAll('-', '')}');
  INSERT INTO terminal_sessions VALUES('term-reopen','${owner.replaceAll('-', '')}',71,NULL,NULL,'历史终端','user','interactive-pty','terminated','sandbox','none',3,18,321,'pty-handle',110,28,'2026-11-01T00:00:00+00:00','2026-11-02T00:00:00+00:00','2026-11-02T00:00:00+00:00');`)
  return { native, db }
}

const allowed = {
  preferences: { shell_enabled: true },
  settings: { sandboxReady: true, terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false, fullUserSandboxAuthorizationEnabled: true },
  ptyEnabled: true,
}

test('重开 owner 终端将状态置 idle、保留 PTY 和输出游标并提交后发布更新', async () => {
  const state = setup()
  const events: unknown[] = []
  try {
    const reopen = createTerminalReopener(state.db, 'sqlite', async (...args) => { events.push(args) }, {
      now: () => new Date('2026-11-17T12:00:00.000Z'), workspaceSupported: true,
    })
    const result = await reopen(owner, 'term-reopen', { ...allowed, origin: 'client-1' })
    assert.equal(result.status, 'idle')
    assert.equal(result.closedAt, null)
    assert.equal(result.lastSequence, 3)
    assert.equal(result.outputChars, 18)
    assert.equal(result.ptyPid, 321)
    assert.equal(result.ptySandboxId, 'pty-handle')
    assert.equal(result.ptyCols, 110)
    assert.equal(result.ptyRows, 28)
    assert.deepEqual(events, [[owner.replaceAll('-', ''), 'term-reopen', 'client-1']])
    assert.deepEqual(state.native.prepare('SELECT status,closed_at,last_sequence,output_chars FROM terminal_sessions').get(), {
      status: 'idle', closed_at: null, last_sequence: 3, output_chars: 18,
    })
  } finally { await state.db.destroy(); state.native.close() }
})

test('重开校验 owner、关联会话、页面 Shell 和交互 PTY 权限，失败不写入也不发事件', async () => {
  const state = setup()
  const events: unknown[] = []
  try {
    const reopen = createTerminalReopener(state.db, 'sqlite', async (...args) => { events.push(args) }, { workspaceSupported: true })
    await assert.rejects(reopen(other, 'term-reopen', { ...allowed, origin: null }), (e: unknown) => (e as { code?: string }).code === 'not_found')
    state.native.prepare('UPDATE terminal_sessions SET session_id=72 WHERE id=?').run('term-reopen')
    await assert.rejects(reopen(owner, 'term-reopen', { ...allowed, origin: null }), (e: unknown) => (e as { statusCode?: number }).statusCode === 403)
    state.native.prepare('UPDATE terminal_sessions SET session_id=71 WHERE id=?').run('term-reopen')
    await assert.rejects(reopen(owner, 'term-reopen', { ...allowed, preferences: { shell_enabled: false }, origin: null }), (e: unknown) => (e as { statusCode?: number }).statusCode === 403)
    await assert.rejects(reopen(owner, 'term-reopen', { ...allowed, ptyEnabled: false, origin: null }), (e: unknown) => (e as { statusCode?: number }).statusCode === 403)
    assert.equal(state.native.prepare('SELECT status FROM terminal_sessions').get()?.status, 'terminated')
    assert.deepEqual(events, [])
  } finally { await state.db.destroy(); state.native.close() }
})
