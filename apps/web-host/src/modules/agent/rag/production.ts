import type { SqlDataRuntime } from '@gugu/core/data'
import type { AgentObservationPort, CanonicalRunPreparationPorts, ContextSourceSelection, RunIdentity } from '@gugu/core/agent'
import type { ProviderTransport } from '@gugu/core/providers'
import type { RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../run/dispatch.js'
import type { createAgentToolRegistry } from '../tools/registry.js'
import { createAgentToolRegistry as createRegistry } from '../tools/registry.js'
import type { AgentToolRegistryOptions } from '../tools/registry.js'
import { createWebAgentRagToolPorts } from './tools.js'
import { createWebAgentRagContextBuilder } from './context.js'
import { bindAgentConversationSearchOwner } from '../tools/conversations.js'
import { createPostgresWebAgentMemorySnapshotReader, createWebAgentMemoryAuthorizer } from './run.js'
import { createWebAgentRagRunAuthorization } from './authorize.js'
import type { WebCalendarCanvasToolName } from './authorize.js'

/**
 * 为单个已验证 Web lease 组合生产 RAG 查询端口。授权仍以同一 registry 的
 * capabilities 为准，快照来自同一 owner/session/run 的正式 PostgreSQL 会话行。
 */
export function createWebAgentProductionRagToolPorts(options: {
  core: Pick<SqlDataRuntime, 'db' | 'backend'>
  pool: Pick<Pool, 'query'>
  storageRoot: string
  lease: AgentDispatchLease
  registry: Pick<ReturnType<typeof createAgentToolRegistry>, 'capabilities'>
  preparation: Pick<CanonicalRunPreparationPorts, 'configuration'>
  embedding?: {
    resolve(ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
    createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
  }
  observation?: AgentObservationPort
}) {
  const authorizeMemory = createWebAgentMemoryAuthorizer(options.pool, options.lease, options.registry, options.preparation)
  const snapshot = createPostgresWebAgentMemorySnapshotReader(options.pool, options.lease)
  const ports = createWebAgentRagToolPorts({
    core: options.core,
    identity: options.lease.identity,
    storageRoot: options.storageRoot,
    authorizeMemory: (identity: RunIdentity, signal, scopes) => authorizeMemory(identity, signal, scopes),
    snapshot,
    ...(options.embedding ? { embedding: options.embedding } : {}),
    ...(options.observation ? { observation: options.observation } : {}),
  })
  return {
    ...ports,
    conversationSearch: bindAgentConversationSearchOwner(ports.conversationSearch, options.lease.identity.ownerId),
  }
}

/**
 * 生产自动 RAG 的同域装配入口：固定 dispatch lease、持久 Core 索引、授权策略，
 * 并在 Host 提供 embedding 配置时读取 owner 旧向量文件及实时向量。未配置 embedding
 * 时沿用 1.7.7 的词法召回路径，不伪造向量结果。
 */
export function createWebAgentProductionRagContextBuilder(options: {
  core: Pick<SqlDataRuntime, 'db' | 'backend'>
  pool: Pick<Pool, 'query'>
  storageRoot: string
  lease: AgentDispatchLease
  selection: Pick<ContextSourceSelection, 'contextPolicy' | 'contextScopeKey' | 'modelIdentity'>
  enabled(lease: AgentDispatchLease): boolean | Promise<boolean>
  embedding?: {
    resolve(ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
    createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
  }
  conversationMessageTime?(identity: import('@gugu/core/agent').HistoryIdentity, timestamp: string, signal?: AbortSignal): Promise<string>
}) {
  return createWebAgentRagContextBuilder(options)
}

/**
 * 构建同一实例授权的生产工具注册器。memory scope 校验需要重新读取实际
 * registry grant，因此这里用延迟闭包引用最终注册器，避免 Host 手工拼装时
 * 意外把授权检查接到另一份配置或仅有 search_memory 的替代注册器。
 */
export function createWebAgentProductionToolRegistry(options: Omit<AgentToolRegistryOptions, 'conversationSearch' | 'memorySearch'> & {
  pool: Pick<Pool, 'query'>
  storageRoot: string
  lease: AgentDispatchLease
  preparation: Pick<CanonicalRunPreparationPorts, 'configuration'>
  embedding?: {
    resolve(ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
    createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
  }
  observation?: AgentObservationPort
}) {
  let registry: ReturnType<typeof createAgentToolRegistry> | undefined
  const rag = createWebAgentProductionRagToolPorts({
    core: options.core,
    pool: options.pool,
    storageRoot: options.storageRoot,
    lease: options.lease,
    preparation: options.preparation,
    registry: {
      capabilities(identity) {
        if (!registry) throw new Error('Agent 工具注册器尚未完成装配')
        return registry.capabilities(identity)
      },
    },
    ...(options.embedding ? { embedding: options.embedding } : {}),
    ...(options.observation ? { observation: options.observation } : {}),
  })
  registry = createRegistry({ ...options, ...rag })
  return registry
}

/**
 * 为同一条 Web Run 一次性装配自动 RAG 和按需 RAG 工具。
 * 两条路径共享 owner、dispatch lease、embedding 解析及配置身份，避免 Host
 * 将自动注入和 search_conversations/search_memory 接到不同授权快照。
 */
export function createWebAgentProductionRagRunPorts(options: Omit<AgentToolRegistryOptions, 'conversationSearch' | 'memorySearch'> & {
  core: Pick<SqlDataRuntime, 'db' | 'backend'>
  pool: Pick<Pool, 'query'>
  storageRoot: string
  lease: AgentDispatchLease
  preparation: Pick<CanonicalRunPreparationPorts, 'configuration'>
  selection: Pick<ContextSourceSelection, 'contextPolicy' | 'contextScopeKey' | 'modelIdentity'>
  enabled(lease: AgentDispatchLease): boolean | Promise<boolean>
  embedding?: {
    resolve(ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null>
    createTransport(settings: RagQueryEmbeddingSettings): ProviderTransport
  }
  observation?: AgentObservationPort
  conversationMessageTime?(identity: import('@gugu/core/agent').HistoryIdentity, timestamp: string, signal?: AbortSignal): Promise<string>
}) {
  return {
    toolRegistry: createWebAgentProductionToolRegistry(options),
    ragContext: createWebAgentProductionRagContextBuilder(options),
  }
}

/**
 * Web 主 Run 的安全装配入口：授权和工具发现均绑定同一 dispatch lease，
 * 不接受调用方另行提供的宽授权器或另一份配置读取器。
 */
export function createAuthorizedWebAgentProductionRagRunPorts(options: Omit<Parameters<typeof createWebAgentProductionRagRunPorts>[0], 'authorize' | 'preparation'> & {
  enabledConversationRead?: boolean
  enabledTime?: boolean
  enabledCalendarCanvasTools?: readonly WebCalendarCanvasToolName[]
  enabledKnowledgeRead?: boolean
  enabledKnowledgeWrites?: boolean
  enabledGlobalSearch?: boolean
  enabledAskUser?: boolean
  enabledLinkButtons?: boolean
  enabledFilePresent?: boolean


  enabledFileFolderDelete?: boolean
  enabledFileDelete?: boolean

  enabledSaveAttachment?: boolean
  enabledRecentAttachments?: boolean

  enabledSendFile?: boolean
  enabledHttpGet?: boolean
  enabledCalendarRead?: boolean
  enabledUpcoming?: boolean
  enabledWorkspaces?: boolean
  enabledWorkspaceMutations?: boolean
  enabledWorkspaceCreation?: boolean
  enabledWorkspaceUnlink?: boolean
  enabledWorkspaceDirectoryDelete?: boolean
  enabledUndoLastAction?: boolean
  enabledTrashList?: boolean
  enabledTrashRestore?: boolean
  enabledTrashPurge?: boolean
  enabledCanvasReads?: boolean
  enabledCanvasPlaceableSearch?: boolean
  enabledCanvasCreate?: boolean
  enabledCanvasMutations?: boolean
  enabledNoteReads?: boolean
  enabledNoteLifecycle?: boolean
  enabledProjectCreation?: boolean
  enabledProjectMutations?: boolean
  enabledClientTools?: boolean
  enabledClientDelete?: boolean
  enabledProjectOverview?: boolean
  enabledScheduledTasks?: boolean
}) {
  const { enabledConversationRead = false, enabledTime = false, enabledCalendarRead = false, enabledUpcoming = false, enabledWorkspaces = false, enabledWorkspaceMutations = false, enabledWorkspaceCreation = false, enabledWorkspaceUnlink = false, enabledWorkspaceDirectoryDelete = false, enabledUndoLastAction = false, enabledTrashList = false, enabledTrashRestore = false, enabledTrashPurge = false, enabledCanvasReads = false, enabledCanvasPlaceableSearch = false, enabledCanvasCreate = false, enabledCanvasMutations = false, enabledNoteReads = false, enabledNoteLifecycle = false, enabledProjectCreation = false, enabledProjectMutations = false, enabledClientTools = false, enabledClientDelete = false, enabledProjectOverview = false, enabledScheduledTasks = false, enabledCalendarCanvasTools = [], enabledKnowledgeRead = false, enabledKnowledgeWrites = false, enabledGlobalSearch = false, enabledAskUser = false, enabledLinkButtons = false, enabledFilePresent = false, enabledFileFolderDelete = false, enabledFileDelete = false, enabledSaveAttachment = false, enabledRecentAttachments = false, enabledSendFile = false, enabledHttpGet = false, ...runOptions } = options
  const authorization = createWebAgentRagRunAuthorization(options.pool, options.lease, { enabledShell: Boolean(runOptions.shell), enabledConversationRead, enabledTime, enabledCalendarRead, enabledUpcoming, enabledWorkspaces, enabledWorkspaceMutations, enabledWorkspaceCreation, enabledWorkspaceUnlink: enabledWorkspaceUnlink || Boolean(runOptions.workspaceUnlink && runOptions.workspaces), enabledWorkspaceDirectoryDelete: enabledWorkspaceDirectoryDelete || Boolean(runOptions.workspaceDirectoryDelete), enabledUndoLastAction: enabledUndoLastAction || Boolean(runOptions.undoLastAction), enabledTrashList, enabledTrashRestore, enabledTrashPurge: enabledTrashPurge || Boolean(runOptions.trashPurge), enabledCanvasReads, enabledCanvasPlaceableSearch, enabledCanvasCreate, enabledCanvasMutations, enabledNoteReads, enabledNoteLifecycle, enabledProjectCreation, enabledProjectMutations, enabledProjectDelete: Boolean(runOptions.projectDelete), enabledClientTools, enabledClientDelete, enabledProjectOverview, enabledScheduledTasks, enabledCalendarCanvasTools, enabledKnowledgeRead, enabledKnowledgeWrites, enabledKnowledgeDelete: Boolean(runOptions.knowledgeDelete), enabledRemember: Boolean(runOptions.remember), enabledGlobalSearch, enabledAskUser, enabledLinkButtons, enabledImageView: Boolean(runOptions.viewImage), enabledFilePresent, enabledFileFolderDelete, enabledFileDelete, enabledSaveAttachment, enabledRecentAttachments, enabledSendFile, enabledHttpGet, enabledSkillManagement: Boolean(runOptions.skillManagement), enabledSkillDelete: Boolean(runOptions.skillDelete), enabledNoteWrites: Boolean(runOptions.noteWrites), enabledCallTool: Boolean(runOptions.callTool), enabledMcpManagement: Boolean(runOptions.mcpManagement), enabledScheduledTaskWrites: Boolean(runOptions.scheduledTaskWrites?.length), enabledScheduledTaskDelete: Boolean(runOptions.scheduledTaskDelete), enabledSendEmail: Boolean(runOptions.sendEmail), enabledWebSearch: Boolean(runOptions.webSearch), enabledWebDownload: Boolean(runOptions.webDownload), enabledSimilarImageSearch: Boolean(runOptions.similarImageSearch), enabledDeepResearch: Boolean(runOptions.deepResearch) })
  const ownerContextAllowed = options.selection.contextPolicy.loadOwnerContext === true
  const configuration: CanonicalRunPreparationPorts['configuration'] = async (identity, signal) => {
    const result = await authorization.configuration(identity, signal)
    return ownerContextAllowed ? result : { ...result, toolNames: [] }
  }
  const ports = createWebAgentProductionRagRunPorts({
    ...runOptions,
    askUser: enabledAskUser ? runOptions.askUser : undefined,
    workspaceCreation: enabledWorkspaceCreation ? runOptions.workspaceCreation : undefined,
    fileFolderDelete: enabledFileFolderDelete ? runOptions.fileFolderDelete : undefined,
    fileDelete: enabledFileDelete ? runOptions.fileDelete : undefined,
    linkButtons: enabledLinkButtons ? runOptions.linkButtons : undefined,
    presentFile: enabledFilePresent ? runOptions.presentFile : undefined,

    saveAttachment: enabledSaveAttachment ? runOptions.saveAttachment : undefined,
    recentAttachments: enabledRecentAttachments ? runOptions.recentAttachments : undefined,

    authorize: async (identity, name) => ownerContextAllowed && await authorization.authorize(identity, name),
    preparation: { configuration },
  })
  return { ...ports, configuration }
}
