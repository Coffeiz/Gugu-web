import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { resetTerminalForOwner, terminateTerminalForOwner } from '../../src/terminals/lifecycle.js'

const owner = '00000000-0000-4000-8000-000000000221'
const other = '00000000-0000-4000-8000-000000000222'

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
  CREATE TABLE terminal_events(id INTEGER PRIMARY KEY AUTOINCREMENT,terminal_id TEXT,run_id TEXT,sequence INTEGER,
    event_type TEXT,source TEXT,command TEXT,stdout TEXT,stderr TEXT,exit_code INTEGER,occurred_at TEXT);
  INSERT INTO conversation_sessions VALUES(71,'${owner.replaceAll('-', '')}');
  INSERT INTO conversation_sessions VALUES(72,'${other.replaceAll('-', '')}');
  INSERT INTO terminal_sessions VALUES('term-clean','${owner.replaceAll('-', '')}',71,41,'run-1','清理终端','user','interactive-pty','running','sandbox','none',4,27,321,'pty-handle',120,32,'2026-11-01T00:00:00+00:00','2026-11-02T00:00:00+00:00',NULL);`)
  native.prepare(`INSERT INTO terminal_events(terminal_id,run_id,sequence,event_type,source,command,stdout,stderr,exit_code,occurred_at)
    VALUES('term-clean','run-1',4,'command','user','echo keep','kept output','',0,'2026-11-02T00:00:00+00:00')`).run()
  return { native, db }
}

test('终端 reset 只清运行态，保留工作区绑定、命令历史和输出游标', async () => {
  const state = setup()
  try {
    const result = await resetTerminalForOwner(state.db, 'sqlite', owner, 'term-clean', () => new Date('2026-11-17T12:00:00.000Z'))
    assert.equal(result.status, 'idle')
    assert.equal(result.closedAt, null)
    assert.equal(result.workspaceId, 41)
    assert.equal(result.ptyPid, null)
    assert.equal(result.ptySandboxId, null)
    assert.equal(result.ptyCols, null)
    assert.equal(result.ptyRows, null)
    assert.equal(result.lastSequence, 4)
    assert.equal(result.outputChars, 27)
    assert.equal(state.native.prepare('SELECT count(*) AS n FROM terminal_events').get()?.n, 1)
  } finally { await state.db.destroy(); state.native.close() }
})

test('终端 terminate 原子追加 status 事件并关闭 owner 终端，隔离其他 owner 且 session 删除不泄露', async () => {
  const state = setup()
  try {
    await assert.rejects(terminateTerminalForOwner(state.db, 'sqlite', other, 'term-clean'), (error: unknown) => (error as { code?: string }).code === 'not_found')
    state.native.prepare('UPDATE terminal_sessions SET session_id=72 WHERE id=?').run('term-clean')
    await assert.rejects(terminateTerminalForOwner(state.db, 'sqlite', owner, 'term-clean'), (error: unknown) => (error as { statusCode?: number }).statusCode === 403)
    state.native.prepare('UPDATE terminal_sessions SET session_id=71 WHERE id=?').run('term-clean')
    const result = await terminateTerminalForOwner(state.db, 'sqlite', owner, 'term-clean', () => new Date('2026-11-17T12:00:00.000Z'))
    assert.equal(result.status, 'terminated')
    assert.equal(result.closedAt, '2026-11-17T12:00:00.000+00:00')
    assert.equal(result.lastSequence, 5)
    assert.equal(result.outputChars, 27)
    assert.equal(state.native.prepare('SELECT count(*) AS n FROM terminal_events').get()?.n, 2)
    assert.deepEqual(state.native.prepare('SELECT sequence,event_type,source,stdout,stderr,exit_code FROM terminal_events ORDER BY sequence DESC LIMIT 1').get(), {
      sequence: 5, event_type: 'status', source: 'user', stdout: '', stderr: '', exit_code: null,
    })
  } finally { await state.db.destroy(); state.native.close() }
})
