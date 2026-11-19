import { createWebRuntimeLog } from '../shared/log-files.js'
import { createGatewayConfigChangePublisher } from '../modules/im/gateway/bot-config.js'
import bcrypt from 'bcryptjs'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createProfileUpdater } from '@gugu/core/auth/profile-update'
import { createDataExportCreator } from '@gugu/core/data-portability/create-export'
import { createDataExportPreviewReader } from '@gugu/core/data-portability/export-preview'
import { createDataImportResumer } from '@gugu/core/data-portability/resume-import'
import { createDataImportApplier, createDataImportRecoverer, createDataImportRollbackCreator } from '@gugu/core/data-portability/apply-import'
import { createImMemorySummaryReader } from '@gugu/core/im-memory-summary'
import { createImMaintenanceSource } from '@gugu/core/im-memory-maintenance-source'
import { createAdminUserBanToggle } from '../modules/admin/user-management.js'
import { renderEmailPreview } from '@gugu/core/email-preview'
import { createSmtpFileProbe, readSmtpFileSettings } from '../modules/admin/smtp.js'
import { createAdminEmailFileTest } from '../modules/admin/email.js'
import { createAdminEmailPublishOperations } from '../modules/admin/email.js'
import { createAdminEmailTranslator } from '../modules/admin/email.js'
import { createLlmStrategySetter, invalidateAllProviderReasoningStates } from '@gugu/core/agent/config/llm-strategy'
import { createLlmPresetSelection } from '@gugu/core/agent/config/llm-preset-selection'
import { createLlmCapabilityOverrideSetter } from '@gugu/core/agent/config/llm-capability-overrides'
import { createLlmPresetMutations } from '@gugu/core/agent/config/llm-preset-mutations'
import { createLlmModelDirectory } from '@gugu/core/agent/config/llm-model-directory'
import { createAdminModelDirectory } from '@gugu/core/agent/config/admin-model-directory'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { defaultLoopScopeEndpoint } from '@gugu/loopscope'
import type { ProviderConfig } from '@gugu/core/providers'
import { createLlmStrategyFileMutator } from '../modules/admin/llm-strategy.js'
import { createAdminMisreadReader } from '@gugu/core/perception-recent-misread'
import { createPerceptionEventExporter } from '@gugu/core/perception-export'
import { createMisreadMarkdownExporter } from '@gugu/core/perception-misread-export'
import { createLocalMisreadTextReader } from '../modules/admin/perception.js'
import { createPerceptionStatsReader } from '@gugu/core/perception-stats'
import { createSecretPromptCancellation } from '@gugu/core/agent-secret-cancel'
import { createRedisHashReader } from '../adapters/cache/redis-events.js'
import { createRedisListReader } from '../adapters/cache/redis-events.js'
import { createAdminEmbeddingRebuildStatusReader } from '../modules/admin/embedding.js'
import { createDataExportDownloader, requireExportReadyForTicket } from '@gugu/core/data-portability/download-export'
import { createPortableArtifactOpener, createLocalDataImportStagingRemover, createLocalDataImportPreflightStorage } from '../modules/data-portability/archive.js'
import { createTaskFilesystemAuthorization } from '@gugu/core/scheduled-task-filesystem-authorize'
import { createTaskAuthorizationEnabledReader } from '../modules/scheduled-tasks/access.js'
import { createRedisFilesystemAuthorizationMetric } from '../adapters/cache/redis-events.js'
import { createVoicePresetFileMutations } from '../modules/admin/voice.js'
import { createDataExportCanceler } from '@gugu/core/data-portability/cancel-export'
import { createPostgresDataExportDeleter, createPostgresDataImportDeleter, createPostgresDataImportCanceler, createPostgresDataImportPreflightStore } from '../modules/data-portability/store.js'
import { createDataImportPreflighter } from '@gugu/core/data-portability/preflight-import'
import { createPostgresDataReplacementWriteGate } from '../modules/data-portability/gate.js'
import { withPostgresTransaction } from '../adapters/database/postgres-transaction.js'
import { createTerminalDeletion } from '@gugu/core/terminals/delete'
import {
  createPostgresTerminalCreator,
  createPostgresTerminalReopener,
  createPostgresTerminalLifecycle,
  createTerminalRuntime,
} from '../modules/terminals/service.js'
import { createTerminalPtyManager } from '../modules/terminals/pty/manager.js'
import { createTerminalPtyRuntime } from '../modules/terminals/pty/runtime.js'
import { createTerminalInputAuthorizer } from '../modules/terminals/pty/access.js'
import { createTerminalShellSnapshotReader } from '../modules/terminals/shell/snapshot.js'
import { createTerminalWorkspaceMounts } from '../modules/terminals/sandbox/mounts.js'
import { createBubblewrapPtyBridge } from '@gugu/sandbox/linux/pty'
import { createPostgresTerminalPtyStateOperations } from '../modules/terminals/pty/state.js'
import {
  createTerminalAccessReader,
  createTerminalRuntimeSettingsReader,
  createIsolatedShellReadiness,
  resolveBubblewrapRootfs,
} from '../modules/terminals/settings.js'
import { createTerminalCancellationMarkers } from '../modules/terminals/shell/cancel.js'
import { createTerminalActiveLease } from '../modules/terminals/pty/lease.js'
import {
  createPostgresTerminalMetricsReader,
  createPostgresTerminalListReader,
  createPostgresTerminalDetailReader,
  createPostgresTerminalRenamer,
  createPostgresTerminalEventStream,
} from '../modules/terminals/store.js'
import { createVoicePresetsFileReader } from '../modules/admin/voice.js'
import { createAdminLlmPresetReader } from '../modules/admin/llm.js'
import { createPostgresVoiceAvailabilityReader } from '../modules/agent/voice.js'
import { createMemoryClearer } from '@gugu/core/agent/memory-clear'
import { embedRagQuery, enqueueAgentRagRebuild, invalidateAgentMemoryRag, readAgentRagRebuildProgress, createSqlRagPersistentIndexReader } from '@gugu/core/agent/rag'
import { createUserMemoryVectorRebuilder } from '@gugu/core/byok/vector-rebuild'
import { activeVoiceTestSettings } from '@gugu/core/agent/config/voice-test'
import { createAdminVoicePresetTestOperations, createAdminVoiceTestOperations } from '../modules/admin/voice.js'
import { createAdminSearchTestOperations } from '../modules/admin/search.js'
import { createAdminMaintenanceStatus } from '@gugu/core/maintenance/admin-status'
import { createAccountMemoryCleanupRuntime } from '../modules/admin/memory-cleanup.js'
import { createAccountMemoryCleanupStorage, createAccountMemoryCleanupVectorRefresh } from '../modules/admin/memory-store.js'
import { createRedisAdminMaintenanceCommands } from '../adapters/cache/redis-events.js'
import { createServiceStatusReader } from '../modules/admin/runtime.js'
import { resolveAdminUpdateMode } from '../modules/admin/runtime.js'
import { createServiceRestarter } from '../modules/admin/runtime.js'
import { createRedisServiceStatusCommands } from '../adapters/cache/redis-events.js'
import { createAttachmentDownloader } from '@gugu/core/agent/attachments/download'
import { createChatAttachmentDraftDeleter } from '@gugu/core/agent/attachments/delete-draft'
import { createChatAttachmentDraftClearer } from '@gugu/core/agent/attachments/clear-drafts'
import { createPostgresAgentAttachmentUploadOperations, createPostgresChatAttachmentDraftDeletePorts } from '../modules/agent/attachments/persistence.js'
import { createRedisLegacyChatAttachmentCleaner } from '../adapters/cache/redis-events.js'
import { openLocalFile, removeLocalTree, UnsafeLocalPathError } from '@gugu/fs/node'
import { createPostgresRedisBindingCodeIssuer } from '../modules/im/connect/code.js'
import { createTaskFilesystemRevoker } from '@gugu/core/scheduled-task-filesystem-revoke'
import {
  createPostgresTaskWrites,
  type TaskWriteOptions,
  createPostgresTaskResolver,
  createPostgresTaskExternal,
} from '../modules/scheduled-tasks/store.js'
import { validateTaskCron } from '../modules/scheduled-tasks/schedule/cron.js'
import { createRedisFilesystemRevokeMetric } from '../adapters/cache/redis-events.js'
import { createRedisEmailDeliveryMetric } from '../adapters/cache/redis-events.js'
import { createRedisStorageQuotaStatusStore } from '../modules/admin/storage.js'
import { createManualStorageQuotaReconcile, StorageQuotaReconcileUnavailable } from '../modules/admin/storage.js'
import { createPostgresStorageQuotaReconcilePort } from '../modules/files/storage/quota.js'
import { reconcileAllStorageUsers } from '../modules/admin/storage.js'
import { createNotificationBroadcaster } from '@gugu/core/notifications/broadcast'
import { createRedisNotificationPublisher } from '../adapters/cache/redis-events.js'
import { createMcpStatusReader } from '@gugu/core/mcp/status'
import { createMcpServerCreator } from '@gugu/core/mcp/server-create'
import { createMcpServerMutations } from '@gugu/core/mcp/server-mutations'
import type { McpServerCreateInput } from '@gugu/core/mcp/server-create'
import type { McpServerPatch } from '@gugu/core/mcp/server-mutations'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import { createMcpServerListReader } from '../modules/mcp/server-list.js'
import { createPostgresMcpConnectionTester } from '../modules/mcp/test-connection.js'
import { createMcpSkillToolDirectory } from '../modules/mcp/skill-tool-directory.js'
import { createMcpRuntime } from '../modules/mcp/runtime.js'
import { createMcpStdioClientFactory, resolveMcpWorkspaceRoot } from '../modules/mcp/stdio-client.js'
import { createProductionGreeting, createRedisGreetingCache } from '../modules/agent/chat/greeting.js'
import { getAttentionDefaults } from '@gugu/core/im/attention/defaults'
import { createMcpSettingsReader } from '../modules/mcp/status.js'
import { createEmailRecipientCounter } from '../modules/admin/email.js'
import { createEmbeddingRebuildStatusReader } from '@gugu/core/byok/embedding-rebuild-status'
import { createRedisExpiringValueStore, createRedisValueReader } from '../adapters/cache/redis-events.js'
import { createImMemoryMaintenanceApplier } from '../modules/admin/memory-apply.js'
import { createLocalImMemoryMaintenanceStorage } from '../modules/admin/memory-apply.js'
import { createImMemoryMaintenancePreviewStarter, createImMemoryMaintenancePreviewState, createImMemoryMaintenancePreviewWorker } from '../modules/admin/memory-preview.js'
import { createStandaloneImMemoryModelCaller } from '../modules/admin/memory-preview.js'
import { createImMemoryGroupDailyCompactor } from '../modules/admin/memory.js'
import { createPostgresUserBotUnbinder } from '../modules/im/connect/unbind.js'
import { createQqBotCreator, invalidateOwnerImSnapshots } from '@gugu/core/im/user-bot-create'
import { createUserBotDeleter } from '@gugu/core/im/user-bot-delete'
import { createUserBotUpdater } from '@gugu/core/im/user-bot-update'
import { createQqConnector } from '@gugu/core/im/qq-connect'
import { createQqConnectHostOptions } from '../modules/im/connect/qq.js'
import { createFeishuConnector } from '@gugu/core/im/feishu-connect'
import { createFeishuConnectHostOptions } from '../modules/im/connect/feishu.js'
import { createWechatConnector } from '@gugu/core/im/wechat-connect'
import { createWechatConnectHostOptions } from '../modules/im/connect/wechat.js'
import { createTelegramConnector } from '@gugu/core/im/telegram-connect'
import { createTelegramConnectHostOptions } from '../modules/im/connect/telegram.js'
import { createRedisUserBotReachCleaner } from '../adapters/cache/redis-events.js'
import { createRedisAccountAttachmentCleaner } from '../adapters/cache/redis-events.js'
import { createPostgresAccountDeleter, createPostgresAccountPasswordVerifier, createPostgresAdminAccountDeleter } from '../modules/auth/account/delete-store.js'
import { createPostgresProfileUpdateStore } from '../modules/auth/account/profile-store.js'
import { encryptEncryptedString, decryptEncryptedString } from '../adapters/security/encrypted-string.js'
import { createPortabilityJobReader } from '@gugu/core/data-portability/read-jobs'
import { createPostgresUserBotsReader } from '../modules/im/bots.js'
import { createImPlatformSettingsReader } from '../modules/im/settings.js'
import { createConfiguredByokEnvelope } from '../modules/byok/crypto.js'
import { createByokService } from '../modules/byok/service.js'
import { createByokGateReader } from '../modules/byok/policy.js'
import { createPostgresAgentEmbeddingSettingsResolver } from '../modules/byok/store.js'
import { createAgentRagEmbeddingTransportFactory } from '../modules/agent/rag/transport.js'
import { createLocalUserMemoryVectorStore } from '../modules/agent/memory/store.js'
import { createOwnerMemoryLock } from '../shared/owner-memory-lock.js'
import { createPersistentMemoryIndexRebuilder, waitForMemoryIndexRebuild } from '../modules/agent/memory/indexing.js'
import { createRedisUserEmbeddingRebuildState, createUserEmbeddingRebuildRuntime } from '../modules/agent/memory/rebuild.js'
import { createAdminEmbeddingRebuildRuntime } from '../modules/admin/embedding.js'
import { createRedisAdminEmbeddingRebuildState } from '../modules/admin/embedding.js'
import { createAdminIndexRebuildRuntime } from '../modules/admin/index-rebuild.js'
import { createRedisAdminIndexRebuildState } from '../modules/admin/index-rebuild.js'
import { createStorageLiveTotals } from '../modules/admin/storage.js'
import { createUserSkillDeletion } from '@gugu/core/agent/skills/user-delete'
import { createUserSkillLister } from '@gugu/core/agent/skills/user-list'
import { createUserSkillManager } from '@gugu/core/agent/skills/user-management'
import { createAgentToolRegistry, filterConfiguredWebAgentTools } from '../modules/agent/tools/registry.js'
import { createCapabilityCatalog } from '@gugu/core/agent/capabilities'
import { createBuiltinSkillDefinitions } from '@gugu/core/skills'
import { createBundledSkillDocuments } from '@gugu/core/skills/bundled'
import { createSkillToolCatalog, createRegisteredUserSkillToolNameReader } from '../modules/skills/tools.js'
import { createSafeEgressSettingsReader } from '../modules/admin/network.js'
import { createSafeEgressFileUpdater } from '../modules/admin/network-update.js'
import { createSafeEgressFileProbe } from '../modules/admin/network.js'
import { createSandboxEgressConfigUpdater } from '../modules/admin/sandbox.js'
import { createSandboxRuntimeUpdater } from '../modules/admin/sandbox.js'
import { createEmbeddingFileProbe } from '../modules/admin/embedding-probe.js'
import { createAdminMediaProbePreview } from '../modules/admin/llm-probe.js'
import { createAdminLlmPresetTest } from '../modules/admin/llm-probe.js'
import { createAdminLlmPresetMediaProbe } from '../modules/admin/llm-probe.js'
import { createAdminLlmCapabilityProbe } from '../modules/admin/llm-probe.js'
import { createSystemLogReader } from '../modules/admin/logs.js'
import { createAdminAuditLogReader, createAdminSecurityEventReader, createAdminUserSecurityEventReader } from '../modules/admin/audit.js'
import { createAdminUserListReader, createAdminUserRiskReader } from '../modules/admin/user-management.js'
import { createNotificationAdminHistory } from '@gugu/core/notifications/admin-history'
import { createPostgresAdminSettingsTransaction } from '../modules/admin/users.js'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { type SqlDataRuntime } from '@gugu/core/data'
import { createDiskFileSearchSources } from '../modules/search/files.js'
import { createPostgresGlobalSearchSources } from '@gugu/core/search/postgres'
import { createGlobalSearchOperations, createKyselyPreferenceDocumentStore, type Fields, type RequestContext } from '@gugu/core'
import { createApp, type WriteRequestMetadata } from '../app.js'
import type { UserAuthOptions } from '../modules/auth/contracts.js'
import { type WebUiConfig } from '../config.js'
import { readConfigOverride, resolveConfigOverridePath } from '../adapters/config/config-override-file.js'
import { checkDatabaseReadiness } from '../database.js'
import { createUserRepository } from '../modules/auth/account/store.js'
import { createRedisLiveSubscription } from '../adapters/cache/redis-live-subscription.js'
import { createPostgresUserQuotaReader, type UserQuotaSettings } from '../modules/auth/quota/read.js'
import { createPostgresUserAvatarOperations } from '../modules/auth/account/avatar-store.js'
import { createPostgresPreferencesStore } from '../modules/preferences/persistence/postgres.js'
import { createKyselyOnboardingStore, createOnboardingReseeder, createRegistrationSeeder } from '@gugu/core/onboarding'
import { createPostgresRegistrationSeedOperations } from '../modules/onboarding/seed.js'
import { createPostgresOnboardingReseedOperations } from '../modules/onboarding/reseed.js'
import { createOnboardingSurpriseMp3Reader } from '../modules/onboarding/assets.js'
import { createRedisRegistrationCodeStore } from '../modules/auth/registration/codes.js'
import { createPostgresRegistrationOperations } from '../modules/auth/registration/store.js'
import { createPostgresPasswordResetStore } from '../modules/auth/password-reset.js'
import { createPostgresEmailChangeStore } from '../modules/auth/email-change.js'
import { createAuthEmailSender, createSmtpTransport } from '../adapters/email/smtp-email.js'
import { createProjectFileCountListing, createProjectGetter, createProjectListing } from '../modules/projects/store.js'
import { projectResponse } from '@gugu/core'
import { createClientOperations } from '../modules/clients/service.js'
import { createPostgresMindReferenceSuggestionPorts } from '../modules/mind/references.js'
import { createMindReferenceSuggester } from '@gugu/core/mind'
import { createSqlMindCanvasReader, createSqlMindNoteReader } from '@gugu/core/mind'
import { createHostCoreUndoOperations } from '../modules/undo/service.js'
import { createLocalFileUndoStorage } from '../modules/files/storage/undo.js'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { createScheduledTaskDeleter } from '@gugu/core/scheduled-task-delete'
import { createKyselyScheduledTaskDeleteRuntime } from '@gugu/core/scheduled-task-delete-data'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '@gugu/core/scheduled-task-list'
import { createScheduledTaskDeliveryTargets } from '../modules/scheduled-tasks/delivery/targets.js'
import { createScheduledTaskTestNotifier } from '@gugu/core/scheduled-task-test-notify'
import { createPostgresScheduledTaskResultDelivery, createPostgresScheduledTaskTestDelivery } from '../modules/scheduled-tasks/delivery/results.js'
import { createScheduledImPushHistory } from '../modules/scheduled-tasks/delivery/history.js'
import { createWebScheduledAttachmentResources } from '../modules/scheduled-tasks/delivery/files.js'
import { createScheduledTaskRunNowRuntime } from '../modules/scheduled-tasks/run/now.js'
import { createScheduledTaskFeishuDelivery } from '../modules/scheduled-tasks/delivery/feishu.js'
import { createScheduledTaskWechatDelivery } from '../modules/scheduled-tasks/delivery/wechat.js'
import { createScheduledTaskQqDelivery } from '../modules/scheduled-tasks/delivery/qq.js'
import { createScheduledTaskTelegramDelivery } from '../modules/scheduled-tasks/delivery/telegram.js'
import { createPostgresScheduledTaskTestEmailDelivery, smtpSettings } from '../modules/scheduled-tasks/delivery/email.js'
import { createSmtpTestDelivery } from '../adapters/email/smtp-test-delivery.js'
import { createKyselyNotificationOperations } from '@gugu/core/notifications'
import { createKyselySmtpStore, createUserSmtpSettings } from '@gugu/core/smtp'
import { encryptEncryptedString as encryptSmtpPassword } from '../adapters/security/encrypted-string.js'
import { createPostgresProjectDeleteJournal, createLocalProjectUndoJournalStorage } from '../modules/undo/journal.js'
import { createWebLoopScopeTrace } from '../modules/loopscope/trace.js'
import { readWebAgentImPrompt } from '../modules/agent/context/prompts.js'
import { createAgentShellSnapshotReader } from '../modules/agent/sandbox/snapshot.js'
import { createPostgresAgentRunStore } from '../modules/agent/run/store.js'
import { createPostgresAgentActiveStatusReader, createPostgresAgentDispatch } from '../modules/agent/run/dispatch.js'
import { createTrackOperations } from '../modules/site/track.js'
import { createFeedbackNotifier, createFeedbackService, createFeedbackSubmission, createKyselyFeedbackOperations } from '@gugu/core/feedback'
import { runBestEffort } from '../shared/best-effort.js'
import { revokeUserSessions } from '../modules/auth/session/revoke.js'
import { createKyselyProjectCreateRuntime } from '@gugu/core/project-create-data'
import { createProjectCreator } from '@gugu/core/project-create'
import {
  createPostgresProjectUpdateRuntime,
  createLocalProjectDirectoryRenamer,
  createProjectPostCommitPublisher,
} from '../modules/projects/update.js'
import { createProjectUpdater } from '@gugu/core/project-update'
import { createProjectTrashService } from '@gugu/core/project-trash'
import { createPostgresProjectTrashRuntime } from '../modules/projects/lifecycle/store.js'
import {
  createLocalProjectTrashStorage,
  createProjectTrashOriginalStorageKeyResolver,
  createPostgresProjectTrashPathMetadataReader,
} from '../modules/projects/lifecycle/storage.js'
import { createCalendarEvent } from '@gugu/core/calendar'
import { createCalendarEventPostCommitPublisher, createCalendarMutationPostCommitPublisher } from '../modules/calendar/publish.js'
import { createCalendarEventReader, createKyselyCalendarReadPort, createKyselyCalendarCreateStore, createKyselyCalendarMutationStores } from '@gugu/core/calendar'
import { deleteCalendarEvent } from '@gugu/core/calendar'
import { updateCalendarEvent } from '@gugu/core/calendar'
import {
  createPostgresWorkspaceCreator,
  createPostgresWorkspaceUpdater,
  createPostgresWorkspaceLister,
  createPostgresWorkspaceDeleter,
} from '../modules/workspaces/store.js'
import { createPostgresWorkspaceBindingOperations } from '../modules/workspaces/bindings.js'
import { createPostgresWorkspaceDirectoryOperations } from '../modules/workspaces/directories.js'
import { createAgentSessionLister } from '../modules/agent/sessions/read.js'
import { createAgentSessionFilesystemAuthorization, unavailableFilesystemAuthorizationConfirmations } from '../modules/agent/sandbox/authorization.js'
import { createFilesystemAuthorizationConfirmationStore } from '../modules/agent/sandbox/confirmations.js'
import { createPostgresAgentSessionRefresher } from '../modules/agent/sessions/update.js'
import { createPostgresAgentSessionRenamer } from '../modules/agent/sessions/update.js'
import { createPostgresAgentSessionDeleteOperations } from '../modules/agent/sessions/delete.js'
import { createAgentMessageHistory } from '../modules/agent/chat/read.js'
import { createPostgresAgentOrphanRecovery } from '../modules/agent/run/recovery.js'
import { createAgentImMemoryRagMutationPorts } from '../modules/agent/memory/invalidate.js'
import { createPostgresAgentSessionStateReader } from '../modules/agent/sessions/read.js'
import { createPostgresAgentInteractionHistory, type AgentSessionDeletePorts } from '@gugu/core/agent-sessions'
import { createInteractionSessionLookup } from '../modules/agent/interactions/session.js'
import { createPostgresAgentMessageLocator } from '../modules/agent/chat/history.js'
import { createPostgresAgentImportedDraftQueueReader, createPostgresAgentPendingQueueReader } from '../modules/agent/chat/queue.js'
import { createPostgresAgentPendingQueuePatch, createPostgresAgentPendingQueueReplace } from '../modules/agent/chat/patch.js'
import { createPostgresAgentPendingQueueClaims } from '../modules/agent/chat/claims.js'
import { createPostgresAgentToolEventDetails } from '../modules/agent/chat/tools.js'
import { agentCommandMenu } from '@gugu/core/agent/commands/menu'
import { BUILTIN_AGENT_TOOL_STATE_LABELS, DEFAULT_AGENT_STATE_LABELS } from '@gugu/core/agent-sessions'
import { createAgentStateLabelOverrides } from '../modules/agent/sessions/labels.js'
import { createAgentStateLabelOperations } from '../modules/admin/llm-strategy.js'
import {
  createPostgresFileBrowserOperations,
  createPostgresFileReadOperations,
  createPostgresFolderReadOperations,
} from '../modules/files/browse.js'
import { createPostgresXlsxPreviewOperations, createPostgresFileContentOperations } from '../modules/files/content.js'
import { createPostgresFileUploadOperations, createPostgresFileConflictOperations } from '../modules/files/upload.js'
import { createPublicAgentEgress } from '../adapters/network/safe-egress-proxy.js'
import {
  createPostgresFileDeleteOperations,
  createPostgresFileRestoreOperations,
  TrashPurgeUnavailableError,
} from '../modules/files/trash/service.js'
import { createPostgresTrashReadOperations, createPostgresTrashMutationOperations } from '../modules/files/trash/store.js'
import { createPostgresTrashPurgeOperations } from '../modules/files/trash/purge.js'
import { createPostgresFileUpdateOperations, createPostgresFileCopyOperations } from '../modules/files/store.js'
import { createPostgresFileBatchDownloadOperations } from '../modules/files/download.js'
import { createPostgresFileArchiveOperations } from '../modules/files/archive/service.js'
import { capturePostgresFolderPathMirrorDirectoryKeys, createPostgresFolderPathMirrorPlanner } from '../modules/files/folders/paths.js'
import { createPostgresFolderWriteOperations, type FolderUndoRecord } from '../modules/files/folders/write.js'
import { createPostgresFolderCopyOperations } from '../modules/files/folders/copy.js'
import { createPostgresFolderDeleteOperations } from '../modules/files/folders/delete.js'
import { prepareWorkspaceDirectoryAcl } from '../adapters/sandbox/workspace-directory-acl.js'
import { createSandboxdWorkspacePtyTerminator } from '../adapters/sandbox/sandboxd-pty.js'
import { createRedisRateLimitCommands, createRedisRegistrationCodeCommands, createRedisPasswordResetCommands, createRedisAgentActiveStatusReader, createRedisAgentCancellationCommands, createRedisAgentRunRecoveryState, createRedisAgentSessionReflectionCleaner, createRedisScheduledTaskCommands, createRedisFilesystemAuthorizationCommands, createRedisTrashPurgeNotifier, type RedisEventPublisher } from '../adapters/cache/redis-events.js'
import { createRedisRateLimiter } from '../modules/auth/rate-limit.js'
import { createPostgresAdminStorageSnapshotQuery, diskUsageForStorage } from '../modules/admin/storage.js'
import { createPostgresAdminUserStatusStore } from '../modules/admin/user-status.js'
import { resolveAdminDebugLogFiles } from '../modules/admin/logs.js'
import { createSecurityEventFingerprint } from '../modules/admin/audit.js'
import { createAdminAuth, createAdminPromptOptions } from './admin.js'
import { booleanSetting, objectSetting, optionalIntegerSetting, userQuotaSettings } from './settings.js'
import { createMindServices } from './mind.js'
import { createWebWorkers } from './workers.js'
import { createAgentServices } from './agent.js'

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
  async publishTrashPurgeProgress() { return false },
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
    isDataReplacementWriteLocked: createPostgresDataReplacementWriteGate(pool),
    ...(quotaSettings ? { getQuota: createPostgresUserQuotaReader(pool, quotaSettings) } : {}),
    async revokeUserSessions(userId) {
      await revokeUserSessions(pool, userId)
    },
    publishAuthStateChanged: (userId: string) => (redisEvents ?? noRedisEvents).publishAuthStateChanged(userId),
    rateLimit,
  }
}

function imMaintenanceProviderConfig(environment: NodeJS.ProcessEnv, path: string): ProviderConfig {
  const values = objectSetting(readConfigOverride(path).ai)
  const text = (key: string, envKey: string, fallback: string) => environment[envKey] ?? String(values[key] ?? fallback)
  const integer = (key: string, envKey: string, fallback: number) => {
    const raw = environment[envKey] === undefined ? values[key] : environment[envKey]
    if (raw === undefined || raw === null || raw === '') return fallback
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('IM 记忆维护模型配置无效')
    return parsed
  }
  return {
    provider: text('provider', 'AI__PROVIDER', 'qwen'),
    api_key: text('api_key', 'AI__API_KEY', ''),
    base_url: text('base_url', 'AI__BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    model: text('model', 'AI__MODEL', 'qwen-max'),
    api_format: text('api_format', 'AI__API_FORMAT', ''),
    thinking: text('thinking', 'AI__THINKING', ''),
    reasoning_effort: text('reasoning_effort', 'AI__REASONING_EFFORT', ''),
    ollama_mode: text('ollama_mode', 'AI__OLLAMA_MODE', 'local'),
    ollama_api_mode: text('ollama_api_mode', 'AI__OLLAMA_API_MODE', 'native'),
    max_tokens: integer('max_tokens', 'AI__MAX_TOKENS', 25_600),
    context_tokens: integer('context_tokens', 'AI__CONTEXT_TOKENS', 128_000),
    timeout_ms: 300_000,
    ...(objectSetting(values.capability_overrides) ? { capability_overrides: values.capability_overrides as Record<string, boolean> } : {}),
  }
}

function ephemeralStorageQuota(config: WebUiConfig, env: NodeJS.ProcessEnv): number {
  const override = config.configOverridePath ? readConfigOverride(config.configOverridePath) : {}
  const sandbox = objectSetting(override.sandbox)
  const configured = optionalIntegerSetting(
    env.SANDBOX__EPHEMERAL_QUOTA_BYTES, sandbox.ephemeral_quota_bytes, 'SANDBOX__EPHEMERAL_QUOTA_BYTES',
  )
  const value = configured ?? 1024 * 1024 * 1024
  if (value < 64 * 1024 * 1024) throw new Error('SANDBOX__EPHEMERAL_QUOTA_BYTES 配置无效')
  return value
}

export async function createWebUiApp(
  config: WebUiConfig,
  pool: Pool,
  core: SqlDataRuntime,
  redisEvents?: RedisEventPublisher,
  env: NodeJS.ProcessEnv = process.env,
  canRebuildAgentMemoryIndex: () => boolean = () => false,
  projectJournalPool?: Pool,
  trashPurgeSchemaApplied = false,
  searchUsageSchemaApplied = false,
  im?: {
    bindMcp(runtime: ReturnType<typeof createMcpRuntime>): void
    clearOwner(ownerId: string, remove: () => Promise<unknown>): Promise<void>
    removeSession(ownerId: string, sessionId: number, ports: AgentSessionDeletePorts, legacy: () => Promise<boolean>): Promise<boolean>
  },
): Promise<{ app: ReturnType<typeof createApp>; startWorkers(): Promise<void>
  loopScopeTrace: ReturnType<typeof createWebLoopScopeTrace>; agentRunLog: import('@gugu/core/agent').AgentRunLogPort }> {
  const publisher = redisEvents ?? noRedisEvents
  const fileUploads = createPostgresFileUploadOperations(pool, {
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
  })
  const fileDeletes = createPostgresFileDeleteOperations(pool, {
    storageRoot: config.storageLocalPath,
    async publishChanged(event) {
      await publisher.publishResourceChanged({ ownerId: event.ownerId, resource: 'files', operation: 'delete',
        entityId: event.entityId, origin: event.origin, payload: { kind: 'file', id: event.entityId } })
    },
  })
  const publishTerminalRefresh = async () => {
    const users = await pool.query<{ id: string }>('SELECT id::text AS id FROM users ORDER BY id')
    for (const user of users.rows) await publisher.publishResourceChanged({ ownerId: user.id, resource: 'terminals', operation: 'refresh' })
  }
  const imMemoryMaintenanceSource = createImMaintenanceSource(core.db)
  const imMemoryStorage = createLocalImMemoryMaintenanceStorage(config.storageLocalPath)
  const imMemoryGroupDailyCompactor = createImMemoryGroupDailyCompactor({
    storage: imMemoryStorage,
    isTombstoned: imMemoryMaintenanceSource.isTombstoned,
    readPrompt: () => readWebAgentImPrompt('group_compress'),
    readModelSettings: () => imMaintenanceProviderConfig(env, resolveConfigOverridePath(env)),
    complete: createStandaloneImMemoryModelCaller({ environment: env }),
  })
  const imMemoryMaintenancePreviewWorker = createImMemoryMaintenancePreviewWorker({
    messages: imMemoryMaintenanceSource.messages,
    storage: imMemoryStorage,
    readModelSettings: () => imMaintenanceProviderConfig(env, resolveConfigOverridePath(env)),
    readPrompt: scopeType => readWebAgentImPrompt(scopeType === 'group' ? 'group_reflection' : 'member_reflection'),
    complete: createStandaloneImMemoryModelCaller({ environment: env }),
    diagnose() { console.error('管理员 IM 记忆模型预览 scope 处理失败') },
  })
  const imMemoryMaintenancePreview = createImMemoryMaintenancePreviewStarter({
    state: config.redisUrl ? createImMemoryMaintenancePreviewState({
      get: createRedisValueReader(config.redisUrl),
      ...createRedisScheduledTaskCommands(config.redisUrl),
    }) : null,
    listCursors: imMemoryMaintenanceSource.listCursors,
    run: imMemoryMaintenancePreviewWorker,
    diagnose() { console.error('管理员 IM 记忆模型预览启动失败') },
  })
  // Collector URL 来自可信部署配置；仍需固定 DNS 目标并拒绝重定向，允许本地地址仅用于该固定内部服务。
  const loopScopeTransport = createNodeProviderTransport({ allowLocal: true, connectTimeoutMs: 5_000, writeTimeoutMs: 10_000, environment: () => env })
  const loopScopeTrace = createWebLoopScopeTrace({ enabled: env.LOOPSCOPE_ENABLED, endpoint: env.LOOPSCOPE_ENDPOINT, transport: loopScopeTransport })
  const recordEmailDelivery = config.redisUrl ? createRedisEmailDeliveryMetric(config.redisUrl) : undefined
  const readStorageQuotaManualState = config.redisUrl ? createRedisValueReader(config.redisUrl) : null
  const storageQuotaReconcile = config.redisUrl && readStorageQuotaManualState
    ? createManualStorageQuotaReconcile({
      commands: createRedisScheduledTaskCommands(config.redisUrl),
      state: { read: () => readStorageQuotaManualState('storage:quota_reconcile:manual_state') },
      work: (signal, onProgress) => reconcileAllStorageUsers(createPostgresStorageQuotaReconcilePort({
        pool,
        storageRoot: config.storageLocalPath,
        defaultFileLibraryLimit: () => config.storageDefaultLimitBytes,
        ephemeralLimit: () => ephemeralStorageQuota(config, env),
      }), {
        signal,
        onProgress,
        onUserError(error) {
          console.error(`gugu-webui storage quota user reconcile failed (${error instanceof Error ? error.name : 'unknown'})`)
        },
      }),
      onError(error) {
        console.error(`gugu-webui storage quota reconciliation failed (${error instanceof Error ? error.name : 'unknown'})`)
      },
    })
    : { async start(): Promise<never> { throw new StorageQuotaReconcileUnavailable() } }
  const readMcpSettings = createMcpSettingsReader(resolveConfigOverridePath(env), env)
  const skillToolRegistry = createAgentToolRegistry({ core, authorize: async () => false })
  const capabilitySkills = createBuiltinSkillDefinitions(createBundledSkillDocuments(), new AbortController().signal)
  const builtinSkillTools = createSkillToolCatalog(skillToolRegistry)
  const mcpSkillTools = createMcpSkillToolDirectory(core.db, {
    enabled: () => readMcpSettings().enabled === true,
    decrypt: createConfiguredByokEnvelope(env),
    transport: () => createNodeProviderTransport({ allowLocal: false, connectTimeoutMs: 5_000, writeTimeoutMs: 10_000, environment: () => env }),
    maxTools: () => readMcpSettings().max_tools_per_server,
    async builtinNames(_owner) { return new Set(skillToolRegistry.catalog().map(item => item.name)) },
  })
  const mcpStdioClient = createMcpStdioClientFactory({
    resolveWorkspaceRoot: owner => resolveMcpWorkspaceRoot(config.storageLocalPath, owner),
    maxSessions: () => readMcpSettings().stdio_max_sessions,
    maxSessionsPerOwner: () => readMcpSettings().stdio_max_sessions_per_user,
    idleSeconds: () => readMcpSettings().stdio_idle_seconds,
  })
  const mcpRuntime = createMcpRuntime({
    configs: createMcpServerConfigLister(core.db), enabled: () => readMcpSettings().enabled === true,
    decrypt: createConfiguredByokEnvelope(env),
    transport: () => createNodeProviderTransport({ allowLocal: false, connectTimeoutMs: 5_000, writeTimeoutMs: 10_000, environment: () => env }),
    maxTools: () => readMcpSettings().max_tools_per_server,
    async builtinNames(_owner) { return new Set(skillToolRegistry.catalog().map(item => item.name)) },
    stdioClient: mcpStdioClient,
  })
  im?.bindMcp(mcpRuntime)
  const publishImChannelsChanged = createGatewayConfigChangePublisher(pool,
    ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }))
  const userSkillTools = async (owner: string) => {
    const [builtins, dynamic] = await Promise.all([builtinSkillTools(owner), mcpSkillTools(owner)])
    const known = new Set(builtins.map(item => item.name))
    return [...builtins, ...dynamic.filter(item => !known.has(item.name)).map(item => ({
      name: item.name, description_short: item.description_short, category: 'mcp', enabled: true,
    }))]
  }
  const userSkillManager = createUserSkillManager(core.db, 'postgres', {
    knownTools: createRegisteredUserSkillToolNameReader({
      registry: skillToolRegistry,
      mcp: mcpSkillTools,
    }),
    digest: text => createHash('sha256').update(text).digest('hex').slice(0, 16),
    publish: async ownerId => publisher.publishResourceChanged({ ownerId, resource: 'skills', operation: 'refresh' }),
  })
  const accountDeleter = createPostgresAccountDeleter(
    pool,
    config.storageLocalPath,
    config.redisUrl ? createRedisAccountAttachmentCleaner(config.redisUrl) : async () => { throw new Error('Redis is not configured') },
    userId => publisher.publishAuthStateChanged(userId),
  )
  const qqConnectOptions = createQqConnectHostOptions(env, config.redisUrl ?? '')
  const feishuConnectOptions = createFeishuConnectHostOptions(env, config.redisUrl ?? '')
  const scheduledNotifyImPlatforms = createImPlatformSettingsReader(env, resolveConfigOverridePath(env))
  const scheduledNotifyReach = config.redisUrl ? createRedisValueReader(config.redisUrl) : null
  const wechatConnectOptions = createWechatConnectHostOptions(env, config.redisUrl ?? '')
  const telegramConnectOptions = createTelegramConnectHostOptions(createSafeEgressSettingsReader(env, resolveConfigOverridePath(env)), config.secretKey)
  const {
    createMindNote, mindNoteMutations, mindCanvasCreate, mindCanvasUpdate, mindCanvasDelete,
    mindCanvasNoteMutations, mindCanvasItemUpdate, mindCanvasItemRemove, mindCanvasItemAdd,
    mindGlobalRelationDelete, mindCanvasRelationCreate, mindCanvasRelationDelete, mindRefNodeCreator, publishCanvasChanged,
  } = createMindServices(core, publisher)
  const postgresSearchSources = createPostgresGlobalSearchSources(pool)
  const globalSearch = createGlobalSearchOperations(postgresSearchSources)
  const webSearch = process.platform === 'linux' ? createGlobalSearchOperations([
    ...postgresSearchSources.filter(source => source.type !== 'file' && source.type !== 'folder'),
    ...createDiskFileSearchSources(pool, config.storageLocalPath),
  ]) : globalSearch
  const mindRefSuggest = createMindReferenceSuggester({
    ...createPostgresMindReferenceSuggestionPorts(pool),
    globalSearch,
  })
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
  const projectCreateRuntime = createKyselyProjectCreateRuntime({
    db: core.db, backend: 'postgres', publishProjectCreated: publishProjectMutation,
  })
  const projectCreate = createProjectCreator(projectCreateRuntime)
  const projectDirectoryRenamer = createLocalProjectDirectoryRenamer(config.storageLocalPath)
  const projectUpdateRuntime = createPostgresProjectUpdateRuntime(
    pool,
    projectDirectoryRenamer,
    publishProjectMutation,
  )
  const projectUpdate = createProjectUpdater(projectUpdateRuntime)
  const projectTrashStorage = createLocalProjectTrashStorage(
    config.storageLocalPath,
    createProjectTrashOriginalStorageKeyResolver(createPostgresProjectTrashPathMetadataReader(pool)),
  )
  const projectTrash = createProjectTrashService(createPostgresProjectTrashRuntime(pool, publishProjectMutation), projectTrashStorage)
  const projectDeleteJournal = projectJournalPool
    ? createPostgresProjectDeleteJournal(projectJournalPool, createLocalProjectUndoJournalStorage(config.storageLocalPath)) : undefined
  const publishCalendarCreate = createCalendarEventPostCommitPublisher({
    bumpContextRevision: (ownerId) => publisher.bumpContextRevision(ownerId, 'calendar'),
    publishResourceChanged: (event) => publisher.publishResourceChanged(event),
  })
  const eventStore = createKyselyCalendarCreateStore(core.db, 'postgres', publishCalendarCreate)
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
  const folderCopy = createPostgresFolderCopyOperations(pool, {
    storageRoot: config.storageLocalPath,
    fileSyncEnabled: config.filesyncEnabled,
    buildSearchRomaji: folderSearchAlias,
    async publishChanged(event) {
      await publisher.publishResourceChanged({
        ownerId: event.ownerId,
        resource: 'files',
        operation: 'create',
        entityId: Number(event.folder.id),
        origin: event.origin,
        payload: { kind: 'folder', entity: event.folder },
      })
    },
  })
  const folderDelete = createPostgresFolderDeleteOperations(pool, {
    storageRoot: config.storageLocalPath,
    async captureDirectoryKeys(client, ownerId, folderId) {
      return capturePostgresFolderPathMirrorDirectoryKeys(config.storageLocalPath, client, ownerId, folderId)
    },
    async publishChanged(event) {
      await publisher.publishResourceChanged({
        ownerId: event.ownerId,
        resource: 'files',
        operation: 'delete',
        entityId: event.folderId,
        origin: event.origin,
        payload: { kind: 'folder', id: event.folderId },
      })
    },
    onPathCleanupFailure(errorType) {
      console.error(`gugu-webui folder delete PathMirror cleanup failed: ${errorType}`)
    },
    onPathRollbackFailure(errorType) {
      console.error(`gugu-webui folder delete PathMirror rollback failed: ${errorType}`)
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
  const runtimeConfigPath = config.configOverridePath ?? resolveConfigOverridePath(env)
  const bubblewrapRootfs = resolveBubblewrapRootfs(env)
  const readBubblewrapReadiness = createIsolatedShellReadiness(bubblewrapRootfs)
  const readTerminalSettings = createTerminalRuntimeSettingsReader(runtimeConfigPath, env, readBubblewrapReadiness, 'none')
  const readTerminalAccess = createTerminalAccessReader(readTerminalSettings)
  const readPtyEnabled = async () => {
    const settings = await readTerminalAccess()
    return settings.terminalMode === 'auto' && settings.fullUserSandboxAuthorizationEnabled
  }
  const workspaceList = createPostgresWorkspaceLister(pool, {
    async readRuntimeSettings() {
      return { ...await readTerminalAccess(), automaticModeEnabled: config.workspaceRuntimeSettings.automaticModeEnabled }
    },
  })
  const readAgentActiveStatuses = config.redisUrl
    ? createPostgresAgentActiveStatusReader(pool)
    : async () => new Map<number, boolean>()
  const listAgentSessions = createAgentSessionLister(pool, {
    activeStatuses: readAgentActiveStatuses,
    filesystemAuthorizationEnabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
    // Host 尚未探测 sandboxd 就绪状态；与 workspace list 一样禁用 Shell/PTY 展示。
    workspaceShellSupported: () => false,
  })
  const agentRunRecoveryState = config.redisUrl
    ? createRedisAgentRunRecoveryState(config.redisUrl)
    : undefined
  const recoverAgentOrphanedSession = agentRunRecoveryState
    ? createPostgresAgentOrphanRecovery(pool, agentRunRecoveryState)
    : undefined
  const activeRunReader = config.redisUrl ? {
    dispatch: createPostgresAgentDispatch(pool, config.secretKey),
    store: createPostgresAgentRunStore(pool, config.secretKey, {
      async writeHistory() { throw new Error('只读运行快照不接受历史写入') },
    }),
  } : null
  const listAgentMessages = createAgentMessageHistory(pool, {
    activeStatuses: readAgentActiveStatuses,
    async readActiveRun(ownerId, sessionId) {
      if (!activeRunReader) return null
      const active = await activeRunReader.dispatch.active(ownerId, sessionId)
      return active?.identity ? await activeRunReader.store.read(active.identity) : null
    },
    filesystemAuthorizationEnabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
    // Host 尚未探测 sandboxd 就绪状态；与 workspace list 一样禁用 Shell/PTY 展示。
    workspaceShellSupported: () => false,
    ...(recoverAgentOrphanedSession ? {
      recoverOrphanedSession: recoverAgentOrphanedSession,
    } : {}),
    listInteractions: createPostgresAgentInteractionHistory(pool, undefined, config.secretKey),
  }).list
  const agentQueueStatuses = config.redisUrl
    ? createRedisAgentActiveStatusReader(config.redisUrl)
    : async () => new Map<number, boolean>()
  const readAgentSessionState = createPostgresAgentSessionStateReader(pool, {
    recover: recoverAgentOrphanedSession ?? (async () => false),
    async isActive(sessionId, ownerId) {
      return (await readAgentActiveStatuses([sessionId], ownerId)).get(sessionId) ?? false
    },
  })
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
    surpriseMp3: createOnboardingSurpriseMp3Reader(),
    onFailure() { console.error('gugu-webui onboarding seed failed') },
  })
  const onboardingReseed = createOnboardingReseeder(createKyselyOnboardingStore(core.db, 'postgres'), {
    ...createPostgresOnboardingReseedOperations(pool, config.storageLocalPath),
    seed: seedRegistration,
  })
  const registrationOperations = createPostgresRegistrationOperations(pool, {
    defaultStorageLimitBytes: config.storageDefaultLimitBytes,
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
  const trashPurgeOperations = createPostgresTrashPurgeOperations(pool, {
    notifyWorker: config.redisUrl ? createRedisTrashPurgeNotifier(config.redisUrl) : async () => undefined,
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
    ...trashPurgeOperations,
    async startEmpty(ownerId: string) {
      if (!trashPurgeSchemaApplied || process.platform !== 'linux') throw new TrashPurgeUnavailableError()
      return trashPurgeOperations.startEmpty(ownerId)
    },
    restoreFolder(ownerId: string, folderId: number, origin: string | null) {
      if (!fileRestores.restoreFolder) throw new Error('Local 文件夹恢复适配器未就绪')
      return fileRestores.restoreFolder(ownerId, folderId, origin)
    },
    restoreFiles(ownerId: string, fileIds: number[], origin: string | null) {
      if (!fileRestores.restoreBatch) throw new Error('Local 批量文件恢复适配器未就绪')
      return fileRestores.restoreBatch(ownerId, fileIds, origin)
    },
  }
  const embeddingGate = createByokGateReader(resolveConfigOverridePath(env), env)
  const embeddingRebuildState = createRedisUserEmbeddingRebuildState(
    config.redisUrl ? createRedisScheduledTaskCommands(config.redisUrl) : null,
  )
  const createEmbeddingTransport = createAgentRagEmbeddingTransportFactory(() => env)
  const embeddingTransport = createEmbeddingTransport()
  const resolveEmbeddingSettings = createPostgresAgentEmbeddingSettingsResolver(pool, {
    enabled: embeddingGate,
    decrypt: async row => createConfiguredByokEnvelope(env).decrypt({
      ciphertext: row.encrypted_value,
      nonce: row.nonce,
      encryptedDataKey: row.encrypted_data_key,
      keyVersion: row.key_version,
    }),
  })
  const memoryVectorStore = createLocalUserMemoryVectorStore(config.storageLocalPath)
  const sessionDeletePorts: AgentSessionDeletePorts = {
      removeIfUnreferenced: (ownerId, storageKey) => createPostgresChatAttachmentDraftDeletePorts(pool, config.storageLocalPath).removeUnreferenced(ownerId, storageKey),
      clearReflection: config.redisUrl
        ? createRedisAgentSessionReflectionCleaner(config.redisUrl)
        : async () => { throw new Error('Redis 会话反思清理不可用') },
    }
  const legacySessionDelete = createPostgresAgentSessionDeleteOperations(pool, sessionDeletePorts)
  const withOwnerMemoryLock = createOwnerMemoryLock(core.db)
  const accountMemoryCleanup = config.redisUrl && core.receipts && process.platform === 'linux'
    ? createAccountMemoryCleanupRuntime({
      values: createRedisAdminMaintenanceCommands(config.redisUrl),
      redis: createRedisScheduledTaskCommands(config.redisUrl),
      storage: createAccountMemoryCleanupStorage({ core, root: config.storageLocalPath }),
      available: canRebuildAgentMemoryIndex,
      model: () => imMaintenanceProviderConfig(env, resolveConfigOverridePath(env)),
      complete: createStandaloneImMemoryModelCaller({ environment: env }),
      refreshVectors: createAccountMemoryCleanupVectorRefresh({
        store: memoryVectorStore, withSourceLock: withOwnerMemoryLock,
        resolve: resolveEmbeddingSettings, createTransport: createEmbeddingTransport,
      }),
      async listOwners() {
        await pool.query('SELECT generation FROM rag_index_jobs LIMIT 0')
        return (await pool.query<{ id: string }>('SELECT id::text AS id FROM users ORDER BY id')).rows.map(row => row.id)
      },
    })
    : undefined
  const rebuildMemoryIndex = createPersistentMemoryIndexRebuilder(core, {
    now: Date.now,
    wait: waitForMemoryIndexRebuild,
  })
  const embeddingRebuildRuntime = createUserEmbeddingRebuildRuntime({
    state: embeddingRebuildState,
    resolve: resolveEmbeddingSettings,
    now: Date.now,
    async rebuild(ownerId, settings, signal) {
      return createUserMemoryVectorRebuilder({
        ...memoryVectorStore,
        withSourceLock: withOwnerMemoryLock,
        async embed(_ownerId, text, embedSignal) {
          const result = await embedRagQuery(settings, text, embeddingTransport, embedSignal)
          return result.outcome === 'success' ? result.vector : null
        },
        rebuildMemoryIndex,
      })(ownerId, `${settings.provider}:${settings.model}:${settings.dimensions || 'default'}`, signal)
    },
  })
  const adminEmbeddingRebuildRuntime = createAdminEmbeddingRebuildRuntime({
    state: createRedisAdminEmbeddingRebuildState(config.redisUrl ? createRedisScheduledTaskCommands(config.redisUrl) : null),
    async listOwners() {
      const result = await pool.query<{ id: string }>('SELECT id::text AS id FROM users ORDER BY id')
      return result.rows.map(row => row.id)
    },
    resolve: resolveEmbeddingSettings,
    startOwner: embeddingRebuildRuntime.start,
    readOwner: embeddingRebuildState.read,
    wait: waitForMemoryIndexRebuild,
    now: Date.now,
  })
  const ragIndexReader = createSqlRagPersistentIndexReader(core.db, core.backend)
  const readStateLabelOverrides = createAgentStateLabelOverrides(() => readConfigOverride(runtimeConfigPath))
  const readAgentShellSnapshot = createAgentShellSnapshotReader(pool, core.db, readTerminalSettings)
  const shellMounts = createTerminalWorkspaceMounts(pool, core.db, config.storageLocalPath)
  const updateSandboxRuntime = createSandboxRuntimeUpdater(runtimeConfigPath)
  const readTerminalDetail = createPostgresTerminalDetailReader(pool, core.db, readTerminalAccess)
  const readTerminalExecutionSettings = async () => {
    const settings = await readTerminalSettings()
    return { ...settings, shellEnabled: settings.shellEnabled && settings.terminalMode !== 'entry_disabled' }
  }
  const terminalPtySnapshot = createTerminalShellSnapshotReader(core.db, 'postgres', readTerminalExecutionSettings)
  const authorizeTerminalPty = createTerminalInputAuthorizer({
    read: async (owner, terminalId) => {
      const value = await readTerminalDetail(owner, terminalId)
      if (!value) throw Object.assign(new Error('终端不存在'), { statusCode: 404 })
      return value
    },
    snapshot: terminalPtySnapshot,
    ptyEnabled: readPtyEnabled,
  })
  const terminalPtyManager = createTerminalPtyManager({
    bridge: createBubblewrapPtyBridge(bubblewrapRootfs),
  })
  terminalPtyManager.startReaper()
  const runtimeLog = createWebRuntimeLog(config.logFile)
  const terminalPtyRuntime = createTerminalPtyRuntime({
    diagnose: error => runtimeLog('sandbox.command_failed', { error }),
    read: async (owner, terminalId) => {
      const value = await readTerminalDetail(owner, terminalId)
      if (!value) throw Object.assign(new Error('終端不存在'), { statusCode: 404 })
      return value
    },
    authorize: authorizeTerminalPty,
    snapshot: terminalPtySnapshot,
    mounts: createTerminalWorkspaceMounts(pool, core.db, config.storageLocalPath),
    manager: terminalPtyManager,
  })
  const terminalCommand = config.redisUrl
    ? createTerminalRuntime({
        sandboxRootfs: bubblewrapRootfs,
        pool,
        db: core.db,
        storageRoot: config.storageLocalPath,
        publisher,
        confirmations: createFilesystemAuthorizationConfirmationStore(createRedisFilesystemAuthorizationCommands(config.redisUrl)),
        read: async (owner, terminalId) => {
          const value = await readTerminalDetail(owner, terminalId)
          if (!value) throw Object.assign(new Error('终端不存在'), { statusCode: 404 })
          return value
        },
        runtime: readTerminalExecutionSettings,
        ptyEnabled: readPtyEnabled,
        diagnose: error => runtimeLog('sandbox.command_failed', { error }),
        cancellation: createTerminalCancellationMarkers(createRedisAgentCancellationCommands(config.redisUrl)),
        lease: createTerminalActiveLease(createRedisScheduledTaskCommands(config.redisUrl)),
      })
    : {
        async start() { throw Object.assign(new Error('终端执行服务暂不可用'), { statusCode: 503 }) },
        async cancel() { throw Object.assign(new Error('终端执行服务暂不可用'), { statusCode: 503 }) },
      }
  const adminIndexRebuildRuntime = createAdminIndexRebuildRuntime({
    state: createRedisAdminIndexRebuildState(config.redisUrl ? createRedisScheduledTaskCommands(config.redisUrl) : null),
    async listOwners() {
      const result = await pool.query<{ id: string }>('SELECT id::text AS id FROM users ORDER BY id')
      return result.rows.map(row => row.id)
    },
    sourceTypes: ['memory', 'calendar', 'canvas', 'conversation', 'knowledge', 'note', 'project', 'scheduled_task'],
    enqueue: (ownerId, sourceType) => enqueueAgentRagRebuild(core.db, core.backend, ownerId, sourceType),
    readProgress: (ownerId, sourceType) => readAgentRagRebuildProgress(core.db, core.backend, ownerId, sourceType),
    async countDocuments(ownerId, rebuiltSources) {
      return (await ragIndexReader.snapshot(ownerId)).documents.filter(document => rebuiltSources.includes(document.source_type)).length
    },
    wait: waitForMemoryIndexRebuild,
    now: Date.now,
  })
  const { scheduledAttempt, agentRunLifecycle, ownerReflectionWork, agentInteractionRespond, agentSecretInteraction, agentRunLog } = await createAgentServices({
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
    // 调度依赖在 Agent 初始化后装配，工具执行时才读取。
    get scheduledAttachments() { return scheduledAttachments },
    get downloadAttachment() { return downloadAttachment },
    get scheduledTaskWriteOptions() { return scheduledTaskWriteOptions },
    scheduledWorkers: () => ({ once: Boolean(scheduledOnceWorker), repeating: Boolean(scheduledRepeatingWorker) }),
    refreshScheduledWorkers,
  })
  const downloadAttachment = createAttachmentDownloader(core.db, {
    readLegacy: async (ownerId, attachId) => {
      if (!config.redisUrl) throw new Error('附件元数据服务不可用')
      return createRedisValueReader(config.redisUrl)(`chatfile:${ownerId}:${attachId}`)
    },
    open: key => openLocalFile(config.storageLocalPath, key),
    isUnsafe: error => error instanceof UnsafeLocalPathError,
  })
  const attachmentUpload = createPostgresAgentAttachmentUploadOperations(pool, config.storageLocalPath)
  const attachmentEgress = createPublicAgentEgress(createSafeEgressSettingsReader(env, runtimeConfigPath), config.secretKey)
  const scheduledAttachments = createWebScheduledAttachmentResources(core, config.storageLocalPath, downloadAttachment, {
    open: attachmentEgress.open, stage: attachmentUpload.stage,
  })
  const publishScheduledNotification = config.redisUrl ? createRedisNotificationPublisher(config.redisUrl) : async () => false
  const scheduledDeliveryOptions = {
    recordImPush: config.redisUrl ? createScheduledImPushHistory(core, {
      get: createRedisValueReader(config.redisUrl),
      eval: createRedisScheduledTaskCommands(config.redisUrl).eval,
    }, createPostgresChatAttachmentDraftDeletePorts(pool, config.storageLocalPath).removeUnreferenced) : undefined,
    feishu: createScheduledTaskFeishuDelivery(pool, {
      transport: feishuConnectOptions.transport,
      readAttachment: scheduledAttachments.read,
      decrypt: value => decryptEncryptedString(config.secretKey, value),
      enabled: () => scheduledNotifyImPlatforms().includes('feishu'),
      async readReach(ownerId) {
        const raw = await scheduledNotifyReach?.(`imreach:${ownerId}:feishu`)
          ?? await scheduledNotifyReach?.(`imreach:${ownerId}`)
        return raw ? JSON.parse(raw) : null
      },
    }),
    wechat: createScheduledTaskWechatDelivery(pool, {
      transport: wechatConnectOptions.transport,
      readAttachment: scheduledAttachments.read,
      generateId: randomUUID,
      randomUin: wechatConnectOptions.randomUin,
      decrypt: value => decryptEncryptedString(config.secretKey, value),
      enabled: () => scheduledNotifyImPlatforms().includes('wechat'),
      async readReach(ownerId) {
        const raw = await scheduledNotifyReach?.(`imreach-private:${ownerId}:wechat`)
          ?? await scheduledNotifyReach?.(`imreach:${ownerId}:wechat`)
          ?? await scheduledNotifyReach?.(`imreach:${ownerId}`)
        return raw ? JSON.parse(raw) : null
      },
      async readTarget(ownerId, recipient) {
        const key = createHash('sha256').update(recipient).digest('hex').slice(0, 32)
        const raw = await scheduledNotifyReach?.(`imreach-target:${ownerId}:wechat:c2c:${key}`)
        return raw ? JSON.parse(raw) : null
      },
    }),
    qq: createScheduledTaskQqDelivery(pool, {
      transport: qqConnectOptions.transport,
      readAttachment: scheduledAttachments.read,
      enabled: () => scheduledNotifyImPlatforms().includes('qq'),
      decrypt: value => decryptEncryptedString(config.secretKey, value),
      async readReach(ownerId) {
        const raw = await scheduledNotifyReach?.(`imreach:${ownerId}:qq`)
          ?? await scheduledNotifyReach?.(`imreach:${ownerId}`)
        return raw ? JSON.parse(raw) : null
      },
    }),
    telegram: createScheduledTaskTelegramDelivery(pool, {
      sendMessage: telegramConnectOptions.sendMessage,
      sendAttachment: telegramConnectOptions.sendAttachment,
      readAttachment: scheduledAttachments.read,
      enabled: () => scheduledNotifyImPlatforms().includes('telegram'),
      decrypt: value => decryptEncryptedString(config.secretKey, value),
      async readReach(ownerId) {
        const raw = await scheduledNotifyReach?.(`imreach:${ownerId}:telegram`)
          ?? await scheduledNotifyReach?.(`imreach:${ownerId}`)
        return raw ? JSON.parse(raw) : null
      },
    }),
    email: createPostgresScheduledTaskTestEmailDelivery(pool, {
      secretKey: config.secretKey,
      globalSmtp: config.smtp,
      send: createSmtpTestDelivery(env),
      storageRoot: config.storageLocalPath,
      downloadGenerated: downloadAttachment,
    }),
  }
  const scheduledResultDelivery = createPostgresScheduledTaskResultDelivery(pool, publishScheduledNotification, scheduledDeliveryOptions)
  const scheduledRunNow = config.redisUrl && scheduledAttempt ? createScheduledTaskRunNowRuntime({
    db: core.db, backend: 'postgres', storageRoot: config.storageLocalPath,
    redis: createRedisScheduledTaskCommands(config.redisUrl),
    filesystemAuthorizationEnabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
    execution: { attempt: scheduledAttempt,
      deliver: scheduledResultDelivery,
      timeZone: userQuotaSettings(config, env).serverTimezone,
    },
    bindRecurringDelivery: scheduledResultDelivery.bindRecipients,
    recurringStopEffects: {
      revokeConfirmation: (owner, summary, identity) => filesystemAuthorizationConfirmations.revoke(owner, summary, identity),
      fingerprint: createSecurityEventFingerprint(config.secretKey),
    },
    unavailable(plan) {
      if (plan.workspaceId !== null || plan.filesystemGrantId !== null) return '定时任务的工作区执行能力暂不可用'
      if (!core.receipts && plan.authorizedTools.includes('send_email')) return '定时任务的自动发送邮件工具暂不可用'
    },
    async notifyTasksChanged(ownerId) {
      await publisher.publishResourceChanged({ ownerId, resource: 'scheduled_tasks', operation: 'refresh' })
    },
  }) : undefined
  const onceWorkerEnabled = booleanSetting(env.GUGU_WEBUI_ONCE_TASK_WORKER_ENABLED, undefined, false)
  if (onceWorkerEnabled && !scheduledRunNow) throw new Error('一次性任务 Worker 需要 Redis')
  const scheduledOnceWorker = onceWorkerEnabled ? scheduledRunNow?.createOnceWorker() : undefined
  const repeatingWorkerEnabled = booleanSetting(env.GUGU_WEBUI_REPEATING_TASK_WORKER_ENABLED, undefined, false)
  if (repeatingWorkerEnabled && !scheduledRunNow) throw new Error('周期任务 Worker 需要 Redis')
  const scheduledRepeatingWorker = repeatingWorkerEnabled ? scheduledRunNow?.createRepeatingWorker() : undefined
  const projectExpiryWorkerEnabled = booleanSetting(env.GUGU_WEBUI_PROJECT_EXPIRY_WORKER_ENABLED, undefined, false)
  if (projectExpiryWorkerEnabled && !projectJournalPool) throw new Error('项目过期清理 Worker 需要已迁移的 PostgreSQL 项目日志结构')
  const backgroundWorkers = createWebWorkers({
    config, pool, core, publisher, trashOperations, trashPurgeSchemaApplied, projectJournalPool,
    projectExpiryWorkerEnabled, canRebuildAgentMemoryIndex, ownerReflectionWork, scheduledRepeatingWorker, scheduledOnceWorker,
  })
  async function refreshScheduledWorkers() {
    await Promise.all([scheduledOnceWorker?.refresh(), scheduledRepeatingWorker?.refresh()])
  }
  const scheduledTaskWriteOptions: TaskWriteOptions = {
    validateCron: validateTaskCron,
    filesystemAuthorizationEnabled: () => config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
    resolve: createPostgresTaskResolver(createPostgresTaskExternal({
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
    })),
    async publish(ownerId, operation, task, origin) {
      const item = task as { id?: unknown }
      await Promise.all([
        refreshScheduledWorkers(),
        publisher.publishResourceChanged({
          ownerId, resource: 'scheduled_tasks', operation,
          entityId: Number(item.id), origin,
          payload: { kind: 'task', entity: task },
        }),
      ])
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
    ...(agentRunLifecycle ? { agentChat: agentRunLifecycle.service } : {}),
    ...(agentInteractionRespond ? { agentInteractionRespond } : {}),
    ...(agentSecretInteraction ? { agentSecretInteraction } : {}),
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
    onboardingReseed,
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
      updateProfile: createProfileUpdater({
        ...createPostgresProfileUpdateStore(pool),
        verifyPassword: (password, hash) => bcrypt.compare(password, hash),
        hashPassword: (password) => bcrypt.hash(password, 12),
      }),
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
    }, { trash: projectTrashStorage, renameDirectory: projectDirectoryRenamer }, createLocalFileUndoStorage(config.storageLocalPath)),
    deleteScheduledTask: createScheduledTaskDeleter(createKyselyScheduledTaskDeleteRuntime(core.db, 'postgres', async (ownerId, id, origin) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'scheduled_tasks', operation: 'delete', entityId: id, origin })
    })),
    listScheduledTasks: createScheduledTaskQueries(createKyselyScheduledTaskReader(core.db, 'postgres'), () => ({
      workspaceSupported: true,
      filesystemAuthorizationEnabled: config.workspaceRuntimeSettings.fullUserSandboxAuthorizationEnabled,
    })).web,
    scheduledTaskDeliveryTargets: createScheduledTaskDeliveryTargets(pool),
    ...(scheduledRunNow ? { scheduledTaskRunNow: scheduledRunNow } : {}),
    scheduledTaskTestNotify: createScheduledTaskTestNotifier(createPostgresScheduledTaskTestDelivery(
      pool, publishScheduledNotification, scheduledDeliveryOptions,
    )),
    scheduledTaskWrites: createPostgresTaskWrites(pool, scheduledTaskWriteOptions),
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
    readAgentSessionState,
    agentFilesystemAuthorization: { operations: agentFilesystemAuthorization },
    refreshAgentSession: createPostgresAgentSessionRefresher(pool),
    renameAgentSession: createPostgresAgentSessionRenamer(pool),
    deleteAgentSession: { remove: (ownerId, sessionId) => im
      ? im.removeSession(ownerId, sessionId, sessionDeletePorts, () => legacySessionDelete.remove(ownerId, sessionId))
      : legacySessionDelete.remove(ownerId, sessionId) },
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
      stateLabelOverrides: readStateLabelOverrides,
      greeting: createProductionGreeting({
        pool,
        storageRoot: config.storageLocalPath,
        serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        overridePath: config.configOverridePath ?? resolveConfigOverridePath(env),
        env,
        ...(config.redisUrl ? { redis: createRedisGreetingCache(
          createRedisScheduledTaskCommands(config.redisUrl), createRedisValueReader(config.redisUrl),
        ) } : {}),
      }),
    },
    fileBrowser: createPostgresFileBrowserOperations(pool, config.secretKey),
    fileReads: {
      ...createPostgresFileReadOperations(pool, config.storageDefaultLimitBytes, config.storageLocalPath),
      ...createPostgresXlsxPreviewOperations(pool, config.storageLocalPath),
    },
    fileUploads,
    fileDeletes,
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
    globalSearch: webSearch,
    folderDownloads: createPostgresFileBatchDownloadOperations(pool, config.storageLocalPath),
    folderReads: createPostgresFolderReadOperations(pool),
    folderWrites,
    folderCopy,
    folderDelete,
    adminAuth: createAdminAuth(pool, config),
    adminUpdateMode: resolveAdminUpdateMode(env.GUGU_UPDATE_DEPLOYMENT_MODE),
    adminAgentCapabilities: {
      async read() {
        return createCapabilityCatalog({ tools: skillToolRegistry.catalog(), skills: await capabilitySkills })
      },
    },
    adminAgentStateLabels: createAgentStateLabelOperations({
      path: runtimeConfigPath,
      toolLabels: Object.fromEntries(filterConfiguredWebAgentTools(Object.keys(BUILTIN_AGENT_TOOL_STATE_LABELS))
        .map(name => [name, BUILTIN_AGENT_TOOL_STATE_LABELS[name]!])),
    }),
    adminPrompts: createAdminPromptOptions(pool),
    adminConfig: config.configOverridePath ? { path: config.configOverridePath, env } : undefined,
    adminLlmPresetList: config.configOverridePath ? { read: createAdminLlmPresetReader(config.configOverridePath) } : undefined,
    adminVoiceTest: { test: createAdminVoiceTestOperations(config.configOverridePath, env) },
    adminVoicePresetTest: createAdminVoicePresetTestOperations(config.configOverridePath, env),
    adminSearchTest: { test: createAdminSearchTestOperations(config.configOverridePath, env) },
    adminStorageSnapshots: {
      query: createPostgresAdminStorageSnapshotQuery(pool),
      diskUsage: () => diskUsageForStorage({ localPath: config.storageLocalPath }),
    },
    adminUsers: {
      read: createAdminUserListReader(core.db),
    },
    adminUserRisk: {
      read: createAdminUserRiskReader(core.db),
    },
    emailRecipientCount: { read: createEmailRecipientCounter((sql, values) => pool.query(sql, values)) },
    storageQuotaStatus: {
      store: config.redisUrl ? createRedisStorageQuotaStatusStore(config.redisUrl) : {
        async read() { throw new Error('Redis unavailable') },
        async lockExists() { throw new Error('Redis unavailable') },
        async interruptIfUnchanged() { throw new Error('Redis unavailable') },
      },
      reconcile: storageQuotaReconcile,
    },
    serviceStatus: { read: createServiceStatusReader({
      redis: config.redisUrl ? createRedisServiceStatusCommands(config.redisUrl) : null,
      dbOk: async () => { try { await pool.query('SELECT 1'); return true } catch { return false } },
      worker: backgroundWorkers.status,
    }) },
    serviceRestart: { restart: createServiceRestarter(backgroundWorkers.restart) },
    accountMemoryCleanup,
    adminMaintenanceStatus: { available: () => Boolean(config.redisUrl), read: createAdminMaintenanceStatus({
      get: key => { if (!config.redisUrl) throw new Error('维护状态服务不可用'); return createRedisAdminMaintenanceCommands(config.redisUrl).get(key) },
      compareAndSet: async (key, expected, value, ttl) => { if (!config.redisUrl) throw new Error('维护状态服务不可用'); return await createRedisAdminMaintenanceCommands(config.redisUrl).compareAndSet(key, expected, value, ttl) === '1' }
    }) },
    storageLiveTotals: { read: createStorageLiveTotals((sql, values) => pool.query(sql, values)) },
    safeEgressRead: { readSettings: createSafeEgressSettingsReader(env, resolveConfigOverridePath(env)) },
    imMemorySummary: { read: createImMemorySummaryReader(core.db) },
    imMemoryMaintenanceApply: {
      apply: createImMemoryMaintenanceApplier({
        state: config.redisUrl
          ? {
            get: createRedisValueReader(config.redisUrl),
            delete: createRedisExpiringValueStore(config.redisUrl).delete,
          }
          : {
            async get() { throw Object.assign(new Error('Redis 维护计划服务不可用'), { statusCode: 503 }) },
            async delete() { throw Object.assign(new Error('Redis 维护计划服务不可用'), { statusCode: 503 }) },
          },
        messages: createImMaintenanceSource(core.db).messages,
        isTombstoned: imMemoryMaintenanceSource.isTombstoned,
        storage: imMemoryStorage,
        memoryIndex: createAgentImMemoryRagMutationPorts(core),
        compactGroupDaily: imMemoryGroupDailyCompactor,
        onGroupDailyCompactionError() { console.error('群日报压缩超过硬上限，保留未压缩记录') },
      }),
    },
    imMemoryMaintenancePreview: { start: imMemoryMaintenancePreview },
    adminUserBan: { adminUsername: request => request.adminIdentity?.username ?? 'admin', toggle: createAdminUserBanToggle(core.db, userId => publisher.publishAuthStateChanged(userId)) },
    adminEmailPreview: { render: renderEmailPreview },
    smtpProbe: { probe: createSmtpFileProbe(env, resolveConfigOverridePath(env)) },
    adminEmailTest: { send: createAdminEmailFileTest(env, resolveConfigOverridePath(env)) },
    adminEmailPublish: createAdminEmailPublishOperations({
      query: (sql: string, values: unknown[]) => pool.query(sql, values),
      readSettings: () => readSmtpFileSettings(env, resolveConfigOverridePath(env)),
      send: createSmtpTestDelivery(env),
      reportResult(result) {
        console.info(`管理员邮件发布完成 recipients=${result.recipient_count} sent=${result.sent} failed=${result.failed} locales=${JSON.stringify(result.locale_counts)}`)
      },
      recordMetric(metric) { if (recordEmailDelivery) void recordEmailDelivery(metric).catch(() => {}) },
      reportFailure() { console.error('管理员邮件发布任务失败') },
    }),
    adminEmailTranslate: { translate: createAdminEmailTranslator(env, resolveConfigOverridePath(env)) },
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
    secretPromptCancel: { cancel: createSecretPromptCancellation(core.db) },
    adminEmbeddingProbe: { probe: createEmbeddingFileProbe(env, resolveConfigOverridePath(env)) },
    adminMediaProbePreview: { probe: createAdminMediaProbePreview(env) },
    adminLlmPresetTest: { test: createAdminLlmPresetTest({ readDocument: () => readConfigOverride(resolveConfigOverridePath(env)), environment: env }) },
    adminLlmPresetMediaProbe: { probe: createAdminLlmPresetMediaProbe({
      environment: env,
      readDocument: () => readConfigOverride(resolveConfigOverridePath(env)),
      mutate: createLlmStrategyFileMutator(resolveConfigOverridePath(env)),
      invalidate: () => invalidateAllProviderReasoningStates(core.db),
    }) },
    adminLlmCapabilityProbe: { probe: createAdminLlmCapabilityProbe({
      environment: env, readDocument: () => readConfigOverride(resolveConfigOverridePath(env)),
      mutate: createLlmStrategyFileMutator(resolveConfigOverridePath(env)),
      invalidate: () => invalidateAllProviderReasoningStates(core.db),
    }) },
    adminEmbeddingRebuildStatus: { available: () => Boolean(config.redisUrl), read: createAdminEmbeddingRebuildStatusReader(() => createRedisValueReader(config.redisUrl ?? '')('emb:rebuild')) },
    adminEmbeddingRebuild: {
      state: { available: () => Boolean(config.redisUrl) },
      canStart: canRebuildAgentMemoryIndex,
      runtime: adminEmbeddingRebuildRuntime,
    },
    adminIndexRebuild: {
      available: () => Boolean(config.redisUrl),
      canStart: canRebuildAgentMemoryIndex,
      runtime: adminIndexRebuildRuntime,
    },
    safeEgressUpdate: { update: createSafeEgressFileUpdater(env, resolveConfigOverridePath(env), config.secretKey) },
    safeEgressProbe: { probe: createSafeEgressFileProbe(env, resolveConfigOverridePath(env), config.secretKey) },
    sandboxEgress: {
      updateProxy: createSandboxEgressConfigUpdater(config.configOverridePath ?? resolveConfigOverridePath(env)),
      readSettings: readTerminalSettings,
      readiness: readBubblewrapReadiness,
    },
    sandboxStatus: {
      readSettings: readTerminalSettings,
      readiness: readBubblewrapReadiness,
    },
    sandboxEnable: {
      updateEnabled: enabled => updateSandboxRuntime(enabled),
      publishTerminalRefresh,
      readSettings: readTerminalSettings,
      readiness: readBubblewrapReadiness,
    },
    sandboxDisable: {
      updateDisabled: () => updateSandboxRuntime(false),
      publishTerminalRefresh,
      readSettings: readTerminalSettings,
      readiness: readBubblewrapReadiness,
    },
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
    adminUserDelete: {
      deleteUser: createPostgresAdminAccountDeleter(pool, accountDeleter),
      adminUsername: request => request.adminIdentity?.username ?? 'admin',
      async writeAuditLog(username, action, description, request) {
        const forwarded=request.headers['x-forwarded-for']
        const ip=typeof forwarded==='string'?forwarded.split(',',1)[0]?.trim().slice(0,60)||null:request.ip.slice(0,60)||null
        await pool.query('INSERT INTO audit_logs (username, action, description, ip, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',[username,action,description,ip])
      },
    },
    adminAgentUsage: {
      query: (sql, params) => pool.query(sql, params),
    },
    adminUserStatus: {
      store: createPostgresAdminUserStatusStore(work => withPostgresTransaction(pool, client => work(async (sql, values) => client.query(sql, values)))),
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
    adminDebugLogs: resolveAdminDebugLogFiles(config.logFile),
    adminSecurityEvents: {
      read: createAdminSecurityEventReader(core.db, createSecurityEventFingerprint(config.secretKey)),
    },
    adminUserSecurityEvents: {
      read: createAdminUserSecurityEventReader(core.db),
    },
    createDataExport: createDataExportCreator(work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))), (sql, values) => pool.query(sql, values), { now: () => new Date(), uuid: () => randomUUID() }),
    dataExportPreview: { read: createDataExportPreviewReader(core.db) },
    resumeDataImport: createDataImportResumer(work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))), (sql, values) => pool.query(sql, values), { token: () => randomBytes(32).toString('base64url'), hash: token => createHash('sha256').update(token).digest('hex') }),
    applyDataImport: createDataImportApplier(
      work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))),
      (sql, values) => pool.query(sql, values),
      { verify(token, expectedHash) {
        const actualHash = createHash('sha256').update(token, 'utf8').digest('hex')
        return /^[0-9a-f]{64}$/u.test(expectedHash)
          && timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))
      } },
    ),
    rollbackDataImport: createDataImportRollbackCreator(
      work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))),
      (sql, values) => pool.query(sql, values),
      { uuid: () => randomUUID() },
    ),
    recoverDataImport: createDataImportRecoverer(
      work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))),
      (sql, values) => pool.query(sql, values),
    ),
    dataExportDownload: { secretKey: config.secretKey, download: createDataExportDownloader((sql, values) => pool.query(sql, values), createPortableArtifactOpener(config.storageLocalPath), config.secretKey), requireReady: (owner, job) => requireExportReadyForTicket((sql, values) => pool.query(sql, values), owner, job) },
    cancelDataExport: createDataExportCanceler(work => withPostgresTransaction(pool, client => work((sql, values) => client.query(sql, values))), (sql, values) => pool.query(sql, values)),
    deleteDataExport: createPostgresDataExportDeleter(pool, config.storageLocalPath),
    deleteDataImport: createPostgresDataImportDeleter(pool, config.storageLocalPath),
    cancelDataImport: createPostgresDataImportCanceler(pool),
    cleanupDataImportStaging: createLocalDataImportStagingRemover(config.storageLocalPath),
    preflightDataImport: createDataImportPreflighter(
      createPostgresDataImportPreflightStore(pool),
      createLocalDataImportPreflightStorage(config.storageLocalPath),
      { secretKey: config.secretKey },
    ),
    portabilityJobs: createPortabilityJobReader((sql, values) => pool.query(sql, values)),
    userBotBindingCode: { issue: createPostgresRedisBindingCodeIssuer(pool, config.redisUrl ?? '', config.secretKey) },
    userBotUnbind: { unbind: createPostgresUserBotUnbinder(pool, async ownerId => {
      try { await invalidateOwnerImSnapshots(core.db, ownerId) } catch { /* 与 Python 一致，失效失败不阻止后续资源通知。 */ }
      await publishImChannelsChanged(ownerId)
    }) },
    userBotUpdate: { update: createUserBotUpdater(core.db, {
      encrypt: value => encryptEncryptedString(config.secretKey, value), decrypt: value => decryptEncryptedString(config.secretKey, value),
      publishChanged: publishImChannelsChanged,
    }) },
    userBotDelete: { remove: createUserBotDeleter(core.db, {
      clearReach: createRedisUserBotReachCleaner(config.redisUrl ?? ''),
      publishChanged: publishImChannelsChanged,
    }) },
    wechatConnect: { connect: createWechatConnector(core.db, {
      ...wechatConnectOptions, encrypt: value => encryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)),
      publishChanged: publishImChannelsChanged,
    }) },
    feishuConnect: { connect: createFeishuConnector(core.db, {
      ...feishuConnectOptions, encrypt: value => encryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)),
      publishChanged: publishImChannelsChanged,
    }) },
    qqConnect: { connect: createQqConnector(core.db, {
      ...qqConnectOptions, encrypt: value => encryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)),
      publishChanged: publishImChannelsChanged,
    }) },
    telegramConnect: { connect: createTelegramConnector(core.db, {
      ...telegramConnectOptions, encrypt: value => encryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)), dialect: 'postgres',
      publishChanged: publishImChannelsChanged,
    }) },
    userBotCreate: { create: createQqBotCreator(core.db, {
      encrypt: value => encryptEncryptedString(config.secretKey, value), decrypt: value => decryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)),
      publishChanged: publishImChannelsChanged,
    }) },
    mcpStatus: { read: createMcpStatusReader(() => readMcpSettings().enabled) },
    mcpServerConfig: (() => {
      const crypto = createConfiguredByokEnvelope(env)
      const create = createMcpServerCreator(core.db, {
        maxServersPerUser: () => readMcpSettings().max_servers_per_user,
        id: () => randomUUID(), encrypt: async plaintext => crypto.encrypt(plaintext),
      })
      const mutations = createMcpServerMutations(core.db, { crypto, maxTools: () => readMcpSettings().max_tools_per_server })
      return { operations: {
        list: createMcpServerListReader({ list: createMcpServerConfigLister(core.db), decrypt: crypto, settings: readMcpSettings, runtimeState: (owner, id) => mcpRuntime.state(owner, id) }),
        create: (owner: string, input: Record<string, unknown>) => create(owner, input as unknown as McpServerCreateInput),
        update: (owner: string, id: string, input: Record<string, unknown>) => mutations.update(owner, id, input as McpServerPatch),
        remove: mutations.remove,
      }, invalidate: (owner: string, id: string) => mcpRuntime.invalidate(owner, id) }
    })(),
    mcpRuntime: { runtime: mcpRuntime },
    mcpConnectionTest: { test: createPostgresMcpConnectionTester(core.db, {
      decrypt: createConfiguredByokEnvelope(env),
      transport: () => createNodeProviderTransport({ allowLocal: false, connectTimeoutMs: 5_000, writeTimeoutMs: 10_000, environment: () => env }),
      maxTools: () => readMcpSettings().max_tools_per_server,
      stdioClient: mcpStdioClient,
    }) },
    attentionDefaults: { read: getAttentionDefaults },
    loopScopeProxy: { endpoint: env.LOOPSCOPE_ENDPOINT || defaultLoopScopeEndpoint, transport: loopScopeTransport },
    attachmentDownload: { download: downloadAttachment },
    attachmentUpload: { operations: attachmentUpload },
    attachmentDelete: { remove: createChatAttachmentDraftDeleter(
      createPostgresChatAttachmentDraftDeletePorts(pool, config.storageLocalPath),
    ) },
    attachmentClear: (() => {
      const ports = createPostgresChatAttachmentDraftDeletePorts(pool, config.storageLocalPath)
      const legacy = config.redisUrl ? createRedisLegacyChatAttachmentCleaner(config.redisUrl) : null
      return { clear: createChatAttachmentDraftClearer({
        deleteDraftRows: ports.deleteDraftRows,
        removeUnreferenced: ports.removeUnreferenced,
        async clearLegacy(ownerId, removeStorage) {
          if (!legacy) return 0
          const entries = await legacy.list(ownerId)
          let deleted = 0
          for (const entry of entries) {
            try {
              if (entry.storageKey) await removeStorage(entry.storageKey)
              await legacy.remove(ownerId, entry.id)
              deleted += 1
            } catch { /* Python 按单个旧记录 best-effort 清理，保留其他记录的进度。 */ }
          }
          return deleted
        },
      }) }
    })(),
    terminalDelete: { remove: createTerminalDeletion(core.db, async (ownerId, terminalId, origin) => { await publisher.publishResourceChanged({ ownerId, resource: 'terminals', operation: 'delete', entityId: terminalId, origin }) }) },
    terminalCreate: { create: createPostgresTerminalCreator({
      pool, db: core.db, publisher, readRuntime: readTerminalAccess,
    }) },
    terminalReopen: { reopen: createPostgresTerminalReopener({
      pool, db: core.db, publisher, readRuntime: readTerminalAccess,
    }) },
    terminalLifecycle: createPostgresTerminalLifecycle({ db: core.db, manager: terminalPtyManager, publisher }),
    terminalMetrics: { read: createPostgresTerminalMetricsReader(pool, core.db, readTerminalAccess) },
    terminalList: { read: createPostgresTerminalListReader(pool, core.db, readTerminalAccess) },
    terminalDetail: { read: readTerminalDetail },
    terminalRename: { rename: createPostgresTerminalRenamer(pool, core.db, readTerminalAccess, async (ownerId, terminalId, origin) => {
      await publisher.publishResourceChanged({ ownerId, resource: 'terminals', operation: 'update', entityId: terminalId, origin })
    }) },
    terminalEvents: createPostgresTerminalEventStream(pool, core.db, readTerminalAccess),
    terminalCommand,
    terminalWebsocket: {
      manager: terminalPtyManager,
      runtime: {
        read: async (owner, terminalId) => {
          const value = await readTerminalDetail(owner, terminalId)
          if (!value) throw Object.assign(new Error('终端不存在'), { statusCode: 404 })
          return value
        },
        ...terminalPtyRuntime,
      },
      state: createPostgresTerminalPtyStateOperations({ db: core.db, publisher, authorize: authorizeTerminalPty }),
      accountCheckIntervalMs: 1000,
    },
    userBotsList: { readBots: createPostgresUserBotsReader(pool, config.secretKey, createImPlatformSettingsReader(env, resolveConfigOverridePath(env))) },
    embeddingRebuildStatus: { available: () => Boolean(config.redisUrl), read: createEmbeddingRebuildStatusReader(async ownerId => {
      if (!config.redisUrl) throw Object.assign(new Error('重建状态服务不可用'), { statusCode: 503 })
      return createRedisValueReader(config.redisUrl)(`emb:rebuild:user:${ownerId}`)
    }) },
    embeddingRebuild: {
      state: embeddingRebuildState,
      canStart: canRebuildAgentMemoryIndex,
      start: embeddingRebuildRuntime.start,
    },
    voiceAvailability: createPostgresVoiceAvailabilityReader(pool, {
      enabled: createByokGateReader(resolveConfigOverridePath(env), env),
      readBaseSettings: () => activeVoiceTestSettings(readConfigOverride(resolveConfigOverridePath(env))),
      decrypt: async row => createConfiguredByokEnvelope(env).decrypt({
        ciphertext: row.encrypted_value, nonce: row.nonce,
        encryptedDataKey: row.encrypted_data_key, keyVersion: row.key_version,
      }),
    }),
    clearAgentMemory: { clear: createMemoryClearer({
      invalidateMemoryIndex: ownerId => invalidateAgentMemoryRag(core.db, core.backend, ownerId),
      clearOwner: ownerId => {
        const remove = () => withOwnerMemoryLock(ownerId, () => removeLocalTree(config.storageLocalPath, `${ownerId}/.agent`))
        return im ? im.clearOwner(ownerId, remove) : remove()
      },
      enqueueMemoryRebuild: ownerId => enqueueAgentRagRebuild(core.db, core.backend, ownerId, 'memory'),
      bumpContextRevision: async ownerId => { await publisher.bumpContextRevision(ownerId, 'memory') },
    }) },
    taskFilesystemAuthorization: createTaskFilesystemAuthorization(core.db, { confirmations: filesystemAuthorizationConfirmations, enabled: createTaskAuthorizationEnabledReader(resolveConfigOverridePath(env), env), fingerprint: createSecurityEventFingerprint(config.secretKey), ...(config.redisUrl ? { recordMetric: createRedisFilesystemAuthorizationMetric(config.redisUrl) } : {}) }),
    taskFilesystemRevoke: { revoke: createTaskFilesystemRevoker(core.db, { revokeConfirmation: (owner, summary, identity) => filesystemAuthorizationConfirmations.revoke(owner, summary, identity), fingerprint: createSecurityEventFingerprint(config.secretKey), ...(config.redisUrl ? { recordMetric: createRedisFilesystemRevokeMetric(config.redisUrl) } : {}) }) },
    ...createByokService(core.db, pool, env),
    userSkillDelete: { remove: createUserSkillDeletion(core.db, 'postgres', async ownerId => { await publisher.publishResourceChanged({ ownerId, resource: 'skills', operation: 'refresh' }) }) },
    userSkillList: { list: createUserSkillLister(core.db, 'postgres'), tools: userSkillTools },
    userSkillWrite: { manager: userSkillManager },
    accountDelete: {
      verifyPassword: createPostgresAccountPasswordVerifier(pool),
      remove: accountDeleter,
    },
    notifications: createKyselyNotificationOperations(core.db, 'postgres'),
    track: createTrackOperations(pool),
  })
  app.addHook('onClose', async () => {
    await accountMemoryCleanup?.close()
    try {
      await backgroundWorkers.stop()
    } finally {
      await scheduledRunNow?.drain()
      await agentRunLifecycle?.close()
      await mcpRuntime.close()
      await embeddingRebuildRuntime.close()
      await embeddingTransport.close?.()
      await loopScopeTrace?.close()
      await loopScopeTransport.close?.()
      await Promise.all([
        qqConnectOptions.transport.close(),
        feishuConnectOptions.transport.close(),
        wechatConnectOptions.transport.close(),
      ])
    }
  })
  return { app, loopScopeTrace, agentRunLog, async startWorkers() {
    await agentRunLifecycle?.start()
    await backgroundWorkers.start()
  } }
}
