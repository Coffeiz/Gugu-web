import { createDataExportCreator } from '@gugu/core/data-portability/create-export'
import { createDataExportPreviewReader } from '@gugu/core/data-portability/export-preview'
import { createDataImportResumer } from '@gugu/core/data-portability/resume-import'
import { createImMemorySummaryReader } from '@gugu/core/im-memory-summary'
import { createAdminUserBanToggle } from '@gugu/core/admin-user-ban'
import { renderEmailPreview } from '@gugu/core/email-preview'
import { createSmtpFileProbe } from './modules/admin/smtp-probe.js'
import { createAdminEmailFileTest } from './modules/admin/email-test.js'
import { createLlmStrategySetter, invalidateAllProviderReasoningStates } from '@gugu/core/agent/config/llm-strategy'
import { createLlmPresetSelection } from '@gugu/core/agent/config/llm-preset-selection'
import { createLlmCapabilityOverrideSetter } from '@gugu/core/agent/config/llm-capability-overrides'
import { createLlmPresetMutations } from '@gugu/core/agent/config/llm-preset-mutations'
import { createLlmModelDirectory } from '@gugu/core/agent/config/llm-model-directory'
import { createAdminModelDirectory } from '@gugu/core/agent/config/admin-model-directory'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { createLlmStrategyFileMutator } from './modules/admin/llm-strategy.js'
import { createAdminMisreadReader } from '@gugu/core/perception-recent-misread'
import { createPerceptionEventExporter } from '@gugu/core/perception-export'
import { createMisreadMarkdownExporter } from '@gugu/core/perception-misread-export'
import { createLocalMisreadTextReader } from './modules/admin/perception-misread-export.js'
import { createPerceptionStatsReader } from '@gugu/core/perception-stats'
import { createSecretPromptCancellation } from '@gugu/core/agent-secret-cancel'
import { createFileSyncRunReader } from '@gugu/core/filesync-run-read'
import { createFileSyncRunCancellation } from '@gugu/core/filesync-run-cancel'
import { createFileSyncDryRun, createFileSyncInitialize } from '@gugu/core/filesync-dry-run'
import { createWatcherCapacityRequester } from './adapters/inotify-limit-client.js'
import { createRedisFileSyncPublisher } from './adapters/redis-events.js'
import { createRedisHashReader } from './adapters/redis-events.js'
import { createRedisListReader } from './adapters/redis-events.js'
import { createAdminEmbeddingRebuildStatusReader } from '@gugu/core/admin-embedding-rebuild-status'
import { createDataExportDownloader, requireExportReadyForTicket } from '@gugu/core/data-portability/download-export'
import { createPortableArtifactOpener } from './modules/data-portability/artifact-source.js'
import { createTaskFilesystemAuthorization } from '@gugu/core/scheduled-task-filesystem-authorize'
import { createTaskAuthorizationEnabledReader } from './modules/scheduled-tasks/task-filesystem-authorize.js'
import { createRedisFilesystemAuthorizationMetric } from './adapters/redis-events.js'
import { createVoicePresetFileMutations } from './modules/admin/voice-presets-mutate.js'
import { createDataExportCanceler } from '@gugu/core/data-portability/cancel-export'
import { withPostgresTransaction } from './adapters/postgres-transaction.js'
import { createTerminalDeletion } from '@gugu/core/terminals/delete'
import { createVoicePresetsFileReader } from './modules/admin/voice-presets-read.js'
import { createAdminMaintenanceStatus } from '@gugu/core/maintenance/admin-status'
import { createRedisAdminMaintenanceCommands } from './adapters/redis-events.js'
import { createServiceStatusReader } from './modules/admin/service-status.js'
import { createRedisServiceStatusCommands } from './adapters/redis-events.js'
import { createAttachmentDownloader } from '@gugu/core/agent/attachments/download'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import { createPostgresRedisBindingCodeIssuer } from './modules/im/binding-code.js'
import { createTaskFilesystemRevoker } from '@gugu/core/scheduled-task-filesystem-revoke'
import { createRedisFilesystemRevokeMetric } from './adapters/redis-events.js'
import { createRedisStorageQuotaStatusStore } from './modules/admin/storage-quota-status.js'
import { createNotificationBroadcaster } from '@gugu/core/notifications/broadcast'
import { createRedisNotificationPublisher } from './adapters/redis-events.js'
import { createMcpStatusReader } from '@gugu/core/mcp/status'
import { createMcpEnabledReader } from './modules/mcp/status.js'
import { createEmailRecipientCounter } from '@gugu/core/admin/email-recipient-count'
import { createEmbeddingRebuildStatusReader } from '@gugu/core/byok/embedding-rebuild-status'
import { createRedisValueReader } from './adapters/redis-events.js'
import { createPostgresUserBotUnbinder } from './modules/im/user-bot-unbind.js'
import { createQqBotCreator, invalidateOwnerImSnapshots } from '@gugu/core/im/user-bot-create'
import { createUserBotDeleter } from '@gugu/core/im/user-bot-delete'
import { createUserBotUpdater } from '@gugu/core/im/user-bot-update'
import { createQqConnector } from '@gugu/core/im/qq-connect'
import { createQqConnectHostOptions } from './modules/im/qq-connect.js'
import { createFeishuConnector } from '@gugu/core/im/feishu-connect'
import { createFeishuConnectHostOptions } from './modules/im/feishu-connect.js'
import { createWechatConnector } from '@gugu/core/im/wechat-connect'
import { createWechatConnectHostOptions } from './modules/im/wechat-connect.js'
import { createRedisUserBotReachCleaner } from './adapters/redis-events.js'
import { encryptEncryptedString, decryptEncryptedString } from './adapters/encrypted-string.js'
import { createPortabilityJobReader } from '@gugu/core/data-portability/read-jobs'
import { createPostgresUserBotsReader } from './modules/im/user-bots.js'
import { createImPlatformSettingsReader } from './modules/im/platform-settings.js'
import { createCredentialDeletion } from '@gugu/core/byok/credential-delete'
import { createCredentialPatch } from '@gugu/core/byok/credential-patch'
import { createCredentialModelsPreview } from '@gugu/core/byok/credential-models-preview'
import { createCredentialCreator } from '@gugu/core/byok/credential-create'
import { createProviderCapabilityPreview } from '@gugu/core/byok/capabilities-preview'
import { createByokListService, createPostgresByokListReader } from '@gugu/core/agent/config'
import { createConfiguredByokEnvelope } from './adapters/byok-envelope.js'
import { createByokGateReader } from './modules/byok/gate.js'
import { createByokModelsPreviewFetcher } from './modules/byok/models-preview.js'
import { createStorageLiveTotals } from '@gugu/core/admin/storage-live-totals'
import { createUserSkillDeletion } from '@gugu/core/agent/skills/user-delete'
import { createSafeEgressSettingsReader } from './modules/admin/safe-egress-settings.js'
import { createSafeEgressFileUpdater } from './modules/admin/safe-egress-update.js'
import { createSafeEgressFileProbe } from './modules/admin/safe-egress-probe.js'
import { createEmbeddingFileProbe } from './modules/admin/embedding-probe.js'
import { createSystemLogReader } from '@gugu/core/admin/system-logs'
import { createAdminAuditLogReader } from '@gugu/core/admin-audit-log'
import { createNotificationAdminHistory } from '@gugu/core/notifications/admin-history'
import { createPostgresAdminSettingsTransaction } from './modules/admin/user-settings.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { createPostgresRuntime, type SqlDataRuntime } from '@gugu/core/data'
import { createPostgresGlobalSearchSources } from '@gugu/core/search/postgres'
import { createGlobalSearchOperations, createKyselyPreferenceDocumentStore, type Fields, type RequestContext } from '@gugu/core'
import { createApp, type WriteRequestMetadata } from './app.js'
import type { UserAuthOptions } from './domains/auth/contracts.js'
import { loadConfig, type WebUiConfig } from './config.js'
import { readConfigOverride, resolveConfigOverridePath } from './adapters/config-override-file.js'
import { checkDatabaseReadiness } from './database.js'
import { createUserRepository } from './domains/auth/persistence/users.js'
import { createRedisLiveSubscription } from './adapters/redis-live-subscription.js'
import { createPostgresUserQuotaReader, type UserQuotaSettings } from './domains/auth/persistence/quota.js'
import { createPostgresUserAvatarOperations } from './domains/auth/persistence/avatar.js'
import { createPostgresPreferencesStore } from './domains/preferences/persistence/postgres.js'
import { createKyselyOnboardingStore } from '@gugu/core/onboarding'
import { createRegistrationSeeder } from '@gugu/core/onboarding'
import { createPostgresRegistrationSeedOperations } from './modules/onboarding/persistence/registration-seed-postgres.js'
import { createOnboardingSurpriseMp3Reader } from './modules/onboarding/surprise-asset.js'
import { createRedisRegistrationCodeStore } from './domains/auth/persistence/registration-codes.js'
import { createPostgresRegistrationOperations } from './domains/auth/persistence/registration.js'
import { createPostgresPasswordResetStore } from './domains/auth/password-reset.js'
import { createPostgresEmailChangeStore } from './domains/auth/email-change.js'
import { createAuthEmailSender, createSmtpTransport } from './domains/auth/smtp-email.js'
import { createProjectFileCountListing, createProjectGetter, createProjectListing } from './domains/projects/persistence/projects.js'
import { projectResponse } from '@gugu/core'
import { createClientOperations } from './modules/clients/persistence/clients.js'
import { createPostgresMindRefSuggestOperations } from './domains/mind/persistence/mind-ref-suggest-postgres.js'
import { createMindCanvasNoteMutations } from '@gugu/core/mind'
import { createMindRefNodeCreator } from '@gugu/core/mind'
import { createMindNoteCreator } from '@gugu/core/mind'
import { createMindCanvasCreation, createMindCanvasUpdate, createMindCanvasDelete, createMindCanvasItemAdd, createMindCanvasItemRemove, createMindCanvasItemUpdate, createMindCanvasRelationCreate, createMindCanvasRelationDelete, createMindGlobalRelationDelete, createSqlMindCanvasCreateRuntime, createSqlMindCanvasUpdateRuntime, createSqlMindCanvasDeleteRuntime, createSqlMindCanvasNoteRuntime, createSqlMindCanvasItemAddRuntime, createSqlMindCanvasItemRemoveRuntime, createSqlMindCanvasItemUpdateRuntime, createSqlMindCanvasRelationCreateRuntime, createSqlMindCanvasRelationDeleteRuntime, createSqlMindGlobalRelationDeleteRuntime, createSqlMindRefNodeCreateRuntime, createSqlMindCanvasReader, createSqlMindNoteReader, createSqlMindNoteInserter, createSqlMindNoteMutator } from '@gugu/core/mind'
import { createMindNoteMutations } from '@gugu/core/mind'
import { createHostCoreUndoOperations } from './domains/undo/persistence/core-operations.js'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { createScheduledTaskDeleter } from '@gugu/core/scheduled-task-delete'
import { createKyselyScheduledTaskDeleteRuntime } from '@gugu/core/scheduled-task-delete-data'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '@gugu/core/scheduled-task-list'
import { createScheduledTaskDeliveryTargets } from './modules/scheduled-tasks/delivery-targets.js'
import { createKyselyNotificationOperations } from '@gugu/core/notifications'
import { createKyselySmtpStore, createUserSmtpSettings } from '@gugu/core/smtp'
import { encryptEncryptedString as encryptSmtpPassword } from './adapters/encrypted-string.js'
import { startSecurityRetentionWorker } from './maintenance/security-retention.js'
import { createTrackOperations } from './modules/site/persistence/track.js'
import { createFeedbackNotifier, createFeedbackService, createFeedbackSubmission, createKyselyFeedbackOperations } from '@gugu/core/feedback'
import { runBestEffort } from './adapters/best-effort.js'
import { revokeUserSessions } from './domains/auth/persistence/auth-revocation.js'
import { createKyselyProjectCreateRuntime } from '@gugu/core/project-create-data'
import { createProjectCreator } from '@gugu/core/project-create'
import { createPostgresProjectUpdateRuntime } from './domains/projects/persistence/project-update-postgres.js'
import { createLocalProjectDirectoryRenamer } from './domains/projects/persistence/project-directory-storage.js'
import { createProjectUpdater } from '@gugu/core/project-update'
import { createProjectTrashService } from './domains/projects/application/project-trash.js'
import { createPostgresProjectTrashRuntime } from './domains/projects/persistence/project-trash-postgres.js'
import {
  createLocalProjectTrashStorage,
  createProjectTrashOriginalStorageKeyResolver,
} from './domains/projects/persistence/project-trash-storage.js'
import { createPostgresProjectTrashPathMetadataReader } from './domains/projects/persistence/project-trash-path-metadata-postgres.js'
import { createProjectPostCommitPublisher } from './domains/projects/persistence/project-post-commit-postgres.js'
import { createCalendarEvent } from '@gugu/core/calendar'
import { createCalendarEventPostCommitPublisher } from './modules/calendar/persistence/calendar-create-post-commit-postgres.js'
import { createCalendarEventReader, createKyselyCalendarReadPort, createKyselyCalendarCreateStore, createKyselyCalendarMutationStores } from '@gugu/core/calendar'
import { deleteCalendarEvent } from '@gugu/core/calendar'
import { createCalendarMutationPostCommitPublisher } from './modules/calendar/persistence/calendar-mutation-post-commit-postgres.js'
import { updateCalendarEvent } from '@gugu/core/calendar'
import { createPostgresWorkspaceCreator } from './domains/workspaces/persistence/workspace-create.js'
import { createPostgresWorkspaceUpdater } from './domains/workspaces/persistence/workspace-update.js'
import { createPostgresWorkspaceBindingOperations } from './domains/workspaces/persistence/workspace-bindings.js'
import { createPostgresWorkspaceLister } from './domains/workspaces/persistence/workspace-list.js'
import { createPostgresWorkspaceDeleter } from './domains/workspaces/persistence/workspace-delete.js'
import { createPostgresWorkspaceDirectoryOperations } from './domains/workspaces/persistence/workspace-directories.js'
import { createAgentSessionLister } from './domains/agent-sessions/agent-sessions.js'
import {
  createAgentSessionFilesystemAuthorization,
  unavailableFilesystemAuthorizationConfirmations,
} from './domains/agent-sessions/agent-filesystem-authorization.js'
import { createFilesystemAuthorizationConfirmationStore } from './domains/agent-sessions/filesystem-authorization-confirmations.js'
import { createPostgresAgentSessionRefresher } from './domains/agent-sessions/agent-session-refresh.js'
import { createPostgresAgentSessionRenamer } from './domains/agent-sessions/agent-session-rename.js'
import { createAgentMessageHistory } from './domains/agent-sessions/persistence/agent-message-history.js'
import { createPostgresAgentOrphanRecovery } from './domains/agent-sessions/persistence/agent-run-recovery.js'
import { createPostgresAgentInteractionHistory } from '@gugu/core/agent-sessions'
import { createInteractionSessionLookup } from './domains/agent-sessions/persistence/agent-interaction-session.js'
import { createPostgresAgentMessageLocator } from './domains/agent-sessions/agent-message-location.js'
import {
  createPostgresAgentImportedDraftQueueReader,
  createPostgresAgentPendingQueueReader,
} from './domains/agent-sessions/agent-pending-queues.js'
import {
  createPostgresAgentPendingQueuePatch,
  createPostgresAgentPendingQueueReplace,
} from './domains/agent-sessions/agent-pending-queue-patch.js'
import { createPostgresAgentPendingQueueClaims } from './domains/agent-sessions/agent-pending-queue-claims.js'
import { createPostgresAgentToolEventDetails } from './domains/agent-sessions/agent-tool-event-details.js'
import { agentCommandMenu } from '@gugu/core/agent/commands/menu'
import { DEFAULT_AGENT_STATE_LABELS } from '@gugu/core/agent-sessions'
import { createAgentStateLabelOverrides } from './domains/agent-sessions/agent-state-label-config.js'
import { createPostgresFileBrowserOperations } from './domains/files/file-browser-postgres.js'
import { createPostgresFileReadOperations } from './domains/files/file-reads-postgres.js'
import { createPostgresFileUploadOperations } from './domains/files/file-upload-postgres.js'
import { createPostgresFileDeleteOperations } from './domains/files/file-delete-postgres.js'
import { createPostgresFileRestoreOperations } from './domains/files/file-restore-postgres.js'
import { createPostgresTrashReadOperations } from './domains/files/persistence/trash-postgres.js'
import { createPostgresTrashMutationOperations } from './domains/files/persistence/trash-mutations-postgres.js'
import { createPostgresTrashPurgeOperations } from './domains/files/persistence/trash-purge-postgres.js'
import { createPostgresFileContentOperations } from './domains/files/file-content-postgres.js'
import { createPostgresFileUpdateOperations } from './domains/files/file-update-postgres.js'
import { createPostgresFileCopyOperations } from './domains/files/file-copy-postgres.js'
import { createPostgresFileConflictOperations } from './domains/files/file-conflicts-postgres.js'
import { createPostgresFileBatchDownloadOperations } from './domains/files/file-batch-download-postgres.js'
import { createPostgresFileArchiveOperations } from './domains/files/file-archive-postgres.js'
import { createPostgresFolderReadOperations } from './domains/files/folder-reads-postgres.js'
import { capturePostgresFolderPathMirrorDirectoryKeys, createPostgresFolderPathMirrorPlanner } from './domains/files/folder-path-planner.js'
import { createLocalPathMirrorMutation } from './domains/files/local-path-mirror.js'
import { createPostgresFolderWriteOperations, type FolderUndoRecord } from './domains/files/folder-writes-postgres.js'
import { prepareWorkspaceDirectoryAcl } from './adapters/workspace-directory-acl.js'
import { createSandboxdWorkspacePtyTerminator } from './adapters/sandboxd-pty.js'
import {
  createRedisAdminAuthVersionStore,
  createRedisEventPublisher,
  createRedisRateLimitCommands,
  createRedisRegistrationCodeCommands,
  createRedisPasswordResetCommands,
  createRedisAgentActiveStatusReader,
  createRedisAgentRunRecoveryState,
  createRedisFilesystemAuthorizationCommands,
  createRedisTrashPurgeNotifier,
  type RedisEventPublisher,
} from './adapters/redis-events.js'
import {
  createInMemoryRateLimitCommands,
  createRedisRateLimiter,
  RateLimitError,
} from './domains/auth/rate-limit.js'
import {
  AdminAuthError,
  createAdminAuthAdapter,
  createInMemoryAdminAuthVersionStore,
} from './domains/admin/admin-auth.js'
import {
  createPostgresAdminStorageSnapshotQuery,
  diskUsageForStorage,
} from './domains/admin/admin-storage-snapshots.js'
import {
  createPostgresAdminUserStatusStore,
  createPostgresAdminUsersQuery,
} from './domains/admin/admin-users.js'
import { createPostgresAdminUserRiskQuery } from './domains/admin/admin-user-risk.js'
import type { AdminDebugLogSource } from './domains/admin/admin-debug-logs.js'
import { createAdminHostGuard } from './http/admin-host-guard.js'
import {
  createPostgresAdminSecurityEventQuery,
  createSecurityEventFingerprint,
} from './domains/admin/admin-audit-log.js'
import { createPostgresAdminUserSecurityEventQuery } from './domains/admin/admin-user-security-events.js'

function createPool(config: WebUiConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.postgresPoolMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
}

async function recordFolderUndo(client: PoolClient, record: FolderUndoRecord): Promise<void> {
  const contextId = record.contextId?.trim().slice(0, 128)
  if (!contextId) return
  const ref = `folder:${record.folder.id}`
  const snapshot = (folder: FolderUndoRecord['folder']) => ({
    id: folder.id,
    name: folder.name,
    project_id: folder.projectId,
    workspace_directory_id: folder.workspaceDirectoryId,
    parent_id: folder.parentId,
    version: folder.version,
    deleted_at: null,
  })
  const beforeItems = record.before ? { [ref]: snapshot(record.before) } : {}
  const afterItems = { [ref]: snapshot(record.folder) }

  await client.query(
    `UPDATE undo_operations
     SET status = 'expired', failure_code = 'redo_cleared_by_new_operation'
     WHERE user_id = $1 AND undo_context_id = $2 AND actor_type = 'web' AND status = 'undone'`,
    [record.userId, contextId],
  )
  await client.query(
    `INSERT INTO undo_operations (
       id, user_id, undo_context_id, group_id, resource, action, target_refs,
       before_state, after_state, base_versions, artifact_refs, actor_type,
       status, created_at, expires_at, undone_at, failure_code
     ) VALUES (
       $1, $2, $3, $4, 'files', $5, $6::json, $7::json, $8::json, $9::json,
       '{}'::json, 'web', 'active', CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP + INTERVAL '30 days', NULL, NULL
     )`,
    [
      `op-${randomUUID().replaceAll('-', '')}`,
      record.userId,
      contextId,
      `group-${randomUUID().replaceAll('-', '')}`,
      record.action,
      JSON.stringify([{ kind: 'folder', id: record.folder.id }]),
      JSON.stringify({ items: beforeItems }),
      JSON.stringify({ items: afterItems }),
      JSON.stringify({ [ref]: { version: record.before?.version ?? 0 } }),
    ],
  )
}

function folderSearchAlias(name: string): string {
  // Preserve case-insensitive literal search until the Python pinyin/Sudachi indexer is ported.
  return name.toLowerCase()
}

const noRedisEvents: RedisEventPublisher = {
  async publishAuthStateChanged() { return false },
  async bumpContextRevision() { return false },
  async publishResourceChanged() { return false },
}

function createUserAuth(
  pool: Pool,
  secret: string,
  tokenExpiresMinutes: number,
  redisEvents?: RedisEventPublisher,
  rateLimit = createRedisRateLimiter(null),
  quotaSettings?: UserQuotaSettings,
): UserAuthOptions {
  return {
    secret,
    tokenExpiresMinutes,
    ...createUserRepository(pool),
    ...(quotaSettings ? { getQuota: createPostgresUserQuotaReader(pool, quotaSettings) } : {}),
    async revokeUserSessions(userId) {
      await revokeUserSessions(pool, userId)
    },
    publishAuthStateChanged: (userId: string) => (redisEvents ?? noRedisEvents).publishAuthStateChanged(userId),
    rateLimit,
  }
}

function objectSetting(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function optionalIntegerSetting(envValue: string | undefined, configValue: unknown, key: string): number | null {
  const raw = envValue === undefined ? configValue : envValue.trim()
  if (raw === undefined || raw === null || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${key} 配置无效`)
  return value
}

function booleanSetting(envValue: string | undefined, configValue: unknown, fallback: boolean): boolean {
  const raw = envValue === undefined ? configValue : envValue.trim().toLowerCase()
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    if (['1', 'true', 't', 'yes', 'y', 'on'].includes(raw.toLowerCase())) return true
    if (['0', 'false', 'f', 'no', 'n', 'off'].includes(raw.toLowerCase())) return false
  }
  throw new Error('用户配额功能开关配置无效')
}

function userQuotaSettings(config: WebUiConfig, env: NodeJS.ProcessEnv): UserQuotaSettings {
  const override = config.configOverridePath ? readConfigOverride(config.configOverridePath) : {}
  const quota = objectSetting(override.quota)
  const byok = objectSetting(override.byok)
  const ai = objectSetting(override.ai)
  const deploymentMode = env.AI__DEPLOYMENT_MODE?.trim().toLowerCase()
    || String(ai.deployment_mode ?? 'cloud').trim().toLowerCase()
  return {
    defaultLimit6h: optionalIntegerSetting(
      env.QUOTA__DEFAULT_TOKEN_LIMIT_6H, quota.default_token_limit_6h, 'QUOTA__DEFAULT_TOKEN_LIMIT_6H',
    ),
    defaultLimitWeekly: optionalIntegerSetting(
      env.QUOTA__DEFAULT_TOKEN_LIMIT_WEEKLY, quota.default_token_limit_weekly, 'QUOTA__DEFAULT_TOKEN_LIMIT_WEEKLY',
    ),
    byokEnabled: booleanSetting(env.BYOK__ENABLED, byok.enabled, true),
    localDeployment: deploymentMode === 'local',
    serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }
}

function createAdminAuth(pool: Pool, config: WebUiConfig) {
  const versions = config.redisUrl
    ? createRedisAdminAuthVersionStore(config.redisUrl)
    : createInMemoryAdminAuthVersionStore()
  const limiter = createRedisRateLimiter(config.redisUrl
    ? createRedisRateLimitCommands(config.redisUrl)
    : createInMemoryRateLimitCommands())
  return createAdminAuthAdapter({
    username: config.adminUsername,
    password: config.adminPassword,
    secret: config.secretKey,
    tokenExpiresMinutes: config.accessTokenExpiresMinutes,
    getAuthVersion: versions.getAuthVersion,
    incrementAuthVersion: versions.incrementAuthVersion,
    async rateLimit(request, bucket, limit, windowSeconds) {
      try {
        await limiter(request, { bucket, limit, windowSeconds })
      } catch (error) {
        if (error instanceof RateLimitError)
          throw new AdminAuthError(error.message, error.statusCode)
        throw error
      }
    },
    hostGuard: createAdminHostGuard(config.adminAllowedHosts),
    async audit(username, action, detail, request) {
      const forwarded = request.headers['x-forwarded-for']
      const ip = typeof forwarded === 'string'
        ? forwarded.split(',', 1)[0]?.trim().slice(0, 60) || null
        : request.ip.slice(0, 60) || null
      await pool.query(
        'INSERT INTO audit_logs (username, action, description, ip, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
        [username, action, detail, ip],
      )
    },
  })
}

function createWebUiApp(
  config: WebUiConfig,
  pool: Pool,
  core: SqlDataRuntime,
  redisEvents?: RedisEventPublisher,
  env: NodeJS.ProcessEnv = process.env,
) {
  const publisher = redisEvents ?? noRedisEvents
  const qqConnectOptions = createQqConnectHostOptions(env, config.redisUrl ?? '')
  const feishuConnectOptions = createFeishuConnectHostOptions(env, config.redisUrl ?? '')
  const wechatConnectOptions = createWechatConnectHostOptions(env, config.redisUrl ?? '')
  const publishFileSyncRun = async ({ runId, bindingId, revision }: { runId: string; bindingId: number; revision: number }) => {
    if (config.redisUrl) await createRedisFileSyncPublisher(config.redisUrl)({ protocol_version: 'live-event-v1', event_id: `evt-${randomUUID().replaceAll('-', '')}`, type: 'filesync.run.changed', run_id: runId, binding_id: bindingId, revision, created_at: new Date().toISOString() })
  }
  const createMindNote = createMindNoteCreator({
    insert: createSqlMindNoteInserter(core.db, 'postgres'),
    async publishCreated({ ownerId, note, clientId, mutationId }) {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation: 'create',
        entityId: note.id,
        origin: clientId,
        mutationId,
        payload: { kind: 'note', entity: note },
      })
    },
    reportFailure(operation) {
      console.error(`gugu-webui ${operation} failed`)
    },
  })
  const mindNoteMutations = createMindNoteMutations({
    ...createSqlMindNoteMutator(core.db, 'postgres'),
    async publishUpdated({ ownerId, note, clientId, mutationId }) {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation: 'update',
        entityId: note.id,
        origin: clientId,
        mutationId,
        payload: { kind: 'note', entity: note },
      })
    },
    async publishDeleted({ ownerId, noteId, clientId, mutationId }) {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation: 'delete',
        entityId: noteId,
        origin: clientId,
        mutationId,
        payload: { kind: 'note', entity: { id: noteId } },
      })
    },
    reportFailure(operation) {
      console.error(`gugu-webui ${operation} failed`)
    },
  })
  const publishCanvasChanged = async ({ ownerId, operation, entityId, origin, entity }: { ownerId: string; operation: 'create' | 'update' | 'delete'; entityId: number; origin: string | null; entity: unknown }) => {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation,
        entityId,
        origin,
        payload: { kind: 'canvas', entity },
      })
    }
  const reportMindFailure = (operation: string) => { console.error(`gugu-webui ${operation} 失败`) }
  const mindCanvasCreate = createMindCanvasCreation(createSqlMindCanvasCreateRuntime(core.db, 'postgres', publishCanvasChanged, reportMindFailure))
  const mindCanvasUpdate = createMindCanvasUpdate(createSqlMindCanvasUpdateRuntime(core.db, 'postgres', publishCanvasChanged, reportMindFailure))
  const mindCanvasDelete = createMindCanvasDelete(createSqlMindCanvasDeleteRuntime(core.db, 'postgres', publishCanvasChanged, reportMindFailure))
  const mindCanvasNoteMutations = createMindCanvasNoteMutations(createSqlMindCanvasNoteRuntime(
    core.db, 'postgres',
    async ({ ownerId, operation, entityId, origin, mutationId, entityKind, entity }) => {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation,
        entityId,
        origin,
        mutationId,
        payload: { kind: entityKind, entity },
      })
    },
    (operation) => {
      console.error(`gugu-webui ${operation} failed`)
    },
  ))
  const mindCanvasItemUpdate = createMindCanvasItemUpdate(createSqlMindCanvasItemUpdateRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'canvas_item', entity } })
    }, reportMindFailure,
  ))
  const mindCanvasItemRemove = createMindCanvasItemRemove(createSqlMindCanvasItemRemoveRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'canvas_item', entity } })
    }, reportMindFailure,
  ))
  const mindCanvasItemAdd = createMindCanvasItemAdd(createSqlMindCanvasItemAddRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'canvas_item', entity } })
    }, reportMindFailure,
  ))
  const mindGlobalRelationDelete = createMindGlobalRelationDelete(createSqlMindGlobalRelationDeleteRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'relation', entity } })
    }, reportMindFailure,
  ))
  const mindCanvasRelationCreate = createMindCanvasRelationCreate(createSqlMindCanvasRelationCreateRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'relation', entity } })
    }, reportMindFailure,
  ))
  const mindCanvasRelationDelete = createMindCanvasRelationDelete(createSqlMindCanvasRelationDeleteRuntime(
    core.db, 'postgres', async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'mind', operation, entityId, origin, mutationId, payload: { kind: 'relation', entity } })
    }, reportMindFailure,
  ))
  const mindRefNodeCreator = createMindRefNodeCreator(createSqlMindRefNodeCreateRuntime(
    core.db, 'postgres',
    async ({ ownerId, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation: 'create',
        entityId,
        origin,
        mutationId,
        payload: { kind: 'ref_node', entity },
      })
    },
    (operation) => {
      console.error(`gugu-webui ${operation} failed`)
    },
  ))
  const globalSearch = createGlobalSearchOperations(createPostgresGlobalSearchSources(pool))
  const mindRefSuggest = createPostgresMindRefSuggestOperations(pool, globalSearch)
  const publishProjectMutation = createProjectPostCommitPublisher(pool, {
    bumpContextRevision: (ownerId, resource) => publisher.bumpContextRevision(ownerId, resource),
    async publishResourceChanged(event) {
      await publisher.publishResourceChanged({
        ownerId: event.userId,
        resource: event.resource,
        operation: event.operation,
        entityId: event.entityId,
        entityIds: event.entityIds,
        origin: event.origin,
        payload: event.payload,
      })
    },
  })
  const projectCreate = createProjectCreator(createKyselyProjectCreateRuntime({
    db: core.db, backend: 'postgres', publishProjectCreated: publishProjectMutation,
  }))
  const projectDirectoryRenamer = createLocalProjectDirectoryRenamer(config.storageLocalPath)
  const projectUpdate = createProjectUpdater(createPostgresProjectUpdateRuntime(
    pool,
    projectDirectoryRenamer,
    publishProjectMutation,
  ))
  const projectTrash = createProjectTrashService(
    createPostgresProjectTrashRuntime(pool, publishProjectMutation),
    createLocalProjectTrashStorage(
      config.storageLocalPath,
      createProjectTrashOriginalStorageKeyResolver(createPostgresProjectTrashPathMetadataReader(pool)),
    ),
  )
  const eventStore = createKyselyCalendarCreateStore(core.db, 'postgres', createCalendarEventPostCommitPublisher({
    bumpContextRevision: (ownerId) => publisher.bumpContextRevision(ownerId, 'calendar'),
    publishResourceChanged: (event) => publisher.publishResourceChanged(event),
  }))
  const publishCalendarMutation = createCalendarMutationPostCommitPublisher(pool, {
    bumpContextRevision: (ownerId) => publisher.bumpContextRevision(ownerId, 'calendar'),
    publishResourceChanged: (publication) => publisher.publishResourceChanged(publication),
  })
  const eventMutations = createKyselyCalendarMutationStores(core.db, 'postgres', publishCalendarMutation)
  const eventDeleteStore = eventMutations.delete
  const eventUpdateStore = eventMutations.update
  const eventCreate = (context: RequestContext, input: unknown, metadata: WriteRequestMetadata) =>
    createCalendarEvent(eventStore, {
      ownerId: context.data.ownerId,
      input,
      idempotencyKey: metadata.idempotencyKey,
      undoContextId: metadata.undoContextId,
      clientId: metadata.clientId,
    })
  const folderPathPlanner = createPostgresFolderPathMirrorPlanner(config.storageLocalPath, folderSearchAlias)
  const folderWrites = createPostgresFolderWriteOperations(pool, {
    buildSearchRomaji: folderSearchAlias,
    async preparePathMirrorMutation(client, ownerId, folderId, action, beforeName, previousDirectoryKeys) {
      return folderPathPlanner(client, ownerId, folderId, action, beforeName, previousDirectoryKeys)
    },
    async capturePathMirrorDirectoryKeys(client, ownerId, folderId) {
      return capturePostgresFolderPathMirrorDirectoryKeys(config.storageLocalPath, client, ownerId, folderId)
    },
    recordForwardUndo: recordFolderUndo,
    async publishChanged(event) {
      await publisher.publishResourceChanged({
        ownerId: event.ownerId,
        resource: 'files',
        operation: event.operation,
        entityId: event.folder.id,
        origin: event.origin,
        payload: {
          kind: 'folder',
          entity: {
            id: event.folder.id,
            projectId: event.folder.projectId,
            workspaceDirectoryId: event.folder.workspaceDirectoryId,
            parentId: event.folder.parentId,
            name: event.folder.name,
            fileCount: event.folder.fileCount,
            folderCount: event.folder.folderCount,
            version: event.folder.version,
          },
        },
      })
    },
    onPathCleanupFailure(errorType) {
      console.error(`gugu-webui files PathMirror cleanup failed: ${errorType}`)
    },
    onPathRollbackFailure(errorType) {
      console.error(`gugu-webui files PathMirror rollback failed: ${errorType}`)
    },
  })
  const workspaceCreate = createPostgresWorkspaceCreator(pool)
  const workspaceUpdate = createPostgresWorkspaceUpdater(pool)
  const workspaceBindings = createPostgresWorkspaceBindingOperations(pool)
  const workspaceDelete = createPostgresWorkspaceDeleter(pool)
  const workspaceDirectories = createPostgresWorkspaceDirectoryOperations(pool, {
    localPath: config.storageLocalPath,
    prepareDirectoryAcl: prepareWorkspaceDirectoryAcl,
    terminateActivePty: createSandboxdWorkspacePtyTerminator(pool, config.sandboxdSocket),
  })
  const workspaceList = createPostgresWorkspaceLister(pool, {
    readRuntimeSettings: () => ({
      ...config.workspaceRuntimeSettings,
      // Node's Host has no sandbox daemon readiness probe yet; keep shell/PTY capability off.
      sandboxReady: false,
    }),
  })
  const listAgentSessions = createAgentSessionLister(pool, {
    activeStatuses: config.redisUrl
      ? createRedisAgentActiveStatusReader(config.redisUrl)
      : async () => new Map(),
    filesystemAuthorizationEnabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
    // Host 尚未探测 sandboxd 就绪状态；与 workspace list 一样禁用 Shell/PTY 展示。
    workspaceShellSupported: () => false,
  })
  const agentRunRecoveryState = config.redisUrl
    ? createRedisAgentRunRecoveryState(config.redisUrl)
    : undefined
  const listAgentMessages = createAgentMessageHistory(pool, {
    activeStatuses: config.redisUrl
      ? createRedisAgentActiveStatusReader(config.redisUrl)
      : async () => new Map(),
    filesystemAuthorizationEnabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
    // Host 尚未探测 sandboxd 就绪状态；与 workspace list 一样禁用 Shell/PTY 展示。
    workspaceShellSupported: () => false,
    ...(agentRunRecoveryState ? {
      recoverOrphanedSession: createPostgresAgentOrphanRecovery(pool, agentRunRecoveryState),
    } : {}),
    listInteractions: createPostgresAgentInteractionHistory(pool),
  }).list
  const agentQueueStatuses = config.redisUrl
    ? createRedisAgentActiveStatusReader(config.redisUrl)
    : async () => new Map<number, boolean>()
  const filesystemAuthorizationConfirmations = config.redisUrl
    ? createFilesystemAuthorizationConfirmationStore(
      createRedisFilesystemAuthorizationCommands(config.redisUrl),
    )
    : unavailableFilesystemAuthorizationConfirmations
  const agentFilesystemAuthorization = createAgentSessionFilesystemAuthorization(
    pool,
    filesystemAuthorizationConfirmations,
    {
      enabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
      secretKey: config.secretKey,
      terminateActivePty: createSandboxdWorkspacePtyTerminator(pool, config.sandboxdSocket),
    },
  )
  const publishPendingQueueChanged = async (ownerId: string, sessionId: number, origin?: string) => {
    await publisher.publishResourceChanged({
      ownerId,
      resource: 'pending_queues',
      operation: 'update',
      entityId: sessionId,
      origin,
    })
  }
  const userRepository = createUserRepository(pool)
  const rateLimit = createRedisRateLimiter(
    config.redisUrl ? createRedisRateLimitCommands(config.redisUrl) : null,
    (scope, category) => console.error(`gugu-webui 注册限流失败 scope=${scope} category=${category}`),
  )
  const registrationCodeStore = config.redisUrl
    ? createRedisRegistrationCodeStore(
      createRedisRegistrationCodeCommands(config.redisUrl),
      config.secretKey,
    )
    : undefined
  const passwordResetRedis = config.redisUrl
    ? createRedisPasswordResetCommands(config.redisUrl)
    : null
  const authEmailSender = createAuthEmailSender(config.smtp)
  const seedRegistration = createRegistrationSeeder({
    applySeed: createPostgresRegistrationSeedOperations(pool, {
      storageRoot: config.storageLocalPath,
      defaultLimitBytes: config.storageDefaultLimitBytes,
    }),
    surpriseMp3: createOnboardingSurpriseMp3Reader(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../backend/onboarding/assets'),
    ),
    onFailure() { console.error('gugu-webui onboarding seed failed') },
  })
  const registrationOperations = createPostgresRegistrationOperations(pool, {
    workspaceShellSupported: () => true,
    async prepareDefaultWorkspaceRoot(userId, directoryName) {
      await prepareWorkspaceDirectoryAcl(resolve(config.storageLocalPath, userId, 'workspace', directoryName))
    },
    // 关闭验证码时不会调用此端口；启用验证码但 Redis 不可用时保持 fail-closed。
    registrationCodes: registrationCodeStore ?? {
      async remainingTtlMs() { throw new Error('Registration code store is unavailable') },
      async consume() { return false },
      async restore() { throw new Error('Registration code store is unavailable') },
    },
    onCodeRestoreFailure() {
      console.error('gugu-webui registration code recovery failed')
    },
  })
  const logsDirectory = config.logFile
    ? dirname(config.logFile)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../backend/logs')
  const logPath = (name: string) => resolve(logsDirectory, `gugu-${name}.log`)
  const feedbackStore = createFeedbackService(createKyselyFeedbackOperations(core.db, 'postgres'))
  const prepareFeedbackNotice = createFeedbackNotifier(createKyselyPreferenceDocumentStore(core.db, 'postgres'), config.smtp, createSmtpTransport(config.smtp))
  const feedback = createFeedbackSubmission(feedbackStore, prepareFeedbackNotice, (send) => {
    setImmediate(() => { void runBestEffort('feedback_email', send, () => console.error('反馈通知邮件发送失败')) })
  })
  const fileRestores = createPostgresFileRestoreOperations(pool, {
    storageRoot: config.storageLocalPath,
    async publishChanged(event) {
      await publisher.publishResourceChanged({
        ownerId: event.ownerId,
        resource: 'files',
        operation: 'update',
        entityId: event.entityId,
        origin: event.origin,
        payload: { kind: event.entityType ?? 'file', id: event.entityId },
      })
    },
  })
  const trashOperations = {
    ...createPostgresTrashReadOperations(pool, config.secretKey),
    ...createPostgresTrashMutationOperations(pool, {
      storageRoot: config.storageLocalPath,
      async publishChanged(event) {
        await publisher.publishResourceChanged({
          ownerId: event.ownerId,
          resource: 'files',
          operation: 'delete',
          entityId: event.entityId,
          origin: event.origin,
          payload: { kind: event.entityType, id: event.entityId },
        })
      },
    }),
    ...createPostgresTrashPurgeOperations(pool, {
      notifyWorker: config.redisUrl ? createRedisTrashPurgeNotifier(config.redisUrl) : async () => undefined,
    }),
    restoreFolder(ownerId: string, folderId: number, origin: string | null) {
      if (!fileRestores.restoreFolder) throw new Error('Local 文件夹恢复适配器未就绪')
      return fileRestores.restoreFolder(ownerId, folderId, origin)
    },
    restoreFiles(ownerId: string, fileIds: number[], origin: string | null) {
      if (!fileRestores.restoreBatch) throw new Error('Local 批量文件恢复适配器未就绪')
      return fileRestores.restoreBatch(ownerId, fileIds, origin)
    },
  }
  const app = createApp({
    appName: config.appName,
    publicSiteConfig: config.publicSiteConfig,
    staticRoot: config.staticRoot,
    async isReady() {
      await checkDatabaseReadiness((statement) => pool.query(statement))
      return true
    },
    onReadinessError: () => console.error('gugu-webui PostgreSQL readiness check failed'),
    userAuth: createUserAuth(
      pool,
      config.secretKey,
      config.accessTokenExpiresMinutes,
      redisEvents,
      rateLimit,
      userQuotaSettings(config, env),
    ),
    live: {
      subscribe: createRedisLiveSubscription(config.redisUrl),
      async isUserActive(ownerId, expectedSecurityVersion) {
        const user = await userRepository.lookupUser(ownerId)
        return Boolean(user && user.isActive && (user.accountStatus ?? 'active') === 'active'
          && (user.securityVersion || 1) === expectedSecurityVersion)
      },
    },
    userAvatar: createPostgresUserAvatarOperations(pool, config.storageLocalPath),
    preferences: createPostgresPreferencesStore(pool, {
      documentStore: createKyselyPreferenceDocumentStore(core.db, 'postgres'),
      storageRoot: config.storageLocalPath,
      secretKey: config.secretKey,
      smtpSettings: createUserSmtpSettings(createKyselySmtpStore(core.db, 'postgres'),
        password => encryptSmtpPassword(config.secretKey, password)),
      personalityPreferenceAvailable: config.personalityPreferenceEnabled,
      bumpContextRevision: (ownerId, resource) => publisher.bumpContextRevision(ownerId, resource),
    }),
    onboarding: createKyselyOnboardingStore(core.db, 'postgres'),
    feedback,
    adminFeedback: feedback,
    registration: {
      secret: config.secretKey,
      verificationRequired: config.publicSiteConfig.registrationVerificationEnabled,
      rateLimit,
      userExists: registrationOperations.userExists,
      async verifyRegistrationCode(email, code) {
        if (!registrationCodeStore) throw new Error('Registration code store is unavailable')
        return registrationCodeStore.verify(email, code)
      },
      registerUser: registrationOperations.registerUser,
      seedUser(user, locale) { return seedRegistration(user.id, locale) },
      tokenExpiresMinutes: config.accessTokenExpiresMinutes,
    },
    registrationCode: {
      registrationVerificationEnabled: config.publicSiteConfig.registrationVerificationEnabled,
      systemEmailAvailable: config.publicSiteConfig.passwordResetEnabled,
      rateLimit,
      async emailIsOccupied(email) {
        const result = await pool.query<{ present: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($1)) AS present`,
          [email],
        )
        return result.rows[0]?.present ?? false
      },
      codeStore: registrationCodeStore,
      ...(authEmailSender ? { sendRegistrationVerification: async (email: string, code: string) =>
        authEmailSender.sendRegistrationVerification({ to: email, code }) } : {}),
    },
    passwordReset: {
      store: createPostgresPasswordResetStore(pool),
      redis: passwordResetRedis,
      rateLimit,
      systemEmailAvailable: config.publicSiteConfig.passwordResetEnabled,
      publicAppUrl: config.publicAppUrl,
      sendResetEmail: authEmailSender?.sendResetEmail ?? (async () => false),
      async publishAuthStateChanged(userId) {
        await publisher.publishAuthStateChanged(userId)
      },
    },
    emailChange: {
      store: createPostgresEmailChangeStore(pool),
      rateLimit,
      systemEmailAvailable: config.publicSiteConfig.passwordResetEnabled,
      publicAppUrl: config.publicAppUrl,
      mail: authEmailSender ? {
        sendVerification: ({ to, username, link }) =>
          authEmailSender.sendEmailChangeVerification({ to, username, link }),
        sendNotice: ({ to, username, kind }) =>
          authEmailSender.sendEmailChangeNotice({ to, username, kind }),
      } : null,
      async publishAuthStateChanged(userId) {
        await publisher.publishAuthStateChanged(userId)
      },
    },
    profile: {
      pool,
      secret: config.secretKey,
      tokenExpiresMinutes: config.accessTokenExpiresMinutes,
      lookupUser: userRepository.lookupUser,
      async bumpContextRevision(userId, resource) {
        await publisher.bumpContextRevision(userId, resource)
      },
      async publishAuthStateChanged(userId) {
        await publisher.publishAuthStateChanged(userId)
      },
    },
    listProjects: createProjectListing(core, pool),
    listProjectFileCounts: createProjectFileCountListing(pool),
    getProject: createProjectGetter(core, pool),
    createProject: async (context, input, metadata) => {
      const result = await projectCreate(context.data.ownerId, input as Fields, {
        idempotencyKey: metadata.idempotencyKey,
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      })
      return projectResponse(result.project, 0)
    },
    ...(projectUpdate ? {
      updateProject: (ownerId: string, projectId: number, input: unknown, metadata: WriteRequestMetadata) =>
        projectUpdate(ownerId, projectId, input, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
        }),
    } : {}),
    deleteProject: (ownerId: string, projectId: number, metadata: WriteRequestMetadata) =>
      projectTrash.deleteProject(ownerId, projectId, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      }),
    restoreProject: (ownerId: string, projectId: number, metadata: WriteRequestMetadata) =>
      projectTrash.restoreProject(ownerId, projectId, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      }),
    clients: createClientOperations(core),
    events: {
      ...createCalendarEventReader(createKyselyCalendarReadPort(core.db, 'postgres')),
      create: async (context, input, metadata) => (await eventCreate(context, input, metadata)).event,
      delete: async (context, eventId, version, metadata) => deleteCalendarEvent(eventDeleteStore, {
        ownerId: context.data.ownerId,
        eventId,
        version,
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      }),
      update: async (context, eventId, body, metadata) => updateCalendarEvent(eventUpdateStore, {
        ownerId: context.data.ownerId,
        eventId,
        body,
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      }),
    },
    undo: createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(core), async (ownerId, event) => {
      await publisher.publishResourceChanged({
        ownerId, resource: String(event.resource), operation: String(event.operation),
        origin: String(event.origin), entityIds: event.entity_ids as number[],
      })
    }),
    deleteScheduledTask: createScheduledTaskDeleter(createKyselyScheduledTaskDeleteRuntime(core.db, 'postgres', async (ownerId, id, origin) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'scheduled_tasks', operation: 'delete', entityId: id, origin })
    })),
    listScheduledTasks: createScheduledTaskQueries(createKyselyScheduledTaskReader(core.db, 'postgres'), () => ({
      workspaceSupported: true,
      filesystemAuthorizationEnabled: config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
    })).web,
    scheduledTaskDeliveryTargets: createScheduledTaskDeliveryTargets(pool),
    mindNotes: createSqlMindNoteReader(core.db, 'postgres'),
    mindCanvasReads: createSqlMindCanvasReader(core.db, 'postgres'),
    mindRefSuggest,
    mindCanvasMutations: {
      create: (ownerId, input, metadata) => mindCanvasCreate(ownerId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      }),
      update: (ownerId, canvasId, input, metadata) => mindCanvasUpdate(ownerId, canvasId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      }),
      delete: (ownerId, canvasId, metadata) => mindCanvasDelete(ownerId, canvasId, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      }),
    },
    mindCanvasNoteMutations: {
      create: (ownerId, canvasId, input, metadata) => mindCanvasNoteMutations.create(ownerId, canvasId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      update: (ownerId, nodeId, input, metadata) => mindCanvasNoteMutations.update(ownerId, nodeId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
    },
    mindCanvasItemMutations: {
      add: (ownerId, canvasId, input, metadata) => mindCanvasItemAdd(ownerId, canvasId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      update: (ownerId, canvasId, itemId, input, metadata) => mindCanvasItemUpdate.update(ownerId, canvasId, itemId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      bringToFront: (ownerId, canvasId, itemId, input, metadata) => mindCanvasItemUpdate.bringToFront(ownerId, canvasId, itemId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      remove: (ownerId, canvasId, itemId, metadata) => mindCanvasItemRemove(ownerId, canvasId, itemId, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
    },
    mindCanvasRelationMutations: {
      create: (ownerId, input, metadata) => mindCanvasRelationCreate(ownerId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      delete: (ownerId, canvasId, relationId, metadata) => mindCanvasRelationDelete(
        ownerId, canvasId, relationId, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
          mutationId: metadata.mutationId,
        },
      ),
      deleteGlobal: (ownerId, relationId, metadata) => mindGlobalRelationDelete(
        ownerId, relationId, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
          mutationId: metadata.mutationId,
        },
      ),
    },
    mindRefNodeCreate: {
      create: (ownerId, input, metadata) => mindRefNodeCreator.create(ownerId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
    },
    mindNoteCreate: {
      create: (ownerId, input, metadata) => createMindNote(ownerId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
    },
    mindNoteMutations: {
      update: (ownerId, noteId, input, metadata) => mindNoteMutations.update(ownerId, noteId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      delete: (ownerId, noteId, metadata) => mindNoteMutations.delete(ownerId, noteId, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
    },
    createWorkspace: (ownerId, input) => workspaceCreate(ownerId, input as Fields),
    workspaceBindings,
    updateWorkspace: (ownerId, workspaceId, input) => workspaceUpdate(ownerId, workspaceId, input as Fields),
    deleteWorkspace: workspaceDelete,
    listWorkspaces: workspaceList,
    workspaceDirectories,
    listAgentSessions,
    agentFilesystemAuthorization: { operations: agentFilesystemAuthorization },
    refreshAgentSession: createPostgresAgentSessionRefresher(pool),
    renameAgentSession: createPostgresAgentSessionRenamer(pool),
    lookupAgentInteractionSession: createInteractionSessionLookup(pool).get,
    listAgentMessages,
    locateAgentMessage: createPostgresAgentMessageLocator(pool),
    agentPendingQueueReads: {
      readQueue: createPostgresAgentPendingQueueReader(pool),
      readImportedDrafts: createPostgresAgentImportedDraftQueueReader(pool),
    },
    agentPendingQueuePatch: {
      patch: createPostgresAgentPendingQueuePatch(pool),
      publishChanged: publishPendingQueueChanged,
    },
    agentPendingQueueReplace: {
      replaceDraft: createPostgresAgentPendingQueueReplace(pool),
    },
    agentPendingQueueClaims: {
      ...createPostgresAgentPendingQueueClaims(pool, {
        async isSessionActive(sessionId) {
          return (await agentQueueStatuses([sessionId])).get(sessionId) ?? false
        },
      }),
      publishChanged: publishPendingQueueChanged,
    },
    readAgentToolEventDetails: createPostgresAgentToolEventDetails(pool),
    agentMisc: {
      commandMenu: agentCommandMenu,
      defaultStateLabels: DEFAULT_AGENT_STATE_LABELS,
      stateLabelOverrides: createAgentStateLabelOverrides(() =>
        config.configOverridePath ? readConfigOverride(config.configOverridePath) : {}),
    },
    fileBrowser: createPostgresFileBrowserOperations(pool, config.secretKey),
    fileReads: createPostgresFileReadOperations(pool, config.storageDefaultLimitBytes, config.storageLocalPath),
    fileUploads: createPostgresFileUploadOperations(pool, {
      storageRoot: config.storageLocalPath,
      defaultLimitBytes: config.storageDefaultLimitBytes,
      async publishChanged(event) {
        await publisher.publishResourceChanged({
          ownerId: event.ownerId,
          resource: 'files',
          operation: event.operation,
          entityId: event.entityId,
          origin: event.origin,
          payload: { kind: 'file', entity: event.payload },
        })
      },
    }),
    fileDeletes: createPostgresFileDeleteOperations(pool, {
      storageRoot: config.storageLocalPath,
      async publishChanged(event) {
        await publisher.publishResourceChanged({
          ownerId: event.ownerId,
          resource: 'files',
          operation: 'delete',
          entityId: event.entityId,
          origin: event.origin,
          payload: { kind: 'file', id: event.entityId },
        })
      },
    }),
    fileRestores,
    trash: trashOperations,
    fileContents: createPostgresFileContentOperations(pool, {
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
    }),
    fileUpdates: createPostgresFileUpdateOperations(pool, {
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
    }),
    fileCopies: createPostgresFileCopyOperations(pool, {
      storageRoot: config.storageLocalPath,
      fileSyncEnabled: config.filesyncEnabled,
      async publishChanged(event) {
        await publisher.publishResourceChanged({
          ownerId: event.ownerId,
          resource: 'files',
          operation: event.operation,
          entityId: event.entityId,
          origin: event.origin,
          payload: { kind: 'file', entity: event.payload },
        })
      },
    }),
    fileConflicts: createPostgresFileConflictOperations(pool),
    fileBatchDownloads: createPostgresFileBatchDownloadOperations(pool, config.storageLocalPath),
    fileArchives: createPostgresFileArchiveOperations(pool, {
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
    }),
    globalSearch,
    folderDownloads: createPostgresFileBatchDownloadOperations(pool, config.storageLocalPath),
    folderReads: createPostgresFolderReadOperations(pool),
    folderWrites,
    adminAuth: createAdminAuth(pool, config),
    adminConfig: config.configOverridePath ? { path: config.configOverridePath, env } : undefined,
    adminStorageSnapshots: {
      query: createPostgresAdminStorageSnapshotQuery(pool),
      diskUsage: () => diskUsageForStorage({ localPath: config.storageLocalPath }),
    },
    adminUsers: {
      query: createPostgresAdminUsersQuery(pool),
    },
    adminUserRisk: {
      query: createPostgresAdminUserRiskQuery(pool),
    },
    emailRecipientCount: { read: createEmailRecipientCounter((sql, values) => pool.query(sql, values)) },
    storageQuotaStatus: { store: config.redisUrl ? createRedisStorageQuotaStatusStore(config.redisUrl) : { async read() { throw new Error('Redis unavailable') }, async lockExists() { throw new Error('Redis unavailable') }, async interruptIfUnchanged() { throw new Error('Redis unavailable') } } },
    serviceStatus: { read: createServiceStatusReader({ redis: config.redisUrl ? createRedisServiceStatusCommands(config.redisUrl) : null, dbOk: async () => { try { await pool.query('SELECT 1'); return true } catch { return false } } }) },
    adminMaintenanceStatus: { available: () => Boolean(config.redisUrl), read: createAdminMaintenanceStatus({
      get: key => { if (!config.redisUrl) throw new Error('维护状态服务不可用'); return createRedisAdminMaintenanceCommands(config.redisUrl).get(key) },
      compareAndSet: async (key, expected, value, ttl) => { if (!config.redisUrl) throw new Error('维护状态服务不可用'); return await createRedisAdminMaintenanceCommands(config.redisUrl).compareAndSet(key, expected, value, ttl) === '1' }
    }) },
    storageLiveTotals: { read: createStorageLiveTotals((sql, values) => pool.query(sql, values)) },
    safeEgressRead: { readSettings: createSafeEgressSettingsReader(env, resolveConfigOverridePath(env)) },
    imMemorySummary: { read: createImMemorySummaryReader(core.db) },
    adminUserBan: { adminUsername: request => request.adminIdentity?.username ?? 'admin', toggle: createAdminUserBanToggle(core.db, userId => publisher.publishAuthStateChanged(userId)) },
    adminEmailPreview: { render: renderEmailPreview },
    smtpProbe: { probe: createSmtpFileProbe(env, resolveConfigOverridePath(env)) },
    adminEmailTest: { send: createAdminEmailFileTest(env, resolveConfigOverridePath(env)) },
    llmStrategy: { set: createLlmStrategySetter(createLlmStrategyFileMutator(resolveConfigOverridePath(env)), () => invalidateAllProviderReasoningStates(core.db)) },
    llmPresetSelection: { operations: createLlmPresetSelection(createLlmStrategyFileMutator(resolveConfigOverridePath(env)), () => invalidateAllProviderReasoningStates(core.db)) },
    llmCapabilityOverrides: { set: createLlmCapabilityOverrideSetter(createLlmStrategyFileMutator(resolveConfigOverridePath(env)), () => invalidateAllProviderReasoningStates(core.db)) },
    llmPresetMutations: { operations: createLlmPresetMutations(createLlmStrategyFileMutator(resolveConfigOverridePath(env)), () => invalidateAllProviderReasoningStates(core.db), () => `p_${randomUUID().replaceAll('-', '').slice(0, 8)}`) },
    modelDirectory: { operations: createAdminModelDirectory(() => readConfigOverride(resolveConfigOverridePath(env)), createLlmModelDirectory(() => createNodeProviderTransport({ allowLocal: true, environment: () => env }))) },
    adminRecentMisread: { available: () => Boolean(config.redisUrl), read: createAdminMisreadReader(core.db, createRedisListReader(config.redisUrl ?? '')) },
    adminPerceptionExport: { available: () => Boolean(config.redisUrl), read: createPerceptionEventExporter(createRedisListReader(config.redisUrl ?? '')) },
    adminMisreadExport: { read: createMisreadMarkdownExporter(createLocalMisreadTextReader(config.storageLocalPath)) },
    adminPerceptionStats: { available: () => Boolean(config.redisUrl), read: createPerceptionStatsReader(core.db, createRedisListReader(config.redisUrl ?? '')) },
    adminOpsSummary: { hgetall: createRedisHashReader(config.redisUrl ?? '') },
    adminFileSyncRunRead: { reader: createFileSyncRunReader(core.db) },
    adminFileSyncRunCancel: { cancel: createFileSyncRunCancellation(core.db, publishFileSyncRun) },
    adminFileSyncDryRun: { create: createFileSyncDryRun(core.db, randomUUID, publishFileSyncRun) },
    adminFileSyncInitialize: { create: createFileSyncInitialize(core.db, randomUUID, publishFileSyncRun) },
    watcherCapacity: { request: createWatcherCapacityRequester(env) },
    secretPromptCancel: { cancel: createSecretPromptCancellation(core.db) },
    adminFileSyncEvents: { subscribe: createRedisLiveSubscription(config.redisUrl) },
    adminEmbeddingProbe: { probe: createEmbeddingFileProbe(env, resolveConfigOverridePath(env)) },
    adminEmbeddingRebuildStatus: { available: () => Boolean(config.redisUrl), read: createAdminEmbeddingRebuildStatusReader(() => createRedisValueReader(config.redisUrl ?? '')('emb:rebuild')) },
    safeEgressUpdate: { update: createSafeEgressFileUpdater(env, resolveConfigOverridePath(env), config.secretKey) },
    safeEgressProbe: { probe: createSafeEgressFileProbe(env, resolveConfigOverridePath(env), config.secretKey) },
    voicePresetsMutate: { operations: createVoicePresetFileMutations(resolveConfigOverridePath(env)) },
    voicePresetsRead: { read: createVoicePresetsFileReader(resolveConfigOverridePath(env)) },
    adminSystemLogs: { ...createSystemLogReader((sql, values) => pool.query(sql, values)) },
    adminAnalytics: { query: (sql, values) => pool.query(sql, values) },
    adminAuditLog: { read: createAdminAuditLogReader((sql, values) => pool.query(sql, values)) },
    notificationBroadcast: { broadcast: createNotificationBroadcaster((sql, values) => pool.query(sql, values), config.redisUrl ? createRedisNotificationPublisher(config.redisUrl) : async () => false) },
    notificationAdminHistory: createNotificationAdminHistory(core.db, 'postgres'),
    adminUserSettings: {
      transaction: createPostgresAdminSettingsTransaction(pool),
      adminUsername: (request) => request.adminIdentity?.username ?? 'admin',
      async writeAuditLog(username, action, description, request) {
        const forwarded = request.headers['x-forwarded-for']
        const ip = typeof forwarded === 'string' ? forwarded.split(',', 1)[0]?.trim().slice(0, 60) || null : request.ip.slice(0, 60) || null
        await pool.query('INSERT INTO audit_logs (username, action, description, ip, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)', [username, action, description, ip])
      },
    },
    adminAgentUsage: {
      query: (sql, params) => pool.query(sql, params),
    },
    adminUserStatus: {
      store: createPostgresAdminUserStatusStore(pool),
      publishAuthStateChanged: (userId) => publisher.publishAuthStateChanged(userId),
      adminUsername: (request) => request.adminIdentity?.username ?? 'admin',
      async writeAuditLog(username, action, description, request) {
        const forwarded = request.headers['x-forwarded-for']
        const ip = typeof forwarded === 'string'
          ? forwarded.split(',', 1)[0]?.trim().slice(0, 60) || null
          : request.ip.slice(0, 60) || null
        await pool.query(
          'INSERT INTO audit_logs (username, action, description, ip, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
          [username, action, description, ip],
        )
      },
    },
    adminDebugLogs: {
      paths: {
        web: resolve(logsDirectory, 'gugu.log'),
        worker: logPath('worker'),
        gateway: logPath('gateway'),
      } satisfies Record<AdminDebugLogSource, string>,
      webCandidates: [resolve(logsDirectory, 'gugu-web-dev.log'), resolve(logsDirectory, 'gugu.log')],
    },
    adminSecurityEvents: {
      query: createPostgresAdminSecurityEventQuery(pool),
      fingerprintUserId: createSecurityEventFingerprint(config.secretKey),
    },
    adminUserSecurityEvents: {
      query: createPostgresAdminUserSecurityEventQuery(pool),
    },
    createDataExport: createDataExportCreator(work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))), (sql, values) => pool.query(sql, values), { now: () => new Date(), uuid: () => randomUUID() }),
    dataExportPreview: { read: createDataExportPreviewReader(core.db) },
    resumeDataImport: createDataImportResumer(work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))), (sql, values) => pool.query(sql, values), { token: () => randomBytes(32).toString('base64url'), hash: token => createHash('sha256').update(token).digest('hex') }),
    dataExportDownload: { secretKey: config.secretKey, download: createDataExportDownloader((sql, values) => pool.query(sql, values), createPortableArtifactOpener(config.storageLocalPath), config.secretKey), requireReady: (owner, job) => requireExportReadyForTicket((sql, values) => pool.query(sql, values), owner, job) },
    cancelDataExport: createDataExportCanceler(work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))), (sql, values) => pool.query(sql, values)),
    portabilityJobs: createPortabilityJobReader((sql, values) => pool.query(sql, values)),
    userBotBindingCode: { issue: createPostgresRedisBindingCodeIssuer(pool, config.redisUrl ?? '', config.secretKey) },
    userBotUnbind: { unbind: createPostgresUserBotUnbinder(pool, async ownerId => {
      try { await invalidateOwnerImSnapshots(core.db, ownerId) } catch { /* 与 Python 一致，失效失败不阻止后续资源通知。 */ }
      await publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' })
    }) },
    userBotUpdate: { update: createUserBotUpdater(core.db, {
      encrypt: value => encryptEncryptedString(config.secretKey, value), decrypt: value => decryptEncryptedString(config.secretKey, value),
      publishChanged: ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }),
    }) },
    userBotDelete: { remove: createUserBotDeleter(core.db, {
      clearReach: createRedisUserBotReachCleaner(config.redisUrl ?? ''),
      publishChanged: ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }),
    }) },
    wechatConnect: { connect: createWechatConnector(core.db, {
      ...wechatConnectOptions, encrypt: value => encryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)),
      publishChanged: ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }),
    }) },
    feishuConnect: { connect: createFeishuConnector(core.db, {
      ...feishuConnectOptions, encrypt: value => encryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)),
      publishChanged: ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }),
    }) },
    qqConnect: { connect: createQqConnector(core.db, {
      ...qqConnectOptions, encrypt: value => encryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)),
      publishChanged: ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }),
    }) },
    userBotCreate: { create: createQqBotCreator(core.db, {
      encrypt: value => encryptEncryptedString(config.secretKey, value), decrypt: value => decryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)),
      publishChanged: ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }),
    }) },
    mcpStatus: { read: createMcpStatusReader(createMcpEnabledReader(resolveConfigOverridePath(env), env)) },
    loopScopeProxy: { endpoint: env.LOOPSCOPE_ENDPOINT || 'http://127.0.0.1:4320' },
    attachmentDownload: { download: createAttachmentDownloader(core.db, {
      readLegacy: async (ownerId, attachId) => { if (!config.redisUrl) throw new Error('附件元数据服务不可用'); return createRedisValueReader(config.redisUrl)(`chatfile:${ownerId}:${attachId}`) },
      open: key => openLocalFile(config.storageLocalPath, key), isUnsafe: error => error instanceof UnsafeLocalPathError
    }) },
    terminalDelete: { remove: createTerminalDeletion(core.db, async (ownerId, terminalId, origin) => { await publisher.publishResourceChanged({ ownerId, resource: 'terminals', operation: 'delete', entityId: terminalId, origin }) }) },
    userBotsList: { readBots: createPostgresUserBotsReader(pool, config.secretKey, createImPlatformSettingsReader(env, resolveConfigOverridePath(env))) },
    embeddingRebuildStatus: { available: () => Boolean(config.redisUrl), read: createEmbeddingRebuildStatusReader(async ownerId => {
      if (!config.redisUrl) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      return createRedisValueReader(config.redisUrl)(`emb:rebuild:user:${ownerId}`)
    }) },
    taskFilesystemAuthorization: createTaskFilesystemAuthorization(core.db, { confirmations: filesystemAuthorizationConfirmations, enabled: createTaskAuthorizationEnabledReader(resolveConfigOverridePath(env), env), fingerprint: createSecurityEventFingerprint(config.secretKey), ...(config.redisUrl ? { recordMetric: createRedisFilesystemAuthorizationMetric(config.redisUrl) } : {}) }),
    taskFilesystemRevoke: { revoke: createTaskFilesystemRevoker(core.db, { revokeConfirmation: (owner, summary, identity) => filesystemAuthorizationConfirmations.revoke(owner, summary, identity), fingerprint: createSecurityEventFingerprint(config.secretKey), ...(config.redisUrl ? { recordMetric: createRedisFilesystemRevokeMetric(config.redisUrl) } : {}) }) },
    credentialDelete: { remove: createCredentialDeletion(core.db, createByokGateReader(resolveConfigOverridePath(env), env)) },
    credentialPatch: { patch: createCredentialPatch(core.db, {
      enabled: createByokGateReader(resolveConfigOverridePath(env), env),
      encrypt: async (value, allowEmpty) => { const envelope = await createConfiguredByokEnvelope(env).encrypt(value, allowEmpty); return envelope },
      decrypt: async row => createConfiguredByokEnvelope(env).decrypt({ ciphertext: row.encrypted_value, nonce: row.nonce, encryptedDataKey: row.encrypted_data_key, keyVersion: row.key_version }),
    }) },
    credentialModelsPreview: { preview: createCredentialModelsPreview(core.db, {
      enabled: createByokGateReader(resolveConfigOverridePath(env), env),
      decrypt: async row => createConfiguredByokEnvelope(env).decrypt({ ciphertext: row.encrypted_value, nonce: row.nonce, encryptedDataKey: row.encrypted_data_key, keyVersion: row.key_version }),
      fetchModels: createByokModelsPreviewFetcher(env),
    }) },
    credentialCreate: { create: createCredentialCreator({
      transaction: work => withPostgresTransaction(pool, client => work((sql, values) => client.query<Record<string, unknown>>(sql, [...values]))),
      enabled: createByokGateReader(resolveConfigOverridePath(env), env),
      encrypt: (value, allowEmpty) => createConfiguredByokEnvelope(env).encrypt(value, allowEmpty),
    }) },
    credentialList: { list: createByokListService({
      enabled: createByokGateReader(resolveConfigOverridePath(env), env),
      readOwned: createPostgresByokListReader(pool),
      verifyEnvelope: async envelope => {
        await createConfiguredByokEnvelope(env).decrypt({ ciphertext: envelope.encrypted_value, nonce: envelope.nonce,
          encryptedDataKey: envelope.encrypted_data_key, keyVersion: envelope.key_version })
      },
    }) },
    providerCapabilityPreview: { preview: createProviderCapabilityPreview(createByokGateReader(resolveConfigOverridePath(env), env)) },
    userSkillDelete: { remove: createUserSkillDeletion(core.db, 'postgres', async ownerId => { await publisher.publishResourceChanged({ ownerId, resource: 'skills', operation: 'refresh' }) }) },
    notifications: createKyselyNotificationOperations(core.db, 'postgres'),
    track: createTrackOperations(pool),
  })
  app.addHook('onClose', async () => { await Promise.all([qqConnectOptions.transport.close(), feishuConnectOptions.transport.close(), wechatConnectOptions.transport.close()]) })
  return app
}

async function listen(app: ReturnType<typeof createWebUiApp>, host: string, port: number): Promise<void> {
  try {
    const address = await app.listen({ host, port })
    console.info(`gugu-webui listening at ${address}`)
  } catch {
    await app.close().catch(() => undefined)
    throw new Error('gugu-webui HTTP server failed to listen')
  }
}

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const configOverridePath = resolveConfigOverridePath(env)
  const config = loadConfig(env, configOverridePath)
  const pool = createPool(config)
  const redisEvents = config.redisUrl ? createRedisEventPublisher(config.redisUrl) : undefined
  let core: SqlDataRuntime
  try {
    core = await createPostgresRuntime({ url: config.databaseUrl, maxConnections: config.postgresPoolMax })
  } catch {
    // 保留 Admin 登录和配置入口，让用户可以修正数据库连接；业务 API 仍由未就绪状态阻断。
    const app = createApp({
      appName: config.appName,
      staticRoot: config.staticRoot,
      isReady: async () => false,
      adminAuth: createAdminAuth(pool, config),
      adminConfig: config.configOverridePath ? { path: config.configOverridePath, env } : undefined,
    })
    try {
      await listen(app, config.host, config.port)
    } catch (listenError) {
      await pool.end().catch(() => undefined)
      throw listenError
    }
    console.error('gugu-webui PostgreSQL unavailable; serving Admin configuration only')
    let closePromise: Promise<void> | undefined
    return {
      app,
      pool,
      close() {
        closePromise ??= (async () => {
          await app.close()
          await pool.end()
        })()
        return closePromise
      },
    }
  }
  const app = createWebUiApp(config, pool, core, redisEvents, env)
  try {
    await listen(app, config.host, config.port)
  } catch (error) {
    await core.close().catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw error
  }

  const securityRetention = startSecurityRetentionWorker({
    pool,
    onError: () => { console.error('安全事件过期清理失败') },
  })
  let closePromise: Promise<void> | undefined
  return {
    app,
    pool,
    close() {
      closePromise ??= (async () => {
        try {
          await app.close()
        } finally {
          await securityRetention.stop()
          await core.close()
          await pool.end()
        }
      })()
      return closePromise
    },
  }
}

async function main(): Promise<void> {
  const server = await startServer()
  const shutdown = () => {
    void server.close().catch(() => {
      console.error('gugu-webui shutdown failed')
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error('gugu-webui startup failed')
    process.exitCode = 1
  })
}
