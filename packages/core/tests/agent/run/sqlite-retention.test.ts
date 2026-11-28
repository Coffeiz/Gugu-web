import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createDesktopAgentSession } from '../../../src/agent/sessions/desktop.js'
import { cleanupSqliteAgentRunRetention, compactSqliteAgentRunStorage, readSqliteFreeBytes } from '../../../src/agent/run/sqlite-retention.js'

const DAY = 24 * 60 * 60 * 1000

it('事件与检查点带保留期时间列，历史运行按正文时间回填', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-retention-columns-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const eventColumns = (await sql<{ name: string }>`PRAGMA table_info(agent_run_events)`.execute(runtime.db)).rows.map(row => row.name)
      const checkpointColumns = (await sql<{ name: string }>`PRAGMA table_info(agent_run_checkpoints)`.execute(runtime.db)).rows.map(row => row.name)
      expect(eventColumns).toContain('created_at_ms')
      expect(checkpointColumns).toContain('updated_at_ms')
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('只有过期终态运行被回收，活跃、租约未过期和未过期运行都保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-retention-cleanup-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const db = runtime.db
      const owner = ownerId.replaceAll('-', '')
      const session = await db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const now = Date.now()
      const insert = async (runId: string, status: string, updatedAtMs: number) => {
        await sql`INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,version,sequence,status,phase,nonce,payload,updated_at_ms)
          VALUES(${owner},${session.id},${runId},1,1,${status},'idle',${Buffer.alloc(12)},${Buffer.alloc(64)},${updatedAtMs})`.execute(db)
        const eventId = 'event-' + runId
        await sql`INSERT INTO agent_run_events(user_id,session_id,run_id,event_id,sequence,nonce,payload,created_at_ms)
          VALUES(${owner},${session.id},${runId},${eventId},1,${Buffer.alloc(12)},${Buffer.alloc(128)},${updatedAtMs})`.execute(db)
      }
      await insert('expired-run', 'completed', now - 10 * DAY)
      await insert('recent-run', 'completed', now - 60 * 60 * 1000)
      await insert('running-run', 'running', now - 10 * DAY)
      await insert('leased-run', 'completed', now - 10 * DAY)
      await sql`INSERT INTO agent_run_leases(user_id,session_id,run_id,token,fence,expires_at_ms)
        VALUES(${owner},${session.id},'leased-run','synthetic-token',1,${now + 60_000})`.execute(db)

      const cleaned = await cleanupSqliteAgentRunRetention(db, { now, retentionMs: 7 * DAY })
      expect(cleaned.runs).toBe(1)
      expect(cleaned.events).toBe(1)
      const remaining = (await sql<{ run_id: string }>`SELECT run_id FROM agent_run_checkpoints ORDER BY run_id`.execute(db)).rows.map(row => row.run_id)
      expect(remaining).toEqual(['leased-run', 'recent-run', 'running-run'])
      const events = (await sql<{ run_id: string }>`SELECT run_id FROM agent_run_events ORDER BY run_id`.execute(db)).rows.map(row => row.run_id)
      expect(events).toEqual(['leased-run', 'recent-run', 'running-run'])
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('删除后磁盘不自动收缩，需要压缩才能回收空闲页', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-retention-compact-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const db = runtime.db
      const owner = ownerId.replaceAll('-', '')
      const session = await db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const now = Date.now()
      await sql`INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,version,sequence,status,phase,nonce,payload,updated_at_ms)
        VALUES(${owner},${session.id},'bulk-run',1,1,'completed','idle',${Buffer.alloc(12)},${Buffer.alloc(64 * 1024)},${now - 10 * DAY})`.execute(db)
      await sql`INSERT INTO agent_run_events(user_id,session_id,run_id,event_id,sequence,nonce,payload,created_at_ms)
        VALUES(${owner},${session.id},'bulk-run','event-bulk',1,${Buffer.alloc(12)},${Buffer.alloc(256 * 1024)},${now - 10 * DAY})`.execute(db)
      await cleanupSqliteAgentRunRetention(db, { now, retentionMs: 7 * DAY })
      expect(await readSqliteFreeBytes(db)).toBeGreaterThan(0)
      expect(await compactSqliteAgentRunStorage(db, 0)).toBe(true)
      expect(await readSqliteFreeBytes(db)).toBe(0)
    } finally { await runtime.close() }
    const info = await stat(path)
    expect(info.size).toBeGreaterThan(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
