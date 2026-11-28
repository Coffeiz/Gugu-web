import type { createSqliteAgentAdmission, DesktopGroupSender } from '#core-source/agent/run/sqlite-admission.js'
import type { DesktopAgentChatReference } from '#core-source/contracts/desktop.js'
import { createDesktopMcpCrypto } from '#core-source/mcp/desktop-crypto.js'
import { consumeSqliteInteraction } from '#core-source/agent/interactions/sqlite-consume.js'
import { InteractionConsumeError } from '#core-source/agent/interactions/consume-action.js'
import { InteractionTextError } from '#core-source/agent/interactions/consume-text.js'
import { createSubagentDeliveryStore } from '#core-source/agent/subagent/delivery-store.js'
import { settleCancelledSqliteSubagentWait, settleClosedSqliteInteraction, settleStoppedSqliteAgentRun } from '#core-source/agent/run/sqlite-recovery.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import type { ProviderConfig } from '#core-source/agent/providers/contracts.js'
import type { RagQueryEmbeddingSettings } from '#core-source/agent/rag/query-embedding.js'
import type { CanonicalRunContext, RunCheckpoint, RunIdentity } from '#core-source/agent/models.js'
import type { createSqliteAgentRuntime } from '#core-source/agent/run/sqlite-runtime.js'
import { createSqliteAgentRunStore } from '#core-source/agent/run/sqlite-store.js'
import { loadSqliteAgentRunSecret } from '#core-source/agent/run/sqlite-secret.js'
import { CoreError, dataContext } from '#core-source/contracts/index.js'
import { sql } from 'kysely'

export function createDesktopSessionRuns(options: {
  db: SqlDataRuntime['db']
  databasePath: string
  ownerId: string
  admission: ReturnType<typeof createSqliteAgentAdmission>
  running: Map<number, { runId: string; cancel(): Promise<unknown>; done: Promise<void> }>
  runTasks: Set<Promise<void>>
  createRunRuntime: (sessionId: number, config: ProviderConfig, embedding?: RagQueryEmbeddingSettings,
    interactive?: boolean, resumeIdentity?: RunIdentity, modelId?: string, locale?: string, desktopChat?: boolean) => Promise<{
    agent: ReturnType<typeof createSqliteAgentRuntime>
    checkpoint: RunCheckpoint<CanonicalRunContext> | null
    drainReflections: () => Promise<void>
  }>
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  reflectionModelIdentity: (config: ProviderConfig) => string
  isDesktopChatMessage: (clientId: string) => boolean
  scheduleAdmittedRuns: (secret: string) => void
  scheduleSubagentWake: (identity: RunIdentity) => void
  cancelChildren: (identity: RunIdentity) => Promise<void>
  notify: (sessionId: number, runId: string, interactionChanged?: true) => void
}) {
  const { db, databasePath, ownerId, admission, running, runTasks, createRunRuntime, hostRequest,
    reflectionModelIdentity, isDesktopChatMessage, scheduleAdmittedRuns, scheduleSubagentWake, cancelChildren, notify } = options
  const responding = new Set<number>()

  async function runModel(sessionId: number, runId: string) {
    const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
    const { rows: [row] } = await sql<{ model_id: string }>`SELECT model_id FROM desktop_agent_run_models
      WHERE user_id=${owner} AND session_id=${sessionId} AND run_id=${runId}`.execute(db)
    return row?.model_id ?? null
  }

  async function resumeCheckpoint(checkpoint: RunCheckpoint<CanonicalRunContext>, signal: AbortSignal) {
    if (!checkpoint.context || signal.aborted) return false
    const identity = checkpoint.identity
    const sessionId = Number(identity.sessionId)
    const modelId = await runModel(sessionId, identity.runId)
    const config = await hostRequest('agent.memory.resolveReflectionModel', {
      modelIdentity: checkpoint.context.modelIdentity, modelId,
    }, signal) as ProviderConfig | null
    if (!config || reflectionModelIdentity(config) !== checkpoint.context.modelIdentity) return false
    signal.throwIfAborted()
    const embedding = await hostRequest('agent.memory.resolveEmbedding', {}, signal) as RagQueryEmbeddingSettings | null
    signal.throwIfAborted()
    const { agent, drainReflections } = await createRunRuntime(sessionId, config, embedding ?? undefined, true, identity, modelId ?? undefined)
    const iterator = agent.harness.resume(identity)
    try {
      let event = await iterator.next()
      while (!event.done && (event.value.sequence <= checkpoint.sequence
        || event.value.type !== 'run_resumed' && event.value.type !== 'final')) event = await iterator.next()
      if (event.done) {
        await agent.close()
        return false
      }
    } catch (error) {
      await iterator.return(undefined as never)
      await agent.close()
      throw error
    }
    const done = (async () => {
      try {
        for await (const _event of iterator) { /* 驱动运行继续提交事件。 */ }
        await drainReflections()
      } catch (error) {
        await settleStoppedSqliteAgentRun(db, databasePath, identity)
        throw error
      } finally {
        try { await agent.close() }
        finally {
          if (running.get(sessionId)?.runId === identity.runId) running.delete(sessionId)
          notify(sessionId, identity.runId)
        }
      }
    })()
    running.set(sessionId, { runId: identity.runId, cancel: () => agent.service.cancel(ownerId, sessionId), done })
    runTasks.add(done)
    void done.finally(() => runTasks.delete(done)).catch(() => {})
    return true
  }

  return {
    resumeCheckpoint,
    async start(sessionId: number, text: string, clientId: string, config: ProviderConfig, embedding?: RagQueryEmbeddingSettings, interactive = false, modelId?: string,
      attachments: string[] = [], references: DesktopAgentChatReference[] = [], queueClaim?: { key: number; token: string }, locale?: string,
      groupSender?: DesktopGroupSender, resumePassiveMessage = false, quotedText?: string) {
      if (responding.has(sessionId)) throw new CoreError('busy', '会话已有运行中的任务')
      const active = await admission.active(ownerId, sessionId)
      if (active?.identity && running.has(sessionId)) throw new CoreError('busy', '会话已有运行中的任务')
      if (active?.identity) await settleClosedSqliteInteraction(db, databasePath, active.identity)
      const { agent, drainReflections } = await createRunRuntime(sessionId, config, embedding, interactive, undefined, modelId, locale,
        !groupSender && isDesktopChatMessage(clientId))
      try {
        const stream = await agent.service.start(ownerId, { session_id: sessionId, message: text,
          client_message_id: clientId, attachments, references, queueClaim, groupSender, resumePassiveMessage, quotedText }, undefined)
        const iterator = stream[Symbol.asyncIterator]()
        const first = await iterator.next()
        if (first.done || typeof first.value.run_id !== 'string') throw new Error('运行确认缺失')
        const runId = first.value.run_id
        const done = (async () => {
          try {
            while (true) {
              const next = await iterator.next()
              if (next.done) break
              if (next.value.type === 'final') {
                try { await drainReflections() }
                catch { /* 反思失败不能改变已经完成的主回答。 */ }
              }
            }
          }
          finally {
            try { await agent.close() }
            finally {
              if (running.get(sessionId)?.runId === runId) running.delete(sessionId)
              notify(sessionId, runId)
            }
          }
        })()
        runTasks.add(done)
        void done.finally(() => runTasks.delete(done)).catch(() => {})
        running.set(sessionId, { runId, cancel: () => agent.service.cancel(ownerId, sessionId), done })
        return first.value
      } catch (error) {
        await agent.close()
        throw error
      }
    },
    runModel,
    async respond(sessionId: number, runId: string, promptId: number, eventId: string,
      reply: { token: string; selectedOptionIds?: string[]; customAnswer?: string } | { text: string } | { secrets: Record<string, string> | null } | null, config: ProviderConfig, embedding?: RagQueryEmbeddingSettings) {
      if (responding.has(sessionId)) throw new CoreError('busy', '正在提交交互回复')
      responding.add(sessionId)
      try {
        const identity = { ownerId, sessionId: String(sessionId), runId }
        const secret = await loadSqliteAgentRunSecret(db, databasePath)
        const deliveries = createSubagentDeliveryStore(db, secret, undefined, 'sqlite')
        const delegated = await deliveries.findWaitingInteraction(identity, promptId)
        if (delegated) {
          const store = createSqliteAgentRunStore<CanonicalRunContext>(db, secret, { async writeHistory() {} })
          const child = await store.read(delegated.identity)
          if (child?.status !== 'waiting' || child.pending?.id !== delegated.interactionId)
            throw new CoreError('conflict', '子运行交互已失效')
          const result = await consumeSqliteInteraction(db, delegated.identity, promptId, reply, eventId,
            { id: delegated.interactionId, version: child.version },
            reply && 'secrets' in reply ? createDesktopMcpCrypto(databasePath).encrypt : undefined,
            async tx => (await deliveries.findWaitingInteraction(identity, promptId, tx))?.interactionId === delegated.interactionId)
          notify(sessionId, runId, true)
          if (result.resolution) scheduleAdmittedRuns(secret)
          return { runId, awaitingText: result.awaitingText }
        }
        const active = running.get(sessionId)
        if (active && active.runId !== runId) throw new CoreError('conflict', '会话运行已变更')
        const { agent, checkpoint, drainReflections } = await createRunRuntime(sessionId, config, embedding, true, identity,
          await runModel(sessionId, runId) ?? undefined)
        try {
          if (checkpoint?.status !== 'waiting' || !checkpoint.pending)
            throw new CoreError('conflict', '运行没有等待回复的交互')
          const outcome = await consumeSqliteInteraction(db, identity, promptId, reply, eventId, {
            id: checkpoint.pending.id, version: checkpoint.version,
          }, reply && 'secrets' in reply ? createDesktopMcpCrypto(databasePath).encrypt : undefined)
          if (!outcome.resolution) {
            await agent.close()
            return { runId, awaitingText: true }
          }
          await active?.done
          const resolution = outcome.resolution
          const iterator = agent.harness.resume(identity, resolution)
          try {
            let event = await iterator.next()
            while (!event.done && event.value.type !== 'final' && !(event.value.type === 'interaction_resolved'
              && event.value.payload.interactionId === resolution.interactionId))
              event = await iterator.next()
            if (event.done) throw new CoreError('conflict', '交互运行无法恢复')
          } catch (error) {
            await iterator.return(undefined as never)
            throw error
          }
          const done = (async () => {
            try {
              for await (const _event of iterator) { /* 驱动运行继续提交事件。 */ }
              try { await drainReflections() }
              catch { /* 反思失败不能改变已经完成的主回答。 */ }
            } catch (error) {
              await settleStoppedSqliteAgentRun(db, databasePath, identity)
              throw error
            } finally {
              try { await agent.close() }
              finally {
                if (running.get(sessionId)?.runId === runId) running.delete(sessionId)
                notify(sessionId, runId)
              }
            }
          })()
          running.set(sessionId, { runId, cancel: () => agent.service.cancel(ownerId, sessionId), done })
          runTasks.add(done)
          void done.finally(() => runTasks.delete(done)).catch(() => {})
          return { runId, awaitingText: false }
        } catch (error) {
          await agent.close()
          if (error instanceof InteractionConsumeError || error instanceof InteractionTextError)
            throw new CoreError('conflict', error.message)
          throw error
        }
      } finally { responding.delete(sessionId) }
    },
    async notifyCancel(sessionId: number, runId: string) {
      const run = running.get(sessionId)
      if (run?.runId === runId) await run.cancel()
      const identity = { ownerId, sessionId: String(sessionId), runId }
      await cancelChildren(identity)
      if (await settleCancelledSqliteSubagentWait(db, databasePath, identity)
        || await settleClosedSqliteInteraction(db, databasePath, identity))
        notify(sessionId, runId)
      // 等待中的父运行不占执行位，会话被占用时改由唤醒路径退避后结算。
      else scheduleSubagentWake(identity)
    },
  }
}
