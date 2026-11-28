import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { createTerminalListReader } from '../../src/terminals/list.js'

const owner = '00000000-0000-4000-8000-000000000101'
const other = '00000000-0000-4000-8000-000000000102'
const now = new Date('2026-11-17T12:00:00.000Z')

function row(id: string, ownerId: string, source: string, updatedAt: string, options: {
  sessionId?: number | null; closedAt?: string | null; name?: string; status?: string
} = {}) {
  return {
    id, owner_id: ownerId.replaceAll('-', ''), session_id: options.sessionId ?? null,
    workspace_id: null, run_id: null, name: options.name ?? id, source,
    mode: 'agent-events', status: options.status ?? 'idle', shell_mode: 'sandbox',
    network_profile: 'none', last_sequence: 0, output_chars: 0,
    pty_pid: null, pty_sandbox_id: null, pty_cols: null, pty_rows: null,
    created_at: updatedAt, updated_at: updatedAt, closed_at: options.closedAt ?? null,
  }
}

test('终端列表按 owner 清理过期与超额 Agent 记录并返回 Python DTO 顺序', async () => {
  const file = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: file }) })
  file.exec(`
    CREATE TABLE terminal_sessions(
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id INTEGER,workspace_id INTEGER,run_id TEXT,
      name TEXT NOT NULL,source TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,shell_mode TEXT NOT NULL,
      network_profile TEXT NOT NULL,last_sequence INTEGER NOT NULL,output_chars INTEGER NOT NULL,
      pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT
    );
    CREATE TABLE terminal_events(terminal_id TEXT NOT NULL,sequence INTEGER NOT NULL);
  `)
  const insert = file.prepare(`INSERT INTO terminal_sessions VALUES(
    @id,@owner_id,@session_id,@workspace_id,@run_id,@name,@source,@mode,@status,@shell_mode,
    @network_profile,@last_sequence,@output_chars,@pty_pid,@pty_sandbox_id,@pty_cols,@pty_rows,
    @created_at,@updated_at,@closed_at)`)
  const add = (value: ReturnType<typeof row>) => insert.run(value)
  add(row('expired-closed', owner, 'user', '2026-10-01T00:00:00+00:00', { closedAt: '2026-10-01T00:00:00+00:00' }))
  add(row('expired-orphan', owner, 'agent', '2026-09-30T00:00:00+00:00'))
  add(row('recent-closed', owner, 'user', '2026-11-16T00:00:00+00:00', { closedAt: '2026-11-16T00:00:00+00:00' }))
  add(row('open-user', owner, 'user', '2026-11-15T00:00:00+00:00', { name: '我的终端', status: 'running' }))
  for (let index = 1; index <= 6; index++) add(row(`agent-${index}`, owner, 'agent', `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00+00:00`, { sessionId: index }))
  add(row('foreign-agent', other, 'agent', '2026-10-31T00:00:00+00:00', { sessionId: 20 }))
  file.prepare('INSERT INTO terminal_events VALUES(?,1)').run('expired-closed')
  file.prepare('INSERT INTO terminal_events VALUES(?,1)').run('agent-1')
  file.prepare('INSERT INTO terminal_events VALUES(?,1)').run('agent-2')

  try {
    const list = createTerminalListReader(db, 'sqlite', { now: () => now })
    const result = await list(owner, {
      preferences: { shell_enabled: true },
      settings: { sandboxReady: true, terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false, fullUserSandboxAuthorizationEnabled: true },
    })
    assert.equal(result.enabled, true)
    assert.equal(result.ptyEnabled, true)
    assert.deepEqual(result.items.map(item => item.id), ['recent-closed', 'open-user', 'agent-6', 'agent-5', 'agent-4', 'agent-3', 'agent-2'])
    assert.equal(result.items[1]?.name, '我的终端')
    assert.deepEqual(file.prepare('SELECT terminal_id FROM terminal_events ORDER BY terminal_id').all(), [{ terminal_id: 'agent-2' }])
    assert.equal(file.prepare('SELECT COUNT(*) count FROM terminal_sessions WHERE owner_id=?').get(owner.replaceAll('-', ''))?.count, 7)
    assert.equal(file.prepare('SELECT COUNT(*) count FROM terminal_sessions WHERE owner_id=?').get(other.replaceAll('-', ''))?.count, 1)
  } finally {
    await db.destroy()
  }
})

test('终端列表沿用 Python 的 Shell 页面 403 与独立 PTY 禁用状态', async () => {
  const file = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: file }) })
  file.exec(`CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY,owner_id TEXT,session_id INTEGER,workspace_id INTEGER,run_id TEXT,name TEXT,source TEXT,
    mode TEXT,status TEXT,shell_mode TEXT,network_profile TEXT,last_sequence INTEGER,output_chars INTEGER,
    pty_pid INTEGER,pty_sandbox_id TEXT,pty_cols INTEGER,pty_rows INTEGER,created_at TEXT,updated_at TEXT,closed_at TEXT
  ); CREATE TABLE terminal_events(terminal_id TEXT,sequence INTEGER);`)
  try {
    const list = createTerminalListReader(db, 'sqlite')
    await assert.rejects(list(owner, {
      preferences: { shell_enabled: false },
      settings: { sandboxReady: true, terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: false },
      fullUserSandboxAuthorizationEnabled: true,
    }), (error: unknown) => (error as Error).message === '用户未开启 Shell' && (error as { statusCode?: number }).statusCode === 403)

    const visible = await list(owner, {
      preferences: { shell_enabled: true },
      settings: { sandboxReady: true, terminalMode: 'pty_disabled', shellEnabled: true, shellSystemEnabled: false, fullUserSandboxAuthorizationEnabled: true },
    })
    assert.deepEqual(visible, { enabled: true, ptyEnabled: false, items: [] })

    const systemEnabled = await list(owner, {
      preferences: { shell_enabled: false, shell_system_enabled: true },
      settings: { sandboxReady: true, terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: true, fullUserSandboxAuthorizationEnabled: true },
    })
    assert.deepEqual(systemEnabled, { enabled: true, ptyEnabled: true, items: [] })
  } finally {
    await db.destroy()
  }
})
