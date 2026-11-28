import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createDesktopAgentSession } from '../../../src/agent/sessions/desktop.js'
import { createSubagentDeliveryStore } from '../../../src/agent/subagent/delivery-store.js'
import { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } from '../../../src/agent/run/sqlite-store.js'
import { createSqliteAgentAdmission, listActiveSqliteAgentRuns } from '../../../src/agent/run/sqlite-admission.js'
import type { RunCheckpoint } from '../../../src/agent/models.js'

/**
 * 会话执行位只跟随主 Agent 的运行：
 * 父运行等待子代理时必须归还会话，用户才能在同一会话里继续说话；
 * 仍在执行中的运行必须保留归属，恢复流程才能找到这轮孤儿运行。
 */
it('父运行等待子代理时归还会话执行位，用户可以继续发言且界面仍能读到等待中的运行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sqlite-session-ownership-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const db = runtime.db
      const session = await db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const admission = createSqliteAgentAdmission(db)
      const leases = createSqliteAgentRunLeasePort(db)
      const store = createSqliteAgentRunStore(db, '合成密钥', { async writeHistory() {} })
      const deliveries = createSubagentDeliveryStore(db, '合成密钥', undefined, 'sqlite')
      const accepted = await admission.prepare(ownerId, { session_id: session.id, message: '合成提问' })
      const identity = accepted.identity
      const child = await deliveries.admit(identity, '派单', '合成任务输入',
        { input: { task: '合成任务输入' }, modelIdentity: '合成模型' })
      const lease = (await leases.acquire(identity))!
      const checkpoint = { identity, version: 0, sequence: 0, status: 'running', phase: 'tools', round: 1,
        context: null, text: '', displayTimeline: [] } as unknown as RunCheckpoint<unknown>
      try {
        await store.create(checkpoint, lease, [])
        await store.commit({ identity, lease, expectedVersion: 0, events: [], history: null, interactionReceipt: null,
          subagentWaitChildId: child.childId,
          checkpoint: { ...checkpoint, version: 1, status: 'waiting', subagentWaitChildId: child.childId } })
      } finally { await leases.release(identity, lease) }

      // 等待中的父运行已经归还会话执行位。
      const session_row = await sql<{ active_run_id: string | null; execution_state: string }>`
        SELECT active_run_id,execution_state FROM conversation_sessions WHERE id=${session.id}`.execute(db)
      expect(session_row.rows[0]).toEqual({ active_run_id: null, execution_state: 'idle' })

      // 等待期不再把会话判成「已有运行中的任务」，新消息可以直接进来。
      const followUp = await admission.prepare(ownerId, { session_id: session.id, message: '等待期间的追加提问' })
      expect(followUp.identity.runId).not.toBe(identity.runId)

      // 新一轮占着会话时，当前运行是新一轮；它结束后回退到等待中的父运行。
      expect(await admission.active(ownerId, session.id)).toMatchObject({ identity: { runId: followUp.identity.runId } })
      await sql`UPDATE conversation_sessions SET active_run_id=NULL,execution_state='idle'
        WHERE id=${session.id}`.execute(db)
      expect(await admission.active(ownerId, session.id)).toMatchObject({ identity: { runId: identity.runId } })
      expect((await listActiveSqliteAgentRuns(db, ownerId)).map(row => row.identity.runId)).toContain(identity.runId)
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('仍在执行中的运行保留会话归属，恢复索引才能找到这轮孤儿运行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sqlite-orphan-run-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const db = runtime.db
      const session = await db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const admission = createSqliteAgentAdmission(db)
      const leases = createSqliteAgentRunLeasePort(db)
      const store = createSqliteAgentRunStore(db, '合成密钥', { async writeHistory() {} })
      const accepted = await admission.prepare(ownerId, { session_id: session.id, message: '合成提问' })
      const identity = accepted.identity
      const lease = (await leases.acquire(identity))!
      const checkpoint = { identity, version: 0, sequence: 0, status: 'running', phase: 'provider', round: 1,
        context: null, text: '', displayTimeline: [] } as unknown as RunCheckpoint<unknown>
      try {
        await store.create(checkpoint, lease, [])
      } finally { await leases.release(identity, lease) }

      // 崩溃残留的运行仍在执行中：会话归属不能被归还，恢复流程要靠它找到这轮运行。
      const session_row = await sql<{ active_run_id: string | null; execution_state: string }>`
        SELECT active_run_id,execution_state FROM conversation_sessions WHERE id=${session.id}`.execute(db)
      expect(session_row.rows[0]).toEqual({ active_run_id: identity.runId, execution_state: 'running' })
      expect((await listActiveSqliteAgentRuns(db, ownerId)).map(row => row.identity.runId)).toContain(identity.runId)
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('租约接管必须要求会话空闲，抢占他人运行时整体回滚', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sqlite-lease-takeover-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const db = runtime.db
      const session = await db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const admission = createSqliteAgentAdmission(db)
      const leases = createSqliteAgentRunLeasePort(db)
      const accepted = await admission.prepare(ownerId, { session_id: session.id, message: '合成提问' })
      const identity = accepted.identity
      const other = { ...identity, runId: '另一个运行' }
      // 会话已被准入但尚未开始的运行占着：别的运行不能抢走它的会话归属。
      expect(await leases.acquire(other)).toBeNull()
      const session_row = await sql<{ active_run_id: string | null }>`
        SELECT active_run_id FROM conversation_sessions WHERE id=${session.id}`.execute(db)
      expect(session_row.rows[0]?.active_run_id).toBe(identity.runId)
      const lease_row = await sql<{ run_id: string }>`SELECT run_id FROM agent_run_leases
        WHERE user_id=${ownerId.replaceAll('-', '')} AND session_id=${session.id}`.execute(db)
      expect(lease_row.rows).toEqual([])
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
