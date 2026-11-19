import { createWebRuntimeLog } from '../shared/log-files.js'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createNodeProviderTransportFactory, isPublicAddress } from '@gugu/core/providers/node'
import { validateMcpEndpoint } from '@gugu/core/mcp/server-config'
import { createTerminalWorkspaceMounts } from '../modules/terminals/sandbox/mounts.js'
import { AgentRunError, stableJson } from '@gugu/core/agent'
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
import { createAgentSkillRuntimePorts, createBuiltinSkillDefinitions } from '@gugu/core/skills'
import { createSkillMetadataReader } from '@gugu/core/skills'
import { createSafeEgressSettingsReader } from '../modules/admin/network.js'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { type Database, type SqlDataRuntime } from '@gugu/core/data'
import { createAgentWorkspaceQueries, createKyselyAgentWorkspaceReader } from '@gugu/core/workspaces'
import { createAgentTrashListPort, createAgentTrashPurgePort } from '../modules/agent/tools/trash/purge.js'
import { createAgentTrashRestorePort } from '../modules/agent/tools/trash/restore.js'
import { createGlobalSearchOperations, createKyselyDashboardCounter } from '@gugu/core'
import { type WebUiConfig } from '../config.js'
import { readConfigOverride, resolveConfigOverridePath } from '../adapters/config/config-override-file.js'
import { createRedisLiveSubscription } from '../adapters/cache/redis-live-subscription.js'
import { createPostgresUserQuotaReader } from '../modules/auth/quota/read.js'
import { createAgentMindReader, createAgentPlaceableSearch, createSqlMindCanvasReader } from '@gugu/core/mind'
import { createKnowledgeDeleteTool, createProjectDeleteTool, createCanvasCreationPort, createClientDeletePort, createNoteWritePort, createSkillDeleteTool, createSkillManagementWriteTools, createMcpManagementTool, createMcpManagementCreateOperations, createMcpManagementRemoveOperations, createMcpManagementEditOperations, createScheduledTaskDeleteTool, createDurableProjectMutationPort, createWebLinkButtonDeliveryPort, createWorkspaceMutationPort, createWorkspaceDirectoryDeleteTool, createUndoLastActionTool, createPermanentDeleteTool } from '@gugu/core/tools'
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
import { createRedisAgentReflectionInbox } from '../modules/agent/memory/reflection/queue.js'
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
import { createWebAgentPromptReader, webAgentPromptRoot } from '../modules/agent/context/prompts.js'
import { createWebAgentMcpProductionPorts } from '../modules/agent/tools/mcp/production.js'
import { createWebAgentRunLifecycle } from '../modules/agent/run/lifecycle.js'
import { createConfiguredWebAgentProviderBinding } from '../modules/agent/llm/configured.js'
import { createWebAgentSearchPorts } from '../modules/agent/tools/search.js'
import { createWebAgentCalendarWritePorts } from '../modules/agent/tools/calendar.js'
import { createWebAgentCanvasMutationPorts, createWebAgentCanvasWritePorts } from '../modules/agent/tools/canvas.js'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from '../modules/agent/tools/confirm.js'
import { createWebAgentShell } from '../modules/agent/tools/shell/sandbox.js'
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
import { createPostgresAgentDispatch } from '../modules/agent/run/dispatch.js'
import { createAgentConversationReadPort } from '../modules/agent/tools/conversations.js'
import { createWebAgentFileReadPort } from '../modules/agent/tools/files/read.js'
import { createWebAgentFilePresentPort } from '../modules/agent/tools/files/present.js'
import { createWebAgentFileGrepPort } from '../modules/agent/tools/files/grep.js'
import { createWebAgentFileEditPort } from '../modules/agent/tools/files/edit.js'
import { createWebAgentFileRenamePort } from '../modules/agent/tools/files/rename.js'
import { createWebAgentFileCopyPort } from '../modules/agent/tools/files/copy.js'
import { createWebAgentFileArchivePort } from '../modules/agent/tools/files/archive.js'
import { createWebAgentFileCreatePort } from '../modules/agent/tools/files/create.js'
import { createWebAgentSaveUploadedFilePort } from '../modules/agent/tools/files/save.js'
import { createWebAgentRecentAttachmentsPort } from '../modules/agent/tools/files/recent.js'
import { createWebAgentFolderCreatePort, createWebAgentFolderRenamePort, createWebAgentMoveItemsPort } from '../modules/agent/tools/files/write.js'
import { createWebAgentFileDirectoryPort } from '../modules/agent/tools/files/directory.js'
import { createWebAgentFileDeletePort, createWebAgentFileFolderDeletePort } from '../modules/agent/tools/files/delete.js'
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
import { createPostgresFileBrowserOperations } from '../modules/files/browse.js'
import { extractOfficeText } from '@gugu/core/files/office-text'
import { createPostgresFileUploadOperations } from '../modules/files/upload.js'
import { createWebAgentDiskDownloadTool } from '../modules/agent/tools/files/download.js'
import { createPublicAgentEgress } from '../adapters/network/safe-egress-proxy.js'
import { createPostgresFileDeleteOperations, createPostgresFileRestoreOperations } from '../modules/files/trash/service.js'
import { createPostgresFileContentOperations } from '../modules/files/content.js'
import { createPostgresFileUpdateOperations, createPostgresFileCopyOperations } from '../modules/files/store.js'
import { createPostgresFileArchiveOperations } from '../modules/files/archive/service.js'
import { createPostgresFolderWriteOperations } from '../modules/files/folders/write.js'
import { createPostgresFolderDeleteOperations } from '../modules/files/folders/delete.js'
import { createRedisAgentCancellationCommands, createRedisScheduledTaskCommands, type RedisEventPublisher } from '../adapters/cache/redis-events.js'
import { createWebAgentLog, writeTimestampedAgentDiagnostic } from '../modules/agent/run/diagnostics.js'
import { createSecurityEventFingerprint } from '../modules/admin/audit.js'
import type { createMindServices } from './mind.js'
import { booleanSetting, objectSetting, optionalIntegerSetting, userQuotaSettings } from './settings.js'
import type { FilesystemAuthorizationConfirmationPort } from '../modules/agent/sandbox/authorization.js'
import type { AgentTrashPurgeOperations } from '../modules/files/trash/service.js'
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
  trashPurgeSchemaApplied: boolean
  fileUploads: ReturnType<typeof createPostgresFileUploadOperations>
  searchUsageSchemaApplied: boolean
  folderDelete: ReturnType<typeof createPostgresFolderDeleteOperations>
  fileDeletes: ReturnType<typeof createPostgresFileDeleteOperations>
  folderWrites: ReturnType<typeof createPostgresFolderWriteOperations>
  projectCreateRuntime: ReturnType<typeof createKyselyProjectCreateRuntime>
  publishProjectMutation: ReturnType<typeof createProjectPostCommitPublisher>
  projectUpdateRuntime: ReturnType<typeof createPostgresProjectUpdateRuntime>
  publishCanvasChanged: ReturnType<typeof createMindServices>['publishCanvasChanged']
  scheduledNotifyImPlatforms: ReturnType<typeof createImPlatformSettingsReader>
  workspaceCreate: ReturnType<typeof createPostgresWorkspaceCreator>
  workspaceDirectories: ReturnType<typeof createPostgresWorkspaceDirectoryOperations>
  fileRestores: ReturnType<typeof createPostgresFileRestoreOperations>
  trashOperations: AgentTrashPurgeOperations
  userSkillManager: ReturnType<typeof createUserSkillManager<Database>>
  globalSearch: ReturnType<typeof createGlobalSearchOperations>
  resolveEmbeddingSettings: ReturnType<typeof createPostgresAgentEmbeddingSettingsResolver>
  createEmbeddingTransport: ReturnType<typeof createAgentRagEmbeddingTransportFactory>
  publishCalendarCreate: ReturnType<typeof createCalendarEventPostCommitPublisher>
  publishCalendarMutation: ReturnType<typeof createCalendarMutationPostCommitPublisher>
  loopScopeTrace: ReturnType<typeof createWebLoopScopeTrace>
  scheduledAttachments: ReturnType<typeof createWebScheduledAttachmentResources>
  downloadAttachment: Parameters<typeof createWebAgentSaveUploadedFilePort>[0]["downloadAttachment"]
  scheduledTaskWriteOptions: TaskWriteOptions
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
    projectDeleteJournal, trashPurgeSchemaApplied, fileUploads, searchUsageSchemaApplied,
    folderDelete, fileDeletes, folderWrites, projectCreateRuntime,
    publishProjectMutation, projectUpdateRuntime, publishCanvasChanged, scheduledNotifyImPlatforms,
    workspaceCreate, workspaceDirectories, fileRestores, trashOperations,
    userSkillManager, globalSearch, resolveEmbeddingSettings, createEmbeddingTransport,
    publishCalendarCreate, publishCalendarMutation, loopScopeTrace, readStateLabelOverrides,
  } = options
  let scheduledAttempt: ReturnType<typeof createWebScheduledTaskAgentAttempt> | null = null
  let agentRunLifecycle: ReturnType<typeof createWebAgentRunLifecycle> | null = null
  let ownerReflectionWork: ReturnType<typeof createOwnerReflectionWork> | undefined
  let agentInteractionRespond: ReturnType<typeof createAgentInteractionRespondService> | null = null
  let agentSecretInteraction: ReturnType<typeof createAgentSecretInteractionService> | null = null
  const runtimeLog = createWebRuntimeLog(config.logFile)
  const agentLog = createWebAgentLog(config.logFile, createSecurityEventFingerprint(config.secretKey))
  if (config.redisUrl) {
    const agentRedisUrl = config.redisUrl
    const providerContinuationStore = createRedisProviderContinuationStore(createRedisExpiringValueStore(agentRedisUrl), config.secretKey)
    const overridePath = config.configOverridePath ?? resolveConfigOverridePath(env)
    const override = readConfigOverride(overridePath)
    const agentSettings = objectSetting(override.agent)
    const searchSettings = objectSetting(override.search)
    const memoryEnabled = booleanSetting(undefined, agentSettings.memory_enabled, true)
    const ragEnabled = booleanSetting(undefined, searchSettings.rag_enabled, true)
    const reflectionThreshold = optionalIntegerSetting(undefined, agentSettings.web_private_reflection_threshold, 'agent.web_private_reflection_threshold') ?? 10
    if (reflectionThreshold < 1 || reflectionThreshold > 100) throw new Error('agent.web_private_reflection_threshold 配置无效')
    const serverTimezone = userQuotaSettings(config, env).serverTimezone
    const readPrompts = createWebAgentPromptReader()
    if (Object.values(readPrompts()).some(value => !value.trim())) throw new Error('Web Agent 提示词不可用')
    const builtinSkillDefinitions = await capabilitySkills
    const skillMetadata = createSkillMetadataReader(core.db, 'postgres', builtinSkillDefinitions)
    const skillIndex = builtinSkillDefinitions.length ? [
      '## 可用技能',
      '下列技能是带触发条件的做法剧本。命中场景时，第一工具调用必须是 `use_skill` 拉取对应正文；正文加载前禁止直接调用该技能负责的业务工具。',
      'Skill ID（S/U 编号）仅用于内部调用；对用户提及技能时使用技能名称，不展示内部 ID，除非用户明确询问。',
      '列出当前账号的完整技能目录时调用 `list_skills`；目录包含停用项但不包含正文。',
      ...builtinSkillDefinitions.map(skill => `- ${skill.emoji ? `${skill.emoji} ` : ''}**${skill.name}**（Skill ID：\`${skill.id}\`）${skill.description_short ? ` — ${skill.description_short}` : ''}`),
    ].join('\n') : ''
    const redisValues = createRedisValueReader(config.redisUrl)
    const imPlatforms = createImPlatformSettingsReader(env, overridePath)
    const knowledgeStore = createLocalAgentKnowledgeReadStore(config.storageLocalPath)
    const providerBinding = await createConfiguredWebAgentProviderBinding({
      pool,
      configPath: overridePath,
      versionSecret: config.secretKey,
      promptRoot: webAgentPromptRoot,
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
    const makeConfirmation = (lease: import('../modules/agent/run/dispatch.js').AgentDispatchLease, action: string) => {
      if (!trustedIntents) return undefined
      const authorization = createWebAgentConfirmationAuthorization({
        pool, lease, accessVersion: identity => providerBinding.accessVersion(identity, lease.input.source === 'web' ? lease.input.model : undefined),
      })
      const labels: Record<string, string> = {
        unlink_workspace: '解除工作区的 Shell 与会话绑定，不删除目标资源',
        delete_workspace_directory: '永久删除顶层物理工作区目录及其中内容',
        delete_event: '软删除日历事件及其提醒，可在当前会话撤销',
        delete_client: '删除联系人，此操作不可恢复',
        canvas_delete: '删除画布及其内容',
        canvas_delete_note: '删除画布专属便签及对应视图',
        canvas_disconnect: '删除画布中的关系',
        canvas_batch: '执行包含便签删除的画布批量操作',
      }
      return createWebAgentToolConfirmation({
        pool, intents: trustedIntents, lease, action,
        authorize: authorization.authorize,
        authorizeInTransaction: authorization.authorizeInTransaction,
        async describe(_binding, snapshot) {
          if (action === 'send_email' || action === 'delete_knowledge' || action === 'update_mcp_server' || action === 'add_mcp_server'
            || action === 'delete_workspace_directory' || action === 'permanent_delete'
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
            const names = result.rows.slice(0, 10).map(row => row.name).join('、')
            const more = ids.length > 10 ? `等 ${ids.length} 个` : ''
            const visible = names.length > 900 ? `${Array.from(names).slice(0, 450).join('')}…` : names
            return { summary: `将删除定时任务：${visible}${more}，共 ${ids.length} 个` }
          }
          const targets = Object.entries({ ...snapshot.targetIds, ...snapshot.targetRefs }).map(([kind, ids]) =>
            `${kind}：${ids.length ? ids.join('、') : '级联内容'}`).join('；')
          const summary = `${labels[action] ?? '执行受保护操作'}。目标：${targets}`
          return { summary }
        },
      })
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
      references: {
        async dehydrate(entry: import('@gugu/core/agent').MessageEntry) { return entry.message },
        async hydrate(entry: import('@gugu/core/agent').MessageEntry) { return entry.message },
      },
      preparation: {
        async buildRag() { return { tail: [] } },
        formatMessageTime: formatAgentHistoryMessageTime,
      },
      compaction: { async summarize() { throw new Error('Web Agent 压缩服务未绑定') } },
      async prepareRequest() { throw new Error('Web Agent Provider 请求服务未绑定') },
      currentRequest() { return null },
      async stageContinuation() { throw new Error('Web Agent Provider 续接服务未绑定') },
      async releaseContinuations() {},
      diagnoseCompactionFailure(input: { identity: import('@gugu/core/agent').RunIdentity; revision: number; contextInput: number }) {
        agentLog.log.write({ identity: input.identity, at: Date.now(), level: 'warn', event: 'agent.context.compaction_failed',
          attributes: { reason: 'summary_failed', revision: input.revision, contextInput: input.contextInput } })
      },
    }
    const reflectionCommands = createRedisScheduledTaskCommands(agentRedisUrl)
    const reflectionModelScope = createReflectionModelScope(config.secretKey)
    if (memoryEnabled && process.platform === 'linux' && core.receipts) {
      const source = createPostgresOwnerReflectionSource(pool)
      const quota = createPostgresUserQuotaReader(pool, userQuotaSettings(config, env))
      ownerReflectionWork = createOwnerReflectionWork({
        claim: createRedisAgentReflectionInbox({ commands: reflectionCommands }),
        writer: createLocalOwnerReflectionWriter({
          core, storageRoot: config.storageLocalPath, authorize: authorizeOwnerReflectionWrite,
        }),
        checkSource: source,
        extract: createOwnerReflectionExtractor({
          pool, source, bind: providerBinding.bind, modelScope: reflectionModelScope, context: baseContext,
          transport: model => createNodeProviderTransportFactory({ allowLocal: !model.isByok, environment: () => env }),
          readPrompt: () => readFile(resolve(webAgentPromptRoot, 'reflection.md'), 'utf8'),
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
    const resourceFactory = createWebAgentRagResources({
      source,
      rag: {
        core, pool, storageRoot: config.storageLocalPath,
        enabled: () => ragEnabled && canRebuildAgentMemoryIndex(),
        async toolPorts(lease, _binding, context) {
          const shellConfirmation = bubblewrapRootfs ? makeConfirmation(lease, 'shell') : undefined
          const shell = shellConfirmation && bubblewrapRootfs ? createWebAgentShell({
            rootfs: bubblewrapRootfs, mounts: shellMounts, confirmation: shellConfirmation, log: runtimeLog,
            async read(identity, signal) {
              signal.throwIfAborted()
              if (identity.ownerId !== lease.identity.ownerId || identity.sessionId !== lease.identity.sessionId
                || identity.runId !== lease.identity.runId || !await dispatch.isCurrent(lease)) return null
              return readAgentShellSnapshot(identity.ownerId, identity.sessionId)
            },
            claim: (reference, signal) => core.db.transaction().execute(tx => shellConfirmation.claim(tx, reference, signal)),
          }) : undefined
          const agentWorkspaces = createAgentWorkspaceQueries(createKyselyAgentWorkspaceReader(core.db, 'postgres'))
          const fileGrep = createWebAgentFileGrepPort(pool, config.storageLocalPath, lease)
          const mcpRemoveConfirmation = makeConfirmation(lease, 'remove_mcp_server')
          const mcpUpdateConfirmation = makeConfirmation(lease, 'update_mcp_server')
          const mcpCreateConfirmation = makeConfirmation(lease, 'add_mcp_server')
          const mcpCrypto = createConfiguredByokEnvelope(env)
          const mcpAuthorization = createWebAgentConfirmationAuthorization({
            pool, lease, accessVersion: identity => providerBinding.accessVersion(identity, lease.input.source === 'web' ? lease.input.model : undefined),
          })
          const authorizeRunWrite: Parameters<typeof createMcpManagementEditOperations>[1]['authorize'] = async (tx, identity, signal) => {
            const epoch = await mcpAuthorization.authorizeInTransaction(tx, identity, signal)
            return epoch !== null && epoch.endsWith(`:${lease.input.accessVersion}`)
          }
          const validateMcpToolEndpoint = (endpoint: string) => validateMcpEndpoint(endpoint, isPublicAddress)
          const scheduledTaskDeleteConfirmation = makeConfirmation(lease, 'delete_scheduled_task')
          const scheduledEmailAuthorization = trustedIntents ? {
            create_scheduled_task: makeConfirmation(lease, 'create_scheduled_task'),
            update_scheduled_task: makeConfirmation(lease, 'update_scheduled_task'),
          } : undefined
          const emailConfirmation = makeConfirmation(lease, 'send_email')
          const knowledgeDeleteConfirmation = process.platform === 'linux' && core.receipts
            ? makeConfirmation(lease, 'delete_knowledge') : undefined
          const skillDeleteConfirmation = makeConfirmation(lease, 'delete_skill')
          const clientDeleteConfirmation = makeConfirmation(lease, 'delete_client')
          const projectDeleteConfirmation = projectDeleteJournal ? makeConfirmation(lease, 'delete_project') : undefined
          const workspaceUnlinkConfirmation = core.receipts ? makeConfirmation(lease, 'unlink_workspace') : undefined
          const workspaceDirectoryDeleteConfirmation = core.receipts ? makeConfirmation(lease, 'delete_workspace_directory') : undefined
          const trashPurgeConfirmation = core.receipts && trashPurgeSchemaApplied && process.platform === 'linux'
            ? makeConfirmation(lease, 'permanent_delete') : undefined
          const downloadEgress = createPublicAgentEgress(createSafeEgressSettingsReader(env, overridePath), config.secretKey)
          let webDownload: ReturnType<typeof createWebAgentDiskDownloadTool> | undefined
          if (process.platform === 'linux') {
            try {
              downloadEgress.assertConfigured()
              webDownload = createWebAgentDiskDownloadTool({ pool, lease, storageRoot: config.storageLocalPath, open: downloadEgress.open })
            } catch { /* 当前 Host 的公网出站能力不可用。 */ }
          }
          const deleteEventConfirmation = makeConfirmation(lease, 'delete_event')
          const canvasDeleteConfirmation = makeConfirmation(lease, 'canvas_delete')
          const canvasDeleteNoteConfirmation = makeConfirmation(lease, 'canvas_delete_note')
          const canvasDisconnectConfirmation = makeConfirmation(lease, 'canvas_disconnect')
          const canvasBatchConfirmation = makeConfirmation(lease, 'canvas_batch')
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
          return {
            askUser: createWebAgentAskUserAuthorization({
              pool, lease,
              enabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
            }),
            callTool: true,
            mcpManagement: createMcpManagementTool({
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
            }) : undefined),
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
            ...(clientDeleteConfirmation ? { clientDelete: createClientDeletePort(core, clientDeleteConfirmation) } : {}),
            ...(shell ? { shell } : {}),
            fileDirectory: createWebAgentFileDirectoryPort(createPostgresFileBrowserOperations(pool, config.secretKey), lease, pool),
            fileFolderDelete: createWebAgentFileFolderDeletePort(pool, folderDelete, lease),
            fileDelete: createWebAgentFileDeletePort(pool, fileDeletes, lease, fileGrep),
            sendFile: options.scheduledAttachments.toolForRun(() => dispatch.isCurrent(lease)),
            saveUploadedFile: createWebAgentSaveUploadedFilePort({ pool, db: core.db, upload: fileUploads, downloadAttachment: options.downloadAttachment, lease }),
            recentAttachments: createWebAgentRecentAttachmentsPort(pool, lease),
            readFile: createWebAgentFileReadPort(pool, config.storageLocalPath, lease,
              fileGrep),
            fileGrep,
            presentFile: createWebAgentFilePresentPort({ pool, ownerId: lease.identity.ownerId, lease,
              files: fileGrep }),
            fileEdit: createWebAgentFileEditPort(pool, config.storageLocalPath, createPostgresFileContentOperations(pool, {
              storageRoot: config.storageLocalPath,
              fileSyncEnabled: config.filesyncEnabled,
              async publishChanged(event) {
                await publisher.publishResourceChanged({
                  ownerId: event.ownerId,
                  resource: 'files',
                  operation: 'update',
                  entityId: event.entityId,
                  origin: event.origin,
                  payload: { kind: 'file', entity: event.payload },
                })
              },
            }), lease, createWebAgentFileGrepPort(pool, config.storageLocalPath, lease)),
            fileRename: createWebAgentFileRenamePort(pool, createPostgresFileUpdateOperations(pool, {
              storageRoot: config.storageLocalPath,
              async publishChanged(event) {
                await publisher.publishResourceChanged({
                  ownerId: event.ownerId,
                  resource: 'files',
                  operation: 'update',
                  entityId: event.entityId,
                  origin: event.origin,
                  payload: { kind: 'file', entity: event.payload },
                })
              },
            }), lease, fileGrep),
            fileCopy: createWebAgentFileCopyPort(pool, createPostgresFileCopyOperations(pool, {
              storageRoot: config.storageLocalPath,
              fileSyncEnabled: config.filesyncEnabled,
              async publishChanged(event) {
                await publisher.publishResourceChanged({
                  ownerId: event.ownerId,
                  resource: 'files',
                  operation: 'create',
                  entityId: event.entityId,
                  origin: event.origin,
                  payload: { kind: 'file', entity: event.payload },
                })
              },
            }), lease, fileGrep),
            fileArchive: createWebAgentFileArchivePort(pool, createPostgresFileArchiveOperations(pool, {
              storageRoot: config.storageLocalPath,
              fileSyncEnabled: config.filesyncEnabled,
              defaultLimitBytes: config.storageDefaultLimitBytes,
              async publishCreatedFile(event) {
                await publisher.publishResourceChanged({
                  ownerId: event.ownerId,
                  resource: 'files',
                  operation: 'create',
                  entityId: event.entityId,
                  origin: event.origin,
                  payload: { kind: 'file', entity: event.payload },
                })
              },
              async publishCreatedBatch(ownerId, origin) {
                await publisher.publishResourceChanged({ ownerId, resource: 'files', operation: 'create', origin })
              },
            }), lease),
            fileCreate: createWebAgentFileCreatePort({ pool, db: core.db, upload: fileUploads, lease }),
            folderCreate: createWebAgentFolderCreatePort({ core, pool, operations: folderWrites, lease }),
            folderRename: createWebAgentFolderRenamePort({ core, pool, operations: folderWrites, lease }),
            fileMoveItems: createWebAgentMoveItemsPort(pool, createPostgresFileUpdateOperations(pool, {
              storageRoot: config.storageLocalPath,
              async publishChanged(event) {
                await publisher.publishResourceChanged({
                  ownerId: event.ownerId,
                  resource: 'files',
                  operation: 'update',
                  entityId: event.entityId,
                  origin: event.origin,
                  payload: { kind: 'file', entity: event.payload },
                })
              },
            }), folderWrites, lease, fileGrep),
            projects: projectCreateRuntime,
            ...(projectDeleteJournal && projectDeleteConfirmation ? {
              projectDelete: createProjectDeleteTool(core, {
                ...projectDeleteJournal, transactionPort: createBorrowedPostgresProjectTrashTransaction,
                storage: projectTrashStorage, publish: publishProjectMutation,
              }, projectDeleteConfirmation),
            } : {}),
            ...(webDownload ? { webDownload } : {}),
            projectMutations: createDurableProjectMutationPort({
              core,
              runtime: {
                renameProjectDirectory: projectUpdateRuntime.renameProjectDirectory,
                getFileCount: projectUpdateRuntime.getFileCount,
                publishProjectUpdated: projectUpdateRuntime.publishProjectUpdated,
              },
              metadata: identity => ({ undoContextId: `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128) }),
            }),
            conversations: createAgentConversationReadPort(pool),
            canvases: createSqlMindCanvasReader(core.db, 'postgres'),
            canvasPlaceableSearch: createAgentPlaceableSearch(core.db, 'postgres'),
            canvasCreation: createCanvasCreationPort(core, publishCanvasChanged),
            ...createWebAgentCanvasMutationPorts({
              core,
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
            }),
            notes: createAgentMindReader(core.db, 'postgres'),
            noteWrites: createNoteWritePort(core, {
              timezone: await context.loadTimezone(lease.identity),
              async publish(event) {
                await publisher.publishResourceChanged({
                  ownerId: event.ownerId, resource: 'mind', operation: event.operation,
                  entityId: event.note.id, origin: null, mutationId: event.mutationId,
                  payload: { kind: 'note', entity: event.note },
                })
              },
            }),
            fileOverview: createProjectFileOverviewPort(pool),
            ...(emailConfirmation ? {
              sendEmail: createWebAgentEmailTool({
                core, pool, confirmation: emailConfirmation, secretKey: config.secretKey, globalSmtp: config.smtp,
                storageRoot: config.storageLocalPath, send: createSmtpTestDelivery(env), sanitizeHtml: sanitizeEmailHtml,
              }),
            } : {}),
            scheduledTaskWrites: createWebAgentScheduledTaskWrites(core, {
              writes: options.scheduledTaskWriteOptions,
              emailAuthorization: scheduledEmailAuthorization,
              filesystemRevocation: {
                revokeConfirmation: (owner, summary, identity) => filesystemAuthorizationConfirmations.revoke(owner, summary, identity),
                fingerprint: createSecurityEventFingerprint(config.secretKey),
              },
              authorize: createWebAgentConfirmationAuthorization({ pool, lease, accessVersion: identity => providerBinding.accessVersion(identity, lease.input.source === 'web' ? lease.input.model : undefined) }).authorizeInTransaction,
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
            ...(scheduledTaskDeleteConfirmation ? {
              scheduledTaskDelete: createScheduledTaskDeleteTool(core, scheduledTaskDeleteConfirmation, async (ownerId, id) => {
                await publisher.publishResourceChanged({ ownerId, resource: 'scheduled_tasks', operation: 'delete', entityId: id, origin: null })
              }),
            } : {}),
            scheduledTasks: {
              list(identity, signal) {
                const queries = createScheduledTaskQueries(createKyselyScheduledTaskReader(core.db, 'postgres'), () => ({
                  workspaceSupported: true,
                  filesystemAuthorizationEnabled: config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
                }))
                return queries.agent(identity.ownerId, signal)
              },
            },
            time: { now: () => new Date(), timezone: (identity: import('@gugu/core/agent').RunIdentity) => context.loadTimezone(identity) },
            dashboard: createKyselyDashboardCounter(core.db, 'postgres'),
            workspaces: agentWorkspaces,
            workspaceMutations: createWorkspaceMutationPort(core),
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
            trash: createAgentTrashListPort(pool, config.secretKey),
            trashRestore: createAgentTrashRestorePort(core, fileRestores),
            ...(trashPurgeConfirmation && core.receipts ? { trashPurge: createPermanentDeleteTool(
              createAgentTrashPurgePort({ core, pool, lease, operations: trashOperations,
                confirmation: { gate: trashPurgeConfirmation.gate, claim: trashPurgeConfirmation.claim } }),
              { gate: trashPurgeConfirmation.gate, claim: trashPurgeConfirmation.claim },
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
            skillMetadata,
            ...(core.receipts ? { skillManagement: createSkillManagementWriteTools(core, userSkillManager, authorizeRunWrite) } : {}),
            ...(skillDeleteConfirmation ? {
              skillDelete: createSkillDeleteTool(core, { gate: skillDeleteConfirmation.gate, claim: skillDeleteConfirmation.claim }, async ownerId =>
                publisher.publishResourceChanged({ ownerId, resource: 'skills', operation: 'refresh' })),
            } : {}),
            search: globalSearch,
            knowledge: createWebOwnerAgentKnowledgeReadPort(core, knowledgeStore, {
              timezone: (identity, signal) => context.loadTimezone(identity, signal),
            }),
            ...(memoryEnabled && process.platform === 'linux' && core.receipts && canRebuildAgentMemoryIndex() ? {
              remember: createLocalAgentRememberPort({
                core, storageRoot: config.storageLocalPath, authorize: authorizeRunWrite,
                embedding: { resolve: resolveEmbeddingSettings, createTransport: createEmbeddingTransport },
              }),
            } : {}),
            ...(process.platform === 'linux' ? {
              knowledgeWrites: createLocalAgentKnowledgeWritePort(core, config.storageLocalPath, knowledgeStore),
            } : {}),
            ...(knowledgeDeleteConfirmation ? { knowledgeDelete: createKnowledgeDeleteTool(createLocalAgentKnowledgeDeletePort(
              core, config.storageLocalPath, knowledgeStore, knowledgeDeleteConfirmation,
            )) } : {}),
            ...(trustedIntents ? createWebAgentCanvasWritePorts({
              core,
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
            ...createWebAgentCalendarWritePorts({
              core, pool, lease, delivery,
              publishCreate: publishCalendarCreate,
              publishUpdate: publishCalendarMutation,
              publishDelete: publishCalendarMutation,
              ...(deleteEventConfirmation ? { deleteConfirmation: deleteEventConfirmation } : {}),
            }),
          }
        },
        embedding: {
          resolve: (ownerId, signal) => resolveEmbeddingSettings(ownerId, signal),
          createTransport: createEmbeddingTransport,
        },
      },
      reflection: {
        commands: reflectionCommands,
        modelScope: reflectionModelScope,
        enabled: () => !!ownerReflectionWork && canRebuildAgentMemoryIndex(),
        threshold: () => reflectionThreshold,
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
            async catalog() { return null },
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
        mcp: createWebAgentMcpProductionPorts({ directory: mcpSkillTools, runtime: mcpRuntime }),
      },
    })
    const dispatch = createPostgresAgentDispatch(pool, config.secretKey)
    const reconstruct = createWebAgentReconstructor({
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
      pool, secretKey: config.secretKey, redisUrl: agentRedisUrl, dispatchTtlSeconds: 7 * 24 * 60 * 60,
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
    agentRunLog: agentLog.log }
}
