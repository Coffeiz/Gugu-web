import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'vitest'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createAgentSessionRefresh, createSqlAgentSessionRefreshRepository } from '../../../src/agent/sessions/refresh.js'
import { clock } from './contract.js'

test('正式 SQLite 刷新隔离 owner、保留快照并并发递增 epoch', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-refresh-')), path = join(folder, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const hex = ownerId.replaceAll('-', '')
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,session_context,snapshot_hash,session_info_hash,snapshot_expires_at,created_at,updated_at) VALUES (1,${hex},'旧',0,'','web',1,'{"private":true}','snapshot','info','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00')`.execute(runtime.db)
      const refresh = createAgentSessionRefresh(createSqlAgentSessionRefreshRepository(runtime.db, 'sqlite', clock))
      expect(await refresh(randomUUID(), 1)).toBeNull()
      const rows = await Promise.all(Array.from({ length: 6 }, () => refresh(ownerId, 1)))
      expect(rows.map(row => row!.contextEpoch).sort((a, b) => a-b)).toEqual([2,3,4,5,6,7])
      expect(rows.every(row => row!.expiresAt === '2026-11-14T12:00:00.123456Z' && row!.snapshotHash === 'snapshot' && row!.sessionInfoHash === 'info')).toBe(true)
      const state = await sql<{ session_context: string; context_epoch: number; updated_at: string }>`SELECT session_context,context_epoch,updated_at FROM conversation_sessions WHERE id=1`.execute(runtime.db)
      expect(state.rows[0]).toEqual({ session_context: '{"private":true}', context_epoch: 7, updated_at: '2026-11-14 12:00:00.123456' })
    } finally { await runtime.close() }
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('隔离缺表库明确要求升级', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-refresh-missing-')), path = join(folder, 'core.db')
  try {
    await initializeSqlite(path); const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      await sql`DROP TABLE conversation_sessions`.execute(runtime.db)
      const refresh = createAgentSessionRefresh(createSqlAgentSessionRefreshRepository(runtime.db, 'sqlite', clock))
      await expect(refresh(ownerId, 1)).rejects.toThrow('尚未初始化')
    } finally { await runtime.close() }
  } finally { await rm(folder, { recursive: true, force: true }) }
})
