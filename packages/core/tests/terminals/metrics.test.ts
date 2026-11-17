import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { createTerminalMetricsReader, terminalPageAccess } from '../../src/terminals/metrics.js'

test('terminal metrics aggregate only the owner’s records using Python response fields', async () => {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  try {
    native.exec(`CREATE TABLE terminal_sessions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL, closed_at TEXT, output_chars INTEGER NOT NULL);
      INSERT INTO terminal_sessions VALUES ('a','00000000-0000-4000-8000-000000000101','running',NULL,12),('b','00000000-0000-4000-8000-000000000101','running','closed',8),('c','00000000-0000-4000-8000-000000000101','idle',NULL,4),('x','00000000-0000-4000-8000-000000000102','running',NULL,900);`)
    assert.deepEqual(await createTerminalMetricsReader(db)('00000000-0000-4000-8000-000000000101'), {
      total: 3, running: 1, outputChars: 24, retentionDays: 30, outputRetentionChars: 500000,
    })
  } finally { await db.destroy() }
})

test('terminal page access matches Python shell gates and handles malformed preference payloads fail closed by capability', () => {
  const settings = { sandboxReady: true, terminalMode: 'auto', shellEnabled: true, shellSystemEnabled: true }
  assert.deepEqual(terminalPageAccess({ shell_enabled: false, shell_system_enabled: true }, settings), { allowed: true, reason: '允许访问终端' })
  assert.deepEqual(terminalPageAccess({ shell_enabled: false }, settings), { allowed: false, reason: '用户未开启 Shell' })
  assert.deepEqual(terminalPageAccess({}, { ...settings, terminalMode: 'entry_disabled' }), { allowed: false, reason: '终端入口已由管理员关闭' })
  assert.deepEqual(terminalPageAccess('{malformed', settings), { allowed: true, reason: '允许访问终端' })
  assert.deepEqual(terminalPageAccess({}, { ...settings, sandboxReady: false }), { allowed: false, reason: 'MXC 隔离沙盒不可用' })
})
