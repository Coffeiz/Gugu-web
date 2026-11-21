import { matchesScheduledGroup, readDesktopScheduledGroups, readHostedScheduledGroups } from '../scheduled-tasks/desktop-group-targets.js'
import { createKyselySqliteGlobalSearchSources } from '../search/sqlite.js'
import { desktopScheduleImDeliveryTargets, desktopScheduleImPlatforms, desktopScheduleImTarget, desktopScheduleImReminderVersion, type DesktopScheduleImTarget, ownsDesktopScheduleImTarget, readDesktopScheduleImTargets } from '../scheduled-tasks/desktop-im.js'
import { createGlobalSearchOperations } from '../search/global-search.js'
import { parseGlobalSearchQuery } from '../search/query.js'
import { createDesktopImProjectionTransfer } from './desktop-im-projection-transfer.js'
import { mergeSkillToolCatalog, projectSkillToolCatalog } from '../agent/skills/tool-catalog.js'
import { lstat, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createChatAttachmentDraftClearer } from '../agent/attachments/clear-drafts.js'
import { clearSqliteAgentMemory, forgetSqliteAgentMemory, readSqliteAgentMemory } from '../agent/memory/sqlite.js'
import { loadSqliteAgentRunSecret } from '../agent/run/sqlite-secret.js'
import { readDesktopImAttachmentReference, nextDesktopQqSequence, recordDesktopImGroupMessage, readDesktopImGroupAttentionHistory, resumeDesktopImPendingAsk, readPendingDesktopImConnection, desktopImProjection, rejectDesktopImEvent, desktopImPrompt, admitDesktopImEvent, prepareDesktopImEvent, updateDesktopImDelivery } from '../im/desktop-inbox.js'
import { DESKTOP_CALENDAR_UNDO_CONTEXT, MAX_AGENT_RESPONSE } from '../contracts/desktop.js'
import { createDesktopMemoryFiles } from '../agent/memory/desktop-files.js'
import { settleClosedSqliteInteraction } from '../agent/run/sqlite-recovery.js'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { compactDesktopConversation } from './desktop-manual-compaction.js'
import { createDesktopLoopScope } from './desktop-loopscope.js'
import type { DesktopAgentRuntimeModule } from './desktop-agent-port.js'
import type { RagQueryEmbeddingSettings } from '../agent/rag/query-embedding.js'
import type { ProviderConfig } from '../agent/providers/contracts.js'
import { createSqliteAgentAdmission } from '../agent/run/sqlite-admission.js'
import { createSqlAgentPendingQueue } from '../agent/sessions/pending-queue.js'
import { createDesktopAgentEventReader } from './desktop-agent-events.js'
import { AgentToolEventDetailsNotFoundError, AgentToolEventSessionNotFoundError, createSqlAgentToolEventDetails } from '../agent/sessions/tool-event-details.js'
import { appendDesktopAgentTurn, createDesktopAgentSession, deleteDesktopAgentSession, renameDesktopAgentSession, listDesktopAgentSessions, manageDesktopSessionGoal, manageDesktopSessionWorkspace, readDesktopAgentHistoryPage, readDesktopAgentMessages } from '../agent/sessions/desktop.js'
import { createAgentSessionApplication } from '../agent/sessions/application.js'
import { createSqlAgentSessionRepository } from '../agent/sessions/data.js'
import { object, safeInteger } from '../shared/values.js'
import { parentPort, workerData } from 'node:worker_threads'
import { dataContext, CoreError } from '../contracts/index.js'
import type { ErrorCode, Fields } from '../contracts/index.js'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../data/schema.js'
import { initializeSqlite, openSqliteRuntime } from '../data/sqlite.js'
import { execute, isMutation, validateCommandParams } from './commands.js'
import { applyUndoInTransaction, createRuntimeUndoTransactionPort, createUndoStateMachine, UndoError } from '../undo/state-machine.js'
import { createCalendarEvent, EventCreateError } from '../calendar/application/event-create.js'
import { createCalendarEventReader } from '../calendar/application/event-read.js'
import { createBorrowedCalendarCreateStore } from '../calendar/create-store.js'
import { createKyselyCalendarReadPort } from '../calendar/read-store.js'
import { createBorrowedKyselyCalendarMutationStores } from '../calendar/mutation-store.js'
import { updateCalendarEvent, EventUpdateError } from '../calendar/application/event-update.js'
import { deleteCalendarEvent, EventDeleteError } from '../calendar/application/event-delete.js'
import { createCalendarUndoAdapter } from '../calendar/undo-adapter.js'
import { createMindNoteCreator, MindNoteCreateError } from '../mind/note-create.js'
import { createSqlMindNoteReader } from '../mind/note-read.js'
import { createBorrowedSqlMindNoteInserter } from '../mind/note-postgres-sqlite.js'
import { createMindNoteMutations, MindNoteMutationError } from '../mind/note-mutations.js'
import { createSqlMindNoteMutator } from '../mind/note-mutations-sql.js'
import { createSqlMindCanvasReader } from '../mind/canvas-read.js'
import { createMindCanvasCreation, MindCanvasMutationError } from '../mind/canvas-create.js'
import { createSqlMindCanvasCreateRuntime } from '../mind/canvas-create-sql.js'
import { createMindCanvasUpdate } from '../mind/canvas-update.js'
import { createSqlMindCanvasUpdateRuntime } from '../mind/canvas-update-sql.js'
import { createMindCanvasDelete } from '../mind/canvas-delete.js'
import { createSqlMindCanvasDeleteRuntime } from '../mind/canvas-delete-sql.js'
import { createMindCanvasNoteMutations, MindCanvasNoteMutationError } from '../mind/canvas-note.js'
import { createSqlMindCanvasNoteRuntime } from '../mind/canvas-note-sql.js'
import { createMindCanvasItemUpdate } from '../mind/canvas-item-update.js'
import { createSqlMindCanvasItemUpdateRuntime } from '../mind/canvas-item-update-sql.js'
import { createMindCanvasItemRemove, MindCanvasItemMutationError } from '../mind/canvas-item-remove.js'
import { createSqlMindCanvasItemRemoveRuntime } from '../mind/canvas-item-remove-sql.js'
import { createPathFileCanvasNode } from '../mind/path-file-canvas.js'
import { createMindCanvasItemAdd } from '../mind/canvas-item-add.js'
import { createSqlMindCanvasItemAddRuntime } from '../mind/canvas-item-add-sql.js'
import { createMindCanvasRelationCreate, createMindCanvasRelationDelete } from '../mind/index.js'
import { createSqlMindCanvasRelationCreateRuntime } from '../mind/relation-create-sql.js'
import { createSqlMindCanvasRelationDeleteRuntime } from '../mind/relation-delete-canvas-sql.js'
import { createMindRefNodeCreator } from '../mind/ref-node-create.js'
import { createSqlMindRefNodeCreateRuntime } from '../mind/ref-node-create-sql.js'
import { desktopMcp, desktopSkills } from './desktop-resources.js'
import { createDesktopMcpAgentRuntime } from '../mcp/desktop-agent-runtime.js'
import { createNodeProviderTransport, desktopTransportOptions, type NodeProviderTransportOptions, type ProxyEndpoint } from '../agent/providers/transport/node.js'
import { filterConfiguredAgentTools } from '../agent/tools/configuration.js'
import { isAllowedDesktopAgentHostRequest } from './desktop-host-method-policy.js'
import { createDesktopMcpCrypto } from '../mcp/desktop-crypto.js'
import { desktopScheduledTaskId, desktopScheduledTasks } from '../scheduled-tasks/desktop.js'
import { createLocalPreferenceTextFiles } from '../preferences/text-files.js'
import { importDesktopBusinessArchive } from '../data-portability/desktop-import.js'
import { exportDesktopBusinessArchive } from '../data-portability/desktop-export.js'
import { readDesktopDataInventory } from '../data-portability/desktop-inventory.js'
import { buildDesktopGreetingPrompt } from './desktop-greeting.js'
import { readDesktopAgentUsage } from './desktop-agent-usage.js'
import { desktopAgentPreference } from '../preferences/desktop-agent.js'
import { createDesktopAppearanceService } from '../preferences/desktop-appearance.js'
import { purgeDesktopProject, setDesktopProjectDeleted } from '../projects/desktop-board.js'
import { projectResponse } from '../projects/project-projection.js'
import { projectRecord } from '../data/codec.js'
import { createKyselyPreferenceDocumentStore } from '../preferences/document-store.js'
import { createKyselyOnboardingStore } from '../onboarding/store.js'
import { createOnboardingService } from '../onboarding/service.js'
import { createDesktopChatAttachmentStore } from '../agent/attachments/desktop-store.js'

interface Job {
  id: number
  method: string
  params: Fields
  operationId?: string
  cancel: SharedArrayBuffer
  deadline: number
}
interface HostResponse {
  event: 'host_response'
  requestId: number
  result?: unknown
  error?: { code: ErrorCode; message: string }
}
const port = parentPort!
try {
  const config = workerData as {
    database: string
    initialize: boolean
    exclusive: boolean
    agentRuntimeModule?: string
  }
  if (config.initialize) await initializeSqlite(config.database)
  const { runtime, ownerId, schemaVersion } = await openSqliteRuntime(config.database, {
    exclusive: config.exclusive,
  })
  const context = dataContext(ownerId)
  const desktopSearch = createGlobalSearchOperations(
    createKyselySqliteGlobalSearchSources(runtime.db).filter(source => source.type !== 'client'),
  )
  const transferImProjection = createDesktopImProjectionTransfer()
  let hostRequestSequence = 0
  const pendingHostRequests = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }>()
  const hostRequest = (method: string, params: Fields, signal?: AbortSignal): Promise<unknown> => {
    if (!isAllowedDesktopAgentHostRequest(method))
      return Promise.reject(new CoreError('invalid_request', '桌面 Agent 宿主能力未开放'))
    signal?.throwIfAborted()
    const requestId = ++hostRequestSequence
    const timeoutMs = method === 'agent.search.deep_research' || method === 'agent.search.similar_image_search'
      ? 120_000
      : 15_000
    return new Promise((resolve, reject) => {
      const finish = () => {
        pendingHostRequests.delete(requestId)
        signal?.removeEventListener('abort', abort)
        clearTimeout(timer)
      }
      const cancelHost = () => {
        finish()
        try { port.postMessage({ event: 'host_cancel', requestId }) } catch { /* 宿主通道已关闭。 */ }
      }
      const abort = () => { cancelHost(); reject(new CoreError('cancelled', '操作已取消')) }
      const timer = setTimeout(() => {
        cancelHost()
        reject(new CoreError('storage_error', '桌面 Agent 宿主能力响应超时'))
      }, timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', abort, { once: true })
      pendingHostRequests.set(requestId, { resolve, reject, cleanup: finish })
      try {
        port.postMessage({ event: 'host_request', requestId, method, params })
      } catch {
        finish()
        reject(new CoreError('storage_error', '桌面 Agent 宿主请求无法传输'))
      }
    })
  }
  const memoryRoot = config.exclusive ? process.env.GUGU_DESKTOP_MEMORY_ROOT : undefined
  const memoryFiles = memoryRoot ? createDesktopMemoryFiles(runtime.db, memoryRoot, ownerId) : undefined
  await memoryFiles?.initialize()
  const notifyAgentRunChanged = (sessionId: number, runId: string) => {
    port.postMessage({ event: 'agent_run_changed', sessionId, runId })
  }
  const loopScope = config.exclusive ? createDesktopLoopScope(process.env, runtime.db, ownerId) : undefined
  const agentModule: unknown = config.agentRuntimeModule
    ? await import(pathToFileURL(resolve(config.agentRuntimeModule)).href)
    : undefined
  if (config.agentRuntimeModule && (!agentModule || typeof agentModule !== 'object'
    || !('createDesktopAgentRuns' in agentModule) || typeof agentModule.createDesktopAgentRuns !== 'function'
    || !('DesktopAgentCoreError' in agentModule) || typeof agentModule.DesktopAgentCoreError !== 'function'))
    throw new CoreError('storage_error', '桌面 Agent 运行模块无效')
  const desktopAgent = agentModule as DesktopAgentRuntimeModule | undefined
  const agentRuns = desktopAgent
    ? desktopAgent.createDesktopAgentRuns(runtime, config.database, ownerId,
      notifyAgentRunChanged, hostRequest, memoryFiles, loopScope?.observation,
      join(dirname(config.agentRuntimeModule!), '../agent-prompts'))
    : undefined
  const scheduledRuns = new Map<number, { result: { text: string; status: 'success' | 'failed' } | null; expiresAt: number }>()
  const scheduledImReminderClaims = new Map<number, { fireAt: number; version: string }>()
  function pruneScheduledRuns() {
    const now = Date.now()
    for (const [id, run] of scheduledRuns) {
      if (run.expiresAt <= now) scheduledRuns.delete(id)
    }
  }
  const agentAdmission = createSqliteAgentAdmission(runtime.db)
  async function builtinSkillTools() {
    if (!agentRuns) throw new CoreError('invalid_request', '当前 Core Worker 未装配桌面 Agent')
    const catalog = await agentRuns.listBuiltinTools()
    const policy = await hostRequest('agent.tools.policy', {}) as { disabledTools?: unknown }
    if (!Array.isArray(policy?.disabledTools) || policy.disabledTools.some(name => typeof name !== 'string'))
      throw new CoreError('storage_error', '桌面 Agent 工具策略无效')
    const disabled = new Set(policy.disabledTools as string[])
    const allowed = new Set(filterConfiguredAgentTools(catalog.map(tool => tool.name)).filter(name => !disabled.has(name)))
    return projectSkillToolCatalog(catalog.filter(tool => allowed.has(tool.name)))
  }
  async function settleSessionInteraction(sessionId: number) {
    const { identity } = await agentAdmission.active(ownerId, sessionId) ?? {}
    if (identity && await settleClosedSqliteInteraction(runtime.db, config.database, identity))
      notifyAgentRunChanged(sessionId, identity.runId)
  }
  const pendingQueue = createSqlAgentPendingQueue(runtime.db, 'sqlite', {
    async isSessionActive(sessionId, tx) {
      const active = await createSqliteAgentAdmission(tx as unknown as Transaction<Database>).active(ownerId, sessionId)
      return Boolean(active?.identity) || active?.executionState === 'baseline_updating'
    },
  })
  const agentSessions = createAgentSessionApplication(createSqlAgentSessionRepository(runtime.db, 'sqlite'))
  const readAgentEvents = createDesktopAgentEventReader(runtime.db, config.database, ownerId)
  const readToolDetails = createSqlAgentToolEventDetails(runtime.db, 'sqlite')
  const mcpCrypto = createDesktopMcpCrypto(config.database)
  port.postMessage({ event: 'ready', ownerId, schemaVersion })
  const compactions = new Map<string, {
    runId: string
    sessionId: number
    clientId: string
    controller: AbortController
    done: Promise<void>
    result?: { text: string; userMessageId: number } | CoreError
  }>()
  function readCompactionEvents(id: number, runId: string | undefined, after: number, stateOnly: boolean) {
    const entry = runId ? compactions.get(runId) : [...compactions.values()].find(item => item.sessionId === id && !item.result)
    if (!entry || entry.sessionId !== id) return undefined
    const result = entry.result
    const status = !result ? 'running' : result instanceof CoreError
      ? result.code === 'cancelled' ? 'cancelled' : 'failed' : 'completed'
    const events: { type: string; [key: string]: unknown }[] = [
      { type: '_context_compaction', phase: 'started', reason: 'manual_compact' },
    ]
    if (result) {
      if (!(result instanceof CoreError))
        events.push({ type: 'session_id', session_id: id, user_message_id: result.userMessageId, client_message_id: entry.clientId })
      events.push({ type: '_context_compaction', phase: 'completed', reason: 'manual_compact' })
      if (result instanceof CoreError) {
        if (status === 'cancelled') events.push({ type: 'done', interrupted: true, cancelled: true })
        else events.push({ type: 'error', message: result.message })
      } else {
        events.push({ type: 'content', text: result.text }, { type: 'done' })
      }
    }
    return { runId: entry.runId, status, cursor: events.length, events: stateOnly ? [] : events.slice(after), hasMore: false,
      executionState: result ? 'idle' : 'baseline_updating' }
  }
  let queue = Promise.resolve()
  let startupRecovery: Promise<void> | undefined
  function recoverStartup() {
    if (!config.exclusive || !agentRuns) return
    if (!startupRecovery) {
      startupRecovery = agentRuns.reconcileInterruptedRuns().catch(error => {
        startupRecovery = undefined
        throw error
      })
    }
    return startupRecovery
  }
  port.on('message', (message: Job | HostResponse) => {
    if ('event' in message) {
      if (message.event !== 'host_response') return
      const pending = pendingHostRequests.get(message.requestId)
      if (!pending) return
      pending.cleanup()
      if (message.error) pending.reject(new CoreError(message.error.code, message.error.message))
      else pending.resolve(message.result)
      return
    }
    const job = message
    let cancellationPoll: NodeJS.Timeout | undefined
    queue = queue.then(async () => {
      try {
        if (job.method === 'runtime.close') {
          for (const operation of compactions.values()) operation.controller.abort()
          await Promise.allSettled([...compactions.values()].map(operation => operation.done))
          try { await agentRuns?.close() } finally { await loopScope?.close() }
          await runtime.close()
          port.postMessage({ id: job.id, result: null })
          port.close()
          return
        }
        const flag = new Int32Array(job.cancel)
        const cancellation = new AbortController()
        const abortIfCancelled = () => {
          if (!cancellation.signal.aborted && (Atomics.load(flag, 0) !== 0 || Date.now() >= job.deadline))
            cancellation.abort(new CoreError('cancelled', '操作已取消'))
        }
        const signal = cancellation.signal
        abortIfCancelled()
        cancellationPoll = setInterval(abortIfCancelled, 25)
        cancellationPoll.unref()
        if (signal.aborted) throw new CoreError('cancelled', '操作已取消')
        if (!agentRuns && job.method.startsWith('agent.'))
          throw new CoreError('invalid_request', '当前 Core Worker 未装配桌面 Agent')
        let result: unknown
        if (job.method === 'im.inbox.admit') {
          validateCommandParams(job.method, job.params)
          result = await admitDesktopImEvent(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.inbox.attachmentReference') {
          validateCommandParams(job.method, job.params)
          result = await readDesktopImAttachmentReference(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.inbox.recordGroup') {
          validateCommandParams(job.method, job.params)
          result = await recordDesktopImGroupMessage(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.inbox.groupAttentionHistory') {
          validateCommandParams(job.method, job.params)
          result = await readDesktopImGroupAttentionHistory(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.inbox.resumePendingAsk') {
          validateCommandParams(job.method, job.params)
          result = await resumeDesktopImPendingAsk(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.inbox.pendingConnection') {
          validateCommandParams(job.method, job.params)
          result = await readPendingDesktopImConnection(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.inbox.prepare') {
          validateCommandParams(job.method, job.params)
          result = await prepareDesktopImEvent(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.inbox.reject') {
          validateCommandParams(job.method, job.params)
          result = await rejectDesktopImEvent(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.inbox.prompt') {
          validateCommandParams(job.method, job.params)
          result = await desktopImPrompt(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.chart.render') {
          validateCommandParams(job.method, job.params)
          const { type, source } = job.params
          if ((type !== 'mermaid' && type !== 'math') || typeof source !== 'string' || !source || source.length > 20_000)
            throw new CoreError('invalid_request', '图表渲染参数无效')
          const { renderCharts } = await import('@gugu/charts/render')
          const [png] = await renderCharts({ charts: [{ type, source }] },
            { signal: AbortSignal.timeout(Math.max(1, Math.min(9_000, job.deadline - Date.now() - 500))) })
          result = png && png.byteLength <= Math.floor((MAX_AGENT_RESPONSE - 512) * 3 / 4)
            ? png.toString('base64') : null
        } else if (job.method === 'im.qq.sequence') {
          validateCommandParams(job.method, job.params)
          result = await nextDesktopQqSequence(runtime.db, ownerId, job.params)
        } else if (job.method === 'im.inbox.projection') {
          validateCommandParams(job.method, job.params)
          const fields = transferImProjection(job.params)
          result = fields ? await desktopImProjection(runtime.db, ownerId, fields) : null
        } else if (job.method === 'im.inbox.delivery') {
          validateCommandParams(job.method, job.params)
          result = await updateDesktopImDelivery(runtime.db, ownerId, job.params)
        } else if (job.method === 'agent.greeting.prompt') {
          validateCommandParams(job.method, job.params)
          const { locale } = job.params
          if (locale !== 'zh-CN' && locale !== 'ja-JP' && locale !== 'en-US')
            throw new CoreError('invalid_request', '问候语言无效')
          result = await buildDesktopGreetingPrompt(runtime.db, ownerId, locale, signal, memoryFiles)
        } else if (job.method === 'agent.memory.read') {
          validateCommandParams(job.method, job.params)
          const { memory } = await readSqliteAgentMemory(runtime.db, ownerId, '', AbortSignal.timeout(5000), undefined, memoryFiles)
          result = { text: [memory.profile, memory.pattern, memory.memory].filter(Boolean).join('\n\n').trim().slice(0, 6000) }
        } else if (job.method === 'agent.memory.clear') {
          validateCommandParams(job.method, job.params)
          await clearSqliteAgentMemory(runtime.db, ownerId, memoryFiles)
          agentRuns?.invalidateEmbedding()
          result = null
        } else if (job.method === 'agent.memory.forget') {
          validateCommandParams(job.method, job.params)
          result = await forgetSqliteAgentMemory(runtime.db, ownerId, (job.params.query as string).trim(),
            job.params.revision as string | undefined, memoryFiles)
        } else if (job.method === 'agent.memory.resumeReflections') {
          validateCommandParams(job.method, job.params)
          await recoverStartup()
          agentRuns?.resumeReflections()
          result = null
        } else if (job.method === 'agent.memory.invalidateEmbedding') {
          validateCommandParams(job.method, job.params)
          agentRuns?.invalidateEmbedding()
          result = null
        } else if (job.method.startsWith('agent.attachments.')) {
          validateCommandParams(job.method, job.params)
          const attachments = createDesktopChatAttachmentStore(runtime.db)
          if (job.method === 'agent.attachments.stage')
            result = await attachments.stage(ownerId, job.params.attachment as Parameters<typeof attachments.stage>[1])
          else if (job.method === 'agent.attachments.deleteDraft') result = await attachments.deleteDraft(ownerId, job.params.attach_id as string)
          else if (job.method === 'agent.attachments.clearDrafts') {
            const root = join(dirname(config.database), 'agent-attachments')
            const clearDrafts = createChatAttachmentDraftClearer({
              deleteDraftRows: attachments.deleteDraftRows,
              async removeUnreferenced(_ownerId, key) {
                // SQLite 约束保证 storage_key 唯一，并且只能指向对应附件 ID。
                if (!/^agent-attachments\/[0-9a-f]{32}$/.test(key)) return false
                const directory = await lstat(root).catch((error: NodeJS.ErrnoException) => {
                  if (error.code === 'ENOENT') return null
                  throw error
                })
                if (!directory?.isDirectory() || directory.isSymbolicLink()) return false
                await rm(join(await realpath(root), key.slice('agent-attachments/'.length)), { force: true })
                return true
              },
              clearLegacy: async () => 0,
            })
            result = await clearDrafts(ownerId)
          }
          else if (job.method === 'agent.attachments.download') result = await attachments.download(ownerId, job.params.attach_id as string)
          else result = await attachments.forSession(ownerId, safeInteger(job.params.id))
        } else if (job.method.startsWith('agent.sessions.')) {
          validateCommandParams(job.method, job.params)
          await recoverStartup()
          switch (job.method) {
            case 'agent.sessions.recoverStartup':
              result = null
              break
            case 'agent.sessions.compact': {
              const id = safeInteger(job.params.id)
              if ([...compactions.values()].some(operation => operation.sessionId === id && !operation.result))
                throw new CoreError('busy', '当前会话正在整理上下文')
              if (compactions.size >= 32) {
                const completed = [...compactions].find(([, operation]) => operation.result)
                if (!completed) throw new CoreError('busy', '当前摘要任务过多')
                compactions.delete(completed[0])
              }
              const operationId = randomUUID()
              const controller = new AbortController()
              const preferences = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(runtime.db, 'sqlite')).get(ownerId)
              const resolveProxy: NodeProviderTransportOptions['resolveProxy'] = preferences.useSystemProxy
                ? async (url, signal) => (await hostRequest('network.resolveProxy', { origin: url.origin }, signal) as ProxyEndpoint | null) ?? undefined
                : undefined
              const done = compactDesktopConversation(runtime.db, ownerId, id, job.params.model as ProviderConfig, {
                text: job.params.text as string, clientId: job.params.clientId as string,
                queueClaim: job.params.queueClaim as { key: number; token: string } | undefined,
              }, operationId, controller.signal, resolveProxy)
                .catch((error: unknown) => controller.signal.aborted ? new CoreError('cancelled', '操作已取消')
                  : error instanceof CoreError ? error : new CoreError('storage_error', '这次压缩没有完成，请稍后再试。'))
                .then(value => {
                  const operation = compactions.get(operationId)
                  if (operation) operation.result = value
                  notifyAgentRunChanged(id, operationId)
                  setTimeout(() => compactions.delete(operationId), 60_000).unref()
                })
              compactions.set(operationId, { runId: operationId, sessionId: id, clientId: job.params.clientId as string, controller, done })
              notifyAgentRunChanged(id, operationId)
              result = { operation: operationId }
              break
            }
            case 'agent.sessions.goal': {
              const id = safeInteger(job.params.id)
              const { text, interruptRunId } = await manageDesktopSessionGoal(runtime.db, ownerId, id,
                job.params.action as 'status' | 'pause' | 'cancel' | 'resume')
              if (interruptRunId) await agentRuns!.notifyCancel(id, interruptRunId)
              result = { text }
              break
            }
            case 'agent.sessions.list':
              result = await listDesktopAgentSessions(runtime.db, ownerId)
              break
            case 'agent.sessions.workspace':
              result = await manageDesktopSessionWorkspace(runtime.db, ownerId, safeInteger(job.params.id),
                job.params.action as 'list' | 'show', undefined,
                () => hostRequest('agent.files.workspaceList', {}))
              break
            case 'agent.sessions.setWorkspace':
              if (!job.operationId) throw new CoreError('invalid_request', '工作区绑定缺少操作标识')
              result = (await runtime.operationWithTransaction(context, job.operationId, job.method, job.params,
                tx => manageDesktopSessionWorkspace(tx, ownerId, safeInteger(job.params.id),
                  job.params.action as 'bind' | 'unlink', job.params.directoryId,
                  () => hostRequest('agent.files.workspaceList', {})), { signal })).result
              break
            case 'agent.sessions.queue': {
              const action = job.params.action
              if (action === 'read') result = await pendingQueue.readQueue(ownerId, job.params.queue_id as string)
              else if (action === 'imports') result = await pendingQueue.readImportedDrafts(ownerId)
              else if (action === 'replace') {
                await pendingQueue.replaceDraft(ownerId, job.params.queue_id as string, job.params.items as Record<string, unknown>[])
                result = null
              } else if (action === 'patch') {
                await pendingQueue.patch(ownerId, job.params.queue_id as string, safeInteger(job.params.session_id),
                  job.params.items as Record<string, unknown>[], job.params.removed_keys as number[])
                result = null
              }
              else if (action === 'claim') {
                const sessionId = safeInteger(job.params.session_id)
                await settleSessionInteraction(sessionId)
                result = await pendingQueue.claim(ownerId, sessionId, job.params.queue_id as string, safeInteger(job.params.key))
              } else result = await pendingQueue.release(ownerId, safeInteger(job.params.session_id),
                job.params.queue_id as string, safeInteger(job.params.key), job.params.claim_token as string)
              break
            }
            case 'agent.sessions.messages':
              result = await readDesktopAgentMessages(runtime.db, ownerId, safeInteger(job.params.id))
              break
            case 'agent.sessions.messageLocation':
              result = await agentSessions.locate(ownerId, safeInteger(job.params.messageId))
              if (!result) throw new CoreError('not_found', '消息不存在')
              break
            case 'agent.sessions.history': {
              const sessionId = safeInteger(job.params.id)
              const before = job.params.before === undefined ? undefined : safeInteger(job.params.before)
              if (before === undefined) await settleSessionInteraction(sessionId)
              result = await readDesktopAgentHistoryPage(runtime.db, ownerId, sessionId, before,
                () => loadSqliteAgentRunSecret(runtime.db, config.database))
              break
            }
            case 'agent.sessions.toolDetails':
              try {
                result = await readToolDetails(ownerId, safeInteger(job.params.id), safeInteger(job.params.messageId),
                  safeInteger(job.params.index, 0))
              } catch (error) {
                if (error instanceof AgentToolEventDetailsNotFoundError || error instanceof AgentToolEventSessionNotFoundError)
                  throw new CoreError('not_found', error.message)
                throw error
              }
              break
            case 'agent.sessions.startRun':
              result = await agentRuns!.start(safeInteger(job.params.id), job.params.text as string,
                job.params.clientId as string, job.params.model as ProviderConfig, job.params.embedding as RagQueryEmbeddingSettings | undefined,
                job.params.interactive === true, job.params.modelId as string | undefined,
                job.params.attachments as string[] | undefined, job.params.references as import('../contracts/desktop.js').DesktopAgentChatReference[] | undefined,
                job.params.queueClaim as { key: number; token: string } | undefined, job.params.locale as string | undefined,
                job.params.groupSender as import('../agent/run/sqlite-admission.js').DesktopGroupSender | undefined,
                job.params.resumePassiveMessage === true)
              break
            case 'agent.sessions.runModel':
              result = await agentRuns!.runModel(safeInteger(job.params.id), job.params.runId as string)
              break
            case 'agent.sessions.respond':
              result = await agentRuns!.respond(safeInteger(job.params.id), job.params.runId as string,
                safeInteger(job.params.promptId), typeof job.params.eventId === 'string' ? job.params.eventId : '',
                typeof job.params.token === 'string' ? { token: job.params.token, selectedOptionIds: job.params.selectedOptionIds as string[] | undefined, customAnswer: job.params.customAnswer as string | undefined }
                  : typeof job.params.text === 'string' ? { text: job.params.text }
                    : Object.hasOwn(job.params, 'secrets') ? { secrets: job.params.secrets as Record<string, string> | null } : null,
                job.params.model as ProviderConfig, job.params.embedding as RagQueryEmbeddingSettings | undefined)
              break
            case 'agent.sessions.cancelRun': {
              const id = safeInteger(job.params.id), runId = job.params.runId as string
              const compaction = compactions.get(runId)
              if (compaction?.sessionId === id && !compaction.result) {
                compaction.controller.abort()
                result = { ok: true, outcome: 'requested' }
                break
              }
              const cancelled = await agentAdmission.requestCancel(ownerId, id, runId)
              if (cancelled.outcome === 'requested') await agentRuns!.notifyCancel(id, runId)
              result = cancelled
              break
            }
            case 'agent.sessions.events': {
              const id = safeInteger(job.params.id), runId = job.params.runId as string | undefined
              const after = job.params.after === undefined ? 0 : safeInteger(job.params.after, 0)
              result = readCompactionEvents(id, runId, after, job.params.stateOnly === true)
                ?? await readAgentEvents(id, runId, after, job.params.stateOnly === true, job.params.imDelivery === true, job.params.imStream === true)
              break
            }
            case 'agent.sessions.append': {
              if (!job.operationId) throw new CoreError('invalid_request', '保存对话缺少操作标识')
              const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params,
                tx => appendDesktopAgentTurn(tx, ownerId, safeInteger(job.params.id), job.params.text, job.params.reply, job.operationId), { signal })
              result = outcome.result
              break
            }
            case 'agent.sessions.create': {
              if (!job.operationId) throw new CoreError('invalid_request', '创建会话必须提供稳定操作标识')
              const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params,
                tx => createDesktopAgentSession(tx, ownerId, job.params.title, job.params.greeting), { signal })
              result = outcome.result
              break
            }
            case 'agent.sessions.rename':
            case 'agent.sessions.delete': {
              if (!job.operationId) throw new CoreError('invalid_request', '会话操作缺少操作标识')
              const id = safeInteger(job.params.id)
              const outcome = await runtime.operationWithTransaction<unknown>(context, job.operationId, job.method, job.params,
                tx => job.method === 'agent.sessions.rename'
                  ? renameDesktopAgentSession(tx, ownerId, id, job.params.title)
                  : deleteDesktopAgentSession(tx, ownerId, id), { signal })
              result = outcome.result
              break
            }
            default: throw new CoreError('invalid_request', '会话操作无效')
          }
        } else if (/^(skills|mcp)\./.test(job.method)) {
          validateCommandParams(job.method, job.params)
          const id = job.params.id as string
          switch (job.method) {
            case 'skills.list':
              result = await desktopSkills(runtime.db, ownerId).list(Number(job.params.offset ?? 0))
              break
            case 'skills.tools': {
              const preferences = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(runtime.db, 'sqlite')).get(ownerId)
              const resolveProxy: NodeProviderTransportOptions['resolveProxy'] = preferences.useSystemProxy
                ? async (url, signal) => (await hostRequest('network.resolveProxy', { origin: url.origin }, signal) as ProxyEndpoint | null) ?? undefined
                : undefined
              const directory = createDesktopMcpAgentRuntime(runtime.db, ownerId, mcpCrypto, {
                transport: () => createNodeProviderTransport({ ...desktopTransportOptions(false, resolveProxy),
                  connectTimeoutMs: 10_000, writeTimeoutMs: 10_000 }),
                // MCP 工具使用专用前缀，内置工具不占用这个命名空间。
                builtinNames: async () => new Set(),
              })
              const [builtins, registered] = await Promise.all([builtinSkillTools(), directory.directory(ownerId)])
              const allowed = new Set(filterConfiguredAgentTools(registered.map(tool => tool.name)))
              const tools = mergeSkillToolCatalog(builtins, registered.filter(tool => allowed.has(tool.name)))
              const offset = Number(job.params.offset ?? 0)
              const page = tools.slice(offset, offset + 16)
              result = { tools: page, nextOffset: offset + page.length < tools.length ? offset + page.length : null }
              break
            }
            case 'mcp.list':
              result = await desktopMcp(runtime.db, ownerId, mcpCrypto).list(job.params.offset == null ? undefined : Number(job.params.offset))
              break
            case 'mcp.config':
              result = await desktopMcp(runtime.db, ownerId, mcpCrypto).config(id)
              break
            default: {
              if (!job.operationId) throw new CoreError('invalid_request', '资源写入必须提供稳定操作标识')
              const fields = job.params.fields
              const related = fields && typeof fields === 'object' && 'related_tools' in fields ? fields.related_tools : undefined
              const builtinNames = job.method.startsWith('skills.') && Array.isArray(related)
                && related.some(name => typeof name === 'string' && !name.startsWith('mcp_'))
                ? new Set((await builtinSkillTools()).map(tool => tool.name)) : undefined
              const outcome = await runtime.operationWithTransaction<unknown>(context, job.operationId, job.method, job.params, tx => {
                const resources = job.method.startsWith('skills.')
                  ? desktopSkills<Database>(tx, ownerId, builtinNames)
                  : desktopMcp<Database>(tx, ownerId, mcpCrypto)
                if (job.method.endsWith('.delete')) return resources.remove(id)
                return resources.write(id, job.params.fields)
              }, { signal })
              result = outcome.result
            }
          }
        } else if (job.method.startsWith('schedules.')) {
          validateCommandParams(job.method, job.params)
          const eventId = job.params.eventId === undefined ? null : desktopScheduledTaskId(job.params.eventId)
          async function scheduledGroups(platform: string, hosted = true, database: Kysely<Database> = runtime.db) {
            if (platform !== 'qq' && platform !== 'feishu' && platform !== 'telegram') return []
            const local = await readDesktopScheduledGroups<Database>(database, ownerId, platform,
              receipt => hostRequest('agent.schedules.im.decodeGroup', receipt, signal))
            if (!hosted) return local
            const remote = await readHostedScheduledGroups(platform,
              () => hostRequest('agent.schedules.im.groupCatalog', { platform }, signal))
            return [...local, ...remote]
          }
          async function ownsScheduledTarget(target: DesktopScheduleImTarget) {
            if (await ownsDesktopScheduleImTarget(runtime.db, ownerId, target)) return true
            return (await scheduledGroups(target.platform)).some(entry => matchesScheduledGroup(entry.target, target))
          }
          if (job.method === 'schedules.groupCatalog') {
            result = await scheduledGroups(String(job.params.platform), false)
          } else if (job.method === 'schedules.targets') {
            const platform = String(job.params.platform)
            const groups = await scheduledGroups(platform)
            const choices = new Map(groups.map(entry => [entry.target.recipient, {
              chat_id: entry.target.recipient,
              title: entry.title === '即时通讯' ? entry.target.recipient : entry.title,
            }]))
            result = { groups: [...choices.values()], private_available: desktopScheduleImPlatforms.some(value => value === platform)
              && Boolean(await hostRequest('agent.schedules.im.privateTarget', { platform }, signal)) }
          } else if (job.method === 'schedules.channels') {
            const available = await Promise.all(desktopScheduleImPlatforms.map(async platform =>
              await hostRequest('agent.schedules.im.privateTarget', { platform }, signal) ? platform : null))
            result = { channels: available.filter(Boolean) }
          } else if (job.method === 'schedules.list') result = await desktopScheduledTasks(runtime.db, ownerId).list(job.params.before as number | undefined, eventId)
          else if (job.method === 'schedules.claim') {
            pruneScheduledRuns()
            const now = Date.now()
            const claims = await runtime.db.transaction().execute(tx => desktopScheduledTasks<Database>(tx, ownerId).claim(now, new Set(scheduledRuns.keys())))
            for (const [id, claim] of scheduledImReminderClaims) {
              if (claim.fireAt < now - 120_000) scheduledImReminderClaims.delete(id)
            }
            result = claims.map(claim => {
              if (claim.mode !== 'reminder' || !claim.imDelivery) return claim
              const { fireAt, version, desktop } = claim.imDelivery
              scheduledImReminderClaims.set(claim.id, { fireAt, version })
              return { ...claim, imDelivery: { fireAt, desktop } }
            })
          } else if (job.method === 'schedules.instruction.start') {
            if (!agentRuns) throw new CoreError('conflict', '桌面 Agent 未启动')
            const id = desktopScheduledTaskId(job.params.id)
            const fireAt = job.params.fireAt as number | undefined
            pruneScheduledRuns()
            if (scheduledRuns.has(id)) throw new CoreError('busy', '此定时任务正在执行')
            if (scheduledRuns.size >= 16) throw new CoreError('busy', '定时任务正在执行，请稍后再试')
            const tasks = desktopScheduledTasks(runtime.db, ownerId)
            const task = await tasks.get(id)
            const assertLease = () => tasks.assertInstructionCurrent(id, task, fireAt)
            await assertLease()
            const run: NonNullable<ReturnType<typeof scheduledRuns.get>> = { result: null, expiresAt: Infinity }
            scheduledRuns.set(id, run)
            void (async () => {
              try {
                const targets = readDesktopScheduleImTargets(task.delivery_targets, task.channels)
                const group = targets.find(target => target.chatType === 'group')
                if (!(await Promise.all(targets.map(ownsScheduledTarget))).every(Boolean))
                  throw new CoreError('conflict', '定时任务的 IM 会话已不可用')
                const outcome = await agentRuns.runScheduledInstruction({
                  id: String(id), ownerId, name: task.name, payload: task.payload, executionMode: 'instruction',
                  channels: task.channels, deliveryTargets: desktopScheduleImDeliveryTargets(targets),
                  ...(group ? { groupScope: {
                    ownerId, platform: group.platform, botId: group.botId, scopeType: 'group', scopeId: group.recipient,
                  } } : {}),
                  authorizedTools: [], emailAttachmentFileIds: [],
                  workspaceId: null, filesystemGrantId: null,
                }, fireAt === undefined, assertLease)
                run.result = { ...outcome, text: outcome.text.slice(0, 4000) }
              } catch (error) {
                run.result = { status: 'failed', text: error instanceof CoreError && error.code === 'invalid_request'
                  ? error.message : '定时任务指令执行失败，请检查任务和默认对话模型' }
              } finally {
                const failed = run.result?.status !== 'success'
                if (fireAt !== undefined) await tasks.finishInstruction(id, fireAt, failed)
                run.expiresAt = Date.now() + 60_000
              }
            })().catch(() => { scheduledRuns.delete(id) })
            result = null
          } else if (job.method === 'schedules.instruction.result') {
            const id = desktopScheduledTaskId(job.params.id)
            const run = scheduledRuns.get(id)
            if (!run) throw new CoreError('not_found', '定时任务执行记录已失效')
            result = Number.isFinite(run.expiresAt) ? run.result : null
            if (result) scheduledRuns.delete(id)
          } else if (job.method === 'schedules.reminder.deliverIm') {
            const id = desktopScheduledTaskId(job.params.id)
            const fireAt = job.params.fireAt as number | undefined
            const tasks = desktopScheduledTasks(runtime.db, ownerId)
            const task = await tasks.get(id)
            const targets = readDesktopScheduleImTargets(task.delivery_targets, task.channels)
            if (task.execution_mode !== 'reminder' || !targets.length
              || !(await Promise.all(targets.map(ownsScheduledTarget))).every(Boolean)
              || fireAt !== undefined && (!task.last_run_at || Date.parse(task.last_run_at) !== fireAt
                || !task.enabled && task.schedule_kind !== 'once'))
              throw new CoreError('conflict', '定时任务的 IM 投递目标已失效')
            if (fireAt !== undefined) {
              const claim = scheduledImReminderClaims.get(id)
              if (claim?.fireAt !== fireAt || claim.version !== desktopScheduleImReminderVersion(task, targets))
                throw new CoreError('conflict', '定时任务提醒认领已失效')
              scheduledImReminderClaims.delete(id)
            }
            for (const target of targets) {
              const latest = await tasks.get(id)
              if (JSON.stringify(latest) !== JSON.stringify(task)) throw new CoreError('conflict', '定时任务已变更')
              if (!await ownsScheduledTarget(target))
                throw new CoreError('conflict', '定时任务的 IM 会话已不可用')
              await hostRequest('agent.schedules.im.deliver', { target, text: task.payload }, AbortSignal.timeout(15_000))
            }
            result = '已发送 IM 提醒'
          } else if (job.method === 'schedules.get') result = await desktopScheduledTasks(runtime.db, ownerId).get(desktopScheduledTaskId(job.params.id))
          else {
            if (!job.operationId) throw new CoreError('invalid_request', '定时任务写入必须提供稳定操作标识')
            const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, async (tx, owner) => {
              const tasks = desktopScheduledTasks<Database>(tx, owner)
              if (job.method === 'schedules.create' || job.method === 'schedules.update') {
                const { im_delivery: rawDelivery, ...fields } = job.params.fields as Fields
                if (rawDelivery !== undefined) object(rawDelivery)
                const delivery = rawDelivery as Fields | undefined
                const id = job.method === 'schedules.update' ? desktopScheduledTaskId(job.params.id) : null
                const targets: DesktopScheduleImTarget[] = []
                if (eventId === null && Array.isArray(fields.channels)) {
                  const current = id === null ? null : await tasks.get(id)
                  const saved = current ? readDesktopScheduleImTargets(current.delivery_targets, current.channels) : []
                  for (const platform of desktopScheduleImPlatforms) {
                    if (!fields.channels.includes(platform)) continue
                    const selection = delivery?.[platform]
                    if (selection !== undefined) object(selection)
                    if (selection?.mode === 'group') {
                      const entry = (await scheduledGroups(platform, true, tx)).find(group => group.target.recipient === selection.chat_id)
                      if (!entry) throw new CoreError('invalid_request', '所选 IM 群会话不可用')
                      targets.push(entry.target)
                      continue
                    }
                    if (selection !== undefined && selection.mode !== 'private')
                      throw new CoreError('invalid_request', 'IM 投递目标格式无效')
                    const existing = saved.find(target => target.platform === platform)
                    if (existing && selection === undefined) { targets.push(existing); continue }
                    const target = desktopScheduleImTarget.safeParse(await hostRequest('agent.schedules.im.privateTarget', { platform }, signal))
                    if (!target.success || target.data.platform !== platform || target.data.chatType !== 'c2c'
                      || target.data.boundUserId !== target.data.recipient)
                      throw new CoreError('invalid_request', '所选 IM 渠道尚无可用的私聊投递目标')
                    targets.push(target.data)
                  }
                }
                if (targets.filter(target => target.chatType === 'group').length > 1)
                  throw new CoreError('invalid_request', '桌面定时任务只能投递到一个群')
                return id === null ? tasks.create(fields, eventId, targets) : tasks.update(id, fields, eventId, targets)
              }
              if (job.method === 'schedules.delete') return tasks.remove(desktopScheduledTaskId(job.params.id), eventId)
              throw new CoreError('invalid_request', '定时任务操作无效')
            }, { signal })
            result = outcome.result
          }
        } else if (job.method === 'desktop.search') {
          validateCommandParams(job.method, job.params)
          const query = parseGlobalSearchQuery(job.params)
          result = await desktopSearch.search(ownerId, { ...query, types: desktopSearch.availableTypes })
        } else if (job.method === 'preferences.preflightBusinessArchive') {
          validateCommandParams(job.method, job.params)
          if (typeof job.params.path !== 'string') throw new CoreError('invalid_request', '归档路径无效')
          result = await importDesktopBusinessArchive(runtime.db, ownerId, job.params.path, undefined, signal)
        } else if (job.method === 'preferences.applyBusinessArchive') {
          validateCommandParams(job.method, job.params)
          const { path, digest } = job.params
          if (typeof path !== 'string' || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))
            throw new CoreError('invalid_request', '归档参数无效')
          result = await importDesktopBusinessArchive(runtime.db, ownerId, path, digest, signal)
        } else if (job.method === 'preferences.exportBusinessArchive') {
          validateCommandParams(job.method, job.params)
          if (typeof job.params.path !== 'string') throw new CoreError('invalid_request', '归档路径无效')
          await exportDesktopBusinessArchive(runtime.db, ownerId, job.params.path, signal)
          result = null
        } else if (job.method === 'preferences.dataInventory') {
          result = await readDesktopDataInventory(runtime.db, ownerId)
        } else if (job.method === 'preferences.agentUsage') {
          validateCommandParams(job.method, job.params)
          result = await readDesktopAgentUsage(runtime.db, config.database, ownerId)
        } else if (job.method === 'preferences.agent') {
          validateCommandParams(job.method, job.params)
          result = await runtime.db.transaction().execute(tx => desktopAgentPreference(
            createKyselyPreferenceDocumentStore(tx, runtime.backend),
            createLocalPreferenceTextFiles(dirname(config.database)), ownerId, job.params.kind, job.params.patch))
        } else if (job.method === 'preferences.desktop.get') {
          validateCommandParams(job.method, job.params)
          result = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(runtime.db, runtime.backend)).get(ownerId)
        } else if (job.method === 'preferences.desktop.update') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '偏好写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params,
            tx => createDesktopAppearanceService(createKyselyPreferenceDocumentStore(tx, runtime.backend)).update(ownerId, job.params.patch), { signal })
          result = outcome.result
        } else if (job.method === 'projects.board.delete' || job.method === 'projects.board.restore' || job.method === 'projects.board.purge') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '项目写入必须提供稳定操作标识')
          const deleted = job.method === 'projects.board.delete'
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params,
            async (tx, owner) => {
              if (job.method === 'projects.board.purge') {
                await purgeDesktopProject(tx, owner, job.params.id)
                return null
              }
              const project = await setDesktopProjectDeleted(tx, owner, job.params.id, deleted)
              return deleted ? null : projectResponse(projectRecord(project), 0)
            }, { signal })
          result = outcome.result
        } else if (job.method === 'onboarding.desktop.get') {
          validateCommandParams(job.method, job.params)
          result = await createOnboardingService(createKyselyOnboardingStore(runtime.db, runtime.backend)).get(ownerId)
        } else if (job.method === 'operations.get') {
          validateCommandParams(job.method, job.params)
          const operationId = job.params.operation_id
          if (typeof operationId !== 'string')
            throw new CoreError('invalid_request', '操作标识必须是文本')
          result = await runtime.receipt(context, operationId)
        } else if (job.method === 'undo.preview') {
          validateCommandParams(job.method, job.params)
          result = await createUndoStateMachine(createRuntimeUndoTransactionPort(runtime), async () => {}).preview(ownerId, job.params.context_id as string)
        } else if (job.method === 'undo.apply' || job.method === 'undo.redo') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '撤销写入必须提供稳定操作标识')
          const { result: outcome, replayed } = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params,
            tx => applyUndoInTransaction(tx, runtime.backend, ownerId, job.params.context_id as string, job.params.undo_id as string, job.method === 'undo.apply' ? 'undo' : 'redo', { adapters: { calendar: createCalendarUndoAdapter(runtime.backend) } }), { signal })
          if (outcome.error) throw new UndoError(outcome.error.code, outcome.error.message, outcome.error.statusCode)
          result = replayed ? { ...outcome.result!, events: [] } : outcome.result
        } else if (job.method === 'calendar.list') {
          validateCommandParams(job.method, job.params)
          result = await createCalendarEventReader(createKyselyCalendarReadPort(runtime.db, runtime.backend)).list(ownerId)
        } else if (job.method === 'calendar.create') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '日历写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params,
            tx => createCalendarEvent(createBorrowedCalendarCreateStore(tx, runtime.backend), { ownerId, input: job.params, undoContextId: DESKTOP_CALENDAR_UNDO_CONTEXT }), { signal })
          result = outcome.result.event
        } else if (job.method === 'calendar.update' || job.method === 'calendar.delete') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '日历写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx => {
            const stores = createBorrowedKyselyCalendarMutationStores(tx, runtime.backend)
            return job.method === 'calendar.update'
              ? updateCalendarEvent(stores.update, { ownerId, eventId: Number(job.params.id), body: job.params.body, undoContextId: DESKTOP_CALENDAR_UNDO_CONTEXT })
              : deleteCalendarEvent(stores.delete, { ownerId, eventId: Number(job.params.id), version: Number(job.params.version), undoContextId: DESKTOP_CALENDAR_UNDO_CONTEXT }).then(() => null)
          }, { signal })
          result = outcome.result
        } else if (job.method === 'mind.notes.list') {
          validateCommandParams(job.method, job.params)
          result = await createSqlMindNoteReader(runtime.db, runtime.backend).list(ownerId, 200, 0)
        } else if (job.method === 'mind.notes.create') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '便签写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx =>
            createMindNoteCreator({
              insert: createBorrowedSqlMindNoteInserter(tx, runtime.backend),
              async publishCreated() {},
            })(ownerId, job.params, { undoContextId: 'desktop-mind', clientId: null }), { signal })
          result = outcome.result
        } else if (job.method === 'mind.notes.update' || job.method === 'mind.notes.delete') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '便签写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx => {
            const mutations = createMindNoteMutations({
              ...createSqlMindNoteMutator(tx, runtime.backend),
              async publishUpdated() {}, async publishDeleted() {},
            })
            return job.method === 'mind.notes.update'
              ? mutations.update(ownerId, Number(job.params.id), job.params.fields, { undoContextId: 'desktop-mind', clientId: null })
              : mutations.delete(ownerId, Number(job.params.id), { undoContextId: 'desktop-mind', clientId: null }).then(() => null)
          }, { signal })
          result = outcome.result
        } else if (job.method === 'mind.canvases.list') {
          validateCommandParams(job.method, job.params)
          result = await createSqlMindCanvasReader(runtime.db, runtime.backend).listCanvases(ownerId, null)
        } else if (job.method === 'mind.canvases.items.list') {
          validateCommandParams(job.method, job.params)
          result = await createSqlMindCanvasReader(runtime.db, runtime.backend).listItems(ownerId, Number(job.params.canvasId)) ?? []
        } else if (job.method === 'mind.canvases.relations.list') {
          validateCommandParams(job.method, job.params)
          result = await createSqlMindCanvasReader(runtime.db, runtime.backend).listRelations(ownerId, Number(job.params.canvasId)) ?? []
        } else if (job.method === 'mind.canvas-note.location') {
          validateCommandParams(job.method, job.params)
          const canvasId = await createSqlMindCanvasReader(runtime.db, runtime.backend).canvasLocation(ownerId, Number(job.params.nodeId))
          result = canvasId === null ? null : { canvasId }
        } else if (job.method === 'mind.canvases.items.add') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '画布写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, async tx => {
            let body = job.params.body
            if (body && typeof body === 'object' && 'desktopFile' in body) {
              const { desktopFile, ...placement } = body
              const { node } = await createPathFileCanvasNode(tx, runtime.backend, ownerId, desktopFile)
              body = { ...placement, nodeId: Number(node.id) }
            }
            return createMindCanvasItemAdd(createSqlMindCanvasItemAddRuntime(tx, runtime.backend, async () => {}))
              (ownerId, Number(job.params.canvasId), body, { undoContextId: 'desktop-mind', clientId: null, mutationId: null })
          }, { signal })
          result = outcome.result
        } else if (job.method === 'mind.canvases.items.bring-to-front') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '画布写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx =>
            createMindCanvasItemUpdate(createSqlMindCanvasItemUpdateRuntime(tx, runtime.backend, async () => {})).bringToFront(ownerId, Number(job.params.canvasId), Number(job.params.id), job.params.body, { undoContextId: 'desktop-mind', clientId: null, mutationId: null }), { signal })
          result = outcome.result
        } else if (job.method === 'mind.canvases.relations.create' || job.method === 'mind.canvases.relations.delete') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '画布关系写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx => job.method === 'mind.canvases.relations.create'
            ? createMindCanvasRelationCreate(createSqlMindCanvasRelationCreateRuntime(tx, runtime.backend, async () => {}))(ownerId, job.params.body, { undoContextId: 'desktop-mind', clientId: null, mutationId: null })
            : createMindCanvasRelationDelete(createSqlMindCanvasRelationDeleteRuntime(tx, runtime.backend, async () => {}))(ownerId, Number(job.params.canvasId), Number(job.params.id), { undoContextId: 'desktop-mind', clientId: null, mutationId: null }).then(() => null), { signal })
          result = outcome.result
        } else if (job.method === 'mind.ref.create') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '引用创建必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx =>
            createMindRefNodeCreator(createSqlMindRefNodeCreateRuntime(tx, runtime.backend, async () => {})).create(ownerId, job.params.body, { undoContextId: 'desktop-mind', clientId: null, mutationId: null }), { signal })
          result = outcome.result
        } else if (job.method === 'mind.canvases.notes.create' || job.method === 'mind.canvases.notes.update' || job.method === 'mind.canvases.items.update' || job.method === 'mind.canvases.items.delete') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '画布内容写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction<unknown>(context, job.operationId, job.method, job.params, tx => {
            if (job.method === 'mind.canvases.notes.create')
              return createMindCanvasNoteMutations(createSqlMindCanvasNoteRuntime(tx, runtime.backend, async () => {})).create(ownerId, Number(job.params.canvasId), job.params.body, { undoContextId: 'desktop-mind', clientId: null })
            if (job.method === 'mind.canvases.notes.update')
              return createMindCanvasNoteMutations(createSqlMindCanvasNoteRuntime(tx, runtime.backend, async () => {})).update(ownerId, Number(job.params.id), job.params.fields, { undoContextId: 'desktop-mind', clientId: null })
            if (job.method === 'mind.canvases.items.update')
              return createMindCanvasItemUpdate(createSqlMindCanvasItemUpdateRuntime(tx, runtime.backend, async () => {})).update(ownerId, Number(job.params.canvasId), Number(job.params.id), job.params.body, { undoContextId: 'desktop-mind', clientId: null, mutationId: null })
            return createMindCanvasItemRemove(createSqlMindCanvasItemRemoveRuntime(tx, runtime.backend, async () => {}))(ownerId, Number(job.params.canvasId), Number(job.params.id), { undoContextId: 'desktop-mind', clientId: null, mutationId: null }).then(() => null)
          }, { signal })
          result = outcome.result
        } else if (job.method === 'mind.canvases.create' || job.method === 'mind.canvases.update' || job.method === 'mind.canvases.delete') {
          validateCommandParams(job.method, job.params)
          if (!job.operationId) throw new CoreError('invalid_request', '画布写入必须提供稳定操作标识')
          const outcome = await runtime.operationWithTransaction(context, job.operationId, job.method, job.params, tx => {
            const publish = async () => {}
            if (job.method === 'mind.canvases.create')
              return createMindCanvasCreation(createSqlMindCanvasCreateRuntime(tx, runtime.backend, publish))(ownerId, job.params, { undoContextId: 'desktop-mind', clientId: null })
            if (job.method === 'mind.canvases.update')
              return createMindCanvasUpdate(createSqlMindCanvasUpdateRuntime(tx, runtime.backend, publish))(ownerId, Number(job.params.id), job.params.body, { undoContextId: 'desktop-mind', clientId: null })
            return createMindCanvasDelete(createSqlMindCanvasDeleteRuntime(tx, runtime.backend, publish))(ownerId, Number(job.params.id), { undoContextId: 'desktop-mind', clientId: null }).then(() => null)
          }, { signal })
          result = outcome.result
        } else if (job.operationId && isMutation(job.method))
          result = await runtime.operation(
            context,
            job.operationId,
            job.method,
            job.params,
            (data) => execute(data, job.method, job.params),
            { signal },
          )
        else
          result = await runtime.transaction(
            context,
            (data) => execute(data, job.method, job.params),
            { signal },
          )
        port.postMessage({ id: job.id, result })
      } catch (error) {
        const safe = error instanceof MindNoteMutationError
          ? new CoreError(error.statusCode === 409 ? 'conflict' : error.statusCode === 404 ? 'not_found' : 'invalid_request', error.message)
          : error instanceof MindNoteCreateError
          ? new CoreError('invalid_request', error.message)
          : error instanceof MindCanvasMutationError
          ? new CoreError(error.statusCode === 404 ? 'not_found' : 'invalid_request', error.message)
          : error instanceof MindCanvasNoteMutationError
          ? new CoreError(error.statusCode === 404 ? 'not_found' : error.statusCode === 409 ? 'conflict' : 'invalid_request', error.message)
          : error instanceof MindCanvasItemMutationError
          ? new CoreError(error.statusCode === 404 ? 'not_found' : 'invalid_request', error.message)
          : error instanceof EventCreateError
          ? new CoreError(error.statusCode === 409 ? 'conflict' : 'invalid_request', error.message)
          : error instanceof EventUpdateError
          ? new CoreError(error.statusCode === 409 ? 'conflict' : error.statusCode === 404 ? 'not_found' : 'invalid_request', error.message)
          : error instanceof EventDeleteError
          ? new CoreError(error.statusCode === 409 ? 'conflict' : 'not_found', error.message)
          : error instanceof UndoError
          ? new CoreError(error.code === 'undo.not_found' ? 'not_found' : error.code === 'undo.unsupported' ? 'invalid_request' : 'conflict', error.message)
          : error
        port.postMessage({
          id: job.id,
          error:
            safe instanceof CoreError || (desktopAgent && safe instanceof desktopAgent.DesktopAgentCoreError)
              ? { code: safe.code, message: safe.message }
              : { code: 'storage_error', message: '本地数据操作失败' },
        })
      } finally {
        if (cancellationPoll) clearInterval(cancellationPoll)
      }
    })
  })
} catch (error) {
  port.postMessage({
    event: 'failed',
    error:
      error instanceof CoreError
        ? { code: error.code, message: error.message }
        : {
            code: 'storage_error',
            message: '本地数据无法打开，请检查版本与文件权限',
          },
  })
  port.close()
}
