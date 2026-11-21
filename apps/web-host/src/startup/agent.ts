import { mcpServiceReminder } from '@gugu/core/mcp/tool-directory'
import { canvasConfirmationLabels, createSaveAttachmentTool } from '@gugu/core/tools'
import { type SerialWorker } from '../workers/admission.js'
import { createOwnerFileTools } from '../modules/agent/tools/owner.js'
import { createAgentToolBrief } from '@gugu/core/agent/tool-brief'
import type { SharedOwnerToolOptions, ImOwnerToolFactory } from '../modules/agent/tools/registry.js'
import { createWebRuntimeLog } from '../shared/log-files.js'
import { createHash, randomUUID } from 'node:crypto'
import { createNodeProviderTransportFactory, isPublicAddress } from '@gugu/core/providers/node'
import { validateMcpEndpoint } from '@gugu/core/mcp/server-config'
import { createSessionWorkspaceTargetReader } from '@gugu/core/workspaces/shell-target'
import { resolveFileDirectoryRoot } from '../modules/workspaces/files.js'
import { readPostgresFolderPathMirrorKey } from '../modules/files/folders/paths.js'
import { createTerminalWorkspaceMounts, sandboxTarget } from '../modules/terminals/sandbox/mounts.js'
import { AgentRunError, createFirstTurnTitleWriter, stableJson } from '@gugu/core/agent'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { createPostgresTaskExternal } from '../modules/scheduled-tasks/store.js'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import { createMcpSkillToolDirectory } from '../modules/mcp/skill-tool-directory.js'
import { createMcpRuntime } from '../modules/mcp/runtime.js'
import { createMcpSettingsReader } from '../modules/mcp/status.js'
import { createRedisExpiringValueStore, createRedisValueReader } from '../adapters/cache/redis-events.js'
import { createImPlatformSettingsReader } from '../modules/im/settings.js'
import { createConfiguredByokEnvelope, readConfiguredByokMasterKeys } from '../modules/byok/crypto.js'
import { createPostgresAgentEmbeddingSettingsResolver } from '../modules/byok/store.js'
import { createAgentRagEmbeddingTransportFactory } from '../modules/agent/rag/transport.js'
import { createUserSkillManager } from '@gugu/core/agent/skills/user-management'
import { createUserSkillReader } from '@gugu/core/agent/skills/user-body'
import { createLocalAgentRememberPort } from '../modules/agent/tools/memory/write.js'
import { filterConfiguredWebAgentTools } from '../modules/agent/tools/registry.js'
import { createAgentSkillRuntimePorts, createBuiltinSkillDefinitions, formatBuiltinSkillIndex } from '@gugu/core/skills'
import { createSkillMetadataReader } from '@gugu/core/skills'
import { createSafeEgressSettingsReader } from '../modules/admin/network.js'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { type Database, type SqlDataRuntime } from '@gugu/core/data'
import { createAgentWorkspaceQueries, createKyselyAgentWorkspaceReader } from '@gugu/core/workspaces'
import { createGlobalSearchOperations, createKyselyDashboardCounter } from '@gugu/core'
import { type WebUiConfig } from '../config.js'
import { readConfigOverride, resolveConfigOverridePath } from '../adapters/config/config-override-file.js'
import { createRedisLiveSubscription } from '../adapters/cache/redis-live-subscription.js'
import { createPostgresUserQuotaReader } from '../modules/auth/quota/read.js'
import { createAgentMindReader, createAgentPlaceableSearch, createSqlMindCanvasReader } from '@gugu/core/mind'
import { createKnowledgeDeleteTool, createProjectDeleteTool, createCanvasCreationPort, createClientDeletePort, createNoteWritePort, createSkillDeleteTool, createSkillManagementWriteTools, createMcpManagementTool, createMcpManagementCreateOperations, createMcpManagementRemoveOperations, createMcpManagementEditOperations, createScheduledTaskDeleteTool, formatScheduledTaskDeleteSummary, createDurableProjectMutationPort, createWebLinkButtonDeliveryPort, createWorkspaceMutationPort, createWorkspaceDirectoryDeleteTool, createUndoLastActionTool } from '@gugu/core/tools'
import { createHostCoreUndoOperations } from '../modules/undo/service.js'
import { createLocalFileUndoStorage } from '../modules/files/storage/undo.js'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '@gugu/core/scheduled-task-list'
import { createScheduledTaskContextLoader, scheduledTaskSupportsFileDelivery } from '@gugu/core/scheduled-task-run-now'
import { createWebScheduledTaskAgentAttempt } from '../modules/scheduled-tasks/run/attempt.js'
import { createWebScheduledTaskContextSources } from '../modules/scheduled-tasks/run/context.js'
import { createWebScheduledTaskToolResources } from '../modules/scheduled-tasks/run/tools.js'
import { readEmailProfile, smtpSettings } from '../modules/scheduled-tasks/delivery/email.js'
import { sanitizeEmailHtml } from '@gugu/core/email/smtp-test'
import { createSmtpTestDelivery } from '../adapters/email/smtp-test-delivery.js'
import { createWebAgentEmailTool } from '../modules/agent/tools/email.js'
import { createPostgresProjectDeleteJournal } from '../modules/undo/journal.js'
import { createOwnerReflectionExtractor } from '../modules/agent/memory/reflection/model.js'
import { createReflectionModelScope } from '../modules/agent/llm/recovery.js'
import { authorizeOwnerReflectionWrite, createPostgresOwnerReflectionSource } from '../modules/agent/memory/reflection/source.js'
import { createOwnerReflectionWork } from '../modules/agent/memory/reflection/work.js'
import { createLocalOwnerReflectionWriter } from '../modules/agent/memory/reflection/write.js'
import { createPostgresWebReflectionIntervals } from '../modules/agent/memory/reflection/intervals.js'
import { createRedisAgentReflectionInbox, createRedisAgentReflectionQueue } from '../modules/agent/memory/reflection/queue.js'
import { createLocalAgentKnowledgeReadStore } from '../modules/agent/rag/knowledge.js'
import { createWebOwnerAgentKnowledgeReadPort } from '../modules/agent/tools/knowledge/list.js'
import { createAgentKnowledgeOverviewLoader } from '../modules/agent/tools/knowledge/list.js'
import { createLocalAgentKnowledgeDeletePort, createLocalAgentKnowledgeWritePort } from '../modules/agent/tools/knowledge/write.js'
import { createAgentImChannelLoader } from '../modules/agent/context/channels.js'
import { createLocalPreferenceTextFiles } from '../modules/preferences/persistence/personality-files.js'
import { createWebCurrentMessageMaterializer } from '../modules/agent/context/message.js'
import { formatAgentHistoryMessageTime } from '../modules/agent/context/time.js'
import { createWebAgentReconstructor, createWebAgentRagResources } from '../modules/agent/run/reconstruct.js'
import { createWebLoopScopeTrace } from '../modules/loopscope/trace.js'
import { readAgentPrompt } from '@gugu/core/agent/context/prompts'
import { createWebAgentPromptReader, webAgentPromptRoot } from '../modules/agent/context/prompts.js'
import { createWebAgentMcpProductionPorts } from '../modules/agent/tools/mcp/production.js'
import { createWebAgentRunLifecycle } from '../modules/agent/run/lifecycle.js'
import { createConfiguredWebAgentProviderBinding } from '../modules/agent/llm/configured.js'
import { createWebAgentSearchPorts } from '../modules/agent/tools/search.js'
import { createWebAgentCalendarWritePorts } from '../modules/agent/tools/calendar.js'
import { createWebAgentCanvasMutationPorts, createWebAgentCanvasWritePorts } from '../modules/agent/tools/canvas.js'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from '../modules/agent/tools/confirm.js'
import type { AgentRunBinding } from '@gugu/core/agent'
import { createAgentShellSnapshotReader } from '../modules/agent/sandbox/snapshot.js'
import { createWebAgentScheduledTaskWrites } from '../modules/agent/tools/schedule.js'
import { createPostgresTrustedIntentStore } from '../modules/agent/interactions/intents.js'
import { createTrustedPromptDescriptions } from '../modules/agent/interactions/prompts.js'
import { createAgentInteractionDescription } from '@gugu/core/agent'
import { createPostgresInteractionProjection } from '../modules/agent/interactions/projection.js'
import { createAgentInteractionRespondService } from '../modules/agent/interactions/respond.js'
import { createRedisProviderContinuationStore } from '../modules/agent/run/continuation.js'
import { createPostgresAgentInteractionCommandEffects } from '../modules/agent/interactions/effects.js'
import { createAgentSecretInteractionService } from '../modules/agent/interactions/secret.js'
import { createInteractionResumeEnqueuer } from '../modules/agent/interactions/resume.js'
import { createPostgresSecretInteraction } from '../modules/agent/interactions/secrets.js'
import { createPostgresAgentRunStore } from '../modules/agent/run/store.js'
import { createPostgresAgentDispatch, type AgentDispatchLease } from '../modules/agent/run/dispatch.js'
import { createAgentConversationReadPort } from '../modules/agent/tools/conversations.js'
import { createViewImageTool, withViewImageReferences } from '../modules/agent/tools/files/image.js'
import { adapterFor, type ProviderRuntimeOptions } from '@gugu/core/providers'
import { createMindFileReferenceResolver, createMindFileReferences } from '../modules/mind/file-references.js'
import { createWebAgentFilePresentPort } from '../modules/agent/tools/files/present.js'
import { createWebAgentSaveAttachmentPort } from '../modules/agent/tools/files/save.js'
import { createWebAgentRecentAttachmentsPort } from '../modules/agent/tools/files/recent.js'
import { createWebAgentFileFolderDeletePort } from '../modules/agent/tools/files/delete.js'
import { createProjectFileOverviewPort } from '../modules/agent/tools/overview.js'
import { projectAgentRunEvent } from '../modules/agent/run/events.js'
import { createKyselyProjectCreateRuntime } from '@gugu/core/project-create-data'
import {
  createPostgresProjectUpdateRuntime,
  createLocalProjectDirectoryRenamer,
  createProjectPostCommitPublisher,
} from '../modules/projects/update.js'
import { createBorrowedPostgresProjectTrashTransaction } from '../modules/projects/lifecycle/store.js'
import { createLocalProjectTrashStorage } from '../modules/projects/lifecycle/storage.js'
import { createCalendarEventPostCommitPublisher, createCalendarMutationPostCommitPublisher } from '../modules/calendar/publish.js'
import { createPostgresWorkspaceCreator } from '../modules/workspaces/store.js'
import { createPostgresWorkspaceDirectoryOperations } from '../modules/workspaces/directories.js'
import { createWebAgentWorkspaceCreatePort } from '../modules/agent/tools/workspaces/create.js'
import { createWebAgentWorkspaceDirectoryDeletePort } from '../modules/agent/tools/workspaces/delete.js'
import { createWebAgentAskUserAuthorization } from '../modules/agent/tools/ask.js'
import { createWebAgentUndoLastActionPort } from '../modules/agent/tools/undo.js'
import { createAgentToolLabelPicker } from '@gugu/core/agent-sessions'
import { createAgentStateLabelOverrides } from '../modules/agent/sessions/labels.js'
import { extractOfficeText } from '@gugu/core/files/office-text'
import { createPostgresFileUploadOperations } from '../modules/files/upload.js'
import { createWebAgentDiskDownloadTool } from '../modules/agent/tools/files/download.js'
import { createPublicAgentEgress } from '../adapters/network/safe-egress-proxy.js'
import { createPostgresFolderDeleteOperations } from '../modules/files/folders/delete.js'
import { createRedisAgentCancellationCommands, createRedisScheduledTaskCommands, type RedisEventPublisher } from '../adapters/cache/redis-events.js'
import { createWebAgentLog, writeTimestampedAgentDiagnostic } from '../modules/agent/run/diagnostics.js'
import { createSecurityEventFingerprint } from '../modules/admin/audit.js'
import type { createMindServices } from './mind.js'
import { booleanSetting, objectSetting, userQuotaSettings } from './settings.js'
import type { FilesystemAuthorizationConfirmationPort } from '../modules/agent/sandbox/authorization.js'
import type { TaskWriteOptions } from '../modules/scheduled-tasks/store.js'
import type { createWebScheduledAttachmentResources } from '../modules/scheduled-tasks/delivery/files.js'

interface AgentDependencies {
  config: WebUiConfig
  pool: Pool
  core: SqlDataRuntime
  env: NodeJS.ProcessEnv
  publisher: RedisEventPublisher
  capabilitySkills: ReturnType<typeof createBuiltinSkillDefinitions>
  filesystemAuthorizationConfirmations: FilesystemAuthorizationConfirmationPort
  readMcpSettings: ReturnType<typeof createMcpSettingsReader>
  mcpSkillTools: ReturnType<typeof createMcpSkillToolDirectory>
  mcpRuntime: ReturnType<typeof createMcpRuntime>
  projectTrashStorage: ReturnType<typeof createLocalProjectTrashStorage>
  projectDirectoryRenamer: ReturnType<typeof createLocalProjectDirectoryRenamer>
  canRebuildAgentMemoryIndex: () => boolean
  bubblewrapRootfs: string | undefined
  shellMounts: ReturnType<typeof createTerminalWorkspaceMounts>
  readAgentShellSnapshot: ReturnType<typeof createAgentShellSnapshotReader>
  projectDeleteJournal: ReturnType<typeof createPostgresProjectDeleteJournal> | undefined
  fileUploads: ReturnType<typeof createPostgresFileUploadOperations>
  searchUsageSchemaApplied: boolean
  folderDelete: ReturnType<typeof createPostgresFolderDeleteOperations>
  projectCreateRuntime: ReturnType<typeof createKyselyProjectCreateRuntime>
  publishProjectMutation: ReturnType<typeof createProjectPostCommitPublisher>
  projectUpdateRuntime: ReturnType<typeof createPostgresProjectUpdateRuntime>
  publishCanvasChanged: ReturnType<typeof createMindServices>['publishCanvasChanged']
  scheduledNotifyImPlatforms: ReturnType<typeof createImPlatformSettingsReader>
  workspaceCreate: ReturnType<typeof createPostgresWorkspaceCreator>
  workspaceDirectories: ReturnType<typeof createPostgresWorkspaceDirectoryOperations>
  userSkillManager: ReturnType<typeof createUserSkillManager<Database>>
  globalSearch: ReturnType<typeof createGlobalSearchOperations>
  resolveEmbeddingSettings: ReturnType<typeof createPostgresAgentEmbeddingSettingsResolver>
  createEmbeddingTransport: ReturnType<typeof createAgentRagEmbeddingTransportFactory>
  publishCalendarCreate: ReturnType<typeof createCalendarEventPostCommitPublisher>
  publishCalendarMutation: ReturnType<typeof createCalendarMutationPostCommitPublisher>
  loopScopeTrace: ReturnType<typeof createWebLoopScopeTrace>
  scheduledAttachments: ReturnType<typeof createWebScheduledAttachmentResources>
  downloadAttachment: Parameters<typeof createWebAgentSaveAttachmentPort>[0]["downloadAttachment"]
  scheduledTaskWriteOptions: TaskWriteOptions
  runAgent: SerialWorker
  scheduledWorkers(): { once: boolean; repeating: boolean }
  refreshScheduledWorkers(): Promise<void>
  readStateLabelOverrides: ReturnType<typeof createAgentStateLabelOverrides>
}

export async function createAgentServices(options: AgentDependencies) {
  const {
    config, pool, core, env,
    publisher, capabilitySkills, filesystemAuthorizationConfirmations, readMcpSettings,
    mcpSkillTools, mcpRuntime, projectTrashStorage, projectDirectoryRenamer,
    canRebuildAgentMemoryIndex, bubblewrapRootfs, shellMounts, readAgentShellSnapshot,
    projectDeleteJournal, fileUploads, searchUsageSchemaApplied,
    folderDelete, projectCreateRuntime,
    publishProjectMutation, projectUpdateRuntime, publishCanvasChanged, scheduledNotifyImPlatforms,
    workspaceCreate, workspaceDirectories,
    userSkillManager, globalSearch, resolveEmbeddingSettings, createEmbeddingTransport,
    publishCalendarCreate, publishCalendarMutation, loopScopeTrace, readStateLabelOverrides,
  } = options
  let imOwnerTools: ImOwnerToolFactory | undefined
  let scheduledAttempt: ReturnType<typeof createWebScheduledTaskAgentAttempt> | null = null
  let agentRunLifecycle: ReturnType<typeof createWebAgentRunLifecycle> | null = null
  let ownerReflectionWork: ReturnType<typeof createOwnerReflectionWork> | undefined
  let agentInteractionRespond: ReturnType<typeof createAgentInteractionRespondService> | null = null
  let agentSecretInteraction: ReturnType<typeof createAgentSecretInteractionService> | null = null
  const runtimeLog = createWebRuntimeLog(config.logFile)
  const agentLog = createWebAgentLog(config.logFile, createSecurityEventFingerprint(config.secretKey))
  const delivery = createPostgresTaskExternal({
    secretKey: config.secretKey,
    async readWechatPrivate(owner) {
      if (!config.redisUrl) return null
      const raw = await createRedisValueReader(config.redisUrl)(`imreach-private:${owner}:wechat`)
      if (!raw) return null
      try {
        const value: unknown = JSON.parse(raw)
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
      } catch { return null }
    },
    async revokeConfirmation(owner, summary, identity) {
      await filesystemAuthorizationConfirmations.revoke(owner, summary, identity)
    },
  })
  const agentWorkspaces = createAgentWorkspaceQueries(createKyselyAgentWorkspaceReader(core.db, 'postgres'))
  const searchMindFiles = createMindFileReferences(pool, config.storageLocalPath)
  const resolveMindFile = createMindFileReferenceResolver(pool, config.storageLocalPath)
  const knowledgeStore = createLocalAgentKnowledgeReadStore(config.storageLocalPath)
  const skillMetadataReady = config.redisUrl ? capabilitySkills.then(definitions => createSkillMetadataReader(core.db, 'postgres', definitions)) : null
  async function commonTools(lease: AgentDispatchLease, timezone: string,
    deleteConfirmation?: Parameters<typeof createWebAgentCalendarWritePorts>[0]['deleteConfirmation'],
    authorize?: () => Promise<boolean>,
    emailAuthorization?: Parameters<typeof createWebAgentScheduledTaskWrites>[1]['emailAuthorization'],
    accessVersion = async () => await authorize?.() ? lease.input.accessVersion : ''): Promise<SharedOwnerToolOptions> {
    const mind = createWebAgentCanvasMutationPorts({
    core,
    resolveFileReference: resolveMindFile,
    publish: async event => {
      if ('entityKind' in event) {
        await publisher.publishResourceChanged({
          ownerId: event.ownerId, resource: 'mind', operation: event.operation,
          entityId: event.entityId, origin: event.origin, mutationId: event.mutationId,
          payload: { kind: event.entityKind, entity: event.entity },
        })
        return
      }
      if (!('operation' in event)) {
        await publisher.publishResourceChanged({
          ownerId: event.ownerId, resource: 'mind', operation: 'create',
          entityId: event.entityId, origin: event.origin, mutationId: event.mutationId,
          payload: { kind: 'note', entity: event.entity },
        })
        return
      }
      const entity = event.entity as Record<string, unknown>
      const kind = 'srcNodeId' in entity || 'src_node_id' in entity ? 'relation'
        : 'canvas_id' in entity ? 'canvas_item' : 'canvas'
      await publisher.publishResourceChanged({
        ownerId: event.ownerId, resource: 'mind', operation: event.operation,
        entityId: event.entityId, origin: event.origin,
        ...('mutationId' in event && event.mutationId ? { mutationId: event.mutationId } : {}),
        payload: { kind, entity },
      })
    },
    publishNote: async event => {
      const nodeId = event.operation === 'delete' ? event.nodeId : event.note.id
      await publisher.publishResourceChanged({
        ownerId: event.ownerId,
        resource: 'mind',
        operation: event.operation,
        entityId: nodeId,
        origin: null,
        payload: { kind: 'note', entity: event.operation === 'delete' ? { id: nodeId } : event.note },
      })
    },
    })
    const authorization = createWebAgentConfirmationAuthorization({ pool, lease, accessVersion })
    const authorizeRunWrite: Parameters<typeof createMcpManagementEditOperations>[1]['authorize'] = async (tx, identity, signal) =>
      (await authorization.authorizeInTransaction(tx, identity, signal))?.endsWith(`:${lease.input.accessVersion}`) === true
    return {
      skillMetadata: await skillMetadataReady ?? undefined,
      ...(core.receipts ? { skillManagement: createSkillManagementWriteTools(core, userSkillManager, authorizeRunWrite) } : {}),
      knowledge: createWebOwnerAgentKnowledgeReadPort(core, knowledgeStore, { timezone: async () => timezone }),
      ...(process.platform === 'linux' ? {
        knowledgeWrites: createLocalAgentKnowledgeWritePort(core, config.storageLocalPath, knowledgeStore),
      } : {}),
      projects: projectCreateRuntime,
      search: globalSearch,
      conversations: createAgentConversationReadPort(pool),
      workspaces: agentWorkspaces,
      workspaceMutations: createWorkspaceMutationPort(core),
      fileOverview: createProjectFileOverviewPort(pool),
      projectMutations: createDurableProjectMutationPort({
        core,
        runtime: {
          renameProjectDirectory: projectUpdateRuntime.renameProjectDirectory,
          getFileCount: projectUpdateRuntime.getFileCount,
          publishProjectUpdated: projectUpdateRuntime.publishProjectUpdated,
        },
        metadata: identity => ({ undoContextId: `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128) }),
      }),
      canvases: createSqlMindCanvasReader(core.db, 'postgres'),
      canvasPlaceableSearch: createAgentPlaceableSearch(core.db, 'postgres', searchMindFiles),
      canvasCreation: createCanvasCreationPort(core, publishCanvasChanged),
      ...mind,
      ...(lease.input.source === 'im' ? { noteLifecycle: undefined } : {}),
      notes: createAgentMindReader(core.db, 'postgres', resolveMindFile),
      noteWrites: createNoteWritePort(core, {
        timezone,
        async validateFileReference(owner, id) { return Boolean(await resolveMindFile(owner, id)) },
        async publish(event) {
          await publisher.publishResourceChanged({
            ownerId: event.ownerId, resource: 'mind', operation: event.operation,
            entityId: event.note.id, origin: null, mutationId: event.mutationId,
            payload: { kind: 'note', entity: event.note },
          })
        },
      }),
      scheduledTaskWrites: createWebAgentScheduledTaskWrites(core, {
        writes: options.scheduledTaskWriteOptions,
        emailAuthorization,
        filesystemRevocation: {
          revokeConfirmation: (owner, summary, identity) => filesystemAuthorizationConfirmations.revoke(owner, summary, identity),
          fingerprint: createSecurityEventFingerprint(config.secretKey),
        },
        authorize: authorization.authorizeInTransaction,
        accessVersion: lease.input.accessVersion,
        workers: options.scheduledWorkers(),
        async emailAvailable(ownerId, client) {
          const profile = await readEmailProfile(client ?? pool, ownerId)
          if (!profile?.ownerEmail) return false
          return Boolean(smtpSettings(profile, config.smtp, config.secretKey).host)
        },
        imEnabled: platform => scheduledNotifyImPlatforms().includes(platform),
        async publish(ownerId, operation, entityId) {
          await Promise.all([
            options.refreshScheduledWorkers(),
            publisher.publishResourceChanged({ ownerId, resource: 'scheduled_tasks', operation, entityId, origin: null }),
          ])
        },
      }),
      scheduledTasks: {
        list(identity: import('@gugu/core/agent').RunIdentity, signal: AbortSignal) {
          const queries = createScheduledTaskQueries(createKyselyScheduledTaskReader(core.db, 'postgres'), () => ({
            workspaceSupported: true,
            filesystemAuthorizationEnabled: config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
          }))
          return queries.agent(identity.ownerId, signal)
        },
      },
      ...createWebAgentCalendarWritePorts({
        core, pool, lease, delivery, authorize,
        publishCreate: publishCalendarCreate,
        publishUpdate: publishCalendarMutation,
        publishDelete: publishCalendarMutation,
        ...(deleteConfirmation ? { deleteConfirmation } : {}),
      }),
    }
  }
  if (config.redisUrl) {
    const agentRedisUrl = config.redisUrl
    const providerContinuationStore = createRedisProviderContinuationStore(createRedisExpiringValueStore(agentRedisUrl), config.secretKey)
    const overridePath = config.configOverridePath ?? resolveConfigOverridePath(env)
    const override = readConfigOverride(overridePath)
    const agentSettings = objectSetting(override.agent)
    const searchSettings = objectSetting(override.search)
    const memoryEnabled = booleanSetting(undefined, agentSettings.memory_enabled, true)
    const ragEnabled = booleanSetting(undefined, searchSettings.rag_enabled, true)
    const serverTimezone = userQuotaSettings(config, env).serverTimezone
    const promptRoot = webAgentPromptRoot(config.storageLocalPath)
    const readPrompts = createWebAgentPromptReader(promptRoot)
    if (Object.values(readPrompts()).some(value => !value.trim())) throw new Error('Web Agent 提示词不可用')
    const builtinSkillDefinitions = await capabilitySkills
    const skillMetadata = await skillMetadataReady!
    const skillIndex = formatBuiltinSkillIndex(builtinSkillDefinitions)
    const redisValues = createRedisValueReader(config.redisUrl)
    const imPlatforms = createImPlatformSettingsReader(env, overridePath)
    const providerBinding = await createConfiguredWebAgentProviderBinding({
      pool,
      configPath: overridePath,
      versionSecret: config.secretKey,
      promptRoot,
      environment: env,
      permissionIdentity: 'web-agent-owner-context-v1',
      contextPolicy: () => ({ loadOwnerContext: true, memoryEnabled }),
      defaultLimit6h: userQuotaSettings(config, env).defaultLimit6h,
    })
    const confirmationKeys = await readConfiguredByokMasterKeys(env)
    const confirmationVersionText = env.CREDENTIALS_MASTER_KEY_VERSION ?? '1'
    const confirmationVersion = Number(confirmationVersionText)
    const trustedIntents = confirmationKeys[String(confirmationVersion)]
      ? createPostgresTrustedIntentStore(version => confirmationKeys[String(version)] ?? '', confirmationVersion)
      : null
    const trustedPrompts = createTrustedPromptDescriptions({
      loadIntent: (client, identity, request) => trustedIntents
        ? trustedIntents.loadIntent(client, identity, request)
        : Promise.resolve(null),
      createConfirmation: (ownerId, summary, identity, ttlMinutes) => filesystemAuthorizationConfirmations
        .createPending(ownerId, summary, identity, ttlMinutes),
      filesystemAuthorizationEnabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
    })
    const interactionActivation = {
      ...createAgentInteractionDescription(trustedPrompts),
      ...(readMcpSettings().enabled === true ? {
        async cancelPendingSecrets(client: PoolClient, identity: import('@gugu/core/agent').RunIdentity) {
          await client.query(`UPDATE mcp_secret_inputs SET status='cancelled', encrypted_payload='', payload_nonce='', encrypted_data_key=''
            WHERE user_id=$1 AND session_id=$2 AND status IN ('pending_choice','awaiting_secret')`, [identity.ownerId, identity.sessionId])
        },
      } : {}),
    }
    const makeConfirmation = (lease: AgentDispatchLease, action: string, imAuthorize?: () => Promise<boolean>) => {
      if (!trustedIntents) return undefined
      const authorization = createWebAgentConfirmationAuthorization({
        pool, lease, accessVersion: async identity => imAuthorize
          ? await imAuthorize() ? lease.input.accessVersion : ''
          : providerBinding.accessVersion(identity, lease.input.source === 'web' ? lease.input.model : undefined),
      })
      const labels: Record<string, string> = {
        unlink_workspace: '解除工作区的 Shell 与会话绑定，不删除目标资源',
        delete_workspace_directory: '永久删除顶层物理工作区目录及其中内容',
        delete_event: '软删除日历事件及其提醒，可在当前会话撤销',
        delete_client: '删除联系人，此操作不可恢复',
        ...canvasConfirmationLabels,
      }
      return createWebAgentToolConfirmation({
        pool, intents: trustedIntents, lease, action, imOwnerAuthorized: Boolean(imAuthorize),
        authorize: authorization.authorize,
        authorizeInTransaction: authorization.authorizeInTransaction,
        async describe(_binding, snapshot) {
          if (action === 'send_email' || action === 'delete_knowledge' || action === 'update_mcp_server' || action === 'add_mcp_server'
            || action === 'delete_workspace_directory' || action === 'permanent_delete'
            || action === 'delete_file' || action === 'restore_file' || action === 'restore_folder'
            || action === 'create_scheduled_task' || action === 'update_scheduled_task' || action === 'shell') {
            if (!snapshot.displaySummary) throw new Error('操作确认摘要不可用')
            return { summary: snapshot.displaySummary }
          }
          if (action === 'delete_project') {
            const ids = snapshot.targetIds?.project_id
            if (!ids?.length) throw new Error('项目删除确认目标无效')
            const result = await pool.query<{ name: string }>(
              'SELECT name FROM projects WHERE user_id=$1 AND deleted_at IS NULL AND id=ANY($2::int[]) ORDER BY id',
              [_binding.ownerId, [...ids]],
            )
            if (result.rows.length !== ids.length) throw new Error('项目删除确认目标已变化')
            const names = Array.from(result.rows.slice(0, 10).map(row => row.name).join('、').replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, 420).join('')
            const files = snapshot.targetIds?.file_id?.length ?? 0
            return { summary: `将把 ${ids.length} 个项目（${names}）及 ${files} 个关联文件移入回收站，并停用关联日历提醒` }
          }
          if (action === 'delete_client') {
            const ids = snapshot.targetIds?.client_id
            if (!ids?.length) throw new Error('联系人删除确认目标无效')
            const result = await pool.query<{ id: number; name: string }>(
              'SELECT id,name FROM clients WHERE user_id=$1 AND id=ANY($2::int[]) ORDER BY id',
              [_binding.ownerId, [...ids]],
            )
            if (result.rows.length !== ids.length) throw new Error('联系人删除确认目标已变化')
            const names = result.rows.map(row => row.name)
            const visible = names.slice(0, 10).join('、') + (names.length > 10 ? `等 ${names.length} 个` : '')
            return { summary: `将删除联系人：${visible}，共 ${names.length} 个，此操作不可恢复` }
          }
          if (action === 'unlink_workspace') {
            const ids = snapshot.targetIds?.workspace_id
            if (ids?.length !== 1) throw new Error('工作区解除绑定确认目标无效')
            const result = await pool.query<{ name: string }>(
              'SELECT name FROM workspaces WHERE user_id=$1 AND id=$2', [_binding.ownerId, ids[0]],
            )
            const workspace = result.rows[0]
            if (!workspace) throw new Error('工作区解除绑定确认目标已变化')
            const name = Array.from(workspace.name.replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, 200).join('')
            return { summary: `解除工作区「${name}」的 Shell 与会话绑定，不删除项目、文件夹或文件` }
          }
          if (action === 'delete_skill') {
            const ids = snapshot.targetIds?.skill_row_id
            if (ids?.length !== 1) throw new Error('技能删除确认目标无效')
            const result = await pool.query<{ skill_id: string; name: string }>(
              "SELECT skill_id,name FROM user_skills WHERE owner_id=$1 AND id=$2 AND source='user'",
              [_binding.ownerId, ids[0]],
            )
            const skill = result.rows[0]
            if (!skill) throw new Error('技能删除确认目标已变化')
            return { summary: `将删除技能「${skill.name}」（${skill.skill_id}），此操作不可恢复` }
          }
          if (action === 'delete_scheduled_task') {
            const ids = snapshot.targetIds?.task_id
            if (!ids?.length) throw new Error('定时任务删除确认目标无效')
            const result = await pool.query<{ name: string }>(
              'SELECT name FROM scheduled_tasks WHERE user_id=$1 AND event_id IS NULL AND id=ANY($2::int[]) ORDER BY id',
              [_binding.ownerId, [...ids]],
            )
            if (result.rows.length !== ids.length) throw new Error('定时任务删除确认目标已变化')
            return { summary: formatScheduledTaskDeleteSummary(result.rows) }
          }
          const targets = Object.entries({ ...snapshot.targetIds, ...snapshot.targetRefs }).map(([kind, ids]) =>
            `${kind}：${ids.length ? ids.join('、') : '级联内容'}`).join('；')
          const summary = `${labels[action] ?? '执行受保护操作'}。目标：${targets}`
          return { summary }
        },
      })
    }
    function ownerMcpManagement(lease: AgentDispatchLease, imAuthorize?: () => Promise<boolean>) {
      const mcpRemoveConfirmation = makeConfirmation(lease, 'remove_mcp_server', imAuthorize)
      const mcpUpdateConfirmation = makeConfirmation(lease, 'update_mcp_server', imAuthorize)
      const mcpCreateConfirmation = makeConfirmation(lease, 'add_mcp_server', imAuthorize)
      const mcpCrypto = createConfiguredByokEnvelope(env)
      const authorization = createWebAgentConfirmationAuthorization({
        pool, lease, accessVersion: async identity => imAuthorize
          ? await imAuthorize() ? lease.input.accessVersion : ''
          : providerBinding.accessVersion(identity, lease.input.source === 'web' ? lease.input.model : undefined),
      })
      const authorizeRunWrite: Parameters<typeof createMcpManagementEditOperations>[1]['authorize'] = async (tx, identity, signal) =>
        (await authorization.authorizeInTransaction(tx, identity, signal))?.endsWith(`:${lease.input.accessVersion}`) === true
      const validateMcpToolEndpoint = (endpoint: string) => validateMcpEndpoint(endpoint, isPublicAddress)
      return createMcpManagementTool({
        list: createMcpServerConfigLister(core.db),
        decrypt: mcpCrypto.decrypt,
        enabled: () => readMcpSettings().enabled === true,
        state: (owner, id) => mcpRuntime.state(owner, id),
        testConnection: mcpRuntime.testConnection,
      }, mcpRemoveConfirmation ? createMcpManagementRemoveOperations(core, {
        crypto: mcpCrypto, maxTools: () => readMcpSettings().max_tools_per_server,
      }, {
        confirmation: mcpRemoveConfirmation,
        invalidate: (owner, id) => mcpRuntime.invalidate(owner, id),
      }) : undefined, core.receipts ? createMcpManagementEditOperations(core, {
        decrypt: mcpCrypto.decrypt,
        authorize: authorizeRunWrite,
        async afterCommit(owner, id, enabled, signal) {
          await mcpRuntime.invalidate(owner, id)
          if (enabled && !signal.aborted) return mcpRuntime.load(owner, id)
        },
        ...(mcpUpdateConfirmation ? { update: {
          crypto: mcpCrypto,
          maxTools: () => readMcpSettings().max_tools_per_server,
          validateEndpoint: validateMcpToolEndpoint,
          confirmation: mcpUpdateConfirmation,
          ...(trustedIntents ? { credential: { id: randomUUID, stage: trustedIntents.stageMcpCredential } } : {}),
        } } : {}),
      }) : undefined, core.receipts && mcpCreateConfirmation && trustedIntents ? createMcpManagementCreateOperations(core, {
        settings: readMcpSettings, id: randomUUID, encrypt: mcpCrypto.encrypt,
        validateEndpoint: validateMcpToolEndpoint, authorize: authorizeRunWrite, confirmation: mcpCreateConfirmation,
        stageCredential: trustedIntents.stageMcpCredential,
      }) : undefined)
    }
    function confirmedOwnerTools(lease: AgentDispatchLease, authorize?: () => Promise<boolean>) {
      const confirmation = (action: string) => makeConfirmation(lease, action, authorize)
      const clientDeleteConfirmation = confirmation('delete_client')
      const projectDeleteConfirmation = projectDeleteJournal ? confirmation('delete_project') : undefined
      const scheduledTaskDeleteConfirmation = confirmation('delete_scheduled_task')
      const skillDeleteConfirmation = confirmation('delete_skill')
      const knowledgeDeleteConfirmation = process.platform === 'linux' && core.receipts ? confirmation('delete_knowledge') : undefined
      const emailConfirmation = confirmation('send_email')
      const canvasDeleteConfirmation = confirmation('canvas_delete')
      const canvasDeleteNoteConfirmation = confirmation('canvas_delete_note')
      const canvasDisconnectConfirmation = confirmation('canvas_disconnect')
      const canvasBatchConfirmation = confirmation('canvas_batch')
      return {
        ...(trustedIntents ? createWebAgentCanvasWritePorts({
          core,
          resolveFileReference: resolveMindFile,
          batchConfirmation: canvasBatchConfirmation,
          deleteNoteConfirmation: canvasDeleteNoteConfirmation,
          disconnectConfirmation: canvasDisconnectConfirmation,
          deleteConfirmation: canvasDeleteConfirmation,
          publishBatchAndNotes: async event => {
            if ('entityKind' in event) {
              await publisher.publishResourceChanged({
                ownerId: event.ownerId, resource: 'mind', operation: event.operation,
                entityId: event.entityId, origin: event.origin, mutationId: event.mutationId,
                payload: { kind: event.entityKind, entity: event.entity },
              })
              return
            }
            if (!('operation' in event)) {
              await publisher.publishResourceChanged({
                ownerId: event.ownerId, resource: 'mind', operation: 'create',
                entityId: event.entityId, origin: event.origin, mutationId: event.mutationId,
                payload: { kind: 'note', entity: event.entity },
              })
              return
            }
            const entity = event.entity as Record<string, unknown>
            const kind = 'srcNodeId' in entity || 'src_node_id' in entity ? 'relation'
              : 'canvas_id' in entity ? 'canvas_item' : 'canvas'
            await publisher.publishResourceChanged({
              ownerId: event.ownerId, resource: 'mind', operation: event.operation,
              entityId: event.entityId, origin: event.origin,
              ...('mutationId' in event && event.mutationId ? { mutationId: event.mutationId } : {}),
              payload: { kind, entity },
            })
          },
          async publishDisconnect(event) {
            await publisher.publishResourceChanged({
              ownerId: event.ownerId, resource: 'mind', operation: event.operation,
              entityId: event.entityId, origin: event.origin, mutationId: event.mutationId,
              payload: { kind: 'relation', entity: event.entity },
            })
          },
          async publishDelete(event) {
            await publisher.publishResourceChanged({
              ownerId: event.ownerId, resource: 'mind', operation: event.operation,
              entityId: event.entityId, origin: event.origin,
              payload: { kind: 'canvas', entity: event.entity },
            })
          },
        }) : {}),
        ...(emailConfirmation ? {
          sendEmail: createWebAgentEmailTool({
            core, pool, confirmation: emailConfirmation, secretKey: config.secretKey, globalSmtp: config.smtp,
            storageRoot: config.storageLocalPath, send: createSmtpTestDelivery(env), sanitizeHtml: sanitizeEmailHtml,
          }),
        } : {}),
        ...(clientDeleteConfirmation ? { clientDelete: createClientDeletePort(core, clientDeleteConfirmation) } : {}),
        ...(projectDeleteJournal && projectDeleteConfirmation ? {
          projectDelete: createProjectDeleteTool(core, {
            ...projectDeleteJournal, transactionPort: createBorrowedPostgresProjectTrashTransaction,
            storage: projectTrashStorage, publish: publishProjectMutation,
          }, projectDeleteConfirmation),
        } : {}),
        ...(scheduledTaskDeleteConfirmation ? {
          scheduledTaskDelete: createScheduledTaskDeleteTool(core, scheduledTaskDeleteConfirmation, async (ownerId, id) => {
            await publisher.publishResourceChanged({ ownerId, resource: 'scheduled_tasks', operation: 'delete', entityId: id, origin: null })
          }),
        } : {}),
        ...(skillDeleteConfirmation ? {
          skillDelete: createSkillDeleteTool(core, { gate: skillDeleteConfirmation.gate, claim: skillDeleteConfirmation.claim }, async ownerId =>
            publisher.publishResourceChanged({ ownerId, resource: 'skills', operation: 'refresh' })),
        } : {}),
        ...(knowledgeDeleteConfirmation ? { knowledgeDelete: createKnowledgeDeleteTool(createLocalAgentKnowledgeDeletePort(
          core, config.storageLocalPath, knowledgeStore, knowledgeDeleteConfirmation,
        )) } : {}),
      }
    }
    function imageTool(lease: AgentDispatchLease, resolve: ProviderRuntimeOptions['resolve'], modelIdentity: string | null | undefined,
      authorize?: () => Promise<boolean>) {
      const egress = createPublicAgentEgress(createSafeEgressSettingsReader(env, overridePath), config.secretKey)
      return createViewImageTool({
        async authorize(identity, signal) {
          signal.throwIfAborted()
          return identity.ownerId === lease.identity.ownerId && identity.sessionId === lease.identity.sessionId && identity.runId === lease.identity.runId
            && await dispatch.isCurrent(lease) && (!authorize || await authorize())
        },
        async supportsImage(identity, signal) {
          if (!modelIdentity) return false
          const { config } = await resolve(identity, modelIdentity, signal)
          return (config.capability_overrides?.image ?? config.image ?? adapterFor(config).capabilities(config).image) === true
        },
        async mount(identity) {
          if (!bubblewrapRootfs) return null
          const snapshot = await readAgentShellSnapshot(identity.ownerId, identity.sessionId)
          if (!snapshot?.facts.userEnabled) return null
          return shellMounts(identity.ownerId, snapshot.workspaceId, snapshot.facts.fullUserSandboxWrite, '.')
        },
        open: egress.open,
      })
    }
    const readFileWorkspace = createSessionWorkspaceTargetReader(core.db, 'postgres')
    async function ownerFileTools(lease: AgentDispatchLease, binding: Pick<AgentRunBinding, 'resolve' | 'selection'>,
      allowsConfirmation: boolean, authorize?: () => Promise<boolean>) {
      const diagnose = (reason: string) => {
        try {
          agentLog.log.write({ identity: lease.identity, at: Date.now(), level: 'info',
            event: 'agent.tools.shell_unavailable', attributes: { shellAvailabilityReason: reason } })
        } catch { /* 诊断日志不可影响工具装配。 */ }
      }
      const authorizeFiles = async (identity: import('@gugu/core/agent').RunIdentity, signal: AbortSignal,
        report?: (reason: string) => void) => {
        signal.throwIfAborted()
        if (identity.ownerId !== lease.identity.ownerId || identity.sessionId !== lease.identity.sessionId
          || identity.runId !== lease.identity.runId) return false
        if (!await dispatch.isCurrent(lease)) { report?.('lease_inactive'); return false }
        if (authorize && !await authorize()) { report?.('im_unauthorized'); return false }
        signal.throwIfAborted()
        return true
      }
      const readShell = async (identity: import('@gugu/core/agent').RunIdentity, report?: typeof diagnose) => {
        const snapshot = await readAgentShellSnapshot(identity.ownerId, identity.sessionId, report)
        if (snapshot && !snapshot.facts.userEnabled) report?.('user_disabled')
        return snapshot?.facts.userEnabled ? snapshot : null
      }
      const read = async (identity: import('@gugu/core/agent').RunIdentity, signal: AbortSignal) => {
        if (!await authorizeFiles(identity, signal, diagnose)) return null
        const snapshot = await readShell(identity)
        signal.throwIfAborted()
        return snapshot
      }
      const confirmation = allowsConfirmation && bubblewrapRootfs ? makeConfirmation(lease, 'shell', authorize) : undefined
      if (!allowsConfirmation) diagnose('confirmation_unavailable')
      else if (!bubblewrapRootfs) diagnose('sandbox_unavailable')
      else if (!confirmation) diagnose('confirmation_unavailable')
      const imAuthorized = !confirmation || !authorize || await authorize()
      if (!imAuthorized) diagnose('im_unauthorized')
      // 装配先于 Run 激活。执行仍须校验已激活的会话与当前 fencing lease。
      const shell = confirmation && bubblewrapRootfs && imAuthorized && await readShell(lease.identity, diagnose)
        ? { rootfs: bubblewrapRootfs, confirmation, log: runtimeLog,
          claim: (reference: Parameters<typeof confirmation.claim>[1], signal: AbortSignal) =>
            core.db.transaction().execute(tx => confirmation.claim(tx, reference, signal)) }
        : undefined
      const deleteFile = allowsConfirmation && makeConfirmation(lease, 'delete_file', authorize)
      const restoreFile = allowsConfirmation && makeConfirmation(lease, 'restore_file', authorize)
      const restoreFolder = allowsConfirmation && makeConfirmation(lease, 'restore_folder', authorize)
      const purgeFile = allowsConfirmation && makeConfirmation(lease, 'permanent_delete', authorize)
      return createOwnerFileTools({
        shell, read, mounts: shellMounts, viewImage: imageTool(lease, binding.resolve, binding.selection.modelIdentity, authorize),
        ...(process.platform === 'linux' && deleteFile && restoreFile && restoreFolder && purgeFile ? { trash: {
          pool, storageRoot: config.storageLocalPath,
          async authorize(identity, signal) {
            if (!await authorizeFiles(identity, signal, diagnose)) return false
            const result = await pool.query(`SELECT 1 FROM users WHERE id=$1
              AND is_active=TRUE AND COALESCE(account_status,'active')='active'`, [identity.ownerId])
            signal.throwIfAborted()
            return result.rowCount === 1
          },
          async currentDirectory(identity) {
            const { ownerId, sessionId } = identity
            const target = await readFileWorkspace(ownerId, Number(sessionId))
            if (!target) return null
            if (target.kind === 'folder') {
              const client = await pool.connect()
              try { return sandboxTarget(await readPostgresFolderPathMirrorKey(client, ownerId, target.folderId)) }
              finally { client.release() }
            }
            const directory = target.kind === 'directory' ? target.directoryId : { projectId: target.projectId }
            return sandboxTarget(await resolveFileDirectoryRoot(pool, ownerId, directory))
          },
          confirmations: { delete_file: deleteFile, restore_file: restoreFile, restore_folder: restoreFolder, permanent_delete: purgeFile },
          claim: (gate, reference, signal) => core.db.transaction().execute(tx => gate.claim(tx, reference, signal)),
        } } : {}),
      })
    }
    imOwnerTools = async (lease, timezone, authorize, binding) => {
      const canConfirm = lease.input.v === 3 && lease.input.im.chatType === 'c2c' && lease.input.im.platform !== 'wechat'
      const calendarConfirmation = canConfirm ? makeConfirmation(lease, 'delete_event', authorize) : undefined
      return {
        tools: { ...await commonTools(lease, timezone, calendarConfirmation, authorize), ...await ownerFileTools(lease, binding, canConfirm, authorize),
          ...(canConfirm ? { ...confirmedOwnerTools(lease, authorize), mcpManagement: ownerMcpManagement(lease, authorize) } : {}) },
        describe: canConfirm ? interactionActivation.describe : undefined,
      }
    }
    const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
    const noUnisolatedExecution = {
      async authorize() { throw Object.assign(new Error('Web Agent 执行能力未启用'), { code: 'denied' }) },
      executor: { async execute() { throw new Error('Web Agent 执行能力未启用') } },
    }
    const baseContext = {
      digest,
      nextId: randomUUID,
      finalization: { async complete() {} },
      references: withViewImageReferences({
        async dehydrate(entry: import('@gugu/core/agent').MessageEntry) { return entry.message },
        async hydrate(entry: import('@gugu/core/agent').MessageEntry) { return entry.message },
      }),
      preparation: {
        async buildRag() { return { tail: [] } },
        formatMessageTime: formatAgentHistoryMessageTime,
      },
      compaction: { async summarize() { throw new Error('Web Agent 压缩服务未绑定') } },
      async prepareRequest() { throw new Error('Web Agent Provider 请求服务未绑定') },
      currentRequest() { return null },
      async stageContinuation() { throw new Error('Web Agent Provider 续接服务未绑定') },
      async releaseContinuations() {},
      diagnoseCompactionFailure(input: { identity: import('@gugu/core/agent').RunIdentity; revision: number; contextInput: number | null }) {
        agentLog.log.write({ identity: input.identity, at: Date.now(), level: 'warn', event: 'agent.context.compaction_failed',
          attributes: { reason: 'summary_failed', revision: input.revision, contextInput: input.contextInput } })
      },
    }
    const reflectionCommands = createRedisScheduledTaskCommands(agentRedisUrl)
    const reflectionModelScope = createReflectionModelScope(config.secretKey)
    const legacyReflectionClaim = createRedisAgentReflectionInbox({ commands: reflectionCommands })
    const legacyReflectionEnqueue = createRedisAgentReflectionQueue({ commands: reflectionCommands, modelScope: reflectionModelScope })
    let reflectionIntervals: ReturnType<typeof createPostgresWebReflectionIntervals> | undefined
    if (memoryEnabled && process.platform === 'linux' && core.receipts) {
      const { rows: [schema] } = await pool.query<{ available: boolean; compaction: boolean }>(`
        SELECT to_regclass('web_reflection_intervals') IS NOT NULL AS available,
          EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('web_reflection_intervals')
            AND attname='compaction_through' AND NOT attisdropped) AS compaction`)
      if (schema?.available) reflectionIntervals = createPostgresWebReflectionIntervals({ pool, modelScope: reflectionModelScope, compactionEnabled: schema.compaction, secretKey: config.secretKey })
      const source = createPostgresOwnerReflectionSource(pool)
      const quota = createPostgresUserQuotaReader(pool, userQuotaSettings(config, env))
      ownerReflectionWork = createOwnerReflectionWork({
        async claim() { return await legacyReflectionClaim() ?? await reflectionIntervals?.claim() ?? null },
        writer: createLocalOwnerReflectionWriter({
          core, storageRoot: config.storageLocalPath, authorize: authorizeOwnerReflectionWrite,
        }),
        checkSource: source,
        extract: createOwnerReflectionExtractor({
          pool, source, bind: providerBinding.bind, modelScope: reflectionModelScope,
          context: { ...baseContext, observation: loopScopeTrace?.forSource('reflection') },
          transport: model => createNodeProviderTransportFactory({ allowLocal: !model.isByok, environment: () => env }),
          readPrompt: async () => readAgentPrompt('reflection.md', promptRoot),
          timezone: serverTimezone,
          async canSpend(ownerId) {
            const state = await quota(ownerId)
            return (state.limit_6h === null || state.used_6h < state.limit_6h)
              && (state.limit_weekly === null || state.used_weekly < state.limit_weekly)
          },
          diagnose: () => writeTimestampedAgentDiagnostic('Web Agent 反思分支失败'),
        }),
        diagnose: () => writeTimestampedAgentDiagnostic('Web Agent 反思批次未完成'),
      })
    }
    const runtime = {
      clock: { now: () => new Date().toISOString() },
      interactions: { async activate() { throw new Error('Web Agent 交互能力未启用') } },
      sanitizeText: stripThinking,
      createStreamSanitizer: () => new ProviderStreamSanitizer(),
      presentError(error: unknown) {
        return error instanceof AgentRunError
          ? { code: error.code, text: '本轮运行未能完成，请稍后重试。' }
          : { code: 'internal_error', text: '生成失败，请稍后重试。' }
      },
      async presentToolResult(value: unknown) { return value },
      async publish() {},
      log: agentLog.log,
      observation: loopScopeTrace?.observation,
      diagnose: agentLog.diagnose,
    }
    const source = {
      pool,
      files: createLocalPreferenceTextFiles(config.storageLocalPath),
      memoryStorageRoot: config.storageLocalPath,
      redis: { get: (key: string) => redisValues(key) },
      serverTimezone,
      now: Date.now,
      external: {
        loadImChannels: createAgentImChannelLoader({ pool, redis: { get: (key: string) => redisValues(key) }, enabled: platform => imPlatforms().includes(platform) }),
        async loadImMemory() { throw new Error('Web Agent IM memory 必须绑定当前 Run') },
        loadKnowledge: createAgentKnowledgeOverviewLoader(knowledgeStore),
      },
      builder: {
        now: Date.now,
        staticPrompt(selection: import('@gugu/core/agent').ContextSourceSelection, _identity: import('@gugu/core/agent').RunIdentity, style: import('@gugu/core/agent').Json = {}, timezone?: string) {
          const prompts = readPrompts()
          const preferences = style && typeof style === 'object' && !Array.isArray(style) ? style as Record<string, unknown> : {}
          return {
            ...prompts, skillIndex,
            locale: selection.locale, groupChat: false,
            customReplyStyleEnabled: preferences.custom_reply_style_enabled === true,
            ...(typeof preferences.custom_reply_style === 'string' ? { customReplyStyle: preferences.custom_reply_style } : {}),
            personalityPreferenceEnabled: preferences.personality_preference_enabled === true,
            ...(typeof preferences.personality_preference === 'string' ? { personalityPreference: preferences.personality_preference } : {}),
            timezone: timezone || serverTimezone,
            now: new Date(),
          }
        },
        sessionInfo() { return {} },
        systemInMessages() { return false },
      },
    }
    const scheduledContext = createWebScheduledTaskContextSources({
      pool, storageRoot: config.storageLocalPath, redis: source.redis, serverTimezone,
      now: Date.now, imPlatformEnabled: platform => imPlatforms().includes(platform), staticPrompt: source.builder.staticPrompt,
    })
    const scheduledTools = createWebScheduledTaskToolResources({
      core, now: () => new Date(), timezone: identity => scheduledContext.data.loadTimezone(identity),
      email: core.receipts ? (automation, assertLease) => createWebAgentEmailTool({
        core, pool, automation, secretKey: config.secretKey, globalSmtp: config.smtp,
        storageRoot: config.storageLocalPath, sanitizeHtml: sanitizeEmailHtml,
        async send(delivery, signal) {
          await assertLease()
          await createSmtpTestDelivery(env)(delivery, signal)
        },
      }) : undefined,
      skillCatalog: { builtins: builtinSkillDefinitions, fingerprint: createSecurityEventFingerprint(config.secretKey) },
      mcp: { directory: mcpSkillTools, runtime: mcpRuntime },
    })
    scheduledAttempt = createWebScheduledTaskAgentAttempt({
      bindProvider: providerBinding.bind, usagePool: pool,
      observation: loopScopeTrace?.forSource('scheduled'),
      async prepareHarness({ identity, task, model, prompt, assertLease, toolsForRun }) {
        if (!assertLease) throw new Error('定时任务租约未绑定')
        await assertLease()
        const { webSearch } = await createWebAgentSearchPorts({
          identity, binding: { resolve: model.resolve, selection: {
            modelIdentity: model.modelIdentity, contextWindow: model.contextWindow, locale: 'zh-CN',
            groupChat: false, workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled },
          } },
          readSafeEgress: createSafeEgressSettingsReader(env, overridePath), secretKey: config.secretKey, digest,
        })
        const { tools, preparation } = await scheduledTools({ identity, task, assertLease,
          additionalReadTools: [...(toolsForRun?.(identity) ?? []), ...(webSearch ? [webSearch] : [])],
          sendFile: scheduledTaskSupportsFileDelivery(task.channels)
            ? options.scheduledAttachments.toolForRun : undefined })
        return {
          context: { ...baseContext, load: createScheduledTaskContextLoader({
            ...scheduledContext, identity, task, model, prompt, memoryEnabled,
          }) },
          runPreparation: preparation, runtime: { ...runtime, tools }, executor: noUnisolatedExecution,
          provider: {
            transportFactory: createNodeProviderTransportFactory({
              allowLocal: !model.usageConfig.isByok, environment: () => env,
            }),
            diagnose() { writeTimestampedAgentDiagnostic('定时任务模型调用失败') },
          },
        }
      },
    })
    const agentUndoOperations = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(core), async (ownerId, event) => {
      await publisher.publishResourceChanged({
        ownerId, resource: String(event.resource), operation: String(event.operation),
        origin: String(event.origin), entityIds: event.entity_ids as number[],
      })
    }, { trash: projectTrashStorage, renameDirectory: projectDirectoryRenamer }, createLocalFileUndoStorage(config.storageLocalPath))
    const writeTitle = createFirstTurnTitleWriter(core.db, 'postgres')
    const resourceFactory = createWebAgentRagResources({
      async writeSessionTitle(lease, reply, complete) {
        const { identity, input } = lease
        if (await writeTitle({ identity, anchorMessageId: String(input.userMessageId), reply, locale: input.locale, complete }))
          await publisher.publishResourceChanged({ ownerId: identity.ownerId, resource: 'sessions', operation: 'update', entityId: Number(identity.sessionId), origin: null })
      },
      compactionPool: pool,
      observation: loopScopeTrace?.observation,
      source,
      rag: {
        core, pool, storageRoot: config.storageLocalPath,
        enabled: () => ragEnabled && canRebuildAgentMemoryIndex(),
        async toolPorts(lease, _binding, context) {
          const mcpAuthorization = createWebAgentConfirmationAuthorization({
            pool, lease, accessVersion: identity => providerBinding.accessVersion(identity, lease.input.source === 'web' ? lease.input.model : undefined),
          })
          const authorizeRunWrite: Parameters<typeof createMcpManagementEditOperations>[1]['authorize'] = async (tx, identity, signal) => {
            const epoch = await mcpAuthorization.authorizeInTransaction(tx, identity, signal)
            return epoch !== null && epoch.endsWith(`:${lease.input.accessVersion}`)
          }
          const scheduledEmailAuthorization = trustedIntents ? {
            create_scheduled_task: makeConfirmation(lease, 'create_scheduled_task'),
            update_scheduled_task: makeConfirmation(lease, 'update_scheduled_task'),
          } : undefined
          const workspaceUnlinkConfirmation = core.receipts ? makeConfirmation(lease, 'unlink_workspace') : undefined
          const workspaceDirectoryDeleteConfirmation = core.receipts ? makeConfirmation(lease, 'delete_workspace_directory') : undefined
          const downloadEgress = createPublicAgentEgress(createSafeEgressSettingsReader(env, overridePath), config.secretKey)
          let webDownload: ReturnType<typeof createWebAgentDiskDownloadTool> | undefined
          if (process.platform === 'linux') {
            try {
              downloadEgress.assertConfigured()
              webDownload = createWebAgentDiskDownloadTool({ pool, lease, storageRoot: config.storageLocalPath, open: downloadEgress.open })
            } catch { /* 当前 Host 的公网出站能力不可用。 */ }
          }
          return {
            askUser: createWebAgentAskUserAuthorization({
              pool, lease,
              enabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
            }),
            callTool: true,
            mcpManagement: ownerMcpManagement(lease),
            ...await createWebAgentSearchPorts({
              identity: lease.identity, binding: _binding,
              readSafeEgress: createSafeEgressSettingsReader(env, overridePath), secretKey: config.secretKey, digest,
              research: {
                pool, readConfig: () => readConfigOverride(overridePath), environment: env, timezone: serverTimezone,
                schemaApplied: searchUsageSchemaApplied,
                durable: { core, authorize: authorizeRunWrite },
                imageStorageRoot: config.storageLocalPath,
                keyForVersion: version => confirmationKeys[String(version)] ?? '',
              },
            }),
            ...await ownerFileTools(lease, _binding, true),
            fileFolderDelete: createWebAgentFileFolderDeletePort(pool, folderDelete, lease),
            sendFile: options.scheduledAttachments.toolForRun(() => dispatch.isCurrent(lease)),
            saveAttachment: createSaveAttachmentTool(createWebAgentSaveAttachmentPort({ pool, db: core.db, upload: fileUploads, downloadAttachment: options.downloadAttachment, lease })),
            recentAttachments: createWebAgentRecentAttachmentsPort(pool, lease),
            presentFile: createWebAgentFilePresentPort({ pool, ownerId: lease.identity.ownerId, lease,
              storageRoot: config.storageLocalPath }),
            ...(webDownload ? { webDownload } : {}),
            ...confirmedOwnerTools(lease),
            ...await commonTools(lease, await context.loadTimezone(lease.identity), makeConfirmation(lease, 'delete_event'), undefined,
              scheduledEmailAuthorization, () => providerBinding.accessVersion(lease.identity, lease.input.source === 'web' ? lease.input.model : undefined)),
            time: { now: () => new Date(), timezone: (identity: import('@gugu/core/agent').RunIdentity) => context.loadTimezone(identity) },
            dashboard: createKyselyDashboardCounter(core.db, 'postgres'),
            workspaceCreation: createWebAgentWorkspaceCreatePort({
              core,
              pool,
              lease,
              createDeclaration: (ownerId, input) => workspaceCreate(ownerId, input),
              createDirectory: (ownerId, name) => workspaceDirectories.create(ownerId, name),
              async readWorkspace(ownerId, workspaceId, signal) {
                const row = await agentWorkspaces.get(ownerId, workspaceId, signal)
                return row ? { ...row } : null
              },
              async listWorkspaces(ownerId, signal) {
                return (await agentWorkspaces.list(ownerId, signal)).map(row => ({ ...row }))
              },
            }),
            ...(workspaceUnlinkConfirmation ? {
              workspaceUnlink: {
                gate: workspaceUnlinkConfirmation.gate,
                claim: workspaceUnlinkConfirmation.claim,
              },
            } : {}),
            ...(workspaceDirectoryDeleteConfirmation ? {
              workspaceDirectoryDelete: createWorkspaceDirectoryDeleteTool(
                createWebAgentWorkspaceDirectoryDeletePort({ core, pool, lease, operations: workspaceDirectories,
                  confirmation: { gate: workspaceDirectoryDeleteConfirmation.gate, claim: workspaceDirectoryDeleteConfirmation.claim } }),
                { gate: workspaceDirectoryDeleteConfirmation.gate, claim: workspaceDirectoryDeleteConfirmation.claim },
              ),
            } : {}),
            ...(core.receipts ? { undoLastAction: createUndoLastActionTool(
              createWebAgentUndoLastActionPort({ core, pool, lease, operations: agentUndoOperations }),
            ) } : {}),
            linkButtons: createWebLinkButtonDeliveryPort(async candidate => candidate.ownerId === lease.identity.ownerId
              && candidate.sessionId === lease.identity.sessionId && candidate.runId === lease.identity.runId),
            skills: await createAgentSkillRuntimePorts({
              ownerId: lease.identity.ownerId,
              builtins: builtinSkillDefinitions,
              listUser: skillMetadata,
              readUser: createUserSkillReader(core.db, 'postgres'),
              fingerprint: createSecurityEventFingerprint(config.secretKey),
            }),
            ...(memoryEnabled && process.platform === 'linux' && core.receipts && canRebuildAgentMemoryIndex() ? {
              remember: createLocalAgentRememberPort({
                core, storageRoot: config.storageLocalPath, authorize: authorizeRunWrite,
                embedding: { resolve: resolveEmbeddingSettings, createTransport: createEmbeddingTransport },
              }),
            } : {}),
          }
        },
        embedding: {
          resolve: (ownerId, signal) => resolveEmbeddingSettings(ownerId, signal),
          createTransport: createEmbeddingTransport,
        },
      },
      reflection: {
        enqueue: reflectionIntervals?.enqueue ?? legacyReflectionEnqueue,
        stageCompaction: reflectionIntervals?.stageCompaction,
        prepareCompaction: reflectionIntervals?.prepareCompaction,
        enabled: () => !!ownerReflectionWork && canRebuildAgentMemoryIndex(),
        diagnose: () => writeTimestampedAgentDiagnostic('Web Agent 反思队列不可用'),
      },
      remaining: {
        context: baseContext,
        preparation: {
          capabilities: {
            workspaceSupported: false,
            async filterConfigured(names) { return filterConfiguredWebAgentTools(names) },
            async shellPolicy(identity) {
              const snapshot = identity.subject.kind === 'session'
                ? await readAgentShellSnapshot(identity.ownerId, identity.subject.id) : null
              return { allowed: snapshot?.facts.userEnabled === true, needsConfirmation: false }
            },
            async shellState() { return 'Shell 使用沙盒内的工作区路径，默认目录由会话工作区决定。' },
            appendShellProtocol(system: string) { return system },
            async catalog(_names, identity, tools, signal, context) {
              signal?.throwIfAborted()
              const preferences = await pool.query('SELECT data_json FROM user_preferences WHERE user_id=$1', [identity.ownerId])
              signal?.throwIfAborted()
              const brief = createAgentToolBrief(preferences.rows[0]?.data_json, tools ?? [], context?.userSkillSnapshot)
              const enabled = ['search_tools', 'call_tool'].every(name => _names.includes(name))
              return { ...brief, mcpReminder: enabled ? mcpServiceReminder(await mcpSkillTools.services(identity.ownerId)) : '' }
            },
          },
          formatPrefix({ original }: { original: import('@gugu/core/agent').PrepareContextInput }) { return original.fixedPrefix },
        },
        materialize: createWebCurrentMessageMaterializer(pool, {
          storageRoot: config.storageLocalPath,
          extractDocumentText: extractOfficeText,
        }),
        runtime,
        interactionActivation,
        executor: noUnisolatedExecution,
        provider: { continuationStore: providerContinuationStore, continuationTtlMs: 35 * 60_000, diagnose() { writeTimestampedAgentDiagnostic('Web Agent Provider 调用失败') } },
        mcp: createWebAgentMcpProductionPorts({ directory: mcpSkillTools, runtime: mcpRuntime, services: mcpSkillTools.services }),
      },
    })
    const dispatch = createPostgresAgentDispatch(pool, config.secretKey)
    const reconstruct = createWebAgentReconstructor({
      async readWorkspaceInstructions(lease, signal) {
        if (lease.input.source !== 'web') return undefined
        signal?.throwIfAborted()
        const { ownerId, sessionId } = lease.identity
        const target = await readFileWorkspace(ownerId, Number(sessionId))
        if (!target) return undefined
        const instructions = await shellMounts.readAgentInstructions(ownerId, target.workspaceId)
        signal?.throwIfAborted()
        return instructions
      },
      pool, secretKey: config.secretKey,
      observation: loopScopeTrace?.observation,
      redis: createRedisAgentCancellationCommands(agentRedisUrl),
      subscribe: createRedisLiveSubscription(agentRedisUrl),
      history: { async writeHistory() { throw new Error('只读 Agent event store 不接受历史写入') } },
      readReconstructionStatus: dispatch.readReconstructionStatus,
      async bind(lease, checkpoint) {
        const model = lease.input.source === 'web' ? lease.input.model : undefined
        if (checkpoint && model && (checkpoint.modelIdentity !== model.modelIdentity || checkpoint.accessScopeHash !== model.accessScopeHash))
          throw new Error('运行模型与恢复记录不匹配')
        const recovery = checkpoint ? {
          identity: checkpoint.identity, modelIdentity: checkpoint.modelIdentity, accessScopeHash: checkpoint.accessScopeHash,
        } : model && { identity: lease.identity, ...model }
        return providerBinding.bindRun(lease.identity, lease.input.locale, recovery)
      },
      async resources(lease, binding) {
        const labels = readStateLabelOverrides()
        const resources = await resourceFactory(lease, binding)
        return { ...resources,
          runtime: { ...resources.runtime, toolLabelOverride: createAgentToolLabelPicker(() => labels) },
          provider: {
            ...resources.provider,
            transportFactory: createNodeProviderTransportFactory({
              allowLocal: !binding.usageConfig.isByok, environment: () => env,
            }),
          },
        }
      },
    })
    const interactionProjection = createPostgresInteractionProjection(pool, config.secretKey)
    agentRunLifecycle = createWebAgentRunLifecycle({
      pool, secretKey: config.secretKey, storageRoot: config.storageLocalPath, redisUrl: agentRedisUrl, dispatchTtlSeconds: 7 * 24 * 60 * 60,
      observation: loopScopeTrace?.observation, runAgent: options.runAgent,
      accessVersion: providerBinding.accessVersion,
      pin: providerBinding.pin,
      reconstruct,
      project: event => projectAgentRunEvent(event, { interaction: event => interactionProjection.interaction(event) }),
      diagnose: code => writeTimestampedAgentDiagnostic('Web Agent 运行生命周期失败', code),
    })
    const interactionRunStore = createPostgresAgentRunStore<import('@gugu/core/agent').CanonicalRunContext>(pool, config.secretKey, {
      async writeHistory() { throw new Error('只读交互恢复 store 不接受历史写入') },
    })
    const enqueueInteractionResume = createInteractionResumeEnqueuer(interactionRunStore)
    agentInteractionRespond = createAgentInteractionRespondService({
      pool,
      effects: {
        ...createPostgresAgentInteractionCommandEffects({
          filesystemAuthorizationEnabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
          secretKey: config.secretKey,
        }),
        redeemConfirmation: (_client, ownerId, code) => filesystemAuthorizationConfirmations.redeem(ownerId, code),
      },
      enqueue: enqueueInteractionResume,
      wake: (ownerId, sessionId) => agentRunLifecycle!.service.wake(ownerId, sessionId),
      diagnose: () => writeTimestampedAgentDiagnostic('Web Agent 交互恢复唤醒失败'),
    })
    const consumeSecret = createPostgresSecretInteraction(pool, {
      async encrypt(values) {
        const envelope = await createConfiguredByokEnvelope(env).encrypt(JSON.stringify(values), false)
        return { ciphertext: envelope.ciphertext, nonce: envelope.nonce, encryptedDataKey: envelope.encryptedDataKey, keyVersion: envelope.keyVersion }
      },
      enqueue: enqueueInteractionResume,
      async invalidate(client, ownerId) {
        await client.query('DELETE FROM user_mcp_tool_schema_snapshots WHERE user_id=$1', [ownerId])
      },
    })
    agentSecretInteraction = createAgentSecretInteractionService({
      consume: consumeSecret,
      async wake(ownerId, promptId, result) {
        const row = (await pool.query<{ session_id: number; schema_json: unknown }>(
          'SELECT session_id,schema_json FROM interaction_prompts WHERE id=$1 AND user_id=$2', [promptId, ownerId],
        )).rows[0]
        if (!row) return
        if (result.status !== 'cancelled') {
          const schema = objectSetting(row.schema_json), context = objectSetting(schema.context), target = objectSetting(context.secret_target)
          if (typeof target.server_id === 'string') await mcpRuntime.invalidate(ownerId, target.server_id)
        }
        await agentRunLifecycle!.service.wake(ownerId, Number(row.session_id))
      },
      diagnose: () => writeTimestampedAgentDiagnostic('Web Agent 凭据交互恢复唤醒失败'),
    })
  }
  return { scheduledAttempt, agentRunLifecycle, ownerReflectionWork, agentInteractionRespond, agentSecretInteraction,
    agentRunLog: agentLog.log, imOwnerTools }
}
