import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sql } from 'kysely'
import { createSubagentDeliveryStore } from '../../../src/agent/subagent/delivery-store.js'
import { createAgentInbox } from '../../../src/agent/subagent/inbox.js'
import { createSubagentService } from '../../../src/agent/subagent/service.js'
import { createSqliteAgentRunCoordination } from '../../../src/agent/run/sqlite-coordination.js'
import { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } from '../../../src/agent/run/sqlite-store.js'
import { createDesktopAgentSession, listDesktopAgentSessions } from '../../../src/agent/sessions/desktop.js'
import { createSqlAgentToolEventDetails } from '../../../src/agent/sessions/tool-event-details.js'
import type { RunCheckpoint } from '../../../src/agent/models.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'

function communicationPorts(db: Parameters<typeof createAgentInbox>[0], secret: string) {
  return {
    inbox: createAgentInbox(db, secret),
    childCheckpoints: createSqliteAgentRunStore(db, secret, { async writeHistory() {} }),
    async schedule() {},
    async requestCancellation() { throw new Error('本用例不应执行取消') },
    parentBinding: async () => ({ agentId: 'builtin:main', modelIdentity: '合成模型' }),
    authorizeResources: async () => true,
  }
}

it('迁移旧派单后从同一父会话的新 Run 恢复子 Agent 身份并投递消息', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-subagent-conversation-'))
  const path = join(directory, 'agent.sqlite')
  const secret = '合成迁移密钥'
  try {
    await initializeSqlite(path)
    const first = await openSqliteRuntime(path)
    let parent, child
    try {
      const session = await first.runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, first.ownerId, '合成父会话'))
      parent = { ownerId: first.ownerId, sessionId: String(session.id), runId: '原始父运行' }
      const store = createSubagentDeliveryStore(first.runtime.db, secret, undefined, 'sqlite')
      child = await store.admit(parent, '派单', '合成请求', { input: { task: '合成任务' }, modelIdentity: '合成模型' })
      await first.runtime.db.transaction().execute(async tx => {
        await sql`INSERT INTO agent_subagent_sessions(child_run_id,child_session_id)
          SELECT child_run_id,child_session_id FROM agent_subagent_executions`.execute(tx)
        await sql`INSERT INTO agent_subagent_launches(child_run_id,nonce,payload)
          SELECT child_run_id,nonce,payload FROM agent_subagent_executions`.execute(tx)
        await sql`DROP TABLE agent_subagent_executions`.execute(tx)
        await sql`DROP TABLE agent_subagent_conversations`.execute(tx)
      })
    } finally { await first.runtime.close() }
    const reopened = await openSqliteRuntime(path)
    try {
      const store = createSubagentDeliveryStore(reopened.runtime.db, secret, undefined, 'sqlite')
      const inbox = createAgentInbox(reopened.runtime.db, secret)
      const nextParent = { ...parent, runId: '下一父运行' }
      const resolved = await store.resolveConversation(nextParent, child.childId)
      expect(resolved).toMatchObject({ parent, delivery: { childId: child.childId, runId: child.runId } })
      const execution = (await store.childIdentity(parent, child.runId))!
      expect(await inbox.send(nextParent, { childId: child.childId }, '追加', '后续问题')).not.toBeNull()
      expect(await inbox.pending(execution)).toMatchObject([{ message: '后续问题' }])
      const stranger = { ...nextParent, sessionId: '999' }
      expect(await store.resolveConversation(stranger, child.childId)).toBeNull()
      expect(await inbox.send(stranger, { childId: child.childId }, '追加', '越权消息')).toBeNull()
      expect(await store.complete(parent, child.runId, { status: 'completed', finalMessage: '原坐标加密结果' })).toBe(true)
      expect((await store.resolveConversation(nextParent, child.childId))?.delivery.outcome)
        .toMatchObject({ finalMessage: '原坐标加密结果' })
      const service = createSubagentService({ ...communicationPorts(reopened.runtime.db, secret), deliveries: store })
      expect(await service.inspect(nextParent, child.childId)).toMatchObject({ run: { childId: child.childId, status: 'completed' } })
      expect(await service.inspect(nextParent)).toMatchObject({ runs: [{ childId: child.childId, status: 'completed' }] })
      expect(await service.cancel(nextParent, child.childId)).toEqual({ childId: child.childId, status: 'completed' })
      await expect(service.inspect(stranger, child.childId)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
      const input = { input: { task: '空闲后继续' }, modelIdentity: '合成模型' }
      const attempts = await Promise.all([
        store.continueConversation(nextParent, child.childId, '续聊', input),
        store.continueConversation(nextParent, child.childId, '续聊', input),
      ])
      expect(attempts.map(attempt => attempt?.created).sort()).toEqual([false, true])
      const nextRunId = attempts[0]!.runId
      expect(attempts[1]?.runId).toBe(nextRunId)
      expect((await store.childIdentity(nextParent, nextRunId))?.sessionId).toBe(execution.sessionId)
      expect(await store.readLaunch(nextParent, nextRunId)).toMatchObject({ childId: child.childId, previousRunId: child.runId })
      const admitted = await sql`SELECT run_id FROM agent_run_admissions WHERE run_id=${nextRunId}`.execute(reopened.runtime.db)
      expect(admitted.rows).toEqual([{ run_id: nextRunId }])
      expect(await store.complete(nextParent, nextRunId, { status: 'completed', finalMessage: '续聊恢复完成' })).toBe(true)
      const laterParent = { ...nextParent, runId: '再下一父运行' }
      const queued = (await store.continueConversation(laterParent, child.childId, '最后追问', input))!
      const queuedIdentity = (await store.childIdentity(laterParent, queued.runId))!
      const checkpoints = createSqliteAgentRunStore(reopened.runtime.db, secret, { async writeHistory() {} })
      const { cancellation } = createSqliteAgentRunCoordination(reopened.runtime.db, checkpoints)
      const cancelled = createSubagentService({
        ...communicationPorts(reopened.runtime.db, secret), deliveries: store, childCheckpoints: checkpoints,
        parentBinding: async () => ({ agentId: 'builtin:main', modelIdentity: '合成模型' }),
        authorizeResources: async () => true,
        async requestCancellation(target) {
          await cancellation.request(target)
          await cancellation.notify(target)
        },
      })
      expect(await cancelled.cancel(nextParent, child.childId)).toEqual({ childId: child.childId, status: 'cancelling' })
      expect(await cancellation.isRequested(queuedIdentity)).toBe(true)
      expect(await checkpoints.read(queuedIdentity)).toBeNull()
      await sql`DELETE FROM agent_run_controls WHERE run_id=${queuedIdentity.runId}`.execute(reopened.runtime.db)
      await cancelled.cancelChildren(nextParent)
      expect(await cancellation.isRequested(queuedIdentity)).toBe(false)
      await cancelled.cancelChildren(laterParent)
      expect(await cancellation.isRequested(queuedIdentity)).toBe(true)
      expect(await checkpoints.read(queuedIdentity)).toBeNull()
    } finally { await reopened.runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('SQLite 重开后 wait 返回同一 final，父回执提交前保持可领取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-subagent-delivery-'))
  const path = join(directory, 'agent.sqlite')
  const secret = '合成子运行交付密钥'
  const finalMessage = '已完成合成研究。'
  const signal = new AbortController().signal
  await initializeSqlite(path)
  try {
    const first = await openSqliteRuntime(path)
    const session = await first.runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, first.ownerId, '合成父会话'))
    const parent = { ownerId: first.ownerId, sessionId: String(session.id), runId: '合成父运行' }
    const deliveries = createSubagentDeliveryStore(first.runtime.db, secret, undefined, 'sqlite')
    const service = createSubagentService({ ...communicationPorts(first.runtime.db, secret), deliveries })
    let childId: string
    try {
      const start = await service.start(parent, '派单', 'builtin:searcher', { task: '合成任务' }, signal)
      childId = start.run.childId
      const result = await deliveries.read(parent, childId)
      expect(await deliveries.complete(parent, result!.runId, { status: 'completed', finalMessage })).toBe(true)
      expect(await service.wait(parent, childId, signal)).toEqual({ childId, status: 'completed', finalMessage })
      const { rows } = await sql<{ payload: Buffer }>`SELECT payload FROM agent_subagent_deliveries`.execute(first.runtime.db)
      expect(rows[0]?.payload.toString('utf8')).not.toContain(finalMessage)
    } finally { await first.runtime.close() }

    const reopened = await openSqliteRuntime(path)
    const restored = createSubagentDeliveryStore(reopened.runtime.db, secret, undefined, 'sqlite')
    let scheduled = 0
    const restarted = createSubagentService({ ...communicationPorts(reopened.runtime.db, secret), deliveries: restored,
      async schedule() { scheduled++ } })
    try {
      const start = await restarted.start(parent, '派单', 'builtin:searcher', { task: '合成任务' }, signal)
      expect(start.run.childId).toBe(childId)
      expect(scheduled).toBe(0)
      expect(await restarted.wait(parent, childId, signal)).toEqual({ childId, status: 'completed', finalMessage })
      await expect(restarted.wait({ ...parent, runId: '其他父运行' }, childId, signal)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
      await expect(reopened.runtime.db.transaction().execute(async tx => {
        expect(await restored.markConsumed(tx, parent, childId, 3)).toBe(true)
        throw new Error('模拟父 checkpoint 回滚')
      })).rejects.toThrow('模拟父 checkpoint 回滚')
      expect(await reopened.runtime.db.transaction().execute(tx => restored.pruneConsumed(tx, parent, 3))).toBe(0)
      expect(await restarted.wait(parent, childId, signal)).toMatchObject({ finalMessage })
      expect(await restored.pending(parent)).toMatchObject([{ childId, finalMessage }])
      await reopened.runtime.db.transaction().execute(tx => restored.markConsumed(tx, parent, childId, 3))
      expect(await restored.pending(parent)).toEqual([])
      expect(await restarted.wait(parent, childId, signal)).toEqual({ childId, status: 'completed', alreadyDelivered: true })
      const timeline = JSON.stringify([{
        kind: 'tool', toolName: 'agent_wait', runId: parent.runId,
        toolInput: { childId }, toolResult: { childId, status: 'completed', alreadyDelivered: true },
      }, {
        kind: 'tool', toolName: 'agent_wait', runId: '其他父运行', toolInput: { childId },
      }])
      await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,created_at,display_timeline)
        VALUES (100,${session.id},1,'assistant','','2026-01-01 00:00:00.000000',${timeline})`.execute(reopened.runtime.db)
      const details = createSqlAgentToolEventDetails(reopened.runtime.db, 'sqlite', () => secret)
      expect(await details(parent.ownerId, session.id, 100, 0)).toMatchObject({ toolResult: {
        finalMessage, childId, status: 'completed',
      } })
      expect(await details(parent.ownerId, session.id, 100, 1)).toEqual({ toolInput: { childId } })
      expect(await reopened.runtime.db.transaction().execute(tx => restored.pruneConsumed(tx, parent, 2))).toBe(0)
      expect(await reopened.runtime.db.transaction().execute(tx => restored.pruneConsumed(tx, parent, 3))).toBe(1)
      const background = await restarted.start(parent, '后台派单', 'builtin:searcher',
        { task: '后台任务', allowBackgroundReport: true }, signal)
      const backgroundId = background.run.childId
      const backgroundRun = await restored.read(parent, backgroundId)
      await expect(restarted.wait({ ...parent, runId: '其他父运行' }, backgroundId, signal))
        .rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
      expect(await restored.complete(parent, backgroundRun!.runId, { status: 'completed', finalMessage })).toBe(true)
      expect(await restarted.wait({ ...parent, runId: '其他父运行' }, backgroundId, signal))
        .toEqual({ childId: backgroundId, status: 'completed', finalMessage, deliveryRunId: backgroundRun!.runId })
      await expect(restarted.wait({ ...parent, sessionId: String(session.id + 1) }, backgroundId, signal))
        .rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
      const nextParent = { ...parent, runId: '其他父运行' }
      expect(await restarted.waitInbox(nextParent, signal)).toEqual({
        messages: [], finals: [{ childId: backgroundId, status: 'completed' }],
      })
      expect(await restored.pending({ ...nextParent, sessionId: String(session.id + 1) })).toEqual([])
      const [delivery] = await restored.pending(nextParent)
      expect(delivery?.deliveryRunId).toBe(backgroundRun!.runId)
      await reopened.runtime.db.transaction().execute(tx =>
        restored.markConsumed(tx, nextParent, `run:${delivery!.deliveryRunId}`, 5))
      expect(await restarted.waitInbox(nextParent, signal)).toEqual({ messages: [], finals: [] })
      expect(await restored.readOutcomeByExecution(nextParent, backgroundRun!.runId, backgroundId))
        .toMatchObject({ finalMessage })
    } finally { await reopened.runtime.close() }
  } finally { await rm(directory, { force: true, recursive: true }) }
})

it('子 checkpoint 已提交而交付未提交时，SQLite 重开后并发 wait 只补交一次 final', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-subagent-recover-'))
  const path = join(directory, 'agent.sqlite')
  const secret = '合成恢复密钥'
  const finalMessage = '已提交的合成子任务结论'
  const signal = new AbortController().signal
  try {
    await initializeSqlite(path)
    const first = await openSqliteRuntime(path)
    const { ownerId } = first
    const parent = { ownerId, sessionId: '1', runId: '合成父运行' }
    let childId: string
    try {
      const db = first.runtime.db
      await db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成父会话'))
      const deliveries = createSubagentDeliveryStore(db, secret, undefined, 'sqlite')
      const launchConfig = { input: { task: '合成任务' }, modelIdentity: '合成模型' }
      await expect(deliveries.admit({ ...parent, sessionId: '99' }, '错误派单', '合成任务', launchConfig)).rejects.toThrow('父运行会话不可用')
      const child = await deliveries.admit(parent, '派单', '合成任务', launchConfig)
      childId = child.childId
      expect((await sql`SELECT 1 FROM agent_subagent_sessions`.execute(db)).rows).toEqual([])
      expect((await sql`SELECT 1 FROM agent_subagent_launches`.execute(db)).rows).toEqual([])
      const identity = (await deliveries.childIdentity(parent, child.runId))!
      expect(identity.sessionId).not.toBe(parent.sessionId)
      expect(await deliveries.admit(parent, '派单', '合成任务', launchConfig)).toMatchObject({ runId: child.runId, created: false })
      expect(await deliveries.childIdentity({ ...parent, runId: '另一个父运行' }, child.runId)).toBeNull()
      expect(await listDesktopAgentSessions(db, ownerId)).toMatchObject([{ id: Number(parent.sessionId) }])
      const { rows } = await sql<{ count: number }>`SELECT count(*) AS count FROM agent_subagent_deliveries`.execute(db)
      expect(Number(rows[0]!.count)).toBe(1)
      const leases = createSqliteAgentRunLeasePort(db)
      const lease = (await leases.acquire(identity))!
      const store = createSqliteAgentRunStore(db, secret, { async writeHistory() {} })
      const checkpoint = { identity, version: 0, sequence: 0, status: 'running', text: '', phase: 'idle', context: null } as RunCheckpoint<unknown>
      try {
        await store.create(checkpoint, lease, [])
        await store.commit({
          identity, expectedVersion: 0, lease, events: [], history: null, interactionReceipt: null,
          checkpoint: { ...checkpoint, version: 1, status: 'completed', text: finalMessage },
        })
      } finally { await leases.release(identity, lease) }
      expect((await deliveries.read(parent, childId))?.outcome).toBeNull()
    } finally { await first.runtime.close() }

    const reopened = await openSqliteRuntime(path)
    const db = reopened.runtime.db
    const deliveries = createSubagentDeliveryStore(db, secret, undefined, 'sqlite')
    const store = createSqliteAgentRunStore(db, secret, { async writeHistory() {} })
    const options = {
      ...communicationPorts(db, secret), deliveries, childCheckpoints: store,
      parentBinding: async () => ({ agentId: 'builtin:main', modelIdentity: '合成模型' }),
      authorizeResources: async () => true,
    }
    const readers = [createSubagentService(options), createSubagentService(options)]
    try {
      const expected = { childId, status: 'completed', finalMessage }
      await deliveries.repairTerminalDeliveries(store, ownerId)
      expect(await deliveries.pending(parent)).toEqual([{ ...expected, deliveryRunId: (await deliveries.read(parent, childId))!.runId }])
      expect(await Promise.all(readers.map(service => service.wait(parent, childId, signal)))).toEqual([expected, expected])
      expect(await deliveries.pending(parent)).toEqual([{ ...expected, deliveryRunId: (await deliveries.read(parent, childId))!.runId }])
      await db.transaction().execute(tx => deliveries.markConsumed(tx, parent, childId, 2))
      expect(await readers[0]!.wait(parent, childId, signal)).toEqual({ childId, status: 'completed', alreadyDelivered: true })
      expect(await deliveries.pending(parent)).toEqual([])
    } finally {
      await reopened.runtime.close()
    }
  } finally { await rm(directory, { force: true, recursive: true }) }
})

const postgresUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
it.skipIf(!postgresUrl)('PostgreSQL 重连后复用已提交的终态和短 ID', async () => {
  const [{ randomUUID }, { Pool }, { createPostgresRuntime }, { subagentDeliveries }] = await Promise.all([
    import('node:crypto'), import('pg'), import('../../../src/data/postgres.js'),
    import('@gugu/database/postgres/migrations/0028_subagent_deliveries'),
  ])
  const schema = `subagent_delivery_${randomUUID().replaceAll('-', '')}`
  const parent = { ownerId: randomUUID(), sessionId: '1', runId: '合成父运行' }
  const admin = new Pool({ connectionString: postgresUrl })
  const pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query('CREATE TABLE agent_run_checkpoints (fixture_id integer)')
    expect(await subagentDeliveries.apply(pool)).toBe('applied')
    const secret = '合成子运行交付密钥'
    const first = await createPostgresRuntime({ url: postgresUrl!, schema })
    const childId = 'd00d1234'
    const runId = randomUUID()
    const outcome = { status: 'completed' as const, finalMessage: '合成 PostgreSQL 最终回复' }
    try {
      // 此存储层用例从普通派单已经提交的交付记录开始。
      await sql`INSERT INTO agent_subagent_deliveries
        (owner_id,parent_session_id,parent_run_id,call_id,child_id,child_run_id,request_digest,status,updated_at)
        VALUES (${parent.ownerId},${parent.sessionId},${parent.runId},'合成调用',${childId},${runId},
          '合成请求','queued',${new Date().toISOString()})`.execute(first.db)
      const store = createSubagentDeliveryStore(first.db, secret)
      expect(await store.complete(parent, runId, outcome)).toBe(true)
      expect(await store.complete(parent, runId, { ...outcome, finalMessage: '重复覆盖' })).toBe(false)
    } finally { await first.close() }
    const second = await createPostgresRuntime({ url: postgresUrl!, schema })
    try {
      const store = createSubagentDeliveryStore(second.db, secret)
      expect(await store.read(parent, childId)).toMatchObject({ childId, runId })
      expect((await store.read(parent, childId))?.outcome).toEqual({ childId, ...outcome })
      expect(await store.read({ ...parent, ownerId: randomUUID() }, childId)).toBeNull()
    } finally { await second.close() }
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})

it('双向收件箱重启后按 Run 恢复，消费失败回滚且发送重放不重复入箱', async () => {
  const { createAgentInbox } = await import('../../../src/agent/subagent/inbox.js')
  const directory = await mkdtemp(join(tmpdir(), 'gugu-inbox-'))
  const path = join(directory, 'agent.sqlite')
  const secret = '合成收件箱密钥'
  try {
    await initializeSqlite(path)
    const initial = await openSqliteRuntime(path)
    const parent = { ownerId: initial.ownerId, sessionId: '1', runId: '合成父运行' }
    let child: typeof parent
    let ids: { childId: string; messageId: string }
    try {
      const { db } = initial.runtime
      await db.transaction().execute(tx => createDesktopAgentSession(tx, initial.ownerId, '合成父会话'))
      const deliveries = createSubagentDeliveryStore(db, secret, undefined, 'sqlite')
      const launch = await deliveries.admit(parent, '派单', '合成输入', { input: { task: '合成输入' }, modelIdentity: '合成模型' })
      child = (await deliveries.childIdentity(parent, launch.runId))!
      const notified: Array<typeof parent> = []
      const inbox = createAgentInbox(db, secret, { async onMessageCommitted(recipient) {
        expect(await inbox.pending(recipient)).toHaveLength(1)
        notified.push(recipient)
      } })
      const sent = (await inbox.send(parent, { childId: launch.childId }, '补充', '合成补充指令'))!
      ids = { childId: launch.childId, messageId: sent.messageId }
      expect(await inbox.send(child, { parent: true }, '进度', '合成进度')).not.toBeNull()
      expect(notified).toEqual([child, parent])
      expect(await inbox.send({ ...child, runId: '未关联子运行' }, { parent: true }, '进度', '错误投递')).toBeNull()
      const { rows } = await sql<{ payload: Buffer }>`SELECT payload FROM agent_inbox_messages`.execute(db)
      expect(rows.every(row => !row.payload.includes(Buffer.from('合成')))).toBe(true)
    } finally { await initial.runtime.close() }
    const reopened = await openSqliteRuntime(path)
    try {
      const { db } = reopened.runtime
      const inbox = createAgentInbox(db, secret)
      expect(await inbox.send(parent, { childId: ids.childId }, '补充', '合成补充指令')).toEqual({ messageId: ids.messageId })
      expect(await inbox.pending(parent)).toMatchObject([{ message: '合成进度' }])
      expect(await inbox.pending({ ...parent, runId: '后续父运行' })).toMatchObject([{ message: '合成进度' }])
      expect(await inbox.pending({ ...child, runId: '后续子运行' })).toEqual([])
      expect(await inbox.pending(child)).toMatchObject([{ id: ids.messageId, message: '合成补充指令' }])
      const leases = createSqliteAgentRunLeasePort(db)
      const lease = (await leases.acquire(child))!
      const store = createSqliteAgentRunStore(db, secret, { async writeHistory() { throw new Error('模拟写入回滚') } })
      try {
        const checkpoint = { identity: child, version: 0, sequence: 0, status: 'running', context: null, phase: 'idle' } as RunCheckpoint<unknown>
        await store.create(checkpoint, lease, [])
        const commit = { identity: child, expectedVersion: 0, lease, checkpoint: { ...checkpoint, version: 1 },
          events: [], interactionReceipt: null, inboxMessageIds: [ids.messageId] }
        await expect(store.commit({ ...commit, history: { outcome: 'success', context: {}, text: '' } })).rejects.toThrow('模拟写入回滚')
        expect(await inbox.pending(child)).toHaveLength(1)
        await store.commit({ ...commit, history: null })
        expect(await inbox.pending(child)).toEqual([])
        expect(await inbox.pending(parent)).toHaveLength(1)
      } finally { await leases.release(child, lease) }
    } finally { await reopened.runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
