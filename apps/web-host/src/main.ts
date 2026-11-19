import { timestampConsole } from './shared/logging.js'
import bcrypt from 'bcryptjs'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createProfileUpdater } from '@gugu/core/auth/profile-update'
import { createDataExportCreator } from '@gugu/core/data-portability/create-export'
import { createDataExportPreviewReader } from '@gugu/core/data-portability/export-preview'
import { createDataImportResumer } from '@gugu/core/data-portability/resume-import'
import { createDataImportApplier, createDataImportRecoverer, createDataImportRollbackCreator } from '@gugu/core/data-portability/apply-import'
import { createImMemorySummaryReader } from '@gugu/core/im-memory-summary'
import { createImMaintenanceSource } from '@gugu/core/im-memory-maintenance-source'
import { createAdminUserBanToggle } from './modules/admin/user-management.js'
import { renderEmailPreview } from '@gugu/core/email-preview'
import { createSmtpFileProbe, readSmtpFileSettings } from './modules/admin/smtp.js'
import { createAdminEmailFileTest } from './modules/admin/email.js'
import { createAdminEmailPublishOperations } from './modules/admin/email.js'
import { createAdminEmailTranslator } from './modules/admin/email.js'
import { createLlmStrategySetter, invalidateAllProviderReasoningStates } from '@gugu/core/agent/config/llm-strategy'
import { createLlmPresetSelection } from '@gugu/core/agent/config/llm-preset-selection'
import { createLlmCapabilityOverrideSetter } from '@gugu/core/agent/config/llm-capability-overrides'
import { createLlmPresetMutations } from '@gugu/core/agent/config/llm-preset-mutations'
import { createLlmModelDirectory } from '@gugu/core/agent/config/llm-model-directory'
import { createAdminModelDirectory } from '@gugu/core/agent/config/admin-model-directory'
import { createNodeProviderTransport, createNodeProviderTransportFactory, isPublicAddress } from '@gugu/core/providers/node'
import { defaultLoopScopeEndpoint } from '@gugu/loopscope'
import { validateMcpEndpoint } from '@gugu/core/mcp/server-config'
import type { ProviderConfig } from '@gugu/core/providers'
import { createLlmStrategyFileMutator } from './modules/admin/llm-strategy.js'
import { createAdminMisreadReader } from '@gugu/core/perception-recent-misread'
import { createPerceptionEventExporter } from '@gugu/core/perception-export'
import { createMisreadMarkdownExporter } from '@gugu/core/perception-misread-export'
import { createLocalMisreadTextReader } from './modules/admin/perception.js'
import { createPerceptionStatsReader } from '@gugu/core/perception-stats'
import { createSecretPromptCancellation } from '@gugu/core/agent-secret-cancel'
import { createRedisHashReader } from './adapters/cache/redis-events.js'
import { createRedisListReader } from './adapters/cache/redis-events.js'
import { createAdminEmbeddingRebuildStatusReader } from './modules/admin/embedding.js'
import { createDataExportDownloader, requireExportReadyForTicket } from '@gugu/core/data-portability/download-export'
import { createPortableArtifactOpener } from './modules/data-portability/artifact-source.js'
import { createTaskFilesystemAuthorization } from '@gugu/core/scheduled-task-filesystem-authorize'
import { createTaskAuthorizationEnabledReader } from './modules/scheduled-tasks/task-filesystem-authorize.js'
import { createRedisFilesystemAuthorizationMetric } from './adapters/cache/redis-events.js'
import { createVoicePresetFileMutations } from './modules/admin/voice.js'
import { createDataExportCanceler } from '@gugu/core/data-portability/cancel-export'
import { createPostgresDataExportDeleter } from './modules/data-portability/delete-export-postgres.js'
import { createPostgresDataImportDeleter } from './modules/data-portability/delete-import-postgres.js'
import { createPostgresDataImportCanceler, createLocalDataImportStagingRemover } from './modules/data-portability/cancel-import-postgres.js'
import { createDataImportPreflighter } from '@gugu/core/data-portability/preflight-import'
import { createPostgresDataImportPreflightStore, createLocalDataImportPreflightStorage } from './modules/data-portability/preflight-import-postgres.js'
import { createPostgresDataReplacementWriteGate } from './modules/data-portability/write-gate-postgres.js'
import { withPostgresTransaction } from './adapters/database/postgres-transaction.js'
import { createTerminalDeletion } from '@gugu/core/terminals/delete'
import { createPostgresTerminalCreator } from './modules/terminals/create-operation.js'
import { createPostgresTerminalReopener } from './modules/terminals/reopen-operation.js'
import { createTerminalPtyManager } from './modules/terminals/pty-manager.js'
import { createTerminalPtyRuntime } from './modules/terminals/pty-runtime.js'
import { createTerminalInputAuthorizer } from './modules/terminals/input-authorization.js'
import { createTerminalShellSnapshotReader } from './modules/terminals/shell-snapshot.js'
import { createTerminalWorkspaceMounts } from './modules/terminals/workspace-mounts.js'
import { createBubblewrapPtyBridge } from '@gugu/sandbox/linux/pty'
import { createPostgresTerminalPtyStateOperations } from './modules/terminals/pty-state-operation.js'
import { createPostgresTerminalLifecycle } from './modules/terminals/lifecycle-operation.js'
import { createTerminalRuntime } from './modules/terminals/runtime.js'
import { createTerminalAccessReader, createTerminalRuntimeSettingsReader } from './modules/terminals/runtime-settings.js'
import { createIsolatedShellReadiness, resolveBubblewrapRootfs } from './modules/terminals/isolated-shell-readiness.js'
import { createTerminalCancellationMarkers } from './modules/terminals/cancellation-redis.js'
import { createTerminalActiveLease } from './modules/terminals/active-lease.js'
import { createPostgresTerminalMetricsReader } from './modules/terminals/persistence/metrics.js'
import { createPostgresTerminalListReader } from './modules/terminals/persistence/list.js'
import { createPostgresTerminalDetailReader } from './modules/terminals/persistence/detail.js'
import { createPostgresTerminalRenamer } from './modules/terminals/persistence/rename.js'
import { createPostgresTerminalEventStream } from './modules/terminals/persistence/events.js'
import { createVoicePresetsFileReader } from './modules/admin/voice.js'
import { createAdminLlmPresetReader } from './modules/admin/llm.js'
import { createPostgresVoiceAvailabilityReader } from './modules/agent/voice-availability.js'
import { createMemoryClearer } from '@gugu/core/agent/memory-clear'
import { AgentRunError, stableJson } from '@gugu/core/agent'
import { embedRagQuery, enqueueAgentRagRebuild, invalidateAgentMemoryRag, readAgentRagRebuildProgress, createSqlRagPersistentIndexReader } from '@gugu/core/agent/rag'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { createUserMemoryVectorRebuilder } from '@gugu/core/byok/vector-rebuild'
import { activeVoiceTestSettings } from '@gugu/core/agent/config/voice-test'
import { createAdminVoicePresetTestOperations, createAdminVoiceTestOperations } from './modules/admin/voice.js'
import { createAdminSearchTestOperations } from './modules/admin/search.js'
import { createAdminMaintenanceStatus } from '@gugu/core/maintenance/admin-status'
import { createAccountMemoryCleanupRuntime } from './modules/admin/memory-cleanup.js'
import { createAccountMemoryCleanupStorage, createAccountMemoryCleanupVectorRefresh } from './modules/admin/memory-store.js'
import { createRedisAdminMaintenanceCommands } from './adapters/cache/redis-events.js'
import { createServiceStatusReader } from './modules/admin/runtime.js'
import { resolveAdminUpdateMode } from './modules/admin/runtime.js'
import { createServiceRestarter } from './modules/admin/runtime.js'
import { createBackgroundWorkerLifecycle } from './maintenance/background-workers.js'
import { createRedisServiceStatusCommands } from './adapters/cache/redis-events.js'
import { createAttachmentDownloader } from '@gugu/core/agent/attachments/download'
import { createChatAttachmentDraftDeleter } from '@gugu/core/agent/attachments/delete-draft'
import { createChatAttachmentDraftClearer } from '@gugu/core/agent/attachments/clear-drafts'
import { createPostgresAgentAttachmentUploadOperations, createPostgresChatAttachmentDraftDeletePorts } from './modules/agent/attachment-staging-postgres.js'
import { createRedisLegacyChatAttachmentCleaner } from './adapters/cache/redis-events.js'
import { openLocalFile, removeLocalTree, UnsafeLocalPathError } from '@gugu/fs/node'
import { createPostgresRedisBindingCodeIssuer } from './modules/im/binding-code.js'
import { createTaskFilesystemRevoker } from '@gugu/core/scheduled-task-filesystem-revoke'
import { createPostgresTaskWrites, type TaskWriteOptions } from './modules/scheduled-tasks/persistence/task-writes-postgres.js'
import { createPostgresTaskResolver } from './modules/scheduled-tasks/persistence/task-resolver-postgres.js'
import { createPostgresTaskExternal } from './modules/scheduled-tasks/persistence/task-external-postgres.js'
import { validateTaskCron } from './modules/scheduled-tasks/validate-cron.js'
import { createRedisFilesystemRevokeMetric } from './adapters/cache/redis-events.js'
import { createRedisEmailDeliveryMetric } from './adapters/cache/redis-events.js'
import { createRedisStorageQuotaStatusStore } from './modules/admin/storage.js'
import { createManualStorageQuotaReconcile, StorageQuotaReconcileUnavailable } from './modules/admin/storage.js'
import { createPostgresStorageQuotaReconcilePort } from './modules/files/persistence/storage-quota-reconcile-postgres.js'
import { reconcileAllStorageUsers } from './modules/admin/storage.js'
import { createNotificationBroadcaster } from '@gugu/core/notifications/broadcast'
import { createRedisNotificationPublisher } from './adapters/cache/redis-events.js'
import { createMcpStatusReader } from '@gugu/core/mcp/status'
import { createMcpServerCreator } from '@gugu/core/mcp/server-create'
import { createMcpServerMutations } from '@gugu/core/mcp/server-mutations'
import type { McpServerCreateInput } from '@gugu/core/mcp/server-create'
import type { McpServerPatch } from '@gugu/core/mcp/server-mutations'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import { createMcpServerListReader } from './modules/mcp/server-list.js'
import { createPostgresMcpConnectionTester } from './modules/mcp/test-connection.js'
import { createMcpSkillToolDirectory } from './modules/mcp/skill-tool-directory.js'
import { createMcpRuntime } from './modules/mcp/runtime.js'
import { createMcpStdioClientFactory, resolveMcpWorkspaceRoot } from './modules/mcp/stdio-client.js'
import { createProductionGreeting, createRedisGreetingCache } from './modules/agent-sessions/greeting.js'
import { getAttentionDefaults } from '@gugu/core/im/attention/defaults'
import { createMcpSettingsReader } from './modules/mcp/status.js'
import { createEmailRecipientCounter } from './modules/admin/email.js'
import { createEmbeddingRebuildStatusReader } from '@gugu/core/byok/embedding-rebuild-status'
import { createRedisExpiringValueStore, createRedisValueReader } from './adapters/cache/redis-events.js'
import { createImMemoryMaintenanceApplier } from './modules/admin/memory-apply.js'
import { createLocalImMemoryMaintenanceStorage } from './modules/admin/memory-apply.js'
import { createImMemoryMaintenancePreviewStarter, createImMemoryMaintenancePreviewState, createImMemoryMaintenancePreviewWorker } from './modules/admin/memory-preview.js'
import { createStandaloneImMemoryModelCaller } from './modules/admin/memory-preview.js'
import { createImMemoryGroupDailyCompactor } from './modules/admin/memory.js'
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
import { createTelegramConnector } from '@gugu/core/im/telegram-connect'
import { createTelegramConnectHostOptions } from './modules/im/telegram-connect.js'
import { createRedisUserBotReachCleaner } from './adapters/cache/redis-events.js'
import { createRedisAccountAttachmentCleaner } from './adapters/cache/redis-events.js'
import { createPostgresAccountDeleter, createPostgresAccountPasswordVerifier, createPostgresAdminAccountDeleter } from './modules/auth/account-deletion-postgres.js'
import { createPostgresProfileUpdateStore } from './modules/auth/profile-update-postgres.js'
import { encryptEncryptedString, decryptEncryptedString } from './adapters/security/encrypted-string.js'
import { createPortabilityJobReader } from '@gugu/core/data-portability/read-jobs'
import { createPostgresUserBotsReader } from './modules/im/user-bots.js'
import { createImPlatformSettingsReader } from './modules/im/platform-settings.js'
import { createCredentialDeletion } from '@gugu/core/byok/credential-delete'
import { createCredentialPatch } from '@gugu/core/byok/credential-patch'
import { createCredentialModelsPreview } from '@gugu/core/byok/credential-models-preview'
import { createCredentialSavedTest, createCredentialTestPreview } from '@gugu/core/byok/credential-test-preview'
import { createByokMediaCapabilityProbe } from '@gugu/core/byok/media-capability-probe'
import { createCredentialCreator } from '@gugu/core/byok/credential-create'
import { createProviderCapabilityPreview } from '@gugu/core/byok/capabilities-preview'
import { createByokListService, createPostgresByokListReader } from '@gugu/core/agent/config'
import { createConfiguredByokEnvelope, readConfiguredByokMasterKeys } from './adapters/security/byok-envelope.js'
import { createByokGateReader } from './modules/byok/gate.js'
import { createByokModelsPreviewFetcher } from './modules/byok/models-preview.js'
import { createByokMediaCapabilityProbeRunner } from './modules/byok/media-capability-probe.js'
import { createByokCredentialTestProbe } from './modules/byok/credential-test-preview.js'
import { createPostgresAgentEmbeddingSettingsResolver } from './modules/byok/embedding-settings.js'
import { createAgentRagEmbeddingTransport, createAgentRagEmbeddingTransportFactory } from './modules/byok/agent-rag-transport.js'
import { createLocalUserMemoryVectorStore } from './modules/byok/memory-vector-store.js'
import { createOwnerMemoryLock } from './shared/owner-memory-lock.js'
import { createPersistentMemoryIndexRebuilder, waitForMemoryIndexRebuild } from './modules/byok/memory-index-rebuild.js'
import { createRedisUserEmbeddingRebuildState, createUserEmbeddingRebuildRuntime } from './modules/byok/embedding-rebuild.js'
import { createAdminEmbeddingRebuildRuntime } from './modules/admin/embedding.js'
import { createRedisAdminEmbeddingRebuildState } from './modules/admin/embedding.js'
import { createAdminIndexRebuildRuntime } from './modules/admin/index-rebuild.js'
import { createRedisAdminIndexRebuildState } from './modules/admin/index-rebuild.js'
import { createStorageLiveTotals } from './modules/admin/storage.js'
import { createUserSkillDeletion } from '@gugu/core/agent/skills/user-delete'
import { createUserSkillLister } from '@gugu/core/agent/skills/user-list'
import { createUserSkillManager } from '@gugu/core/agent/skills/user-management'
import { createUserSkillReader } from '@gugu/core/agent/skills/user-body'
import { createLocalAgentRememberPort } from './modules/agent-sessions/tools/agent-memory-write.js'
import { createAgentToolRegistry, filterConfiguredWebAgentTools } from './modules/agent-sessions/tools/agent-tool-registry.js'
import { createCapabilityCatalog } from '@gugu/core/agent/capabilities'
import { createAgentSkillRuntimePorts, createBuiltinSkillDefinitions } from '@gugu/core/skills'
import { createSkillMetadataReader } from '@gugu/core/skills'
import { createBundledSkillDocuments } from '@gugu/core/skills/bundled'
import { createSkillToolCatalog } from './modules/skills/tool-catalog.js'
import { createRegisteredUserSkillToolNameReader } from './modules/skills/tool-names.js'
import { createSafeEgressSettingsReader } from './modules/admin/network.js'
import { createSafeEgressFileUpdater } from './modules/admin/network-update.js'
import { createSafeEgressFileProbe } from './modules/admin/network.js'
import { createSandboxEgressConfigUpdater } from './modules/admin/sandbox.js'
import { createSandboxRuntimeUpdater } from './modules/admin/sandbox.js'
import { createEmbeddingFileProbe } from './modules/admin/embedding-probe.js'
import { createAdminMediaProbePreview } from './modules/admin/llm-probe.js'
import { createAdminLlmPresetTest } from './modules/admin/llm-probe.js'
import { createAdminLlmPresetMediaProbe } from './modules/admin/llm-probe.js'
import { createAdminLlmCapabilityProbe } from './modules/admin/llm-probe.js'
import { createSystemLogReader } from './modules/admin/logs.js'
import {
  createAdminAuditLogReader,
  createAdminSecurityEventReader,
  createAdminUserSecurityEventReader,
} from './modules/admin/audit.js'
import { createAdminUserListReader, createAdminUserRiskReader } from './modules/admin/user-management.js'
import { createNotificationAdminHistory } from '@gugu/core/notifications/admin-history'
import { createPostgresAdminSettingsTransaction } from './modules/admin/users.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { createPostgresRuntime, type SqlDataRuntime } from '@gugu/core/data'
import { createPostgresGlobalSearchSources } from '@gugu/core/search/postgres'
import { createAgentWorkspaceQueries, createKyselyAgentWorkspaceReader } from '@gugu/core/workspaces'
import { createAgentTrashListPort, createAgentTrashPurgePort } from './modules/agent-sessions/tools/agent-trash-tool.js'
import { createAgentTrashRestorePort } from './modules/agent-sessions/tools/agent-trash-restore.js'
import { createGlobalSearchOperations, createKyselyDashboardCounter, createKyselyPreferenceDocumentStore, type Fields, type RequestContext } from '@gugu/core'
import { createApp, type WriteRequestMetadata } from './app.js'
import type { FastifyRequest } from 'fastify'
import type { UserAuthOptions } from './modules/auth/contracts.js'
import { loadConfig, type WebUiConfig } from './config.js'
import { readConfigOverride, resolveConfigOverridePath } from './adapters/config/config-override-file.js'
import { checkDatabaseReadiness } from './database.js'
import { createUserRepository } from './modules/auth/persistence/users.js'
import { createRedisLiveSubscription } from './adapters/cache/redis-live-subscription.js'
import { createPostgresUserQuotaReader, type UserQuotaSettings } from './modules/auth/persistence/quota.js'
import { createPostgresUserAvatarOperations } from './modules/auth/persistence/avatar.js'
import { createPostgresPreferencesStore } from './modules/preferences/persistence/postgres.js'
import { createKyselyOnboardingStore, createOnboardingReseeder, createRegistrationSeeder } from '@gugu/core/onboarding'
import { createPostgresRegistrationSeedOperations } from './modules/onboarding/persistence/registration-seed-postgres.js'
import { createPostgresOnboardingReseedOperations } from './modules/onboarding/persistence/reseed-postgres.js'
import { createOnboardingSurpriseMp3Reader } from './modules/onboarding/surprise-asset.js'
import { createRedisRegistrationCodeStore } from './modules/auth/persistence/registration-codes.js'
import { createPostgresRegistrationOperations } from './modules/auth/persistence/registration.js'
import { createPostgresPasswordResetStore } from './modules/auth/password-reset.js'
import { createPostgresEmailChangeStore } from './modules/auth/email-change.js'
import { createAuthEmailSender, createSmtpTransport } from './adapters/email/smtp-email.js'
import { createProjectFileCountListing, createProjectGetter, createProjectListing } from './modules/projects/persistence/projects.js'
import { projectResponse } from '@gugu/core'
import { createClientOperations } from './modules/clients/persistence/clients.js'
import { createPostgresMindReferenceSuggestionPorts } from './modules/mind/ref-suggest-postgres.js'
import { createMindCanvasNoteMutations } from '@gugu/core/mind'
import { createMindRefNodeCreator, createMindReferenceSuggester } from '@gugu/core/mind'
import { createMindNoteCreator } from '@gugu/core/mind'
import { createAgentMindReader, createAgentPlaceableSearch, createMindCanvasCreation, createMindCanvasUpdate, createMindCanvasDelete, createMindCanvasItemAdd, createMindCanvasItemRemove, createMindCanvasItemUpdate, createMindCanvasRelationCreate, createMindCanvasRelationDelete, createMindGlobalRelationDelete, createSqlMindCanvasCreateRuntime, createSqlMindCanvasUpdateRuntime, createSqlMindCanvasDeleteRuntime, createSqlMindCanvasNoteRuntime, createSqlMindCanvasItemAddRuntime, createSqlMindCanvasItemRemoveRuntime, createSqlMindCanvasItemUpdateRuntime, createSqlMindCanvasRelationCreateRuntime, createSqlMindCanvasRelationDeleteRuntime, createSqlMindGlobalRelationDeleteRuntime, createSqlMindRefNodeCreateRuntime, createSqlMindCanvasReader, createSqlMindNoteReader, createSqlMindNoteInserter, createSqlMindNoteMutator } from '@gugu/core/mind'
import { createKnowledgeDeleteTool, createProjectDeleteTool, createCanvasCreationPort, createClientDeletePort, createNoteWritePort, createSkillDeleteTool, createSkillManagementWriteTools, createMcpManagementTool, createMcpManagementCreateOperations, createMcpManagementRemoveOperations, createMcpManagementEditOperations, createScheduledTaskDeleteTool, createDurableProjectMutationPort, createWebLinkButtonDeliveryPort, createWorkspaceMutationPort, createWorkspaceUnlinkTool, createWorkspaceDirectoryDeleteTool, createUndoLastActionTool, createPermanentDeleteTool } from '@gugu/core/tools'
import { createMindNoteMutations } from '@gugu/core/mind'
import { createHostCoreUndoOperations } from './modules/undo/persistence/core-operations.js'
import { createLocalFileUndoStorage } from './modules/files/undo-storage.js'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { createScheduledTaskDeleter } from '@gugu/core/scheduled-task-delete'
import { createKyselyScheduledTaskDeleteRuntime } from '@gugu/core/scheduled-task-delete-data'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '@gugu/core/scheduled-task-list'
import { createScheduledTaskDeliveryTargets } from './modules/scheduled-tasks/delivery-targets.js'
import { createScheduledTaskTestNotifier } from '@gugu/core/scheduled-task-test-notify'
import { createPostgresScheduledTaskResultDelivery, createPostgresScheduledTaskTestDelivery } from './modules/scheduled-tasks/test-notify-postgres.js'
import { createScheduledImPushHistory } from './modules/scheduled-tasks/im-push-history.js'
import { createScheduledTaskContextLoader, scheduledTaskSupportsFileDelivery } from '@gugu/core/scheduled-task-run-now'
import { createWebScheduledTaskAgentAttempt } from './modules/scheduled-tasks/agent-attempt.js'
import { createWebScheduledTaskContextSources } from './modules/scheduled-tasks/agent-context.js'
import { createWebScheduledTaskToolResources } from './modules/scheduled-tasks/agent-tools.js'
import { createWebScheduledAttachmentResources } from './modules/scheduled-tasks/send-file.js'
import { createScheduledTaskRunNowRuntime } from './modules/scheduled-tasks/run-now-runtime.js'
import { createScheduledTaskFeishuDelivery } from './modules/scheduled-tasks/feishu-delivery.js'
import { createScheduledTaskWechatDelivery } from './modules/scheduled-tasks/wechat-delivery.js'
import { createScheduledTaskQqDelivery } from './modules/scheduled-tasks/qq-delivery.js'
import { createScheduledTaskTelegramDelivery } from './modules/scheduled-tasks/telegram-delivery.js'
import { createPostgresScheduledTaskTestEmailDelivery, readEmailProfile, smtpSettings } from './modules/scheduled-tasks/test-notify-email.js'
import { sanitizeEmailHtml } from '@gugu/core/email/smtp-test'
import { createSmtpTestDelivery } from './adapters/email/smtp-test-delivery.js'
import { createWebAgentEmailTool } from './modules/agent-sessions/tools/agent-email.js'
import { createKyselyNotificationOperations } from '@gugu/core/notifications'
import { createKyselySmtpStore, createUserSmtpSettings } from '@gugu/core/smtp'
import { encryptEncryptedString as encryptSmtpPassword } from './adapters/security/encrypted-string.js'
import { startSecurityRetentionWorker } from './maintenance/security-retention.js'
import { startProjectDeleteRecoveryWorker } from './modules/projects/project-delete-recovery-worker.js'
import { createPostgresProjectDeleteJournal, hasProjectDeleteJournalSchema } from './modules/undo/persistence/project-journal.js'
import { createLocalProjectUndoJournalStorage } from './modules/undo/persistence/project-journal-local.js'
import { checkRagIndexMigration, RagIndexMigrationError } from './migrations/rag-index-migrate.js'
import { checkTrashPurgeMigration } from './migrations/trash-purge-migrate.js'
import { checkSearchUsageMigration } from './migrations/search-usage-migrate.js'
import { startAgentRagIndexWorker } from './modules/agent-sessions/rag-rebuild.js'
import { startRagIndexWorker } from './modules/agent-sessions/rag-index-worker.js'
import { createOwnerReflectionExtractor } from './modules/agent-sessions/persistence/agent-owner-reflection-model.js'
import { createReflectionModelScope } from './modules/agent/model-config/recoverable-provider.js'
import { authorizeOwnerReflectionWrite, createPostgresOwnerReflectionSource } from './modules/agent-sessions/persistence/agent-owner-reflection-source.js'
import { createOwnerReflectionWork } from './modules/agent-sessions/persistence/agent-owner-reflection-work.js'
import { createLocalOwnerReflectionWriter } from './modules/agent-sessions/persistence/agent-owner-reflection-write.js'
import { createRedisAgentReflectionInbox } from './modules/agent-sessions/persistence/agent-reflection-queue-redis.js'
import { createLocalAgentKnowledgeReadStore } from './modules/agent-sessions/tools/agent-rag-knowledge-store.js'
import { createWebOwnerAgentKnowledgeReadPort } from './modules/agent-sessions/tools/agent-knowledge.js'
import { createAgentKnowledgeOverviewLoader } from './modules/agent-sessions/tools/agent-knowledge.js'
import { createLocalAgentKnowledgeDeletePort, createLocalAgentKnowledgeWritePort } from './modules/agent-sessions/tools/agent-knowledge-write.js'
import { createAgentImChannelLoader } from './modules/agent-sessions/context/agent-im-channels.js'
import { createLocalPreferenceTextFiles } from './modules/preferences/persistence/personality-files.js'
import { createWebCurrentMessageMaterializer } from './modules/agent-sessions/context/agent-current-message.js'
import { formatAgentHistoryMessageTime } from './modules/agent-sessions/context/message-time.js'
import { createWebAgentReconstructor, createWebAgentRagResources, createWebImMemoryLoader } from './modules/agent-sessions/agent-web-reconstructor.js'
import { createWebLoopScopeTrace } from './modules/loopscope/trace.js'
import { createWebAgentPromptReader, readWebAgentImPrompt, webAgentPromptRoot } from './modules/agent-sessions/context/agent-prompt-files.js'
import { createWebAgentMcpProductionPorts } from './modules/agent-sessions/tools/agent-mcp-production-ports.js'
import { createWebAgentRunLifecycle } from './modules/agent-sessions/agent-web-run-lifecycle.js'
import { createConfiguredWebAgentProviderBinding } from './modules/agent/model-config/configured-web-provider-binding.js'
import { createWebAgentSearchPorts } from './modules/agent-sessions/tools/agent-search.js'
import { createWebAgentCalendarWritePorts } from './modules/agent-sessions/tools/agent-calendar-write-ports.js'
import { createWebAgentCanvasMutationPorts, createWebAgentCanvasWritePorts } from './modules/agent-sessions/tools/agent-canvas-write-ports.js'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from './modules/agent-sessions/tools/agent-confirmation.js'
import { createWebAgentShell } from './modules/agent-sessions/tools/agent-shell.js'
import { createAgentShellSnapshotReader } from './modules/agent-sessions/tools/agent-shell-snapshot.js'
import { createWebAgentScheduledTaskWrites } from './modules/agent-sessions/tools/agent-scheduled-task-writes.js'
import { createPostgresTrustedIntentStore } from './modules/agent-sessions/persistence/agent-trusted-intent-postgres.js'
import { createTrustedPromptDescriptions } from './modules/agent-sessions/persistence/agent-trusted-prompt-descriptions.js'
import { createAgentInteractionDescription } from '@gugu/core/agent'
import { createPostgresInteractionProjection } from './modules/agent-sessions/persistence/agent-interaction-projection-postgres.js'
import { createAgentInteractionRespondService } from './modules/agent-sessions/agent-interaction-respond.js'
import { createRedisProviderContinuationStore } from './modules/agent-sessions/persistence/agent-provider-continuation-redis.js'
import { createPostgresAgentInteractionCommandEffects } from './modules/agent-sessions/persistence/agent-interaction-command-effects.js'
import { createAgentSecretInteractionService } from './modules/agent-sessions/agent-secret-interaction-route.js'
import { createInteractionResumeEnqueuer } from './modules/agent-sessions/persistence/agent-interaction-resume-postgres.js'
import { createPostgresSecretInteraction } from './modules/agent-sessions/persistence/agent-secret-interaction-postgres.js'
import { createPostgresAgentRunStore } from './modules/agent-sessions/persistence/agent-run-store-postgres.js'
import { createPostgresAgentActiveStatusReader, createPostgresAgentDispatch } from './modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createAgentConversationReadPort } from './modules/agent-sessions/tools/agent-conversations.js'
import { createWebAgentFileReadPort } from './modules/agent-sessions/tools/agent-file-read.js'
import { createWebAgentFilePresentPort } from './modules/agent-sessions/tools/agent-file-present.js'
import { createWebAgentFileGrepPort } from './modules/agent-sessions/tools/agent-file-grep.js'
import { createWebAgentFileEditPort } from './modules/agent-sessions/tools/agent-file-edit.js'
import { createWebAgentFileRenamePort } from './modules/agent-sessions/tools/agent-file-rename.js'
import { createWebAgentFileCopyPort } from './modules/agent-sessions/tools/agent-file-copy.js'
import { createWebAgentFileArchivePort } from './modules/agent-sessions/tools/agent-file-archive.js'
import { createWebAgentFileCreatePort } from './modules/agent-sessions/tools/agent-file-create.js'
import { createWebAgentSaveUploadedFilePort } from './modules/agent-sessions/tools/agent-file-save-attachment.js'
import { createWebAgentRecentAttachmentsPort } from './modules/agent-sessions/tools/agent-file-recent-attachments.js'
import { createWebAgentFolderCreatePort, createWebAgentFolderRenamePort, createWebAgentMoveItemsPort } from './modules/agent-sessions/tools/agent-file-writes.js'
import { createWebAgentFileDirectoryPort } from './modules/agent-sessions/tools/agent-file-directory.js'
import { createWebAgentFileDeletePort, createWebAgentFileFolderDeletePort } from './modules/agent-sessions/tools/agent-file-folder-delete.js'
import { createProjectFileOverviewPort } from './modules/agent-sessions/tools/project-file-overview-port.js'
import { projectAgentRunEvent } from './modules/agent-sessions/agent-run-events.js'
import { createTrackOperations } from './modules/site/persistence/track.js'
import { createFeedbackNotifier, createFeedbackService, createFeedbackSubmission, createKyselyFeedbackOperations } from '@gugu/core/feedback'
import { runBestEffort } from './shared/best-effort.js'
import { revokeUserSessions } from './modules/auth/persistence/auth-revocation.js'
import { createKyselyProjectCreateRuntime } from '@gugu/core/project-create-data'
import { createProjectCreator } from '@gugu/core/project-create'
import { createPostgresProjectUpdateRuntime } from './modules/projects/persistence/project-update-postgres.js'
import { createLocalProjectDirectoryRenamer } from './modules/projects/persistence/project-directory-storage.js'
import { createProjectUpdater } from '@gugu/core/project-update'
import { createProjectTrashService } from '@gugu/core/project-trash'
import { createBorrowedPostgresProjectTrashTransaction, createPostgresProjectTrashRuntime } from './modules/projects/persistence/project-trash-postgres.js'
import {
  createLocalProjectTrashStorage,
  createProjectTrashOriginalStorageKeyResolver,
} from './modules/projects/persistence/project-trash-storage.js'
import { createPostgresProjectTrashPathMetadataReader } from './modules/projects/persistence/project-trash-path-metadata-postgres.js'
import { createProjectPostCommitPublisher } from './modules/projects/persistence/project-post-commit-postgres.js'
import { createCalendarEvent } from '@gugu/core/calendar'
import { createCalendarEventPostCommitPublisher } from './modules/calendar/persistence/calendar-create-post-commit-postgres.js'
import { createCalendarEventReader, createKyselyCalendarReadPort, createKyselyCalendarCreateStore, createKyselyCalendarMutationStores } from '@gugu/core/calendar'
import { deleteCalendarEvent } from '@gugu/core/calendar'
import { createCalendarMutationPostCommitPublisher } from './modules/calendar/persistence/calendar-mutation-post-commit-postgres.js'
import { updateCalendarEvent } from '@gugu/core/calendar'
import { createPostgresWorkspaceCreator } from './modules/workspaces/persistence/workspace-create.js'
import { createPostgresWorkspaceUpdater } from './modules/workspaces/persistence/workspace-update.js'
import { createPostgresWorkspaceBindingOperations } from './modules/workspaces/persistence/workspace-bindings.js'
import { createPostgresWorkspaceLister } from './modules/workspaces/persistence/workspace-list.js'
import { createPostgresWorkspaceDeleter } from './modules/workspaces/persistence/workspace-delete.js'
import { createPostgresWorkspaceDirectoryOperations } from './modules/workspaces/persistence/workspace-directories.js'
import { createWebAgentWorkspaceCreatePort } from './modules/agent-sessions/tools/agent-workspace-create.js'
import { createWebAgentWorkspaceDirectoryDeletePort } from './modules/agent-sessions/tools/agent-workspace-directory-delete.js'
import { createWebAgentAskUserAuthorization } from './modules/agent-sessions/tools/agent-ask-user-authorization.js'
import { createWebAgentUndoLastActionPort } from './modules/agent-sessions/tools/agent-undo-last-action.js'
import { createAgentSessionLister } from './modules/agent-sessions/agent-sessions.js'
import {
  createAgentSessionFilesystemAuthorization,
  unavailableFilesystemAuthorizationConfirmations,
} from './modules/agent-sessions/agent-filesystem-authorization.js'
import { createFilesystemAuthorizationConfirmationStore } from './modules/agent-sessions/filesystem-authorization-confirmations.js'
import { createPostgresAgentSessionRefresher } from './modules/agent-sessions/agent-session-refresh.js'
import { createPostgresAgentSessionRenamer } from './modules/agent-sessions/agent-session-rename.js'
import { createPostgresAgentSessionDeleteOperations } from './modules/agent/session-delete.js'
import { createAgentMessageHistory } from './modules/agent-sessions/persistence/agent-message-history.js'
import { createPostgresAgentOrphanRecovery } from './modules/agent-sessions/persistence/agent-run-recovery.js'
import { createAgentImMemoryRagMutationPorts } from './modules/agent-sessions/persistence/agent-im-memory-rag-mutations.js'
import { createPostgresAgentSessionStateReader } from './modules/agent-sessions/state.js'
import { createPostgresAgentInteractionHistory } from '@gugu/core/agent-sessions'
import { createInteractionSessionLookup } from './modules/agent-sessions/persistence/agent-interaction-session.js'
import { createPostgresAgentMessageLocator } from './modules/agent-sessions/agent-message-location.js'
import {
  createPostgresAgentImportedDraftQueueReader,
  createPostgresAgentPendingQueueReader,
} from './modules/agent-sessions/agent-pending-queues.js'
import {
  createPostgresAgentPendingQueuePatch,
  createPostgresAgentPendingQueueReplace,
} from './modules/agent-sessions/agent-pending-queue-patch.js'
import { createPostgresAgentPendingQueueClaims } from './modules/agent-sessions/agent-pending-queue-claims.js'
import { createPostgresAgentToolEventDetails } from './modules/agent-sessions/agent-tool-event-details.js'
import { agentCommandMenu } from '@gugu/core/agent/commands/menu'
import { BUILTIN_AGENT_TOOL_STATE_LABELS, createAgentToolLabelPicker, DEFAULT_AGENT_STATE_LABELS } from '@gugu/core/agent-sessions'
import { createAgentStateLabelOverrides } from './modules/agent-sessions/agent-state-label-config.js'
import { createAgentStateLabelOperations } from './modules/admin/llm-strategy.js'
import { createPostgresFileBrowserOperations } from './modules/files/file-browser-postgres.js'
import { createPostgresFileReadOperations } from './modules/files/file-reads-postgres.js'
import { createPostgresXlsxPreviewOperations } from './modules/files/xlsx-preview-postgres.js'
import { extractOfficeText } from '@gugu/core/files/office-text'
import { createPostgresFileUploadOperations } from './modules/files/file-upload-postgres.js'
import { createWebAgentDownloadTool } from './modules/agent-sessions/tools/agent-web-download.js'
import { createPublicAgentEgress } from './adapters/network/safe-egress-proxy.js'
import { createPostgresFileDeleteOperations } from './modules/files/file-delete-postgres.js'
import { createPostgresFileRestoreOperations } from './modules/files/file-restore-postgres.js'
import { createPostgresTrashReadOperations } from './modules/files/persistence/trash-postgres.js'
import { createPostgresTrashMutationOperations } from './modules/files/persistence/trash-mutations-postgres.js'
import { createPostgresTrashPurgeOperations } from './modules/files/persistence/trash-purge-postgres.js'
import { TrashPurgeUnavailableError } from './modules/files/trash.js'
import { startTrashPurgeWorker } from './modules/files/trash-purge-worker.js'
import { createLocalUndoRetentionStorage } from './modules/files/undo-retention-storage.js'
import { startUndoRetentionWorker } from './maintenance/undo-retention.js'
import { startProjectExpiryWorker } from './modules/projects/project-expiry-worker.js'
import { hasProjectExpiryJournalSchema } from './modules/projects/persistence/project-expiry-postgres.js'
import { createPostgresFileContentOperations } from './modules/files/file-content-postgres.js'
import { createPostgresFileUpdateOperations } from './modules/files/file-update-postgres.js'
import { createPostgresFileCopyOperations } from './modules/files/file-copy-postgres.js'
import { createPostgresFileConflictOperations } from './modules/files/file-conflicts-postgres.js'
import { createPostgresFileBatchDownloadOperations } from './modules/files/file-batch-download-postgres.js'
import { createPostgresFileArchiveOperations } from './modules/files/file-archive-postgres.js'
import { createPostgresFolderReadOperations } from './modules/files/folder-reads-postgres.js'
import { capturePostgresFolderPathMirrorDirectoryKeys, createPostgresFolderPathMirrorPlanner } from './modules/files/folder-path-planner.js'
import { createLocalPathMirrorMutation } from './modules/files/local-path-mirror.js'
import { createPostgresFolderWriteOperations, type FolderUndoRecord } from './modules/files/folder-writes-postgres.js'
import { createPostgresFolderCopyOperations } from './modules/files/folder-copy-postgres.js'
import { createPostgresFolderDeleteOperations } from './modules/files/folder-delete-postgres.js'
import { prepareWorkspaceDirectoryAcl } from './adapters/sandbox/workspace-directory-acl.js'
import { createSandboxdWorkspacePtyTerminator } from './adapters/sandbox/sandboxd-pty.js'
import {
  createRedisAdminAuthVersionStore,
  createRedisEventPublisher,
  createRedisRateLimitCommands,
  createRedisRegistrationCodeCommands,
  createRedisPasswordResetCommands,
  createRedisAgentActiveStatusReader,
  createRedisAgentCancellationCommands,
  createRedisAgentRunRecoveryState,
  createRedisAgentSessionReflectionCleaner,
  createRedisScheduledTaskCommands,
  createRedisFilesystemAuthorizationCommands,
  createRedisTrashPurgeNotifier,
  type RedisEventPublisher,
} from './adapters/cache/redis-events.js'
import {
  createInMemoryRateLimitCommands,
  createRedisRateLimiter,
  RateLimitError,
} from './modules/auth/rate-limit.js'
import {
  AdminAuthError,
  createAdminAuthAdapter,
  createInMemoryAdminAuthVersionStore,
} from './modules/admin/auth.js'
import {
  createPostgresAdminStorageSnapshotQuery,
  diskUsageForStorage,
} from './modules/admin/storage.js'
import { createPostgresAdminUserStatusStore } from './modules/admin/user-status.js'
import { resolveAdminDebugLogFiles } from './modules/admin/logs.js'
import { createWebAgentFailureLogger } from './modules/agent-sessions/agent-failure-log.js'
import { createAdminHostGuard } from './http/admin-host-guard.js'
import {
  createSecurityEventFingerprint,
} from './modules/admin/audit.js'

function createPool(config: WebUiConfig, max = config.postgresPoolMax): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max,
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

function objectSetting(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
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

function createAdminPromptOptions(pool: Pool) {
  return {
    root: webAgentPromptRoot,
    adminUsername: (request: FastifyRequest) => request.adminIdentity?.username ?? 'admin',
    async writeAuditLog(username: string, action: 'prompt', description: string, request: FastifyRequest) {
      const forwarded = request.headers['x-forwarded-for']
      const ip = typeof forwarded === 'string' ? forwarded.split(',', 1)[0]?.trim().slice(0, 60) || null : request.ip.slice(0, 60) || null
      await pool.query('INSERT INTO audit_logs (username, action, description, ip, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)', [username, action, description, ip])
    },
  }
}

async function createWebUiApp(
  config: WebUiConfig,
  pool: Pool,
  core: SqlDataRuntime,
  redisEvents?: RedisEventPublisher,
  env: NodeJS.ProcessEnv = process.env,
  canRebuildAgentMemoryIndex: () => boolean = () => false,
  projectJournalPool?: Pool,
  trashPurgeSchemaApplied = false,
  searchUsageSchemaApplied = false,
): Promise<{ app: ReturnType<typeof createApp>; startWorkers(): Promise<void> }> {
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
    listInteractions: createPostgresAgentInteractionHistory(pool),
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
  const terminalPtyRuntime = createTerminalPtyRuntime({
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
        diagnose: () => console.error('gugu-webui terminal command lifecycle failed'),
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
  let scheduledAttempt: ReturnType<typeof createWebScheduledTaskAgentAttempt> | null = null
  let agentRunLifecycle: ReturnType<typeof createWebAgentRunLifecycle> | null = null
  let ownerReflectionWork: ReturnType<typeof createOwnerReflectionWork> | undefined
  let agentInteractionRespond: ReturnType<typeof createAgentInteractionRespondService> | null = null
  let agentSecretInteraction: ReturnType<typeof createAgentSecretInteractionService> | null = null
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
    const makeConfirmation = (lease: import('./modules/agent-sessions/persistence/agent-run-dispatch-postgres.js').AgentDispatchLease, action: string) => {
      if (!trustedIntents) return undefined
      const authorization = createWebAgentConfirmationAuthorization({
        pool, lease, accessVersion: providerBinding.accessVersion,
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
      diagnoseCompactionFailure() { console.error('Web Agent 上下文压缩失败') },
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
          diagnose: () => console.error('Web Agent 反思分支失败'),
        }),
        diagnose: () => console.error('Web Agent 反思批次未完成'),
      })
    }
    const logRunFailure = createWebAgentFailureLogger(config.logFile, createSecurityEventFingerprint(config.secretKey))
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
      diagnose: logRunFailure,
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
            ? scheduledAttachments.toolForRun : undefined })
        return {
          context: { ...baseContext, load: createScheduledTaskContextLoader({
            ...scheduledContext, identity, task, model, prompt, memoryEnabled,
          }) },
          runPreparation: preparation, runtime: { ...runtime, tools }, executor: noUnisolatedExecution,
          provider: {
            transportFactory: createNodeProviderTransportFactory({
              allowLocal: !model.usageConfig.isByok, environment: () => env,
            }),
            diagnose() { console.error('定时任务模型调用失败') },
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
            rootfs: bubblewrapRootfs, mounts: shellMounts, confirmation: shellConfirmation,
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
            pool, lease, accessVersion: providerBinding.accessVersion,
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
          let webDownload: ReturnType<typeof createWebAgentDownloadTool> | undefined
          if (core.receipts) {
            try {
              downloadEgress.assertConfigured()
              webDownload = createWebAgentDownloadTool({ pool, db: core.db, lease, upload: fileUploads, open: downloadEgress.open })
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
            sendFile: scheduledAttachments.toolForRun(() => dispatch.isCurrent(lease)),
            saveUploadedFile: createWebAgentSaveUploadedFilePort({ pool, db: core.db, upload: fileUploads, downloadAttachment, lease }),
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
              writes: scheduledTaskWriteOptions,
              emailAuthorization: scheduledEmailAuthorization,
              filesystemRevocation: {
                revokeConfirmation: (owner, summary, identity) => filesystemAuthorizationConfirmations.revoke(owner, summary, identity),
                fingerprint: createSecurityEventFingerprint(config.secretKey),
              },
              authorize: createWebAgentConfirmationAuthorization({ pool, lease, accessVersion: providerBinding.accessVersion }).authorizeInTransaction,
              accessVersion: lease.input.accessVersion,
              workers: { once: Boolean(scheduledOnceWorker), repeating: Boolean(scheduledRepeatingWorker) },
              async emailAvailable(ownerId, client) {
                const profile = await readEmailProfile(client ?? pool, ownerId)
                if (!profile?.ownerEmail) return false
                return Boolean(smtpSettings(profile, config.smtp, config.secretKey).host)
              },
              imEnabled: platform => scheduledNotifyImPlatforms().includes(platform),
              async publish(ownerId, operation, entityId) {
                await Promise.all([
                  refreshScheduledWorkers(),
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
        diagnose: () => console.error('Web Agent 反思队列不可用'),
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
        provider: { continuationStore: providerContinuationStore, continuationTtlMs: 35 * 60_000, diagnose() { console.error('Web Agent Provider 调用失败') } },
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
        return providerBinding.bindRun(lease.identity, lease.input.locale, checkpoint ? {
          identity: checkpoint.identity, modelIdentity: checkpoint.modelIdentity, accessScopeHash: checkpoint.accessScopeHash,
        } : undefined)
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
    const interactionProjection = createPostgresInteractionProjection(pool)
    agentRunLifecycle = createWebAgentRunLifecycle({
      pool, secretKey: config.secretKey, redisUrl: agentRedisUrl, dispatchTtlSeconds: 7 * 24 * 60 * 60,
      accessVersion: providerBinding.accessVersion,
      reconstruct,
      project: event => projectAgentRunEvent(event, { interaction: event => interactionProjection.interaction(event) }),
      diagnose: code => console.error(`Web Agent ${code}`),
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
      diagnose: () => console.error('Web Agent 交互恢复唤醒失败'),
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
      diagnose: () => console.error('Web Agent 凭据交互恢复唤醒失败'),
    })
  }
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
  const backgroundWorkers = createBackgroundWorkerLifecycle([
    () => startSecurityRetentionWorker({ pool, onError: () => { console.error('安全事件过期清理失败') } }),
    () => trashPurgeSchemaApplied && process.platform === 'linux' ? startTrashPurgeWorker({
      pool, deletes: trashOperations, publisher,
      ...(config.redisUrl ? { subscribe: createRedisLiveSubscription(config.redisUrl) } : {}),
      onError: () => { console.error('回收站清空任务执行失败') },
    }) : null,
    () => startUndoRetentionWorker({
      pool, storage: createLocalUndoRetentionStorage(config.storageLocalPath),
      onError: () => { console.error('撤销操作正文过期清理失败') },
    }),
    () => projectJournalPool ? startProjectDeleteRecoveryWorker({
      pool: projectJournalPool, storageRoot: config.storageLocalPath,
      onError: () => { console.error('项目删除文件日志恢复未完成') },
    }) : null,
    () => projectExpiryWorkerEnabled && projectJournalPool ? startProjectExpiryWorker({
      enabled: true, pool: projectJournalPool, storageRoot: config.storageLocalPath,
      defaultLimitBytes: config.storageDefaultLimitBytes,
      onError: () => { console.error('过期项目清理失败') },
    }) : null,
    () => canRebuildAgentMemoryIndex() ? startAgentRagIndexWorker(core, {
      enabled: true, knowledgeStore: createLocalAgentKnowledgeReadStore(config.storageLocalPath),
      memoryStorageRoot: config.storageLocalPath,
      onError: () => { console.error('Agent RAG 索引重建失败') },
    }) : null,
    () => ownerReflectionWork && canRebuildAgentMemoryIndex() ? startRagIndexWorker({
      enabled: true, work: ownerReflectionWork,
      onError: () => { console.error('Web Agent 反思调度失败') },
    }) : null,
    async () => {
      if (!scheduledRepeatingWorker) return null
      await scheduledRepeatingWorker.start()
      return scheduledRepeatingWorker
    },
    () => {
      if (!scheduledOnceWorker) return null
      scheduledOnceWorker.start()
      return scheduledOnceWorker
    },
  ])
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
    deleteAgentSession: createPostgresAgentSessionDeleteOperations(pool, {
      removeIfUnreferenced: (ownerId, storageKey) => createPostgresChatAttachmentDraftDeletePorts(pool, config.storageLocalPath).removeUnreferenced(ownerId, storageKey),
      clearReflection: config.redisUrl
        ? createRedisAgentSessionReflectionCleaner(config.redisUrl)
        : async () => { throw new Error('Redis 会话反思清理不可用') },
    }),
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
    globalSearch,
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
    telegramConnect: { connect: createTelegramConnector(core.db, {
      ...telegramConnectOptions, encrypt: value => encryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)), dialect: 'postgres',
      publishChanged: ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }),
    }) },
    userBotCreate: { create: createQqBotCreator(core.db, {
      encrypt: value => encryptEncryptedString(config.secretKey, value), decrypt: value => decryptEncryptedString(config.secretKey, value),
      platforms: createImPlatformSettingsReader(env, resolveConfigOverridePath(env)),
      publishChanged: ownerId => publisher.publishResourceChanged({ ownerId, resource: 'im_channels', operation: 'refresh' }),
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
      clearOwner: ownerId => withOwnerMemoryLock(ownerId, () => removeLocalTree(config.storageLocalPath, `${ownerId}/.agent`)),
      enqueueMemoryRebuild: ownerId => enqueueAgentRagRebuild(core.db, core.backend, ownerId, 'memory'),
      bumpContextRevision: async ownerId => { await publisher.bumpContextRevision(ownerId, 'memory') },
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
    credentialTestPreview: { preview: createCredentialTestPreview(core.db, {
      enabled: createByokGateReader(resolveConfigOverridePath(env), env),
      decrypt: async row => createConfiguredByokEnvelope(env).decrypt({ ciphertext: row.encrypted_value, nonce: row.nonce, encryptedDataKey: row.encrypted_data_key, keyVersion: row.key_version }),
      probe: createByokCredentialTestProbe(env),
    }), savedTest: createCredentialSavedTest(core.db, {
      enabled: createByokGateReader(resolveConfigOverridePath(env), env),
      decrypt: async row => createConfiguredByokEnvelope(env).decrypt({ ciphertext: row.encrypted_value, nonce: row.nonce, encryptedDataKey: row.encrypted_data_key, keyVersion: row.key_version }),
      probe: createByokCredentialTestProbe(env),
    }) },
    credentialMediaProbe: { probe: createByokMediaCapabilityProbe(core.db, {
      enabled: createByokGateReader(resolveConfigOverridePath(env), env),
      decrypt: async row => createConfiguredByokEnvelope(env).decrypt({ ciphertext: row.encrypted_value, nonce: row.nonce,
        encryptedDataKey: row.encrypted_data_key, keyVersion: row.key_version }),
      probe: createByokMediaCapabilityProbeRunner(env),
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
  return { app, async startWorkers() {
    await agentRunLifecycle?.start()
    await backgroundWorkers.start()
  } }
}

async function listen(app: ReturnType<typeof createApp>, host: string, port: number): Promise<void> {
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
      adminUpdateMode: resolveAdminUpdateMode(env.GUGU_UPDATE_DEPLOYMENT_MODE),
      adminPrompts: createAdminPromptOptions(pool),
      adminConfig: config.configOverridePath ? { path: config.configOverridePath, env } : undefined,
      adminLlmPresetList: config.configOverridePath ? { read: createAdminLlmPresetReader(config.configOverridePath) } : undefined,
      adminEmailTranslate: config.configOverridePath ? { translate: createAdminEmailTranslator(env, config.configOverridePath) } : undefined,
      adminVoiceTest: { test: createAdminVoiceTestOperations(config.configOverridePath, env) },
      adminVoicePresetTest: createAdminVoicePresetTestOperations(config.configOverridePath, env),
      adminSearchTest: { test: createAdminSearchTestOperations(config.configOverridePath, env) },
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
  let canRebuildAgentMemoryIndex = false
  let trashPurgeSchemaApplied = false
  let searchUsageSchemaApplied = false
  let projectJournalPool: Pool | undefined
  let web: Awaited<ReturnType<typeof createWebUiApp>>
  try {
    try {
      trashPurgeSchemaApplied = await checkTrashPurgeMigration(pool) === 'applied'
    } catch {
      trashPurgeSchemaApplied = false
    }
    try {
      searchUsageSchemaApplied = await checkSearchUsageMigration(pool) === 'applied'
    } catch {
      searchUsageSchemaApplied = false
    }
    // 日志跨事务持有会话锁，使用独立连接池，避免占用本次确认仍需使用的业务连接。
    if (process.platform === 'linux' && core.receipts && await hasProjectDeleteJournalSchema(pool))
      projectJournalPool = createPool(config, 2)
    if (booleanSetting(env.GUGU_WEBUI_PROJECT_EXPIRY_WORKER_ENABLED, undefined, false)
      && (!projectJournalPool || !await hasProjectExpiryJournalSchema(pool)))
      throw new Error('项目过期清理 Worker 需要已迁移的项目日志结构')
    web = await createWebUiApp(config, pool, core, redisEvents, env, () => canRebuildAgentMemoryIndex,
      projectJournalPool, trashPurgeSchemaApplied, searchUsageSchemaApplied)
  } catch (error) {
    await projectJournalPool?.end().catch(() => undefined)
    await core.close().catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw error
  }
  const app = web.app
  let ragIndexMigration: 'pending' | 'applied' | 'unavailable'
  try {
    ragIndexMigration = await checkRagIndexMigration(pool)
  } catch (error) {
    ragIndexMigration = 'unavailable'
    console.error(error instanceof RagIndexMigrationError
      ? `Agent RAG 索引检查不可用（${error.code}），后台重建未启动`
      : 'Agent RAG 索引检查不可用，后台重建未启动')
  }
  canRebuildAgentMemoryIndex = ragIndexMigration === 'applied'
  try {
    await listen(app, config.host, config.port)
    await web.startWorkers()
  } catch (error) {
    await app.close().catch(() => undefined)
    await projectJournalPool?.end().catch(() => undefined)
    await core.close().catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw error
  }

  if (ragIndexMigration === 'pending') console.info('Agent RAG 索引迁移尚未应用，后台重建未启动')
  if (!trashPurgeSchemaApplied || process.platform !== 'linux')
    console.info('回收站清空的 Node 文件后端尚未就绪，清空工具与后台任务未启用')
  if (!searchUsageSchemaApplied)
    console.info('Node 搜索用量迁移尚未应用，深度研究与相似图搜索未启用')
  let closePromise: Promise<void> | undefined
  return {
    app,
    pool,
    close() {
      closePromise ??= (async () => {
        try {
          await app.close()
        } finally {
          await projectJournalPool?.end()
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
  timestampConsole()
  void main().catch(() => {
    console.error('gugu-webui startup failed')
    process.exitCode = 1
  })
}
