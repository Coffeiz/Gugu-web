import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { markTerminalPtyExited, markTerminalPtyRunning } from '../../src/terminals/pty-state.js'

const owner = '00000000-0000-4000-8000-000000000201'
const other = '00000000-0000-4000-8000-000000000202'

function setup() {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,mode TEXT NOT NULL,
    status TEXT NOT NULL,pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    updated_at TEXT NOT NULL,closed_at TEXT
  ); INSERT INTO terminal_sessions VALUES
    ('term-open','${owner.replaceAll('-', '')}',71,41,'interactive-pty','idle',NULL,NULL,NULL,NULL,'2026-11-01T00:00:00+00:00',NULL),
    ('term-closed','${owner.replaceAll('-', '')}',71,41,'interactive-pty','terminated',NULL,NULL,NULL,NULL,'2026-11-01T00:00:00+00:00','2026-11-01T00:00:00+00:00');
  CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL);
  INSERT INTO conversation_sessions VALUES(71,'${owner.replaceAll('-', '')}');
  CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,enabled INTEGER NOT NULL);
  INSERT INTO workspaces VALUES(41,'${owner.replaceAll('-', '')}',1);`)
  return { native, db }
}

test('PTY 启动落库复核 owner、mode、session/workspace 和 closed 状态', async () => {
  const state = setup()
  try {
    const running = await markTerminalPtyRunning(state.db, 'sqlite', owner, 'term-open', {
      workspaceId: 41, pid: 654, sandboxId: 'term-open:654', cols: 120, rows: 32,
    }, () => new Date('2026-11-17T12:00:00.000Z'))
    assert.equal(running.status, 'running')
    assert.equal(running.ptyPid, 654)
    assert.equal(running.ptySandboxId, 'term-open:654')
    assert.equal(running.ptyCols, 120)
    assert.equal(running.ptyRows, 32)
    assert.equal(running.closedAt, null)
    assert.equal(state.native.prepare('SELECT status,pty_pid,pty_sandbox_id FROM terminal_sessions WHERE id=?').get('term-open')?.status, 'running')
    await assert.rejects(markTerminalPtyRunning(state.db, 'sqlite', other, 'term-open', {
      workspaceId: 41, pid: 655, sandboxId: 'foreign', cols: 120, rows: 32,
    }), (error: unknown) => (error as { code?: string }).code === 'not_found')
    await assert.rejects(markTerminalPtyRunning(state.db, 'sqlite', owner, 'term-closed', {
      workspaceId: 41, pid: 656, sandboxId: 'closed', cols: 120, rows: 32,
    }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403)
  } finally { await state.db.destroy(); state.native.close() }
})

test('PTY 自然退出只关闭非 terminated 会话且保留显式停止优先级', async () => {
  const state = setup()
  try {
    const exited = await markTerminalPtyExited(state.db, 'sqlite', owner, 'term-open', () => new Date('2026-11-17T12:01:00.000Z'))
    assert.equal(exited, true)
    assert.equal(state.native.prepare('SELECT status,closed_at FROM terminal_sessions WHERE id=?').get('term-open')?.status, 'exited')
    assert.equal(await markTerminalPtyExited(state.db, 'sqlite', owner, 'term-closed'), false)
    assert.equal(state.native.prepare('SELECT status FROM terminal_sessions WHERE id=?').get('term-closed')?.status, 'terminated')
    assert.equal(await markTerminalPtyExited(state.db, 'sqlite', other, 'term-open'), false)
  } finally { await state.db.destroy(); state.native.close() }
})
