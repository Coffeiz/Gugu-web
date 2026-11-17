import {
  configureRagJieba,
  createCalendarRagSource,
  createCanvasRagSource,
  createConversationRagSource,
  createKnowledgeRagSource,
  createMemoryRagSource,
  createNoteRagSource,
  createProjectRagSource,
  createScheduledTaskRagSource,
  createSqlRagRebuildWorker,
  enqueueMissingAgentRagBaselines,
  createSqlMemoryScopeStateReader,
} from '@gugu/core/agent'
import { createKyselyCalendarReadPort } from '@gugu/core/calendar'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { AgentKnowledgeReadStore } from '@gugu/core/agent'
import { createSqlMindCanvasReader, createSqlMindNoteReader } from '@gugu/core/mind'
import { createKyselyScheduledTaskRagReader } from '@gugu/core/scheduled-task-list'
import { startRagIndexWorker, type RagIndexWorkerOptions } from './rag-index-worker.js'
import { createLocalAgentMemoryRagStore } from './tools/agent-rag-memory-store.js'
import { createPostgresAgentMemoryIndexScopeReader } from './tools/agent-memory-index-scopes.js'
import { getAgentRagJieba } from './tools/agent-rag-jieba.js'

export type AgentRagIndexWorkerOwner = 'python' | 'node'

export function resolveAgentRagIndexWorkerOwner(value: string | undefined): AgentRagIndexWorkerOwner {
  if (value === undefined || value === '') return 'python'
  if (value === 'python' || value === 'node') return value
  throw new Error('Agent RAG Worker owner 配置无效')
}

/**
 * Production PostgreSQL source set for the persistent RAG index.
 * Every source delegates to a Core domain reader or an explicitly injected owner-bound
 * storage port. Memory indexing is enabled only with an injected storage root; its Host
 * cursor reader enumerates owner scopes for rebuilding and does not grant query access.
 * Knowledge is enabled only when Host injects its authorized FS reader.
 */
export function createAgentRagRebuildWorker(core: SqlDataRuntime, options: { knowledgeStore?: AgentKnowledgeReadStore; memoryStorageRoot?: string } = {}) {
  const memoryStore = options.memoryStorageRoot ? createLocalAgentMemoryRagStore(options.memoryStorageRoot) : undefined
  const sources = {
    project: createProjectRagSource(core),
    calendar: createCalendarRagSource(createKyselyCalendarReadPort(core.db, core.backend)),
    note: createNoteRagSource(createSqlMindNoteReader(core.db, core.backend)),
    scheduled_task: createScheduledTaskRagSource(createKyselyScheduledTaskRagReader(core.db, core.backend)),
    conversation: createConversationRagSource(core.db, core.backend),
    canvas: createCanvasRagSource(createSqlMindCanvasReader(core.db, core.backend)),
    ...(options.knowledgeStore ? { knowledge: createKnowledgeRagSource(options.knowledgeStore) } : {}),
    ...(memoryStore ? { memory: createMemoryRagSource({
      storage: memoryStore,
      scopeState: { getMemoryScopeState: createSqlMemoryScopeStateReader(core.db) },
      scopes: createPostgresAgentMemoryIndexScopeReader(core.db),
    }) } : {}),
  } as const
  const work = createSqlRagRebuildWorker(core.db, core.backend, sources)
  return { work, sources: Object.keys(sources) }
}

/** Host 生命周期入口：统一装配可用来源、持久 Worker 与单消费者调度器。 */
export function startAgentRagIndexWorker(core: SqlDataRuntime, options: Omit<RagIndexWorkerOptions, 'work'> & { knowledgeStore?: AgentKnowledgeReadStore; memoryStorageRoot?: string; workerOwner?: AgentRagIndexWorkerOwner }) {
  const { knowledgeStore, memoryStorageRoot, workerOwner: requestedOwner, ...schedulerOptions } = options
  const workerOwner = requestedOwner ?? resolveAgentRagIndexWorkerOwner(process.env.AGENT__RAG_INDEX_WORKER_OWNER)
  const { work, sources } = createAgentRagRebuildWorker(core, { knowledgeStore, memoryStorageRoot })
  // 索引分词与查询共用 1.7.7 Jieba；Worker 是独立生产入口，不能依赖 Agent 查询先初始化全局分词器。
  if (schedulerOptions.enabled && workerOwner === 'node') configureRagJieba(getAgentRagJieba())
  if (schedulerOptions.enabled && workerOwner === 'node') {
    const missing = (['knowledge', 'memory'] as const).filter(source => !sources.includes(source))
    if (missing.length) throw new Error('Node RAG Worker 来源未完整')
  }
  let baselineEnqueued = false
  const scheduler = startRagIndexWorker({
    ...schedulerOptions,
    enabled: schedulerOptions.enabled && workerOwner === 'node',
    work: async signal => {
      if (!baselineEnqueued) {
        await enqueueMissingAgentRagBaselines(core.db, core.backend, sources)
        baselineEnqueued = true
      }
      return work(signal)
    },
  })
  return { sources, workerOwner, stop: scheduler.stop }
}
