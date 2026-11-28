import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { CoreError } from '../../src/contracts/index.js'
import { createTerminalRenamer } from '../../src/terminals/rename.js'

const owner = '00000000-0000-4000-8000-000000000151'
const other = '00000000-0000-4000-8000-000000000152'

function setup(sessionExists = true) {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
    name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
    network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
  ); CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL);`)
  if (sessionExists) native.prepare('INSERT INTO conversation_sessions VALUES(?,?)').run(71, owner.replaceAll('-', ''))
  native.prepare('INSERT INTO terminal_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'term-owned', owner.replaceAll('-', ''), 71, null, null, '原名', 'user', 'interactive-pty', 'idle', 'sandbox', 'none', 0, 0, null, null, null, null,
    '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z', null,
  )
  return { native, db }
}

const access = { preferences: { shell_enabled: true }, settings: { sandboxReady: true, terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false } }

test('重命名修剪并限制 DTO 名称，提交后发布 owner 变更', async () => {
  const { native, db } = setup()
  const changes: unknown[][] = []
  try {
    const rename = createTerminalRenamer(db, 'sqlite', async (...args) => { changes.push(args) }, { now: () => new Date('2026-11-17T12:00:00.000Z') })
    const result = await rename(owner, 'term-owned', { name: `  ${'a'.repeat(210)}  `, ...access, origin: 'client-1' })
    assert.equal(result.name, 'a'.repeat(200))
    assert.equal(result.updatedAt, '2026-11-17T12:00:00.000+00:00')
    assert.deepEqual(changes, [[owner, 'term-owned', 'client-1']])
    assert.equal(native.prepare('SELECT name FROM terminal_sessions WHERE id=?').get('term-owned')?.name, 'a'.repeat(200))
  } finally { await db.destroy(); native.close() }
})

test('重命名保留 Python 的 owner、关联会话、Shell 与空名称错误', async () => {
  const state = setup(false)
  try {
    const rename = createTerminalRenamer(state.db, 'sqlite', async () => {})
    await assert.rejects(rename(other, 'term-owned', { name: '新名', ...access, origin: null }),
      (error: unknown) => error instanceof CoreError && error.code === 'not_found')
    await assert.rejects(rename(owner, 'term-owned', { name: '新名', ...access, origin: null }),
      (error: unknown) => (error as Error).message === '终端会话不存在' && (error as { statusCode?: number }).statusCode === 403)
  } finally { await state.db.destroy(); state.native.close() }

  const withSession = setup(true)
  try {
    const rename = createTerminalRenamer(withSession.db, 'sqlite', async () => {})
    await assert.rejects(rename(owner, 'term-owned', { name: '   ', ...access, origin: null }),
      (error: unknown) => (error as Error).message === '终端名称不能为空' && (error as { statusCode?: number }).statusCode === 400)
    await assert.rejects(rename(owner, 'term-owned', { name: '新名', ...access, preferences: { shell_enabled: false }, origin: null }),
      (error: unknown) => (error as Error).message === '用户未开启 Shell' && (error as { statusCode?: number }).statusCode === 403)
  } finally { await withSession.db.destroy(); withSession.native.close() }
})
