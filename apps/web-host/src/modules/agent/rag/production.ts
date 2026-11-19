import type { SqlDataRuntime } from '@gugu/core/data'
import type { CanonicalRunPreparationPorts, ContextSourceSelection, RunIdentity } from '@gugu/core/agent'
import type { RagSearchScope } from '@gugu/core/agent/rag'
import type { ProviderTransport } from '@gugu/core/providers'
import type { RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import type { Pool } from 'pg'
import type { AgentDispatchLease } from '../run/dispatch.js'
import type { createAgentToolRegistry } from '../tools/registry.js'
import { createAgentToolRegistry as createRegistry } from '../tools/registry.js'
import type { AgentToolRegistryOptions } from '../tools/registry.js'
import { createWebAgentRagToolPorts } from './tools.js'
import { createWebAgentRagContextBuilder } from './context.js'
import { createOwnerAgentRagVectorResolver } from './vectors.js'
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
}) {
  const authorizeMemory = createWebAgentMemoryAuthorizer(options.pool, options.lease, options.registry, options.preparation)
  const snapshot = createPostgresWebAgentMemorySnapshotReader(options.pool, options.lease)
  const ports = createWebAgentRagToolPorts({
    core: options.core,
    storageRoot: options.storageRoot,
    authorizeMemory: (identity: RunIdentity, signal, scopes) => authorizeMemory(identity, signal, scopes),
    snapshot,
    ...(options.embedding ? { embedding: options.embedding } : {}),
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
  const { pool, selection, enabled: hostEnabled, embedding, ...contextOptions } = options
  const lease = contextOptions.lease
  // Reconstructor 会先核对 accessVersion 与可信绑定的 selection.contextScopeKey，再请求资源装配此适配器。
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent RAG 运行来源无法验证')
  if (!selection.modelIdentity || !selection.contextScopeKey || selection.contextScopeKey !== lease.input.accessVersion)
    throw new TypeError('Web Agent RAG 配置版本与调度授权不匹配')
  const bound = Object.freeze({ ...lease.identity })
  const policy = Object.freeze({ ...selection.contextPolicy })
  const enabled = async (candidate: AgentDispatchLease) => {
    if (!policy.loadOwnerContext || candidate.identity.ownerId !== bound.ownerId
      || candidate.identity.sessionId !== bound.sessionId || candidate.identity.runId !== bound.runId
      || candidate.token !== lease.token || candidate.fence !== lease.fence) return false
    return hostEnabled(candidate)
  }
  const authorize = async (candidate: AgentDispatchLease, scope: RagSearchScope, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (!policy.loadOwnerContext || candidate.identity.ownerId !== bound.ownerId
      || candidate.identity.sessionId !== bound.sessionId || candidate.identity.runId !== bound.runId
      || candidate.token !== lease.token || candidate.fence !== lease.fence
      || scope.scope_type !== 'owner' || (scope.scope_id ?? '') !== '') return false
    const active = await pool.query(`SELECT 1 FROM conversation_sessions s
      JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3
        AND d.run_id=$3 AND d.state='selected' AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()`,
    [bound.ownerId, bound.sessionId, bound.runId, lease.token, lease.fence])
    signal?.throwIfAborted()
    return active.rowCount === 1
  }
  const vectors = embedding ? createOwnerAgentRagVectorResolver({
    root: contextOptions.storageRoot,
    resolveEmbedding: embedding.resolve,
    createTransport: embedding.createTransport,
  }) : undefined
  return createWebAgentRagContextBuilder({
    ...contextOptions,
    enabled: candidate => enabled(candidate),
    authorize,
    ...(vectors ? { vectors } : {}),
  })
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
  enabledFileRead?: boolean
  enabledFilePresent?: boolean
  enabledFileGrep?: boolean
  enabledFileDirectoryRead?: boolean
  enabledFileFolderDelete?: boolean
  enabledFileDelete?: boolean
  enabledFileEdit?: boolean
  enabledFileRename?: boolean
  enabledFileCopy?: boolean
  enabledFileCreate?: boolean
  enabledSaveUploadedFile?: boolean
  enabledRecentAttachments?: boolean
  enabledFolderCreate?: boolean
  enabledFolderRename?: boolean
  enabledFileMoveItems?: boolean
  enabledFileArchive?: boolean
  enabledSendFile?: boolean
  enabledHttpGet?: boolean
  enabledCalendarRead?: boolean
  enabledUpcoming?: boolean
  enabledDashboard?: boolean
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
  const { enabledConversationRead = false, enabledTime = false, enabledCalendarRead = false, enabledUpcoming = false, enabledDashboard = false, enabledWorkspaces = false, enabledWorkspaceMutations = false, enabledWorkspaceCreation = false, enabledWorkspaceUnlink = false, enabledWorkspaceDirectoryDelete = false, enabledUndoLastAction = false, enabledTrashList = false, enabledTrashRestore = false, enabledTrashPurge = false, enabledCanvasReads = false, enabledCanvasPlaceableSearch = false, enabledCanvasCreate = false, enabledCanvasMutations = false, enabledNoteReads = false, enabledNoteLifecycle = false, enabledProjectCreation = false, enabledProjectMutations = false, enabledClientTools = false, enabledClientDelete = false, enabledProjectOverview = false, enabledScheduledTasks = false, enabledCalendarCanvasTools = [], enabledKnowledgeRead = false, enabledKnowledgeWrites = false, enabledGlobalSearch = false, enabledAskUser = false, enabledLinkButtons = false, enabledFileRead = false, enabledFilePresent = false, enabledFileGrep = false, enabledFileDirectoryRead = false, enabledFileFolderDelete = false, enabledFileDelete = false, enabledFileEdit = false, enabledFileRename = false, enabledFileCopy = false, enabledFileCreate = false, enabledSaveUploadedFile = false, enabledRecentAttachments = false, enabledFileArchive = false, enabledFolderCreate = false, enabledFolderRename = false, enabledFileMoveItems = false, enabledSendFile = false, enabledHttpGet = false, ...runOptions } = options
  const authorization = createWebAgentRagRunAuthorization(options.pool, options.lease, { enabledShell: Boolean(runOptions.shell), enabledConversationRead, enabledTime, enabledCalendarRead, enabledUpcoming, enabledDashboard, enabledWorkspaces, enabledWorkspaceMutations, enabledWorkspaceCreation, enabledWorkspaceUnlink: enabledWorkspaceUnlink || Boolean(runOptions.workspaceUnlink && runOptions.workspaces), enabledWorkspaceDirectoryDelete: enabledWorkspaceDirectoryDelete || Boolean(runOptions.workspaceDirectoryDelete), enabledUndoLastAction: enabledUndoLastAction || Boolean(runOptions.undoLastAction), enabledTrashList, enabledTrashRestore, enabledTrashPurge: enabledTrashPurge || Boolean(runOptions.trashPurge), enabledCanvasReads, enabledCanvasPlaceableSearch, enabledCanvasCreate, enabledCanvasMutations, enabledNoteReads, enabledNoteLifecycle, enabledProjectCreation, enabledProjectMutations, enabledProjectDelete: Boolean(runOptions.projectDelete), enabledClientTools, enabledClientDelete, enabledProjectOverview, enabledScheduledTasks, enabledCalendarCanvasTools, enabledKnowledgeRead, enabledKnowledgeWrites, enabledKnowledgeDelete: Boolean(runOptions.knowledgeDelete), enabledRemember: Boolean(runOptions.remember), enabledGlobalSearch, enabledAskUser, enabledLinkButtons, enabledFileRead, enabledFilePresent, enabledFileGrep, enabledFileDirectoryRead, enabledFileFolderDelete, enabledFileDelete, enabledFileEdit, enabledFileRename, enabledFileCopy, enabledFileCreate, enabledSaveUploadedFile, enabledRecentAttachments, enabledFileArchive, enabledFolderCreate, enabledFolderRename, enabledFileMoveItems, enabledSendFile, enabledHttpGet, enabledSkillManagement: Boolean(runOptions.skillManagement), enabledSkillDelete: Boolean(runOptions.skillDelete), enabledNoteWrites: Boolean(runOptions.noteWrites), enabledCallTool: Boolean(runOptions.callTool), enabledMcpManagement: Boolean(runOptions.mcpManagement), enabledScheduledTaskWrites: Boolean(runOptions.scheduledTaskWrites?.length), enabledScheduledTaskDelete: Boolean(runOptions.scheduledTaskDelete), enabledSendEmail: Boolean(runOptions.sendEmail), enabledWebSearch: Boolean(runOptions.webSearch), enabledWebDownload: Boolean(runOptions.webDownload), enabledSimilarImageSearch: Boolean(runOptions.similarImageSearch), enabledDeepResearch: Boolean(runOptions.deepResearch) })
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
    readFile: enabledFileRead ? runOptions.readFile : undefined,
    presentFile: enabledFilePresent ? runOptions.presentFile : undefined,
    fileGrep: enabledFileGrep ? runOptions.fileGrep : undefined,
    fileEdit: enabledFileEdit ? runOptions.fileEdit : undefined,
    fileRename: enabledFileRename ? runOptions.fileRename : undefined,
    fileCopy: enabledFileCopy ? runOptions.fileCopy : undefined,
    fileCreate: enabledFileCreate ? runOptions.fileCreate : undefined,
    saveUploadedFile: enabledSaveUploadedFile ? runOptions.saveUploadedFile : undefined,
    recentAttachments: enabledRecentAttachments ? runOptions.recentAttachments : undefined,
    folderCreate: enabledFolderCreate ? runOptions.folderCreate : undefined,
    folderRename: enabledFolderRename ? runOptions.folderRename : undefined,
    fileMoveItems: enabledFileMoveItems ? runOptions.fileMoveItems : undefined,
    authorize: async (identity, name) => ownerContextAllowed && await authorization.authorize(identity, name),
    preparation: { configuration },
  })
  return { ...ports, configuration }
}
