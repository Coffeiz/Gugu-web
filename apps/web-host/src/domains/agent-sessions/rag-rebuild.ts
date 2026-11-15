import {
  createCalendarRagSource,
  createCanvasRagSource,
  createConversationRagSource,
  createKnowledgeRagSource,
  createNoteRagSource,
  createProjectRagSource,
  createScheduledTaskRagSource,
  createSqlRagRebuildWorker,
  enqueueMissingAgentRagBaselines,
} from '@gugu/core/agent'
import { createKyselyCalendarReadPort } from '@gugu/core/calendar'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { AgentKnowledgeReadStore } from '@gugu/core/agent'
import { createSqlMindCanvasReader, createSqlMindNoteReader } from '@gugu/core/mind'
import { createKyselyScheduledTaskRagReader } from '@gugu/core/scheduled-task-list'
import { startRagIndexWorker, type RagIndexWorkerOptions } from './rag-index-worker.js'

/**
 * Production PostgreSQL source set for the persistent RAG index.
 * Every source delegates to a Core domain reader or an explicitly injected owner-bound
 * storage port. Memory remains omitted until its owner/group/member scope authorization
 * service is ready; knowledge is enabled only when Host injects its authorized FS reader.
 */
export function createAgentRagRebuildWorker(core: SqlDataRuntime, options: { knowledgeStore?: AgentKnowledgeReadStore } = {}) {
  const sources = {
    project: createProjectRagSource(core),
    calendar: createCalendarRagSource(createKyselyCalendarReadPort(core.db, core.backend)),
    note: createNoteRagSource(createSqlMindNoteReader(core.db, core.backend)),
    scheduled_task: createScheduledTaskRagSource(createKyselyScheduledTaskRagReader(core.db, core.backend)),
    conversation: createConversationRagSource(core.db, core.backend),
    canvas: createCanvasRagSource(createSqlMindCanvasReader(core.db, core.backend)),
    ...(options.knowledgeStore ? { knowledge: createKnowledgeRagSource(options.knowledgeStore) } : {}),
  } as const
  const work = createSqlRagRebuildWorker(core.db, core.backend, sources)
  return { work, sources: Object.keys(sources) }
}

/** Host 生命周期入口：统一装配可用来源、持久 Worker 与单消费者调度器。 */
export function startAgentRagIndexWorker(core: SqlDataRuntime, options: Omit<RagIndexWorkerOptions, 'work'> & { knowledgeStore?: AgentKnowledgeReadStore }) {
  const { knowledgeStore, ...schedulerOptions } = options
  const { work, sources } = createAgentRagRebuildWorker(core, { knowledgeStore })
  let baselineEnqueued = false
  const scheduler = startRagIndexWorker({
    ...schedulerOptions,
    work: async signal => {
      if (!baselineEnqueued) {
        await enqueueMissingAgentRagBaselines(core.db, core.backend, sources)
        baselineEnqueued = true
      }
      return work(signal)
    },
  })
  return { sources, stop: scheduler.stop }
}
