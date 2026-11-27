import { imAskUserPolicy } from '#core-source/agent/interactions/prompt-description.js'
import { createCurrentTurnImageReferences } from '#core-source/agent/attachments/current-turn.js'
import { createImImageProcessor, IM_IMAGE_MAX_INPUT_BYTES } from '@gugu/gateway/media/image'
import { createDesktopFileTools } from './file-tools.js'
import { createDesktopSessionRuns } from './session-runs.js'
import { createDesktopSubagentRuntime, createDesktopSubagentWake } from './subagent-runtime.js'
import { createDesktopContextRag, createDesktopContextSource, createDesktopContextState, createDesktopImContext, createDesktopRunContextLoader } from './context-source.js'
import { createDesktopToolRuntime } from './tool-runtime.js'
import { createDesktopMcpManagement } from './mcp-management.js'
import { createDesktopScheduleTools } from './schedule-tools.js'
import { createDesktopAttachmentTools } from './attachment-tools.js'
import { createDesktopEmailTool } from './email-tools.js'
import { createDesktopReflectionRecovery, createDesktopReflectionWork } from './reflection.js'
import { bindDesktopPaidSearchTools } from './paid-search.js'
import { startDesktopRagWorker, type MemoryRebuild } from './rag-worker.js'
import { startDesktopAgentRetention } from './retention.js'
import { sceneAllowsPrompt, sceneAllowsTool, type AgentScene } from '#core-source/agent/scenes/index.js'
import { imAllowsBuiltinSkill } from '#core-source/agent/scenes/im/index.js'
import { desktopScheduleImConnection, desktopScheduleImPlatforms } from '#core-source/runtime/desktop-schedules/desktop-im.js'
import { cleanupDesktopDownloadStaging, createDesktopWebDownload } from '#core-source/runtime/desktop-web-download.js'
import { openStreamedAgentGet } from '#core-source/agent/tools/web/streamed-http-get.js'
import { droppedFileReferenceId, readDesktopTurnReferences, workspaceFileReferenceId } from '#core-source/agent/sessions/desktop-references.js'
import { openDroppedFile, readDroppedFileExcerpt } from '#core-source/runtime/desktop-file-excerpt.js'
import { createDesktopContinuationStore } from '#core-source/runtime/desktop-continuation.js'
import { createFirstTurnTitleWriter } from '#core-source/agent/sessions/title.js'
import { createAgentLog } from '@gugu/log'
import { createWebLinkButtonDeliveryPort } from '#core-source/agent/tools/im/link-buttons.js'
import { readPreferenceDocument } from '#core-source/preferences/general.js'
import { createClientDeletePort } from '#core-source/agent/tools/clients/index.js'
import type { ProjectFileOverview } from '#core-source/agent/tools/projects/index.js'
import type { desktopTrashTarget } from '#core-source/runtime/desktop-shell-trash.js'
import { createLocalPreferenceTextFiles } from '#core-source/preferences/text-files.js'
import { createDesktopAppearanceService } from '#core-source/preferences/desktop-appearance.js'
import { createKyselyPreferenceDocumentStore } from '#core-source/preferences/document-store.js'
import type { DesktopMemoryFiles } from '#core-source/agent/memory/desktop-files.js'
import { readAgentPrompt, readAgentPromptSet } from '#core-source/agent/context/prompts.js'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { drainAgentRuns } from '#core-source/agent/run/shutdown.js'
import { constants as fsConstants } from 'node:fs'
import { publishDesktopKnowledgeFile } from '#core-source/runtime/desktop-knowledge-files.js'
import { open as openFile } from 'node:fs/promises'
import { sql, type Kysely } from 'kysely'
import type { Database } from '#core-source/data/schema.js'
import { ScheduledTaskReferenceError } from '@gugu/scheduler/tasks'
import { createSqliteToolConfirmation } from '#core-source/agent/interactions/sqlite-confirmation.js'
import { createScheduledTaskDeleteTool } from '#core-source/agent/tools/scheduled-tasks/index.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import { createAgentCalendarReader } from '#core-source/calendar/application/event-read.js'
import { createKyselyCalendarAgentReadPort, createKyselyCalendarReadPort } from '#core-source/calendar/read-store.js'
import { createAgentPlaceableSearch, createSqlMindCanvasReader } from '#core-source/mind/canvas-read.js'
import { createAgentWorkspaceQueries } from '#core-source/workspaces/workspace-list.js'
import { createDesktopWorkspaceReadPort } from '../workspace-queries.js'
import { readAgentSessionContext } from '#core-source/agent/sessions/list.js'
import { createAgentMindReader } from '#core-source/mind/note-read.js'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '#core-source/tasks/task-list.js'
import { createGlobalSearchOperations, createFileSearchSources } from '@gugu/search'
import { createKyselySqliteGlobalSearchSources } from '#core-source/search/sqlite.js'
import { createFileSkillSearchSource } from '#core-source/agent/skills/search.js'
import { CoreError, dataContext, DEFAULT_LLM_CONTEXT_TOKENS, DEFAULT_LLM_OUTPUT_TOKENS } from '#core-source/contracts/index.js'
import { stableJson } from '#core-source/agent/context/history/canonical-history.js'
import { contextAccessScopeHash } from '#core-source/agent/context/prepare.js'
import type { AgentObservationPort } from '#core-source/agent/observation.js'
import { agentPromptPreferenceFields, buildAgentStaticPrompt } from '#core-source/agent/context/prompt-format.js'
import { createAgentCompactionPort, createLazyAgentCompactionPort } from '#core-source/agent/context/compaction-runtime.js'
import type { ProviderRuntime } from '#core-source/agent/providers/runtime.js'
import type { AgentProviderAuxiliaryPorts } from '#core-source/agent/runtime.js'
import { readSqliteOwnerStylePreferences } from '#core-source/agent/context/sqlite-overview.js'
import { createSqliteAgentSessionSource } from '#core-source/agent/context/sqlite-source.js'
import type { RagQueryEmbeddingSettings } from '#core-source/agent/rag/query-embedding.js'
import type { CanonicalRunContext, Json, RunIdentity } from '#core-source/agent/models.js'
import type { ProviderConfig, ProviderTransport } from '#core-source/agent/providers/contracts.js'
import { ProviderError, providerErrorMessage } from '#core-source/agent/providers/errors.js'
import { supportsCrossRunProviderReasoning } from '#core-source/agent/providers/cross-run-reasoning.js'
import { adapterFor } from '#core-source/agent/providers/registry.js'
import { ProviderStreamSanitizer, stripThinking } from '#core-source/agent/providers/sanitize.js'
import { createNodeProviderTransport, desktopTransportOptions, createNodeProviderTransportFactory, desktopModelTransportOptions, type NodeProviderTransportOptions, type ProxyEndpoint } from '#core-source/agent/providers/transport/node.js'
import {
  createSqliteAgentMemoryRagStorage, createSqliteAgentMemoryRagVectors,
  createSqliteMemorySearch, createSqliteRememberMemory, readSqliteAgentMemory,
} from '#core-source/agent/memory/sqlite.js'
import { createAgentKnowledgeOverview } from '#core-source/agent/knowledge/overview.js'
import { createLocalAgentKnowledgeWritePort, createLocalAgentKnowledgeDeletePort } from '#core-source/agent/knowledge/local-write.js'
import { createLocalAgentKnowledgeReadStore } from '#core-source/agent/knowledge/local-store.js'
import { createOwnerAgentKnowledgeReadPort } from '#core-source/agent/knowledge/read-port.js'
import { createAgentHttpGetPort } from '#core-source/agent/tools/web/http-get.js'
import { createSqlAgentConversationTextReader } from '#core-source/agent/sessions/data.js'
import { createCoreAgentConversationSearchPort } from '#core-source/agent/sessions/tool-search.js'
import { createBuiltinSkillDefinitions, formatBuiltinSkillIndex, type BuiltinSkillDefinition } from '#core-source/agent/skills/builtin.js'
import { createBundledSkillDocuments } from '../../../../../../packages/core/dist/agent/skills/bundled.js'
import { createAgentSkillRuntimePorts } from '#core-source/agent/skills/runtime.js'
import { createFileSkillDefinitions, isUserSkillBundleEnabled, withFileSkillMetadata } from '#core-source/agent/skills/bundle-store.js'
import { createFileSkillDeleteTool } from '#core-source/agent/tools/skill-management/file-delete.js'
import { createDurableFileSkillDeletePort } from '#core-source/agent/tools/skill-management/file-delete-port.js'
import { describeFileSkillDeleteTarget } from '#core-source/agent/tools/skill-management/file-delete-target.js'
import { createFileSkillManagementWriteTools } from '#core-source/agent/tools/skill-management/file-tools.js'
import { createDurableFileSkillManagementPort } from '#core-source/agent/tools/skill-management/file-port.js'
import { createDesktopAgentSkillDeleteStorage, createDesktopAgentSkillMutationAdapter } from './skill-storage.js'
import { createBuiltinSkillMetadataReader } from '#core-source/agent/skills/user-read.js'
import { createCanvasBatchPort, createCanvasCreationPort, createCanvasDeleteNotePort, createCanvasDeletePort, createCanvasDisconnectPort, createCanvasEditPort } from '#core-source/agent/tools/canvas/index.js'
import { createCalendarDeletePort, createCalendarEventCreatePort, createCalendarEventUpdatePort, type CalendarReminderTargetPort } from '#core-source/agent/tools/calendar/index.js'
import { createUndoLastActionTool } from '#core-source/agent/tools/undo/index.js'
import { createAgentUndoLastActionPort } from '#core-source/agent/tools/undo/undo-port.js'
import { createRuntimeUndoTransactionPort, createUndoStateMachine, UndoError } from '#core-source/undo/state-machine.js'
import { createCalendarUndoAdapter } from '#core-source/calendar/undo-adapter.js'
import { createDesktopProjectUndoAdapter } from '#core-source/runtime/desktop-project-undo.js'
import { createNoteLifecyclePort, createNoteWritePort } from '#core-source/agent/tools/note/index.js'
import { createKyselyProjectCreateRuntime } from '#core-source/projects/create-store.js'
import { createDurableProjectMutationPort } from '#core-source/agent/tools/projects/mutation-port.js'
import { createKnowledgeDeleteTool } from '#core-source/agent/tools/knowledge/index.js'
import { createOwnerToolRegistry } from '#core-source/agent/tools/owner.js'
import { createToolRegistry } from '#core-source/agent/tools/registry.js'
import { projectRecentAttachments, type RecentAttachmentRow } from '#core-source/agent/attachments/recent.js'
import { createWebSearchTool } from '#core-source/agent/tools/search/index.js'
import { createSqliteAgentAdmission } from '#core-source/agent/run/sqlite-admission.js'
import { createSqlAgentPendingQueue } from '#core-source/agent/sessions/pending-queue.js'
import { createSqliteAgentRuntime } from '#core-source/agent/run/sqlite-runtime.js'
import { createSqliteInteractionProjection } from '#core-source/agent/interactions/sqlite-projection.js'
import { describeSqliteMcpCredential } from '#core-source/agent/interactions/sqlite-credential.js'
import { createSqliteInteractionActivator } from '#core-source/agent/interactions/sqlite-activate.js'
import { createAgentInteractionDescription } from '#core-source/agent/interactions/prompt-description.js'
import { createSubagentServiceTools } from '#core-source/agent/tools/subagent/index.js'
import { createSqliteAgentRunStore } from '#core-source/agent/run/sqlite-store.js'
import {
  createCalendarRagSource, createCanvasRagSource, createConversationRagSource, createMemoryRagSource,
  createKnowledgeRagSource, createNoteRagSource, createProjectRagSource, createScheduledTaskRagSource,
  createSqlMemoryScopeStateReader,
} from '#core-source/agent/rag/index.js'
import { createSqlMindNoteReader } from '#core-source/mind/note-read.js'
import { createKyselyScheduledTaskRagReader } from '#core-source/tasks/task-list.js'
import { settleExclusiveSqliteAgentRuns, settleStoppedSqliteAgentRun } from '#core-source/agent/run/sqlite-recovery.js'
import { loadSqliteAgentRunSecret } from '#core-source/agent/run/sqlite-secret.js'
import { openLocalFile } from '@gugu/fs/node'
import { canonicalAgentToolName, filterConfiguredAgentTools } from '#core-source/agent/index.js'
import { createViewImageTool, withViewImageReferences } from '#core-source/agent/tools/files/view-image.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const reflectionModelIdentity = (config: ProviderConfig) =>
  digest([config.provider, config.api_format, config.base_url, config.model])
const unavailable = async (): Promise<never> => { throw new CoreError('conflict', '当前运行未配置该能力') }

import { createDesktopScheduledAgent } from '../../schedules/agent.js'
import { createDesktopScheduledShellBinding } from '../../schedules/shell.js'
import { createDesktopScheduledImContext } from '../../schedules/context.js'

export function createDesktopAgentRuns(core: SqlDataRuntime, databasePath: string, ownerId: string,
  notify: (sessionId: number, runId: string, interactionChanged?: true) => void,
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  memoryFiles: DesktopMemoryFiles | undefined, observation: AgentObservationPort | undefined,
  promptDirectory: string) {
  const { db } = core
  const preferenceFiles = createLocalPreferenceTextFiles(dirname(databasePath))
  const moveShellTargetToTrash = (target: Awaited<ReturnType<typeof desktopTrashTarget>>, cwd: string, workspace: string | undefined, signal: AbortSignal) =>
    hostRequest('agent.shell.trash', { ...target, cwd, workspace: workspace ?? null }, signal)
  const agentWorkspaces = createAgentWorkspaceQueries(createDesktopWorkspaceReadPort(hostRequest))
  const imageProcessor = createImImageProcessor()
  async function configuredAgentTools(names: readonly string[], signal?: AbortSignal) {
    const disabled = await hostRequest('agent.tools.policy', {}, signal).then(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('disabledTools' in value) || !Array.isArray(value.disabledTools)
        || value.disabledTools.some(name => typeof name !== 'string' || !name.trim()))
        throw new CoreError('storage_error', '桌面 Agent 工具策略无效')
      return new Set(value.disabledTools as string[])
    })
    signal?.throwIfAborted()
    return filterConfiguredAgentTools(names).filter(name => !disabled.has(name))
  }
  const undoStateMachine = createUndoStateMachine(createRuntimeUndoTransactionPort(core), async () => {}, undefined,
    { calendar: createCalendarUndoAdapter('sqlite'), projects: createDesktopProjectUndoAdapter() })
  const knowledgeRoot = process.env.GUGU_DESKTOP_MEMORY_ROOT ?? dirname(databasePath)
  const admission = createSqliteAgentAdmission(db, { skillDataRoot: knowledgeRoot })
  async function authorizeSearchRecovery(identity: RunIdentity) {
    const session = Number(identity.sessionId)
    if (identity.ownerId !== ownerId || !Number.isSafeInteger(session) || session <= 0) return false
    return (await admission.active(ownerId, session))?.identity?.runId === identity.runId
  }
  async function resolveOwnedAttachment(identity: RunIdentity, attachId: string, signal: AbortSignal, scope: 'turn' | 'session' | 'owner' = 'turn') {
    signal.throwIfAborted()
    if (!/^[0-9a-f]{32}$/u.test(attachId) || !await authorizeSearchRecovery(identity)) return null
    const session = Number(identity.sessionId)
    if (!Number.isSafeInteger(session) || session <= 0) return null
    const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
    const { rows } = await sql<{ attach_id: string; name: string; ext: string; kind: string; size: number; storage_key: string }>`
      SELECT a.attach_id,a.name,a.ext,a.kind,a.size,a.storage_key
      FROM chat_attachments a
      JOIN conversation_messages m ON m.id=a.message_id
      JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=a.user_id
      WHERE a.user_id=${owner} AND a.attach_id=${attachId} AND a.state='attached'
        ${scope === 'owner' ? sql`` : sql`AND s.id=${session}`}
        ${scope !== 'turn' ? sql`` : sql`AND EXISTS (
          SELECT 1 FROM agent_run_admissions r WHERE r.user_id=a.user_id AND r.user_message_id=a.message_id
            AND r.session_id=s.id AND r.run_id=${identity.runId}
        )`}
      LIMIT 1`.execute(db)
    signal.throwIfAborted()
    const attachment = rows[0]
    if (!attachment || attachment.storage_key !== `agent-attachments/${attachId}`
      || !Number.isSafeInteger(Number(attachment.size)) || Number(attachment.size) < 0
      || !await authorizeSearchRecovery(identity)) return null
    return {
      attach_id: attachment.attach_id,
      name: `${attachment.name}${attachment.ext ? `.${attachment.ext}` : ''}`,
      kind: attachment.kind,
      extension: attachment.ext,
      size_bytes: Number(attachment.size),
      root: join(dirname(databasePath), 'agent-attachments'),
      relativePath: attachId,
    }
  }

  const paidSearchTools = bindDesktopPaidSearchTools(hostRequest, resolveOwnedAttachment, digest)
  const readConversation = createSqlAgentConversationTextReader(db, 'sqlite')
  const knowledgeStore = createLocalAgentKnowledgeReadStore(knowledgeRoot)
  const readKnowledgeOverview = createAgentKnowledgeOverview(knowledgeStore)
  const running = new Map<number, { runId: string; cancel(): Promise<unknown>; done: Promise<void> }>()
  const runTasks = new Set<Promise<void>>()
  const subagentWakeAbort = new AbortController()
  const subagentWake = createDesktopSubagentWake({
    db, databasePath, ownerId, signal: subagentWakeAbort.signal, notify,
    activeRunDone: sessionId => running.get(sessionId)?.done,
    resumeCheckpoint: (checkpoint, signal) => sessionRuns.resumeCheckpoint(checkpoint, signal),
  })
  const { scheduleSubagentWake } = subagentWake
  const subagentRuntime = createDesktopSubagentRuntime({
    db, ownerId, databasePath, signal: subagentWakeAbort.signal, running, runTasks,
    scheduleSubagentWake, agentWorkspaces, digest, runModel: (sessionId, runId) => sessionRuns.runModel(sessionId, runId),
    hostRequest, reflectionModelIdentity,
    scheduledAgentProxy, configuredAgentTools, moveShellTargetToTrash, resolveReferencedFile,
    readDesktopShellPreferences, observation, unavailable, notify,
  })
  const { desktopSubagents, scheduleAdmittedRuns, dispatchAdmittedChild } = subagentRuntime

  const sessionRuns = createDesktopSessionRuns({
    db, databasePath, ownerId, admission, running, runTasks, createRunRuntime, hostRequest,
    reflectionModelIdentity, isDesktopChatMessage, scheduleAdmittedRuns, scheduleSubagentWake,
    cancelChildren: subagentRuntime.cancelChildren, notify,
  })
  const reflection = createDesktopReflectionRecovery({
    db, ownerId, memoryFiles, hostRequest, reflectionModelIdentity,
    prepareRecovery: (sessionId, config, modelId) => createRunRuntime(sessionId, config, undefined, false, undefined, modelId),
  })
  const { scheduleReflectionRecovery, resumeReflections } = reflection
  let builtinSkills: Promise<BuiltinSkillDefinition[]> | undefined
  let embeddingGeneration = 0
  let memoryEmbedding: {
    settings: RagQueryEmbeddingSettings
    resolveProxy: NodeProviderTransportOptions['resolveProxy']
    controller: AbortController
  } | undefined
  const memorySource = createMemoryRagSource({
    storage: createSqliteAgentMemoryRagStorage(db, memoryFiles),
    scopeState: { getMemoryScopeState: createSqlMemoryScopeStateReader(db) },
    scopes: async () => [],
  })
  let memoryWarmup: Promise<void> | undefined
  const ragSources = {
    project: createProjectRagSource(core),
    calendar: createCalendarRagSource(createKyselyCalendarReadPort(db, 'sqlite')),
    note: createNoteRagSource(createSqlMindNoteReader(db, 'sqlite')),
    scheduled_task: createScheduledTaskRagSource(createKyselyScheduledTaskRagReader(db, 'sqlite')),
    conversation: createConversationRagSource(db, 'sqlite'),
    canvas: createCanvasRagSource(createSqlMindCanvasReader(db, 'sqlite')),
    memory: async (...args: Parameters<typeof memorySource>) => {
      const documents = await memorySource(...args)
      const [owner, , signal] = args
      const config = memoryEmbedding
      if (config && signal && owner === ownerId && memoryFiles && !signal.aborted) {
        const warmupSignal = AbortSignal.any([signal, config.controller.signal])
        memoryWarmup = (memoryWarmup ?? Promise.resolve()).then(async () => {
          if (warmupSignal.aborted) return
          const vectors = await createSqliteAgentMemoryRagVectors(db, owner, config.settings, memoryFiles, config.resolveProxy)
          try { await vectors.warmDocuments(documents, warmupSignal) }
          finally { await vectors.close() }
        }).catch(() => {})
      }
      return documents
    },
    knowledge: createKnowledgeRagSource(knowledgeStore),
  }
  const ragWorker = startDesktopRagWorker(db, ownerId, ragSources, () => embeddingGeneration)

  const stopRetention = startDesktopAgentRetention(db)

  const scheduledImContext = createDesktopScheduledImContext({ db, ownerId, memoryFiles, hostRequest })
  const currentScheduledIm = scheduledImContext.authorizeIm

  async function resolveReferencedFile(id: string, signal?: AbortSignal, includeFolder = false) {
    const method = workspaceFileReferenceId.test(id) ? 'agent.files.resolveWorkspaceReference' : 'agent.files.resolveDroppedReference'
    const result = await hostRequest(method, { id }, signal)
    if (result === null) return null
    if (!result || typeof result !== 'object' || !('path' in result) || typeof result.path !== 'string'
      || !('fileIdentity' in result) || typeof result.fileIdentity !== 'string')
      throw new CoreError('storage_error', '本机文件引用结果无效')
    const isFolder = 'type' in result && result.type === 'folder'
    if (isFolder && !includeFolder) return null
    return { path: result.path, fileIdentity: result.fileIdentity, isFolder,
      relativePath: 'relativePath' in result && typeof result.relativePath === 'string' ? result.relativePath : undefined }
  }

  async function readDesktopShellPreferences() {
    const local = readPreferenceDocument(await createKyselyPreferenceDocumentStore(db, 'sqlite').read(ownerId))
    return {
      automaticMode: local.automatic_mode_enabled === true,
      shellEnabled: (local.shell_enabled ?? true) === true,
      dangerousEnabled: (local.shell_dangerous_enabled ?? true) === true,
    }
  }

  function isDesktopChatMessage(clientId: string | null | undefined) {
    // 桌面消息使用 UUID，IM 网关使用带连接范围的 SHA-256 摘要。
    return typeof clientId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(clientId)
  }

  async function isDesktopChatRun(identity: RunIdentity) {
    const owner = identity.ownerId.replaceAll('-', '').toLowerCase()
    const { rows: [message] } = await sql<{ client_message_id: string | null }>`
      SELECT m.client_message_id FROM agent_run_admissions a
      JOIN conversation_messages m ON m.id=a.user_message_id AND m.session_id=a.session_id
      WHERE a.user_id=${owner} AND a.session_id=${identity.sessionId} AND a.run_id=${identity.runId}
        AND m.role='user' AND m.platform_user_id IS NULL
    `.execute(db)
    return isDesktopChatMessage(message?.client_message_id)
  }

  async function prepareRunRuntime(sessionId: number | null, config: ProviderConfig | null, embedding?: RagQueryEmbeddingSettings, interactive = false, resumeIdentity?: RunIdentity, modelId?: string, locale = 'zh-CN', desktopChat = false, scheduled?: { identity: RunIdentity; assertCurrent(): Promise<void> }) {
    const imBinding = sessionId === null || desktopChat ? null : (await sql<{ chat_type: string | null; platform: string }>`
      SELECT s.chat_type,im.platform FROM conversation_sessions s JOIN desktop_im_sessions im
        ON im.session_id=s.id AND im.owner_id=s.user_id
      WHERE s.id=${sessionId} AND s.user_id=${dataContext(ownerId).ownerId.replaceAll('-', '')}
    `.execute(db)).rows[0]
    const imSession = imBinding && resumeIdentity && await isDesktopChatRun(resumeIdentity) ? null : imBinding
    const imChatType = imSession ? imSession.chat_type ?? 'c2c' : undefined
    const askUserPolicy = imSession ? imAskUserPolicy : {}
    const groupChat = imChatType === 'group'
    if (groupChat) interactive = false
    const embeddingGenerationAtStart = embeddingGeneration
    // 当前运行身份必须按 RunRuntime 隔离；多个会话可以并行执行。
    if (config) {
      const endpoint = URL.parse(String(config.base_url ?? ''))
      if (!endpoint) throw new CoreError('invalid_request', '模型地址无效')
      const local = (config.provider === 'local' || config.provider === 'ollama')
        && (endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]')
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')))
        throw new CoreError('invalid_request', '模型地址无效')
    }
    let workspaceBinding: Record<string, Json> | null = null
    if (sessionId !== null && !groupChat) {
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      const { rows: [session] } = await sql<{ session_context: string | null }>`SELECT session_context FROM conversation_sessions
        WHERE user_id=${owner} AND id=${sessionId}
          ${imChatType === 'c2c' ? sql`` : sql`AND (source IS NULL OR source='web')`}`.execute(db)
      const context = readAgentSessionContext(session?.session_context, 'sqlite')
      const stored = context.workspace_binding
      const directoryId = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as Record<string, unknown>).directory_id : undefined
      if (typeof directoryId === 'string') {
        const workspace = await agentWorkspaces.get(ownerId, directoryId)
        if (workspace) workspaceBinding = {
          workspace_id: workspace.workspace_id, workspace_name: workspace.name, kind: workspace.kind, space: 'workspace',
          project_id: null, directory_id: workspace.directory_id!, directory_name: workspace.directory_name!,
        }
      }
    }
    const selection = {
      modelIdentity: config ? reflectionModelIdentity(config) : '',
      contextWindow: typeof config?.context_tokens === 'number' ? config.context_tokens : DEFAULT_LLM_CONTEXT_TOKENS,
      locale, groupChat, workspaceBinding, scene: imSession ? 'im' as const : 'default' as const,
      contextPolicy: { loadOwnerContext: !groupChat, memoryEnabled: !groupChat },
      // 业务内容版本由 currentRevision 返回，访问范围只绑定可信身份和上下文策略。
      contextScopeKey: groupChat ? 'desktop-im-group' : 'desktop-overview',
    }
    if (config && !groupChat) await memoryFiles?.flush()
    const builtins = await (builtinSkills ??= createBuiltinSkillDefinitions(createBundledSkillDocuments(), new AbortController().signal))
    const preferences = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(db, 'sqlite')).get(ownerId)
    const contextState = createDesktopContextState(resumeIdentity)
    const agentClock = { now: () => new Date(), timezone: async () => contextState.timezone }
    const prompts = readAgentPromptSet(promptDirectory)
    const scene: AgentScene = imSession ? 'im' : 'default'
    const sceneBuiltins = imSession ? builtins.filter(skill => imAllowsBuiltinSkill(skill.key)) : builtins
    const isFileSkillEnabled = (owner: string, id: string, source?: 'user' | 'clawhub') => isUserSkillBundleEnabled(knowledgeRoot, owner, id, source)
    const fileSkills = groupChat ? [] : (await createFileSkillDefinitions({ dataRoot: knowledgeRoot, ownerId,
      mapPath: path => path, isEnabled: isFileSkillEnabled })).definitions
    const fileSkillIndex = fileSkills.length ? ['## 可用文件技能', '按用途选择技能，使用 use_skill 读取正文；目录包含配套文件。',
      ...fileSkills.map(skill => JSON.stringify({ id: skill.id, name: skill.name, description: skill.description, path: skill.path }))].join('\n') : ''
    const smartView = sceneAllowsPrompt(scene, 'smart_view') ? readAgentPrompt('smart_view.md', promptDirectory) : undefined
    let availableMailPrompt = ''
    const buildSystemPrompt = (preferences: Record<string, Json>, skillIndex = groupChat ? '' : [formatBuiltinSkillIndex(sceneBuiltins), fileSkillIndex].filter(Boolean).join('\n\n')) => [buildAgentStaticPrompt({
      ...prompts, smartView,
      chatFileWorkspace: imSession ? undefined : workspaceBinding
        ? { name: String(workspaceBinding.workspace_name), space: 'workspace' } : null,
      skillIndex, scene,
      locale: selection.locale, timezone: contextState.timezone, now: new Date(), groupChat,
      ...agentPromptPreferenceFields(preferences),
    }), availableMailPrompt].filter(Boolean).join('\n\n')
    contextState.systemPrompt = buildSystemPrompt(contextState.stylePreferences)
    const { readDesktopImMemory, readMemberReminder } = createDesktopImContext({ db, ownerId, groupChat, memoryFiles, hostRequest })
    const resolveProxy: NodeProviderTransportOptions['resolveProxy'] = preferences.useSystemProxy
      ? async (url, signal) => (await hostRequest('network.resolveProxy', { origin: url.origin }, signal) as ProxyEndpoint | null) ?? undefined
      : undefined
    const egress = publicReadEgress(scheduled ? scheduledAgentProxy : resolveProxy)
    const httpGet = createAgentHttpGetPort(egress)
    const webSearch = config ? createWebSearchTool(config, { ...egress, digest }) : undefined
    const [researchAvailable, imageSearchAvailable] = await Promise.all([
      hostRequest('agent.search.deep_research.available', {}),
      hostRequest('agent.search.similar_image_search.available', {}),
    ])
    const { deepResearch, similarImageSearch } = paidSearchTools()
    const authorize = async (identity: RunIdentity) => {
      if (scheduled) {
        const expected = scheduled.identity
        if (identity.ownerId !== ownerId || identity.ownerId !== expected.ownerId
          || identity.sessionId !== expected.sessionId || identity.runId !== expected.runId) return false
        await scheduled.assertCurrent()
        return true
      }
      if (sessionId === null || identity.ownerId !== ownerId || identity.sessionId !== String(sessionId)) return false
      const active = await admission.active(ownerId, sessionId)
      return active?.identity?.runId === identity.runId
    }
    async function desktopPrivateImOwner(identity: RunIdentity, signal?: AbortSignal) {
      const platform = desktopScheduleImPlatforms.find(value => value === imSession?.platform)
      if (!platform || imChatType !== 'c2c' || !await authorize(identity)) return null
      const target = await privateScheduleImTarget(platform, identity, signal)
      if (!target || target.chatType !== 'c2c' || target.platform !== platform || target.recipient !== target.boundUserId) return null
      const { rows } = await sql`SELECT 1 FROM desktop_im_sessions
        WHERE owner_id=${dataContext(identity.ownerId).ownerId.replaceAll('-', '')}
          AND session_id=${Number(identity.sessionId)} AND platform=${target.platform}
          AND connection_id=${desktopScheduleImConnection(target)}`.execute(db)
      return rows.length ? { platform, chatType: 'c2c', role: 'owner', verifiedOwner: true, allowedToolNames: null } as const : null
    }
    async function attachmentScope(identity: RunIdentity, signal: AbortSignal) {
      if (groupChat) return 'session'
      return !imSession || await desktopPrivateImOwner(identity, signal) ? 'owner' : 'session'
    }
    const undoPort = (identity: RunIdentity) => createAgentUndoLastActionPort({
      core, identity, undoContextId: `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128),
      async active(input, signal) {
        signal.throwIfAborted()
        return authorize(input.identity)
      },
      async apply(owner, contextId, operationId, resource) {
        if (!['mind', 'calendar', 'projects'].includes(resource))
          return { success: false, error: '最近操作类型尚未接入桌面撤销处理器' }
        try {
          const outcome = await undoStateMachine.apply(owner, contextId, operationId, 'undo')
          return { success: true, operation: outcome.operation, idempotent: outcome.idempotent }
        } catch (error) {
          const code = error instanceof UndoError ? error.statusCode : 0
          if (code === 404) return { success: false, error: '没有可撤销的操作' }
          if (code === 409) return { success: false, error: '最近的操作已变化，无法撤销' }
          throw error
        }
      },
    })
    const undoLastAction = core.receipts && interactive ? createUndoLastActionTool({
      apply: input => undoPort(input.identity).apply(input),
      reconcile: input => undoPort(input.identity).reconcile(input),
    }) : undefined
    const authorizeContext = async (identity: { ownerId: string; sessionId: string }) => {
      const active = contextState.boundIdentity
      return !!active && identity.ownerId === active.ownerId && identity.sessionId === active.sessionId && await authorize(active)
    }
    const knowledge = createOwnerAgentKnowledgeReadPort(core, knowledgeStore, {
      timezone: async () => contextState.timezone,
      authorize: identity => authorize(identity),
    })
    const fileSources = {
      resolveOwnedAttachment,
      async resolveFilePath(identity: RunIdentity, path: string, signal: AbortSignal) {
        signal.throwIfAborted()
        if (!await authorize(identity)) return null
        const value = await hostRequest('agent.files.resolve', { path }, signal)
        signal.throwIfAborted()
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null
        const file = value as Record<string, unknown>
        if (typeof file.root !== 'string' || !file.root || typeof file.relativePath !== 'string' || !file.relativePath
          || typeof file.name !== 'string' || typeof file.text !== 'boolean' || typeof file.extensionless !== 'boolean'
          || (file.extension !== undefined && typeof file.extension !== 'string')) return null
        return {
          name: file.name, root: file.root, relativePath: file.relativePath,
          text: file.text, extensionless: file.extensionless,
          ...(typeof file.extension === 'string' ? { extension: file.extension } : {}),
        }
      },
    }
    const viewImage = createViewImageTool({
      requiresHostConfirmation: true,
      authorize: async (identity, signal) => { signal.throwIfAborted(); return authorize(identity) },
      supportsImage: async (_identity, signal) => {
        signal.throwIfAborted()
        return config !== null && (config.capability_overrides?.image ?? config.image ?? adapterFor(config).capabilities(config).image) === true
      },
      async openAttachment(identity, attachId, signal) {
        const file = await resolveOwnedAttachment(identity, attachId, signal, await attachmentScope(identity, signal))
        if (file?.kind !== 'image') return null
        const opened = await openLocalFile(file.root, file.relativePath)
        if (!opened || opened.size === file.size_bytes) return opened
        await opened.handle.close()
        return null
      },
      async openPath(identity, path, signal, scope, call) {
        if (isAbsolute(path)) {
          if (!await authorize(identity)) return null
          const slot = /^\/references\/([1-6])$/u.exec(path)
          const { references } = await readDesktopTurnReferences(db, identity)
          // 已有历史仍可使用旧引用槽位，新提示使用宿主解析出的真实绝对路径。
          const candidates = slot ? [references[Number(slot[1]) - 1]] : references.slice(0, 6)
          for (const ref of candidates) {
            if (ref?.type !== 'file' || typeof ref.id !== 'string' || (!droppedFileReferenceId.test(ref.id) && !workspaceFileReferenceId.test(ref.id))) continue
            const file = await resolveReferencedFile(ref.id, signal)
            if (!scope.resolution && file && (slot || file.path === path)) return openDroppedFile(file.path, file.fileIdentity, signal)
          }
          if (path.startsWith('/references/')) return null
          if (isHostFilePath(path)) {
            const result = await authorizeHostFile(path, { path }, scope, call, viewImageConfirmation)
            if (!('target' in result)) return result
            return openDroppedFile(result.target.path, result.target.identity, signal)
          }
        }
        if (scope.resolution) return { error: '图片目标或授权已变化，请重新发起操作' }
        const file = await fileSources.resolveFilePath(identity, path, signal)
        return file ? openLocalFile(file.root, file.relativePath) : null
      },
      open: (url, signal) => egress.withTransport(signal, transport => transport.request({ url, method: 'GET', headers: {} }, signal)),
    })
    let runMemoryRebuild: MemoryRebuild | undefined
    const buildRag = createDesktopContextRag({
      core, contextState, contextPolicy: selection.contextPolicy, groupChat, embedding, memoryFiles, resolveProxy,
      readDesktopImMemory, authorize,
      onRecallFinished() {
        // 当前轮召回结束后再让后台登记持久化任务，避免与首轮读取争用 SQLite。
        if (runMemoryRebuild?.generation === embeddingGeneration) ragWorker.enqueueMemoryRebuild(runMemoryRebuild)
        runMemoryRebuild = undefined
      },
    })
    const scheduledTasks = createScheduledTaskQueries(createKyselyScheduledTaskReader(db, 'sqlite'),
      () => ({ workspaceSupported: false, filesystemAuthorizationEnabled: false }))
    const secret = await loadSqliteAgentRunSecret(db, databasePath)
    const replay = config && sessionId !== null && supportsCrossRunProviderReasoning(adapterFor(config).protocol(config), String(sessionId))
      ? { configuration: digest(config) } : undefined
    const continuation = createDesktopContinuationStore(db, secret, replay)
    const checkpoint = resumeIdentity ? await createSqliteAgentRunStore<CanonicalRunContext>(db, secret, {
      writeHistory: unavailable,
    }).read(resumeIdentity) : null
    if (resumeIdentity && (!checkpoint?.context || checkpoint.context.modelIdentity !== selection.modelIdentity))
      throw new CoreError('conflict', '模型配置已变更，无法恢复原运行')
    if (checkpoint?.context?.replyContext?.locale) selection.locale = checkpoint.context.replyContext.locale
    if (checkpoint) contextState.systemPrompt = buildSystemPrompt(contextState.stylePreferences)
    const agentLog = createAgentLog({
      regular: line => { void hostRequest('agent.log.append', { line, diagnostic: false }).catch(() => {}) },
      diagnostic: line => { void hostRequest('agent.log.append', { line, diagnostic: true }).catch(() => {}) },
      fingerprint: value => createHmac('sha256', secret).update(value).digest('hex'),
    })
    const builtinSkillMetadata = createBuiltinSkillMetadataReader(sceneBuiltins)
    const skillMetadata = groupChat ? builtinSkillMetadata : withFileSkillMetadata({
      dataRoot: knowledgeRoot, list: builtinSkillMetadata, mapPath: path => path,
    })
    const skills = await createAgentSkillRuntimePorts({
      ownerId, builtins: sceneBuiltins,
      fileSkills, isFileSkillEnabled,
      fingerprint: owner => createHmac('sha256', secret).update(owner).digest('hex'),
    })
    const resolveDesktopFileReference = async (_owner: string, id: string, signal?: AbortSignal) => {
      const file = await resolveReferencedFile(id, signal)
      return file ? { label: basename(file.path), path: file.path } : null
    }
    const canvasEdits = core.receipts ? createCanvasEditPort(core, async () => {}, resolveDesktopFileReference) : undefined
    const calendarEvents = createKyselyCalendarAgentReadPort(db, 'sqlite')
    const calendarTargets: CalendarReminderTargetPort = {
      async resolve(identity, reminders, signal) {
        signal.throwIfAborted()
        if (!await authorize(identity)) return { ok: false, error: '日历提醒运行授权已失效' }
        try {
          const resolved = []
          for (const reminder of reminders) {
            const delivery = await resolveScheduleDelivery(db, identity, {
              channels: reminder.channels ?? ['web'], mode: reminder.delivery_mode,
            }, signal)
            resolved.push({ channels: delivery.channels ?? ['web'],
              deliveryTargets: delivery.delivery_targets ?? null, enabled: reminder.enabled !== false })
          }
          if (!await authorize(identity)) return { ok: false, error: '日历提醒运行授权已失效' }
          return { ok: true, reminders: resolved }
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof ScheduledTaskReferenceError) return { ok: false, error: error.message }
          throw error
        }
      },
    }
    async function authorizeWrite(tx: Kysely<Database>, identity: RunIdentity, signal: AbortSignal) {
      signal.throwIfAborted()
      if (identity.ownerId !== ownerId || identity.sessionId !== String(sessionId)) return false
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      const { rows } = await sql`SELECT 1 FROM conversation_sessions s JOIN agent_run_leases l
        ON l.user_id=s.user_id AND l.session_id=s.id AND l.run_id=s.active_run_id
        LEFT JOIN agent_run_controls c ON c.user_id=l.user_id AND c.session_id=l.session_id AND c.run_id=l.run_id
        WHERE s.user_id=${owner} AND s.id=${sessionId} AND l.run_id=${identity.runId}
          AND l.expires_at_ms>${Date.now()} AND COALESCE(c.cancel_requested,0)=0`.execute(tx)
      signal.throwIfAborted()
      return rows.length === 1
    }
    const confirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_scheduled_task')
    const canvasConfirmations = {
      canvas_batch: createSqliteToolConfirmation(db, authorizeWrite, 'canvas_batch'),
      canvas_delete_note: createSqliteToolConfirmation(db, authorizeWrite, 'canvas_delete_note'),
      canvas_disconnect: createSqliteToolConfirmation(db, authorizeWrite, 'canvas_disconnect'),
      canvas_delete: createSqliteToolConfirmation(db, authorizeWrite, 'canvas_delete'),
    }
    const calendarConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_event')
    const clientDeleteConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_client')
    const skillDeleteConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_skill',
      (_tx, identity, input, snapshot) => describeFileSkillDeleteTarget(knowledgeRoot, identity.ownerId, input, snapshot))
    const knowledgeConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_knowledge',
      async (_tx, identity, input, snapshot): Promise<string> => {
        const id = (input as { knowledge_id?: unknown } | null)?.knowledge_id
        const target = typeof id === 'string'
          ? await knowledgeDeletePort?.readTarget(identity, id.trim(), AbortSignal.timeout(5000)) : null
        if (!target?.snapshot.displaySummary || target.snapshot.targetsDigest !== snapshot.targetsDigest
          || target.snapshot.versionsDigest !== snapshot.versionsDigest)
          throw new CoreError('conflict', '知识条目已变化')
        return target.snapshot.displaySummary
      })
    const knowledgeDeletePort = core.receipts && interactive
      ? createLocalAgentKnowledgeDeletePort(core, knowledgeRoot, knowledgeStore, knowledgeConfirmation, publishDesktopKnowledgeFile)
      : undefined
    const { sendEmail, listMail, emailConfirmation, availableMailPrompt: loadAvailableMail } = createDesktopEmailTool({
      core, ownerId, hostRequest, authorizeWrite, digest, enabled: interactive && !groupChat,
      imConfirmation: Boolean(imSession),
      authorize: async identity => await authorize(identity) && (!imSession || Boolean(await desktopPrivateImOwner(identity))),
    })
    const { shell, deleteItem, presentFile, isHostFilePath, authorizeHostFile, shellConfirmation, deleteItemConfirmation,
      presentConfirmation, sendItemConfirmation, viewImageConfirmation } = await createDesktopFileTools({
      db, interactive, authorize, authorizeWrite, hostRequest, digest,
      workspaceDirectoryId: typeof workspaceBinding?.directory_id === 'string' ? workspaceBinding.directory_id : undefined,
      readDesktopShellPreferences, resolveReferencedFile, moveShellTargetToTrash,
    })
    const { management: mcpManagement, mcpCrypto, mcpAddConfirmation, mcpUpdateConfirmation, mcpRemoveConfirmation } =
      createDesktopMcpManagement({
        core, ownerId, databasePath, interactive, authorizeWrite, resolveProxy, getRuntime: () => mcpRuntime,
      })
    const { sendFile, saveAttachment } = createDesktopAttachmentTools({
      db, interactive, allowFilePath: imChatType === 'c2c', groupChat, workspaceBinding: selection.workspaceBinding,
      authorize, attachmentScope, resolveOwnedAttachment, hostRequest, digest,
    })
    const { privateScheduleImTarget, scheduleImTarget, resolveScheduleDelivery, scheduleWrites, groupScheduleList } =
      createDesktopScheduleTools({
        core, ownerId, imPlatform: imSession?.platform, hasImSession: Boolean(imSession), groupChat,
        hostRequest, currentScheduledIm, scheduledTasks, authorizeWrite,
      })
    const registry = createOwnerToolRegistry({
      ...(listMail ? { listMail } : {}),
      ...(sendEmail ? { sendEmail } : {}),
      ...(saveAttachment ? { saveAttachment } : {}),
      sendFile,
      sendItemCards: interactive && sceneAllowsTool(scene, 'send_item', 'app_card'),
      mcpManagement,
      ...(shell ? { shell } : {}),
      ...(interactive ? { diskTrashTools: [deleteItem] } : {}),
      linkButtons: createWebLinkButtonDeliveryPort(authorize),
      core, authorize, webSearch,
      webDownload: createDesktopWebDownload({
        dataRoot: dirname(databasePath), authorized: authorize,
        readTarget: (signal, folderPath) => hostRequest('agent.files.downloadTarget', folderPath === undefined ? {} : { folderPath }, signal),
        commit: (input, signal) => hostRequest('agent.files.commitDownload', input, signal),
        open: (url, signal) => openStreamedAgentGet(createNodeProviderTransport({
          ...desktopTransportOptions(false, resolveProxy), connectTimeoutMs: 10_000, writeTimeoutMs: 10_000,
        }), url, signal),
      }),
      deepResearch: researchAvailable === true ? deepResearch : undefined,
      similarImageSearch: imageSearchAvailable === true ? similarImageSearch : undefined,
      skills, skillMetadata, callTool: true, knowledge, viewImage,
      ...(knowledgeDeletePort ? { knowledgeDelete: createKnowledgeDeleteTool(knowledgeDeletePort) } : {}),
      knowledgeWrites: createLocalAgentKnowledgeWritePort(core, knowledgeRoot, knowledgeStore, publishDesktopKnowledgeFile),
      presentFile,
      ...(core.receipts ? { skillManagement: createFileSkillManagementWriteTools(createDurableFileSkillManagementPort({ core, authorize: authorizeWrite,
          adapter: createDesktopAgentSkillMutationAdapter({ core, dataRoot: knowledgeRoot, hostRequest }),
        })) } : {}),
      ...(core.receipts && interactive ? {
        clientDelete: { ...createClientDeletePort(core, clientDeleteConfirmation), destructive: true },
        skillDelete: createFileSkillDeleteTool(knowledgeRoot, skillDeleteConfirmation,
          createDurableFileSkillDeletePort({ core, dataRoot: knowledgeRoot, confirmation: skillDeleteConfirmation, authorize: authorizeWrite,
            storage: createDesktopAgentSkillDeleteStorage({ core, dataRoot: knowledgeRoot, hostRequest }) })),
      } : {}),
      ...(undoLastAction ? { undoLastAction } : {}),
      async fileOverview(identity, projectId, signal) {
        signal.throwIfAborted()
        if (!await authorize(identity)) throw new CoreError('conflict', '当前运行无权读取项目文件')
        const counts = await hostRequest('agent.files.projectOverview', { projectId }, signal) as ProjectFileOverview
        signal.throwIfAborted()
        if (!await authorize(identity)) throw new CoreError('conflict', '当前运行无权读取项目文件')
        // get_project 使用共享文件统计 Schema 校验宿主回复。
        return counts
      },
      projects: createKyselyProjectCreateRuntime({ db, backend: 'sqlite', async publishProjectCreated() {} }),
      ...(core.receipts ? { projectMutations: createDurableProjectMutationPort({
        core,
        runtime: {
          // 桌面项目目录按最新项目元数据惰性定位；文件服务在读取项目目录时负责迁移旧目录。
          async renameProjectDirectory() {},
          async getFileCount() { return 0 },
          async publishProjectUpdated() {},
        },
        metadata: identity => ({ undoContextId: `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128) }),
      }) } : {}),
      ...(interactive ? { askUser: { ...askUserPolicy, authorization: async () => 'disabled' as const } } : {}),
      httpGet,
      remember: createSqliteRememberMemory(db, memoryFiles),
      memorySearch: createSqliteMemorySearch(db, authorize, embedding, memoryFiles, resolveProxy),
      recentAttachments: {
        async list(identity, signal) {
          signal.throwIfAborted()
          if (!await authorize(identity)) throw new CoreError('conflict', '近期附件运行授权已失效')
          const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
          const staged = await sql<RecentAttachmentRow>`SELECT attach_id,name,ext,kind,NULL AS platform,size,img_width,img_height,duration,created_at
            FROM chat_attachments WHERE user_id=${owner} AND state='draft' ORDER BY created_at DESC`.execute(db)
          signal.throwIfAborted()
          const attached = await sql<RecentAttachmentRow>`SELECT a.attach_id,a.name,a.ext,a.kind,NULL AS platform,a.size,a.img_width,a.img_height,a.duration,a.created_at
            FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id
            JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=a.user_id
            WHERE a.user_id=${owner} AND s.id=${Number(identity.sessionId)} AND a.state='attached'
            ORDER BY a.attached_at DESC,a.created_at DESC LIMIT 20`.execute(db)
          signal.throwIfAborted()
          if (!await authorize(identity)) throw new CoreError('conflict', '近期附件运行授权已失效')
          return projectRecentAttachments(staged.rows, attached.rows)
        },
      },
      conversationSearch: createCoreAgentConversationSearchPort({ db, backend: 'sqlite' }),
      conversations: { read: (identity, id, limit, signal) => readConversation(identity.ownerId, id, limit, signal) },
      time: agentClock,
      currentTime: agentClock,
      events: createKyselyCalendarReadPort(db, 'sqlite'),
      calendar: createAgentCalendarReader(calendarEvents),
      ...(core.receipts ? {
        calendarCreate: createCalendarEventCreatePort(core, async () => {}, calendarTargets, undefined,
          identity => `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128)),
        calendarUpdate: createCalendarEventUpdatePort(core, async () => {}, calendarEvents, calendarTargets, undefined,
          identity => `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128)),
        ...(interactive ? { calendarDelete: createCalendarDeletePort(core, async () => {}, calendarConfirmation,
          identity => `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128)) } : {}),
      } : {}),
      scheduledTasks: { list: (identity, signal) => scheduledTasks.agent(identity.ownerId, signal) },
      ...(core.receipts && interactive ? {
        scheduledTaskDelete: createScheduledTaskDeleteTool(core, confirmation, async () => {}),
      } : {}),
      ...(scheduleWrites.length ? { scheduledTaskWrites: scheduleWrites } : {}),
      notes: createAgentMindReader(db, 'sqlite', resolveDesktopFileReference),
      workspaces: agentWorkspaces,
      ...(interactive ? { projectWorkspaceBinding: async (identity, input, signal) => {
        signal.throwIfAborted()
        if (!await authorize(identity)) throw new CoreError('conflict', '工作区操作授权已失效')
        const result = await hostRequest('agent.files.projectWorkspaceBinding', {
          projectId: input.project_id, directoryId: input.workspace_id, bound: input.bound,
        }, signal)
        if (!result || typeof result !== 'object' || !('changed' in result) || typeof result.changed !== 'boolean')
          throw new CoreError('storage_error', '工作区关联结果无效')
        return result.changed
      } } : {}),
      ...(core.receipts ? { noteLifecycle: createNoteLifecyclePort(core, async () => {}) } : {}),
      ...(core.receipts ? { noteWrites: createNoteWritePort(core, { timezone: contextState.timezone,
        async validateFileReference(_owner, id, signal) { return Boolean(await resolveReferencedFile(id, signal)) },
        async publish() {} }) } : {}),
      canvases: createSqlMindCanvasReader(db, 'sqlite'),
      ...(canvasEdits ? {
        canvasCreation: createCanvasCreationPort(core, async () => {}),
        canvasEdits, canvasPlacements: canvasEdits, canvasRelations: canvasEdits,
      } : {}),
      ...(core.receipts && interactive ? {
        canvasBatch: createCanvasBatchPort(core, async () => {}, canvasConfirmations.canvas_batch, resolveDesktopFileReference),
        canvasDeleteNote: createCanvasDeleteNotePort(core, async () => {}, canvasConfirmations.canvas_delete_note),
        canvasDisconnect: createCanvasDisconnectPort(core, async () => {}, canvasConfirmations.canvas_disconnect),
        canvasDelete: createCanvasDeletePort(core, async () => {}, canvasConfirmations.canvas_delete),
      } : {}),
      canvasPlaceableSearch: createAgentPlaceableSearch(db, 'sqlite', async (_owner, query, limit, signal) => {
        const files = await hostRequest('agent.files.searchReferences', { query }, signal)
        if (!Array.isArray(files)) throw new CoreError('storage_error', '本机文件引用搜索结果无效')
        return files.filter((file): file is { id: string; label: string } =>
          file && file.type === 'file' && typeof file.id === 'string' && workspaceFileReferenceId.test(file.id) && typeof file.label === 'string').slice(0, limit)
      }),
      search: createGlobalSearchOperations([
        ...createKyselySqliteGlobalSearchSources(db),
        createFileSkillSearchSource(knowledgeRoot),
        ...createFileSearchSources((params, signal) =>
          hostRequest('agent.files.globalSearch', params, signal)),
      ]),
      searchAvailableSources: true,
    })
    if (config === null || sessionId === null) return { kind: 'catalog' as const, catalog: registry.catalog(), definitions: registry.definitions }
    const { tools, mcpRuntime, groupTools, groupSkillRegistry, delegation, configuredTools } =
      createDesktopToolRuntime({
        db, ownerId, sessionId, interactive, imSession: Boolean(imSession), imChatType, groupChat, registry,
        mcpCrypto, resolveProxy, authorize, hostRequest, configuredAgentTools, desktopPrivateImOwner, sceneBuiltins,
        agentClock, groupScheduleList, scheduleWrites, scheduleImTarget, researchAvailable, imageSearchAvailable,
        deepResearch, similarImageSearch, webSearch, httpGet, sendFile,
        delegationTools: () => createSubagentServiceTools(desktopSubagents(secret)),
      })
    const adapter = adapterFor(config)
    const imageOverride = config.capability_overrides?.image ?? config.image
    const protocol = adapter.protocol(config)
    const supportsImages = protocol === 'responses' ? adapter.responsesInputCapabilities(config).image
      : (imageOverride ?? (protocol !== 'ollama' && adapter.capabilities(config).image)) === true
    const imageLimits = adapter.mediaLimits(config)
    const fittedImages = new Map<string, { stamp: string; image: NonNullable<Awaited<ReturnType<typeof imageProcessor.fit>>> }>()
    const imageReferences = createCurrentTurnImageReferences(async (identity, id, signal, expectedSize) => {
      if (!supportsImages) return null
      const file = await resolveOwnedAttachment(identity, id, signal)
      if (!file || file.kind !== 'image' || file.size_bytes > IM_IMAGE_MAX_INPUT_BYTES
        || (expectedSize !== undefined && file.size_bytes !== expectedSize)) return null
      const handle = await openFile(join(file.root, file.relativePath), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      let bytes: Buffer
      let stamp: string
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== file.size_bytes) return null
        stamp = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
        const cached = fittedImages.get(id)
        if (cached?.stamp === stamp) return cached.image
        bytes = await handle.readFile({ signal })
        if (bytes.length !== file.size_bytes) return null
      } finally { await handle.close() }
      const image = await imageProcessor.fit({ bytes, ext: file.extension }, imageLimits, signal)
      if (image && (fittedImages.has(id) || fittedImages.size < 6)) fittedImages.set(id, { stamp, image })
      return image
    })
    const sessionSource = createSqliteAgentSessionSource(db, {
      skillDataRoot: knowledgeRoot,
      ...(supportsImages ? { images: {
        maxInputBytes: IM_IMAGE_MAX_INPUT_BYTES,
        readImage: (identity, attachment, signal) => imageReferences.readImage(identity, attachment.attach_id, signal, Number(attachment.size)),
      } } : {}),
      async readProjectPath(id, signal) {
        const path = await hostRequest('agent.files.projectPath', { projectId: id }, signal)
        return typeof path === 'string' ? path : null
      },
      async readReferencedFile(id, signal) {
        const file = await resolveReferencedFile(id, signal, true)
        if (!file) return null
        if (file.isFolder) return { name: basename(file.path), path: file.path, relativePath: file.relativePath, text: null, isFolder: true }
        const excerpt = await readDroppedFileExcerpt(file.path, file.fileIdentity, signal)
        return excerpt ? { ...excerpt, path: file.path, relativePath: file.relativePath } : null
      },
      async readAttachmentText(identity, attachment) {
      const attachId = attachment.attach_id
      if (!/^[0-9a-f]{32}$/.test(attachId)) throw new CoreError('not_found', '附件已过期或文件丢失')
      const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
      const { rows } = await sql<{ storage_key: string; size: number }>`SELECT a.storage_key,a.size FROM chat_attachments a
        JOIN agent_run_admissions r ON r.user_id=a.user_id AND r.user_message_id=a.message_id
        WHERE r.user_id=${owner} AND r.session_id=${Number(identity.sessionId)} AND r.run_id=${identity.runId}
          AND a.attach_id=${attachId} AND a.state='attached'`.execute(db)
      if (rows[0]?.storage_key !== `agent-attachments/${attachId}` || Number(rows[0].size) !== Number(attachment.size))
        throw new CoreError('not_found', '附件已过期或文件丢失')
      const handle = await openFile(`${dirname(databasePath)}/agent-attachments/${attachId}`,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== Number(attachment.size)) throw new CoreError('not_found', '附件已过期或文件丢失')
        return await handle.readFile('utf8')
      } finally { await handle.close() }
    } })
    const { source, contextBuilder } = createDesktopContextSource({
      ownerId, groupChat, contextState, selection, sessionSource, authorizeContext, readDesktopImMemory,
      hostRequest, readKnowledgeOverview, digest, buildSystemPrompt, observation,
    })
    let provider: (AgentProviderAuxiliaryPorts & Pick<ProviderRuntime, 'stageContinuation'>) | undefined
    let reflectionWork: Promise<void> = Promise.resolve()
    const { enqueueReflection, enqueueImReflection, drainReflections } = createDesktopReflectionWork({
      db, ownerId, sessionId, modelId, modelIdentity: selection.modelIdentity, timezone: contextState.timezone, promptDirectory,
      groupChat, memoryFiles, observation, sessionSource, hostRequest, reflection, scheduleReflectionRecovery,
      getProvider: () => provider, runAccessScope, digest,
    })
    const compaction = createLazyAgentCompactionPort(async () => {
      const identity = contextState.boundIdentity
      if (!provider || !identity || !await authorize(identity)) throw new Error('当前运行无权压缩会话')
      const scope = runAccessScope(identity)
      return createAgentCompactionPort({
        provider, identity, modelIdentity: selection.modelIdentity, stableSystem: contextState.systemPrompt,
        scope, scopeRevision: scope,
        contextTokens: selection.contextWindow, maxOutputTokens: config.max_tokens ?? DEFAULT_LLM_OUTPUT_TOKENS,
        instruction: readAgentPrompt('compress_conv.md', promptDirectory), digest, nextId: randomUUID,
        async loadTools(signal) {
          signal?.throwIfAborted()
          return (await configuredTools(identity)).map(tool => tool.schema)
        },
        diagnostic: error => { throw error },
      })
    })
    function runAccessScope(identity: RunIdentity) {
      return checkpoint?.context?.accessScopeHash ?? contextAccessScopeHash(identity, selection, digest)
    }
    const interactions = createSqliteInteractionActivator(db, createAgentInteractionDescription({
      confirmation: (tx, identity, request) => {
        const mcpAction = (request.toolCall.input as { action?: unknown } | null)?.action
        const name = request.toolCall.name
        if (Object.hasOwn(canvasConfirmations, name))
          return canvasConfirmations[name as keyof typeof canvasConfirmations].describe(tx, identity, request)
        if (name === 'send_email' && emailConfirmation) return emailConfirmation.describe(tx, identity, request)
        const handler = request.toolCall.name === 'shell' ? shellConfirmation
          : request.toolCall.name === 'delete_item' ? deleteItemConfirmation
          : request.toolCall.name === 'send_item' ? sendItemConfirmation
          : request.toolCall.name === 'open_item' ? presentConfirmation
          : request.toolCall.name === 'view_image' ? viewImageConfirmation
          : request.toolCall.name === 'delete_event' ? calendarConfirmation
          : request.toolCall.name === 'manage_mcp_servers'
            ? mcpAction === 'add' ? mcpAddConfirmation : mcpAction === 'update' ? mcpUpdateConfirmation : mcpRemoveConfirmation
          : request.toolCall.name === 'delete_knowledge' ? knowledgeConfirmation
          : request.toolCall.name === 'delete_skill' ? skillDeleteConfirmation
          : canonicalAgentToolName(request.toolCall.name) === 'delete_contact' ? clientDeleteConfirmation : confirmation
        return handler.describe(tx, identity, request)
      },
      credential: describeSqliteMcpCredential, authorization: unavailable,
    }, askUserPolicy))
    const runContext = createDesktopRunContextLoader({
      db, ownerId, contextState, selection, source, contextBuilder, sessionSource, privateImChat: imChatType === 'c2c',
      groupChat: Boolean(groupTools), canDelegate: Boolean(delegation), desktopPrivateImOwner, authorizeContext,
      readImChannels, readMemberReminder, hostRequest, preferenceFiles, preferences, embedding, memoryFiles,
      resolveProxy, buildSystemPrompt, sceneBuiltins, configuredTools, groupSkillRegistry,
      readMcpServices: owner => mcpRuntime.services(owner), digest,
      async loadMailPrompt(identity, signal) {
        availableMailPrompt = interactive && await authorize(identity) && (!imSession || await desktopPrivateImOwner(identity, signal))
          ? await loadAvailableMail(signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000)).catch(() => '')
          : ''
        signal?.throwIfAborted()
        return availableMailPrompt
      },
      recordMemoryRevision(revision) {
        if (memoryFiles && embeddingGenerationAtStart === embeddingGeneration) {
          const embeddingChanged = stableJson(memoryEmbedding?.settings ?? null) !== stableJson(embedding ?? null)
            || Boolean(memoryEmbedding?.resolveProxy) !== Boolean(embedding && resolveProxy)
          if (embeddingChanged) {
            memoryEmbedding?.controller.abort()
            memoryEmbedding = embedding ? { settings: embedding, resolveProxy, controller: new AbortController() } : undefined
          }
          if (ragWorker.lastMemoryRevision !== revision || embeddingChanged) {
            // 这里只登记运行时发现的刷新需求，显式记忆写入仍在原事务更新持久队列。
            runMemoryRebuild = { revision, generation: embeddingGenerationAtStart }
          }
        }
      },
    })
    const agent = createSqliteAgentRuntime({
      observation,
      settleStoppedRun: identity => settleStoppedSqliteAgentRun(db, databasePath, identity),
      db, secret, history: { persistPrivateContext: continuation.persist, onSubagentDeliveryCommitted: scheduleSubagentWake }, admission: {
        onCommitted: identity => notify(Number(identity.sessionId), identity.runId),
        async bindRun(tx, identity, input) {
          if (input.queueClaim) await createSqlAgentPendingQueue(db, 'sqlite', {}).consumeClaim(
            tx, identity.ownerId, Number(identity.sessionId), input.queueClaim.key, input.queueClaim.token,
          )
          if (modelId) await sql`INSERT INTO desktop_agent_run_models(user_id, session_id, run_id, model_id)
            VALUES(${dataContext(identity.ownerId).ownerId.replaceAll('-', '')}, ${identity.sessionId}, ${identity.runId}, ${modelId})`.execute(tx)
        },
      },
      projection: createSqliteInteractionProjection(db, secret),
      context: {
        digest, nextId: randomUUID,
        ...runContext,
        preparation: { buildRag },
        references: withViewImageReferences(imageReferences.codec),
        async writeSessionTitle(input, complete) {
          const owner = dataContext(input.identity.ownerId).ownerId.replaceAll('-', '')
          const { rows: [admission] } = await sql<{ user_message_id: number }>`
            SELECT user_message_id FROM agent_run_admissions
            WHERE user_id=${owner} AND session_id=${sessionId} AND run_id=${input.identity.runId}`.execute(db)
          if (admission && await createFirstTurnTitleWriter(db, 'sqlite')({
            identity: input.identity, anchorMessageId: String(admission.user_message_id), reply: input.text, locale: selection.locale, complete,
          })) notify(sessionId, input.identity.runId)
        },
        async persistCompaction(state) {
          if (!groupChat || !memoryFiles) return
          const ids = state.compactions.flatMap(item => item.result.changed ? item.result.coversUntilMessageIds : [])
          if (!ids.length) return
          const owner = dataContext(state.identity.ownerId).ownerId.replaceAll('-', '')
          await sql`INSERT INTO desktop_im_reflection_triggers(owner_id,session_id,requested_sequence)
            SELECT ${owner},s.id,MAX(m.conversation_seq) FROM conversation_sessions s
            JOIN conversation_messages m ON m.session_id=s.id AND m.role='user' AND m.canonical_batch_id IS NULL
            WHERE s.user_id=${owner} AND s.id=${Number(state.identity.sessionId)}
              AND m.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
            GROUP BY s.id
            ON CONFLICT(owner_id,session_id) DO UPDATE SET
              requested_sequence=MAX(desktop_im_reflection_triggers.requested_sequence,excluded.requested_sequence)`.execute(db)
          scheduleReflectionRecovery(0)
        },
        compaction, finalization: { complete: async input => {
          if (groupChat) await enqueueImReflection(input.identity, input.text, input.modelIdentity)
          else await enqueueReflection(input.identity, input.text, input.modelIdentity, input.hadTools)
          if (groupChat) reflectionWork = reflectionWork.then(() => drainReflections()).then(() => memoryFiles?.flush()).catch(() => {})
        } }, currentRequest: () => null,
        async initializeContinuation(context, signal, areaDigest) {
          const value = await continuation.readPrevious(context)
          signal.throwIfAborted()
          if (!value || !provider) return null
          return provider.stageContinuation({ identity: context.identity, modelIdentity: context.modelIdentity,
            accessScopeHash: context.accessScopeHash, round: 0, areaDigest, value })
        },
        stageContinuation: unavailable, releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
      },
      executor: { authorize: unavailable, executor: { execute: unavailable } },
      runtime: {
        clock: { now: () => new Date().toISOString() },
        tools,
        interactions,
        sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
        presentError: error => error instanceof ProviderError ? { code: error.code, text: providerErrorMessage(error) }
          : { code: 'agent_failed', text: '生成失败，请稍后重试' },
        presentToolResult: async value => value, publish: async event => { notify(sessionId, event.identity.runId) },
        log: agentLog.log, diagnose: agentLog.diagnose,
      },
      provider: {
        continuationStore: continuation.store,
        resolve: async (identity, _modelIdentity, signal) => {
          if (identity.ownerId !== ownerId || identity.sessionId !== String(sessionId)) throw new ProviderError('input_rejected')
          if (imChatType === 'c2c' && !await desktopPrivateImOwner(identity, signal)) throw new ProviderError('cancelled')
          return { modelIdentity: selection.modelIdentity, accessScopeHash: runAccessScope(identity), config, systemPrompt: contextState.systemPrompt }
        },
        transportFactory: createNodeProviderTransportFactory(desktopModelTransportOptions(config, resolveProxy)),
      },
    })
    provider = agent.provider
    return { kind: 'run' as const, agent, checkpoint, recoverReflections: drainReflections, drainReflections: async () => {
      await reflectionWork
    } }
  }

  async function createRunRuntime(...args: [sessionId: number, config: ProviderConfig, embedding?: RagQueryEmbeddingSettings,
    interactive?: boolean, resumeIdentity?: RunIdentity, modelId?: string, locale?: string, desktopChat?: boolean]) {
    const prepared = await prepareRunRuntime(...args)
    if (prepared.kind !== 'run') throw new CoreError('invalid_request', 'Agent 运行配置无效')
    return prepared
  }

  async function readImChannels(signal?: AbortSignal) {
    const snapshot: unknown = await hostRequest('agent.im.snapshot', {}, signal)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
      throw new CoreError('storage_error', '桌面 IM 渠道状态无效')
    const record = snapshot as Record<string, unknown>
    return Object.fromEntries(['feishu', 'qq', 'wechat', 'telegram'].map(platform => {
      const enabled = record[platform]
      if (typeof enabled !== 'boolean') throw new CoreError('storage_error', '桌面 IM 渠道状态无效')
      return [platform, enabled]
    }))
  }

  function publicReadEgress(resolveProxy?: NodeProviderTransportOptions['resolveProxy']) {
    return {
      async withTransport<T>(signal: AbortSignal, execute: (transport: ProviderTransport) => Promise<T>): Promise<T> {
        signal.throwIfAborted()
        const transport = createNodeProviderTransport({ ...desktopTransportOptions(false, resolveProxy),
          connectTimeoutMs: 10_000, writeTimeoutMs: 10_000 })
        try { return await execute(transport) }
        finally { await transport.close() }
      },
    }
  }

  const scheduledAgent = createDesktopScheduledAgent({
    core, promptDirectory, observation, filterTools: configuredAgentTools,
    shell: task => createDesktopScheduledShellBinding(task, readDesktopShellPreferences),
    async ownerTools(config, identity, assertCurrent) {
      const prepared = await prepareRunRuntime(null, config, undefined, false, undefined, undefined, 'zh-CN', false, {
        identity, assertCurrent,
      })
      if (prepared.kind !== 'catalog') throw new CoreError('invalid_request', '定时任务工具目录无效')
      return prepared.definitions
    },
    model: () => hostRequest('agent.schedules.model', {}) as Promise<ProviderConfig>,
    ...scheduledImContext,
    async deliverIm(target, text) { await hostRequest('agent.schedules.im.deliver', { target, text }, AbortSignal.timeout(30_000)) },
    loadGroupStyle: (identity, signal) => readSqliteOwnerStylePreferences(db, identity.ownerId, signal, preferenceFiles, true),
    contextData: {
      loadImChannels: (_identity, signal) => readImChannels(signal),
      loadStylePreferences: (identity, signal) => readSqliteOwnerStylePreferences(db, identity.ownerId, signal, preferenceFiles),
      async loadMemory(identity, signal, query = '') {
        const active = signal ?? new AbortController().signal
        await memoryFiles?.flush()
        const embedding = await hostRequest('agent.memory.resolveEmbedding', {}, active) as RagQueryEmbeddingSettings | null
        return (await readSqliteAgentMemory(db, identity.ownerId, query, active, embedding ?? undefined,
          memoryFiles, scheduledAgentProxy)).memory
      },
    },
    resolveProxy: scheduledAgentProxy,
  })
  async function scheduledAgentProxy(url: URL, signal?: AbortSignal) {
    const preferences = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(db, 'sqlite')).get(ownerId)
    return preferences.useSystemProxy
      ? (await hostRequest('network.resolveProxy', { origin: url.origin }, signal) as ProxyEndpoint | null) ?? undefined
      : undefined
  }
  return {
    async subagentSnapshot(sessionId: number, runId: string, childId: string) {
      const secret = await loadSqliteAgentRunSecret(db, databasePath)
      const result = await desktopSubagents(secret).inspect({ ownerId, sessionId: String(sessionId), runId }, childId, undefined, 1, true)
      return result.view === 'run' ? { run: result.run, rounds: result.rounds, task: result.task, finalMessage: result.finalMessage } : null
    },
    async runScheduledInstruction(...args: Parameters<typeof scheduledAgent>) {
      const result = scheduledAgent(...args)
      const done = result.then(() => {}, () => {})
      runTasks.add(done)
      try { return await result }
      finally { runTasks.delete(done) }
    },
    async listBuiltinTools() {
      const prepared = await prepareRunRuntime(null, null, undefined, true)
      if (prepared.kind !== 'catalog') throw new CoreError('invalid_request', 'Agent 工具目录无效')
      return prepared.catalog
    },
    async reconcileInterruptedRuns() {
      // 暂存回收独立于会话恢复，目录繁忙时留到下一次启动。
      void cleanupDesktopDownloadStaging(dirname(databasePath)).catch(() => undefined)
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      // 独占启动时，旧进程已无法提交反思；恢复认领且不增加已消耗的尝试次数。
      await sql`UPDATE desktop_agent_reflection_jobs
        SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
          claimed_at_ms=NULL,last_error='reflection_interrupted'
        WHERE user_id=${owner} AND status='processing'`.execute(db)
      await sql`UPDATE desktop_im_reflection_jobs
        SET status=CASE WHEN attempts>=3 AND NOT EXISTS(SELECT 1 FROM desktop_im_reflection_plans p
          WHERE p.owner_id=desktop_im_reflection_jobs.owner_id AND p.session_id=desktop_im_reflection_jobs.session_id
            AND p.run_id=desktop_im_reflection_jobs.run_id AND p.scope_type=desktop_im_reflection_jobs.scope_type
            AND p.scope_id=desktop_im_reflection_jobs.scope_id AND p.payload IS NOT NULL) THEN 'failed' ELSE 'queued' END,
          claimed_at_ms=NULL,last_error='reflection_interrupted'
        WHERE owner_id=${owner} AND status='processing'`.execute(db)
      const signal = AbortSignal.timeout(5_000)
      const { deepResearch, similarImageSearch } = paidSearchTools(signal)
      const recovery = createToolRegistry({ tools: [deepResearch, similarImageSearch], authorize: authorizeSearchRecovery })
      let childSecret: string | undefined
      await settleExclusiveSqliteAgentRuns(db, databasePath, ownerId, (call, identity) =>
        signal.aborted ? Promise.resolve({ kind: 'unknown' }) : recovery.tools.reconcile(call, identity),
      checkpoint => sessionRuns.resumeCheckpoint(checkpoint, signal), async (identity, source) => {
        if (source !== 'subagent') return false
        childSecret ??= await loadSqliteAgentRunSecret(db, databasePath)
        await dispatchAdmittedChild(childSecret, identity)
        return true
      })
    },
    resumeReflections,
    invalidateEmbedding() {
      embeddingGeneration++
      memoryEmbedding?.controller.abort()
      memoryEmbedding = undefined
    },
    start: sessionRuns.start,
    hasExecutingTasks: () => runTasks.size > 0,
    runModel: sessionRuns.runModel,
    respond: sessionRuns.respond,
    notifyCancel: sessionRuns.notifyCancel,
    async close() {
      subagentWakeAbort.abort()
      stopRetention()
      subagentRuntime.clearInteractionTimers()
      await reflection.close()
      await ragWorker.close()
      await memoryWarmup
      await drainAgentRuns([...runTasks], () => Promise.allSettled([...running.values()].map(run => run.cancel())))
      await subagentWake.drain()
    },
  }
}
