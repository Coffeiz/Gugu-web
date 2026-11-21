import type { Kysely } from 'kysely'
import type { Database } from '../../data/schema.js'
import { formatAgentHistoryMessageTime } from '../context/history/time.js'
import { applySqliteAgentSnapshot } from '../context/sqlite-source.js'
import { createAgentChatService } from '../chat-service.js'
import type { AgentRunner, CanonicalRunContext } from '../models.js'
import { createAgentRuntime, type AgentRuntimeOptions } from '../runtime.js'
import { projectAgentRunEvent, type AgentRunEventProjection } from './event-projection.js'
import { createSqliteAgentAdmission } from './sqlite-admission.js'
import { writeSqliteAgentHistory } from './sqlite-history.js'
import { createSqliteAgentRunCoordination } from './sqlite-coordination.js'
import { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } from './sqlite-store.js'

interface SqliteAgentPersistenceOptions<C> {
  db: Kysely<Database>
  secret: string
  admission: NonNullable<Parameters<typeof createSqliteAgentAdmission>[1]>
  history: Parameters<typeof createSqliteAgentRunStore<C>>[2]
  projection: AgentRunEventProjection
}

/** 所有本机运行端口借用同一个 SQLite 连接，只在事务提交后唤醒订阅。 */
export function createSqliteAgentPersistence<C>(options: SqliteAgentPersistenceOptions<C>) {
  const store = createSqliteAgentRunStore<C>(options.db, options.secret, options.history)
  const leases = createSqliteAgentRunLeasePort(options.db)
  const coordination = createSqliteAgentRunCoordination(options.db, store)
  const admission = createSqliteAgentAdmission(options.db, options.admission)
  return {
    store,
    leases,
    cancellation: coordination.cancellation,
    events: coordination.events,
    createChat(harness: Pick<AgentRunner<C>, 'start' | 'cancel'>) {
      return createAgentChatService({
        ...admission,
        ...coordination,
        harness,
        project: event => projectAgentRunEvent(event, options.projection),
      })
    },
  }
}

export interface SqliteAgentRuntimeOptions extends Omit<SqliteAgentPersistenceOptions<CanonicalRunContext>, 'history'>,
  Omit<AgentRuntimeOptions, 'runtime'> {
  history?: Omit<SqliteAgentPersistenceOptions<CanonicalRunContext>['history'], 'writeHistory' | 'applyPreparedContext'>
  runtime: Omit<AgentRuntimeOptions['runtime'], 'store' | 'leases' | 'cancellation'>
}

/** 本机直连 Harness；调用方提供可信数据、模型、工具和交互端口。 */
export function createSqliteAgentRuntime(options: SqliteAgentRuntimeOptions) {
  const persistence = createSqliteAgentPersistence<CanonicalRunContext>({
    ...options, history: { ...options.history, applyPreparedContext: applySqliteAgentSnapshot, writeHistory: writeSqliteAgentHistory },
  })
  const agent = createAgentRuntime({
    observation: options.observation,
    context: {
      ...options.context,
      preparation: { ...options.context.preparation, formatMessageTime: formatAgentHistoryMessageTime },
    },
    runPreparation: options.runPreparation,
    executor: options.executor,
    provider: options.provider,
    runtime: {
      ...options.runtime,
      store: persistence.store,
      leases: persistence.leases,
      cancellation: persistence.cancellation,
      async publish(event, signal) {
        await options.runtime.publish(event, signal)
        await persistence.events.notify(event.identity)
      },
    },
  })
  return { ...agent, service: persistence.createChat(agent.harness) }
}
