import { registerDataExportCreateRoute } from './modules/data-portability/create-export.js'
import { registerDataExportPreviewRoute, type DataExportPreviewOptions } from './modules/data-portability/export-preview.js'
import { registerDataImportResumeRoute } from './modules/data-portability/resume-import.js'
import { registerDataImportApplyRoute } from './modules/data-portability/apply-import.js'
import { registerDataImportRollbackRoute } from './modules/data-portability/rollback-import.js'
import { registerDataImportRecoverRoute } from './modules/data-portability/recover-import.js'
import type { createDataImportRecoverer } from '@gugu/core/data-portability/apply-import'
import type { createDataImportRollbackCreator } from '@gugu/core/data-portability/apply-import'
import type { createDataImportApplier } from '@gugu/core/data-portability/apply-import'
import type { createDataImportResumer } from '@gugu/core/data-portability/resume-import'
import { registerSecretPromptCancelRoute, type SecretPromptCancelOptions } from './modules/agent-sessions/secret-cancel.js'
import { registerUserBotCreateRoute, type UserBotCreateOptions } from './modules/im/user-bot-create.js'
import { registerUserBotDeleteRoute } from './modules/im/user-bot-delete.js'
import { registerUserBotUpdateRoute } from './modules/im/user-bot-update.js'
import { registerQqConnectRoutes, type QqConnectRouteOptions } from './modules/im/qq-connect.js'
import { registerFeishuConnectRoutes, type FeishuConnectRouteOptions } from './modules/im/feishu-connect.js'
import { registerWechatConnectRoutes, type WechatConnectRouteOptions } from './modules/im/wechat-connect.js'
import { registerDataExportBrowserDownloadRoute, registerDataExportDownloadRoutes, type DataExportDownloadOptions } from './modules/data-portability/download-export.js'
import type { createDataExportCreator } from '@gugu/core/data-portability/create-export'
import { registerTaskFilesystemAuthorizationRoutes, type TaskFilesystemAuthorizationOptions } from './modules/scheduled-tasks/task-filesystem-authorize.js'
import { registerVoicePresetMutationRoutes, type VoicePresetMutationOptions } from './modules/admin/voice-presets-mutate.js'
import { registerDataExportCancelRoute } from './modules/data-portability/cancel-export.js'
import type { createDataExportCanceler } from '@gugu/core/data-portability/cancel-export'
import { registerTerminalDeleteRoute, type TerminalDeleteOptions } from './modules/terminals/delete.js'
import { registerVoicePresetsReadRoute, type VoicePresetsReadOptions } from './modules/admin/voice-presets-read.js'
import { registerAdminVoicePresetTestRoute, registerAdminVoiceTestRoute, type AdminVoicePresetTestOptions, type AdminVoiceTestOptions } from './modules/admin/voice-test.js'
import { registerAdminSearchTestRoute, type AdminSearchTestOptions } from './modules/admin/search-test.js'
import { registerAdminMaintenanceStatusRoutes } from './modules/admin/maintenance-status.js'
import type { createAdminMaintenanceStatus } from '@gugu/core/maintenance/admin-status'
import { registerServiceStatusRoute, type createServiceStatusReader } from './modules/admin/service-status.js'
import { registerAttachmentDownloadRoute, type AttachmentDownloadOptions } from './modules/agent/attachments/download.js'
import { registerAttachmentThumbnailRoute } from './modules/agent/attachment-thumbnail.js'
import { registerUserBotBindingCodeRoutes, type UserBotBindingCodeOptions } from './modules/im/binding-code.js'
import { registerLoopScopeProxyRoutes } from './modules/loopscope/proxy.js'
import { registerTaskFilesystemRevokeRoute, type TaskFilesystemRevokeOptions } from './modules/scheduled-tasks/task-filesystem-revoke.js'
import { registerStorageQuotaStatusRoute, type StorageQuotaStatusOptions } from './modules/admin/storage-quota-status.js'
import { registerNotificationBroadcastRoute } from './modules/notifications/routes/broadcast.js'
import type { NotificationBroadcastInput } from '@gugu/core/notifications/broadcast'
import { registerMcpStatusRoute, type McpStatusOptions } from './modules/mcp/status.js'
import { registerAttentionDefaultsRoute, type AttentionDefaultsOptions } from './modules/im/attention-defaults.js'
import { registerEmailRecipientCountRoute } from './modules/admin/email-recipient-count.js'
import { registerEmbeddingRebuildStatusRoute, type EmbeddingRebuildStatusOptions } from './modules/byok/embedding-rebuild-status.js'
import { registerUserBotUnbindRoute, type UserBotUnbindOptions } from './modules/im/user-bot-unbind.js'
import { registerPortabilityJobReadRoutes } from './modules/data-portability/read-jobs.js'
import type { createPortabilityJobReader } from '@gugu/core/data-portability/read-jobs'
import { registerUserBotsListRoute, type UserBotsListOptions } from './modules/im/user-bots.js'
import { registerCredentialDeleteRoute, type CredentialDeleteOptions } from './modules/byok/credential-delete.js'
import { registerCredentialCreateRoute, type CredentialCreateOptions } from './modules/byok/credential-create.js'
import { registerCredentialListRoute, type CredentialListOptions } from './modules/byok/credential-list.js'
import { registerCredentialPatchRoute, type CredentialPatchRouteOptions } from './modules/byok/credential-patch.js'
import { registerCredentialModelsPreviewRoute, type CredentialModelsPreviewOptions } from './modules/byok/models-preview.js'
import { registerCredentialTestPreviewRoute, type CredentialTestPreviewRouteOptions } from './modules/byok/credential-test-preview.js'
import { registerByokMediaCapabilityProbeRoute, type ByokMediaProbeOptions } from './modules/byok/media-capability-probe.js'
import { registerProviderCapabilityPreviewRoute, type ProviderCapabilityPreviewOptions } from './modules/byok/capabilities-preview.js'
import { registerStorageLiveTotalsRoute } from './modules/admin/storage-live-totals.js'
import { registerUserSkillDeleteRoute, type UserSkillDeleteOptions } from './modules/skills/user-delete.js'
import { registerUserSkillListRoute, type UserSkillListOptions } from './modules/agent-skills/user-list.js'
import { registerSafeEgressReadRoute } from './modules/admin/safe-egress-read.js'
import { registerImMemorySummaryRoutes, type ImMemorySummaryOptions } from './modules/admin/im-memory-summary.js'
import { registerAdminUserBanRoute, type AdminUserBanOptions } from './modules/admin/user-ban.js'
import { registerAdminEmailPreviewRoute, type AdminEmailPreviewOptions } from './modules/admin/email-preview.js'
import { registerSmtpProbeRoute } from './modules/admin/smtp-probe.js'
import { registerAdminEmailTestRoute } from './modules/admin/email-test.js'
import { registerLlmStrategyRoute, type LlmStrategyRouteOptions } from './modules/admin/llm-strategy.js'
import { registerLlmPresetSelectionRoutes, type LlmPresetSelectionOptions } from './modules/admin/llm-preset-selection.js'
import { registerLlmCapabilityOverrideRoute, type LlmCapabilityOverrideOptions } from './modules/admin/llm-capability-overrides.js'
import { registerLlmPresetMutationRoutes, type LlmPresetMutationOptions } from './modules/admin/llm-preset-mutations.js'
import { registerModelDirectoryRoutes, type ModelDirectoryRouteOptions } from './modules/admin/llm-model-directory.js'
import { registerAdminRecentMisreadRoute, type AdminRecentMisreadOptions } from './modules/admin/perception-recent-misread.js'
import { registerAdminPerceptionExportRoute, type AdminPerceptionExportOptions } from './modules/admin/perception-export.js'
import { registerAdminMisreadExportRoute, type AdminMisreadExportOptions } from './modules/admin/perception-misread-export.js'
import { registerAdminPerceptionStatsRoute, type AdminPerceptionStatsOptions } from './modules/admin/perception-stats.js'
import { registerAdminOpsSummaryRoute } from './modules/admin/ops-summary.js'
import { registerAdminFileSyncRunReadRoutes, type AdminFileSyncRunReadOptions } from './modules/filesync/admin-run-read.js'
import { registerAdminFileSyncRunCancelRoute, type AdminFileSyncRunCancelOptions } from './modules/filesync/admin-run-cancel.js'
import { registerAdminFileSyncDryRunRoute, type AdminFileSyncDryRunOptions } from './modules/filesync/admin-dry-run.js'
import { registerAdminFileSyncInitializeRoute, type AdminFileSyncInitializeOptions } from './modules/filesync/admin-initialize.js'
import { registerWatcherCapacityRoute } from './modules/filesync/watcher-capacity.js'
import { registerAdminFileSyncEventsRoute, type AdminFileSyncEventsOptions } from './modules/filesync/admin-events.js'
import { registerEmbeddingProbeRoute, type createEmbeddingFileProbe } from './modules/admin/embedding-probe.js'
import { registerAdminEmbeddingRebuildStatusRoute, type AdminEmbeddingRebuildStatusOptions } from './modules/admin/embedding-rebuild-status.js'
import { registerSafeEgressUpdateRoute, type SafeEgressUpdateOptions } from './modules/admin/safe-egress-update.js'
import { registerSafeEgressProbeRoute } from './modules/admin/safe-egress-probe.js'
import type { SafeEgressReadSettings } from '@gugu/core/preferences/safe-egress'
import { registerOnboardingResetGuideRoute } from './modules/onboarding/reset-guide.js'
import { registerSystemLogRoutes, type SystemLogOptions } from './modules/admin/system-logs.js'
import { registerAdminAnalyticsRoutes, type AdminAnalyticsOptions } from './modules/admin/analytics.js'
import { registerAdminAuditLogRoute, type AdminAuditLogOptions } from './modules/admin/audit-log.js'
import { registerAdminUserSettingsRoutes, type AdminUserSettingsOptions } from './modules/admin/user-settings.js'
import { registerNotificationAdminHistoryRoutes, type NotificationAdminHistoryOptions } from './modules/notifications/routes/admin-history.js'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { requestContext } from '@gugu/core'
import type { RequestContext } from '@gugu/core'
import type { WorkspaceBindingOperations } from './domains/workspaces/persistence/workspace-bindings.js'
import type { WorkspaceDirectoryOperations } from './domains/workspaces/workspace-directories.js'
import {
  authenticateUser,
  AuthenticationError,
  type PublicUserRecord,
} from './domains/auth/auth.js'
import type { UserAuthOptions } from './domains/auth/contracts.js'
import { DEFAULT_PUBLIC_SITE_CONFIG, type PublicSiteConfig } from './modules/site/site-config.js'
import { registerStaticFrontend } from './static.js'
import { registerCurrentUserRoute, registerLoginRoute } from './domains/auth/routes/auth.js'
import { registerLogoutRoute } from './domains/auth/routes/auth-logout.js'
import { registerUserRoute, type RegisterUserRouteOptions } from './domains/auth/routes/auth-register.js'
import { registerPreferencesRoutes, type PreferencesStore } from './domains/preferences/preferences.js'
import { registerOnboardingRoutes } from './modules/onboarding/onboarding.js'
import type { OnboardingStore } from '@gugu/core/onboarding'
import {
  registerRegistrationCodeRoute,
  type RegistrationCodeRouteOptions,
} from './domains/auth/routes/auth-registration-code.js'
import { registerProfileRoute, type ProfileRouteOptions } from './domains/auth/routes/auth-profile.js'
import { registerPasswordResetRoutes, type PasswordResetRouteOptions } from './domains/auth/password-reset.js'
import {
  registerEmailChangeUserRoutes,
  registerEmailChangeVerifyRoute,
  type EmailChangeOptions,
} from './domains/auth/email-change.js'
import { registerUserQuotaRoute } from './domains/auth/quota.js'
import { registerLiveRoutes, type LiveStreamOperations } from './modules/live/live.js'
import {
  registerUserAvatarReadRoute,
  registerUserAvatarUploadRoute,
  type UserAvatarOperations,
} from './domains/auth/avatar.js'
import { registerSiteConfigRoute } from './modules/site/routes/site-config.js'
import { installHttpErrorHandler } from './http/errors.js'
import { registerAuthenticatedDomain } from './http/authenticated-domain.js'
import { registerProjectRoutes } from './domains/projects/routes/projects.js'
import { registerClientRoutes } from './modules/clients/routes/clients.js'
import { registerEventRoutes } from './modules/calendar/routes/events.js'
import { registerMindNoteReadRoutes, type MindNoteReadOperations } from './domains/mind/mind-notes-read.js'
import { registerMindCanvasReadRoutes, type MindCanvasReadOperations } from './domains/mind/mind-canvas-read.js'
import { registerMindRefSuggestRoute, type MindRefSuggestOperations } from './domains/mind/mind-ref-suggest.js'
import { registerMindCanvasMutationRoutes, type MindCanvasMutationOptions } from './domains/mind/routes/mind-canvas-mutations.js'
import { registerMindCanvasNoteMutationRoutes, type MindCanvasNoteMutationOptions } from './domains/mind/routes/mind-canvas-note-mutations.js'
import { registerMindCanvasItemMutationRoutes, type MindCanvasItemMutationOptions } from './domains/mind/routes/mind-canvas-item-mutations.js'
import { registerMindCanvasRelationMutationRoutes, type MindCanvasRelationMutationOptions } from './domains/mind/routes/mind-canvas-relation-mutations.js'
import { registerMindRefNodeCreateRoute, type MindRefNodeCreateOptions } from './domains/mind/routes/mind-ref-node-create.js'
import { registerMindNoteCreateRoute, type MindNoteCreateOptions } from './domains/mind/routes/mind-note-create.js'
import { registerMindNoteMutationRoutes, type MindNoteMutationOptions } from './domains/mind/routes/mind-note-mutations.js'
import { registerUndoRoutes, type UndoOperations } from './domains/undo/undo.js'
import { registerScheduledTaskDelete } from './modules/scheduled-tasks/task-delete.js'
import type { createScheduledTaskDeleter } from '@gugu/core/scheduled-task-delete'
import { registerScheduledTaskList, type ScheduledTaskList } from './modules/scheduled-tasks/task-list.js'
import { registerScheduledTaskDeliveryTargets, type createScheduledTaskDeliveryTargets } from './modules/scheduled-tasks/delivery-targets.js'
import { registerScheduledTaskWrites } from './modules/scheduled-tasks/task-write-routes.js'
import type { createPostgresTaskWrites } from './modules/scheduled-tasks/persistence/task-writes-postgres.js'
import { registerNotificationRoutes } from './modules/notifications/routes/notifications.js'
import { registerTrackRoute } from './modules/site/routes/track.js'
import { registerAdminFeedbackRoute, registerFeedbackRoute, type AdminFeedbackOperations } from './modules/feedback/feedback.js'
import { registerWorkspaceRoutes } from './domains/workspaces/routes/workspaces.js'
import { registerWorkspaceDirectoryRoutes } from './domains/workspaces/workspace-directories.js'
import { registerFileBrowserRoutes, type FileBrowserOperations } from './domains/files/browser.js'
import { registerFolderWriteRoutes, type FolderWriteOperations } from './domains/files/folder-writes.js'
import { registerFolderCopyRoute, type FolderCopyOperations } from './modules/files/folder-copy.js'
import { registerFileReadRoutes, type FileReadOperations } from './domains/files/file-reads.js'
import { registerXlsxPreviewRoutes } from './modules/files/xlsx-preview.js'
import { registerFileThumbnailRoute } from './modules/files/thumbnail.js'
import { registerFileDeleteRoutes, type FileDeleteOperations } from './domains/files/file-delete.js'
import { registerFileRestoreRoutes, type FileRestoreOperations } from './domains/files/file-restore.js'
import { registerTrashRoutes, type TrashOperations } from './domains/files/trash.js'
import { registerFileContentRoutes, type FileContentOperations } from './domains/files/file-content.js'
import { registerFileUpdateRoutes, type FileUpdateOperations } from './domains/files/file-update.js'
import { registerFileCopyRoutes, type FileCopyOperations } from './domains/files/file-copy.js'
import { registerFileConflictRoutes, type FileConflictOperations } from './domains/files/file-conflicts.js'
import { registerFileBatchDownloadRoutes, type FileBatchDownloadOperations } from './domains/files/file-batch-download.js'
import { registerFileArchiveRoutes, type FileArchiveOperations } from './domains/files/file-archive.js'
import { registerGlobalSearchRoute } from './modules/search/search.js'
import type { GlobalSearchOperations } from '@gugu/core'
import { registerFolderDownloadRoutes, type FolderDownloadOperations } from './domains/files/folder-download.js'
import {
  installFileUploadSupport,
  registerFileUploadRoutes,
  type FileUploadOperations,
} from './domains/files/file-upload.js'
import { registerFolderReadRoutes, type FolderReadOperations } from './domains/files/folder-reads.js'
import type { AdminAuthAdapter } from './domains/admin/admin-auth.js'
import { registerAdminUsersRoute, type AdminUsersOptions } from './domains/admin/admin-users.js'
import {
  registerAdminUserStatusRoutes,
  type AdminUserStatusRouteOptions,
} from './domains/admin/admin-users.js'
import {
  registerAdminDebugLogRoutes,
  type AdminDebugLogOptions,
} from './domains/admin/admin-debug-logs.js'
import {
  registerAdminStorageSnapshotsRoute,
  type AdminStorageSnapshotOptions,
} from './domains/admin/admin-storage-snapshots.js'
import {
  registerAdminSecurityEventRoutes,
  type AdminSecurityEventOptions,
} from './domains/admin/admin-audit-log.js'
import {
  registerAdminUserSecurityEventRoute,
  type AdminUserSecurityEventOptions,
} from './domains/admin/admin-user-security-events.js'
import { registerAdminUserRiskRoute, type AdminUserRiskOptions } from './domains/admin/admin-user-risk.js'
import { registerAdminAgentUsageRoute, type AgentUsageOptions } from './modules/admin/agent-usage.js'
import { registerAdminConfigRoutes, type AdminConfigOptions } from './domains/admin/admin-config.js'
import { registerAdminLlmPresetRoutes, type AdminLlmPresetOptions } from './domains/admin/admin-llm-presets.js'
import { registerAgentMessageLocationRoute } from './domains/agent-sessions/agent-message-location.js'
import { registerAgentMessageHistoryRoute } from './domains/agent-sessions/agent-message-history-route.js'
import type { AgentMessagePageOptions } from './domains/agent-sessions/persistence/agent-message-history.js'
import { registerAgentInteractionSessionRoute } from './domains/agent-sessions/agent-interaction-session-route.js'
import { registerAgentInteractionRespondRoute, type AgentInteractionRespondService } from './domains/agent-sessions/agent-interaction-respond.js'
import { registerAgentSessionRoute } from './domains/agent-sessions/agent-sessions.js'
import { registerAgentChatRoutes, type AgentChatService } from './domains/agent-sessions/agent-chat-route.js'
import { registerAgentSessionRefreshRoute } from './domains/agent-sessions/agent-session-refresh.js'
import {
  registerAgentImportedDraftQueueRoute,
  registerAgentPendingQueueReadRoute,
  type AgentImportedDraftQueueReadOptions,
  type AgentPendingQueueReadOptions,
} from './domains/agent-sessions/agent-pending-queues.js'
import {
  registerAgentPendingQueueReplaceRoute,
  registerAgentPendingQueuePatchRoute,
  type AgentPendingQueueReplaceRouteOptions,
  type AgentPendingQueuePatchRouteOptions,
} from './domains/agent-sessions/agent-pending-queue-patch.js'
import {
  registerAgentPendingQueueClaimRoutes,
  type AgentPendingQueueClaimRouteOptions,
} from './domains/agent-sessions/agent-pending-queue-claims.js'
import {
  registerAgentSessionRenameRoute,
  type RenamedAgentSession,
} from './domains/agent-sessions/agent-session-rename.js'
import { registerAgentToolEventDetailsRoute } from './domains/agent-sessions/agent-tool-event-details.js'
import { registerAgentMiscRoutes, type AgentMiscRoutesOptions } from './domains/agent-sessions/agent-misc.js'
import {
  registerAgentFilesystemAuthorizationRoutes,
  type AgentFilesystemAuthorizationRouteOptions,
} from './domains/agent-sessions/agent-filesystem-authorization-route.js'

export type { UserAuthOptions } from './domains/auth/contracts.js'

export interface AuthenticatedWebUser extends PublicUserRecord {
  readonly requestContext: RequestContext
}

export type UserFromRequest = (request: FastifyRequest) => AuthenticatedWebUser

export interface WriteRequestMetadata {
  readonly idempotencyKey: string | null
  readonly undoContextId: string | null
  readonly clientId: string | null
}

export interface ClientResponse {
  id: number
  name: string
  contact: string | null
  email: string | null
  phone: string | null
  notes: string
}

export interface ClientCreateInput extends Record<string, unknown> {
  name: string
  contact?: string | null
  email?: string | null
  phone?: string | null
  notes: string
}

export interface ClientOptions {
  list: (ownerId: string) => Promise<ClientResponse[]>
  create: (ownerId: string, input: ClientCreateInput) => Promise<ClientResponse>
  delete: (ownerId: string, clientId: number) => Promise<void>
}

export interface EventOptions {
  list: (ownerId: string, year?: number, month?: number) => Promise<unknown[]>
  get: (ownerId: string, eventId: number) => Promise<unknown | null>
  create?: (context: RequestContext, input: unknown, metadata: WriteRequestMetadata) => Promise<unknown>
  delete?: (context: RequestContext, eventId: number, version: number, metadata: WriteRequestMetadata) => Promise<void>
  update?: (context: RequestContext, eventId: number, body: unknown, metadata: WriteRequestMetadata) => Promise<unknown>
}

export interface NotificationOptions {
  list: (ownerId: string, userCreatedAt: Date | string, limit: number) => Promise<unknown[]>
  latestBubble: (ownerId: string, userCreatedAt: Date | string) => Promise<unknown>
  markRead: (ownerId: string, userCreatedAt: Date | string, ids: number[] | null) => Promise<number>
  clear: (ownerId: string, userCreatedAt: Date | string) => Promise<number>
}

export interface TrackOptions {
  track: (ownerId: string, event: string, properties: Record<string, unknown> | null) => Promise<void>
}

export interface FeedbackOptions {
  submit: (ownerId: string, username: string, category: string, content: string) => Promise<void>
}

export interface WebUiOptions {
  appName: string
  publicSiteConfig?: PublicSiteConfig
  staticRoot?: string
  isReady: () => Promise<boolean>
  onReadinessError?: () => void
  userAuth?: UserAuthOptions
  live?: LiveStreamOperations
  registration?: RegisterUserRouteOptions
  registrationCode?: RegistrationCodeRouteOptions
  passwordReset?: PasswordResetRouteOptions
  emailChange?: EmailChangeOptions
  listProjects?: (ownerId: string, archived: boolean, deleted?: boolean) => Promise<unknown[]>
  listProjectFileCounts?: (ownerId: string) => Promise<unknown[]>
  getProject?: (ownerId: string, projectId: number) => Promise<unknown | null>
  createProject?: (context: RequestContext, input: unknown, metadata: WriteRequestMetadata) => Promise<unknown>
  updateProject?: (
    ownerId: string,
    projectId: number,
    input: unknown,
    metadata: WriteRequestMetadata,
  ) => Promise<unknown>
  deleteProject?: (ownerId: string, projectId: number, metadata: WriteRequestMetadata) => Promise<void>
  restoreProject?: (ownerId: string, projectId: number, metadata: WriteRequestMetadata) => Promise<unknown>
  clients?: ClientOptions
  events?: EventOptions
  mindNotes?: MindNoteReadOperations
  mindCanvasReads?: MindCanvasReadOperations
  mindRefSuggest?: MindRefSuggestOperations
  mindCanvasMutations?: MindCanvasMutationOptions
  mindCanvasNoteMutations?: MindCanvasNoteMutationOptions
  mindCanvasItemMutations?: MindCanvasItemMutationOptions
  mindCanvasRelationMutations?: MindCanvasRelationMutationOptions
  mindRefNodeCreate?: MindRefNodeCreateOptions
  mindNoteCreate?: MindNoteCreateOptions
  mindNoteMutations?: MindNoteMutationOptions
  undo?: UndoOperations
  deleteScheduledTask?: ReturnType<typeof createScheduledTaskDeleter>
  listScheduledTasks?: ScheduledTaskList
  scheduledTaskDeliveryTargets?: ReturnType<typeof createScheduledTaskDeliveryTargets>
  scheduledTaskWrites?: ReturnType<typeof createPostgresTaskWrites>
  notifications?: NotificationOptions
  track?: TrackOptions
  feedback?: FeedbackOptions
  adminFeedback?: AdminFeedbackOperations
  profile?: Omit<ProfileRouteOptions, 'authenticate'>
  userAvatar?: UserAvatarOperations
  preferences?: PreferencesStore
  onboarding?: OnboardingStore
  createWorkspace?: (ownerId: string, input: unknown) => Promise<unknown>
  listWorkspaces?: (ownerId: string) => Promise<unknown>
  workspaceBindings?: WorkspaceBindingOperations
  updateWorkspace?: (ownerId: string, workspaceId: number, input: unknown) => Promise<unknown>
  deleteWorkspace?: (ownerId: string, workspaceId: number) => Promise<unknown>
  workspaceDirectories?: WorkspaceDirectoryOperations
  listAgentSessions?: (ownerId: string) => Promise<unknown[]>
  agentChat?: AgentChatService
  agentInteractionRespond?: AgentInteractionRespondService
  lookupAgentInteractionSession?: (ownerId: string, promptId: number) => Promise<{ session_id: number }>
  refreshAgentSession?: (ownerId: string, sessionId: number) => Promise<{ id: number; context_epoch: number } | null>
  agentPendingQueueReads?: {
    readQueue: AgentPendingQueueReadOptions['readQueue']
    readImportedDrafts: AgentImportedDraftQueueReadOptions['readImportedDrafts']
    nowSeconds?: () => number
  }
  agentPendingQueuePatch?: Omit<AgentPendingQueuePatchRouteOptions, 'requireUser' | 'userIdFromRequest'>
  agentPendingQueueReplace?: Omit<AgentPendingQueueReplaceRouteOptions, 'requireUser' | 'userIdFromRequest'>
  agentPendingQueueClaims?: Omit<AgentPendingQueueClaimRouteOptions, 'requireUser' | 'userIdFromRequest'>
  renameAgentSession?: (ownerId: string, sessionId: number, title: string) => Promise<RenamedAgentSession | null>
  listAgentMessages?: (ownerId: string, sessionId: number, options: AgentMessagePageOptions) => Promise<unknown>
  locateAgentMessage?: (ownerId: string, messageId: number) => Promise<{ id: number; sessionId: number } | null>
  readAgentToolEventDetails?: (
    ownerId: string,
    sessionId: number,
    messageId: number,
    timelineIndex: number,
  ) => Promise<unknown | null>
  agentFilesystemAuthorization?: Omit<AgentFilesystemAuthorizationRouteOptions, 'requireUser' | 'userIdFromRequest'>
  agentMisc?: Omit<AgentMiscRoutesOptions, 'requireUser'>
  fileBrowser?: FileBrowserOperations
  folderWrites?: FolderWriteOperations
  folderCopy?: FolderCopyOperations
  fileReads?: FileReadOperations
  folderReads?: FolderReadOperations
  fileUploads?: FileUploadOperations
  fileDeletes?: FileDeleteOperations
  fileRestores?: FileRestoreOperations
  trash?: TrashOperations
  fileContents?: FileContentOperations
  fileUpdates?: FileUpdateOperations
  fileCopies?: FileCopyOperations
  fileConflicts?: FileConflictOperations
  fileBatchDownloads?: FileBatchDownloadOperations
  fileArchives?: FileArchiveOperations
  globalSearch?: GlobalSearchOperations
  folderDownloads?: FolderDownloadOperations
  adminAuth?: AdminAuthAdapter
  adminConfig?: Omit<AdminConfigOptions, 'requireAdmin'>
  adminVoiceTest?: Omit<AdminVoiceTestOptions, 'requireAdmin'>
  adminVoicePresetTest?: Omit<AdminVoicePresetTestOptions, 'requireAdmin'>
  adminSearchTest?: Omit<AdminSearchTestOptions, 'requireAdmin'>
  adminLlmPresets?: Omit<AdminLlmPresetOptions, 'requireAdmin'>
  adminStorageSnapshots?: Omit<AdminStorageSnapshotOptions, 'requireAdmin'>
  adminUsers?: Omit<AdminUsersOptions, 'requireAdmin'>
  adminUserStatus?: Omit<AdminUserStatusRouteOptions, 'requireAdmin'>
  adminDebugLogs?: Omit<AdminDebugLogOptions, 'requireAdmin' | 'verifyAdmin'>
  adminSecurityEvents?: Omit<AdminSecurityEventOptions, 'requireAdmin'>
  adminUserSecurityEvents?: Omit<AdminUserSecurityEventOptions, 'requireAdmin'>
  adminUserRisk?: Omit<AdminUserRiskOptions, 'requireAdmin'>
  createDataExport?: ReturnType<typeof createDataExportCreator>
  dataExportPreview?: Omit<DataExportPreviewOptions, 'requireUser' | 'ownerIdFromRequest'>
  resumeDataImport?: ReturnType<typeof createDataImportResumer>
  applyDataImport?: ReturnType<typeof createDataImportApplier>
  rollbackDataImport?: ReturnType<typeof createDataImportRollbackCreator>
  recoverDataImport?: ReturnType<typeof createDataImportRecoverer>
  dataExportDownload?: DataExportDownloadOptions
  cancelDataExport?: ReturnType<typeof createDataExportCanceler>
  portabilityJobs?: ReturnType<typeof createPortabilityJobReader>
  userBotBindingCode?: Omit<UserBotBindingCodeOptions, 'requireUser' | 'ownerIdFromRequest'>
  userBotUnbind?: Omit<UserBotUnbindOptions, 'requireUser' | 'ownerIdFromRequest'>
  userBotCreate?: Omit<UserBotCreateOptions, 'requireUser' | 'ownerIdFromRequest'>
  userBotDelete?: Omit<Parameters<typeof registerUserBotDeleteRoute>[1], 'requireUser' | 'ownerIdFromRequest'>
  userBotUpdate?: Omit<Parameters<typeof registerUserBotUpdateRoute>[1], 'requireUser' | 'ownerIdFromRequest'>
  qqConnect?: Omit<QqConnectRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  feishuConnect?: Omit<FeishuConnectRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  wechatConnect?: Omit<WechatConnectRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  mcpStatus?: Omit<McpStatusOptions, 'requireUser'>
  attentionDefaults?: Omit<AttentionDefaultsOptions, 'requireUser'>
  loopScopeProxy?: { endpoint: string }
  attachmentDownload?: Omit<AttachmentDownloadOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalDelete?: Omit<TerminalDeleteOptions, 'requireUser' | 'ownerIdFromRequest'>
  userBotsList?: Omit<UserBotsListOptions, 'requireUser' | 'ownerIdFromRequest'>
  embeddingRebuildStatus?: Omit<EmbeddingRebuildStatusOptions, 'requireUser' | 'ownerIdFromRequest'>
  taskFilesystemAuthorization?: Omit<TaskFilesystemAuthorizationOptions, 'requireUser' | 'ownerIdFromRequest'>
  taskFilesystemRevoke?: Omit<TaskFilesystemRevokeOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialDelete?: Omit<CredentialDeleteOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialCreate?: Omit<CredentialCreateOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialPatch?: Omit<CredentialPatchRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialModelsPreview?: Omit<CredentialModelsPreviewOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialTestPreview?: Omit<CredentialTestPreviewRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialMediaProbe?: Omit<ByokMediaProbeOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialList?: Omit<CredentialListOptions, 'requireUser' | 'ownerIdFromRequest'>
  providerCapabilityPreview?: Omit<ProviderCapabilityPreviewOptions, 'requireUser'>
  userSkillDelete?: Omit<UserSkillDeleteOptions, 'requireUser' | 'ownerIdFromRequest'>
  userSkillList?: Omit<UserSkillListOptions, 'requireUser' | 'ownerIdFromRequest'>
  secretPromptCancel?: Omit<SecretPromptCancelOptions, 'requireUser' | 'ownerIdFromRequest'>
  safeEgressRead?: { readSettings(): SafeEgressReadSettings }
  imMemorySummary?: Omit<ImMemorySummaryOptions, 'requireAdmin'>
  adminUserBan?: Omit<AdminUserBanOptions, 'requireAdmin'>
  adminEmailPreview?: Omit<AdminEmailPreviewOptions, 'requireAdmin'>
  smtpProbe?: Omit<Parameters<typeof registerSmtpProbeRoute>[1], 'requireAdmin'>
  adminEmailTest?: Omit<Parameters<typeof registerAdminEmailTestRoute>[1], 'requireAdmin'>
  llmStrategy?: Omit<LlmStrategyRouteOptions, 'requireAdmin'>
  llmPresetSelection?: Omit<LlmPresetSelectionOptions, 'requireAdmin'>
  llmCapabilityOverrides?: Omit<LlmCapabilityOverrideOptions, 'requireAdmin'>
  llmPresetMutations?: Omit<LlmPresetMutationOptions, 'requireAdmin'>
  modelDirectory?: Omit<ModelDirectoryRouteOptions, 'requireAdmin'>
  adminRecentMisread?: Omit<AdminRecentMisreadOptions, 'requireAdmin'>
  adminPerceptionExport?: Omit<AdminPerceptionExportOptions, 'requireAdmin'>
  adminMisreadExport?: Omit<AdminMisreadExportOptions, 'requireAdmin'>
  adminPerceptionStats?: Omit<AdminPerceptionStatsOptions, 'requireAdmin'>
  adminOpsSummary?: Omit<Parameters<typeof registerAdminOpsSummaryRoute>[1], 'requireAdmin'>
  adminFileSyncRunRead?: Omit<AdminFileSyncRunReadOptions, 'requireAdmin'>
  adminFileSyncRunCancel?: Omit<AdminFileSyncRunCancelOptions, 'requireAdmin'>
  adminFileSyncDryRun?: Omit<AdminFileSyncDryRunOptions, 'requireAdmin'>
  adminFileSyncInitialize?: Omit<AdminFileSyncInitializeOptions, 'requireAdmin'>
  watcherCapacity?: Omit<Parameters<typeof registerWatcherCapacityRoute>[1], 'requireAdmin'>
  adminFileSyncEvents?: Omit<AdminFileSyncEventsOptions, 'requireAdmin'>
  adminEmbeddingProbe?: { probe: ReturnType<typeof createEmbeddingFileProbe> }
  adminEmbeddingRebuildStatus?: Omit<AdminEmbeddingRebuildStatusOptions, 'requireAdmin'>
  safeEgressUpdate?: Omit<SafeEgressUpdateOptions, 'requireAdmin'>
  safeEgressProbe?: Omit<Parameters<typeof registerSafeEgressProbeRoute>[1], 'requireAdmin'>
  emailRecipientCount?: { read(): Promise<{ count: number; locale_counts: Record<string, number> }> }
  storageQuotaStatus?: Omit<StorageQuotaStatusOptions, 'requireAdmin'>
  serviceStatus?: { read: ReturnType<typeof createServiceStatusReader> }
  adminMaintenanceStatus?: { available(): boolean; read: ReturnType<typeof createAdminMaintenanceStatus> }
  storageLiveTotals?: { read(): Promise<{ categories: Record<string, { object_count: number; total_bytes: number }> }> }
  voicePresetsMutate?: Omit<VoicePresetMutationOptions, 'requireAdmin'>
  voicePresetsRead?: Omit<VoicePresetsReadOptions, 'requireAdmin'>
  adminSystemLogs?: Omit<SystemLogOptions, 'requireAdmin'>
  adminAnalytics?: Omit<AdminAnalyticsOptions, 'requireAdmin'>
  adminAuditLog?: Omit<AdminAuditLogOptions, 'requireAdmin'>
  adminUserSettings?: Omit<AdminUserSettingsOptions, 'requireAdmin'>
  notificationBroadcast?: { broadcast(input: NotificationBroadcastInput): Promise<{ ok: true; id: number }> }
  notificationAdminHistory?: Omit<NotificationAdminHistoryOptions, 'requireAdmin'>
  adminAgentUsage?: Omit<AgentUsageOptions, 'requireAdmin'>
}

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: UserAuthOptions,
): Promise<AuthenticatedWebUser | null> {
  try {
    const { identity, user } = await authenticateUser({
      method: request.method,
      authorization: typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : undefined,
      cookie: request.headers.cookie,
      csrfHeader: typeof request.headers['x-csrf-token'] === 'string'
        ? request.headers['x-csrf-token']
        : undefined,
    }, auth.secret, auth.lookupUser)
    await auth.markUserActive?.(user.id)
    return {
      ...user,
      requestContext: requestContext({
        userId: identity.userId,
        securityVersion: identity.securityVersion,
      }),
    }
  } catch (error) {
    if (error instanceof AuthenticationError) {
      reply.code(error.statusCode).send({ detail: error.message })
      return null
    }
    throw error
  }
}

function registerProtectedDomain(
  app: FastifyInstance,
  auth: UserAuthOptions,
  registerRoutes: Parameters<typeof registerAuthenticatedDomain<AuthenticatedWebUser>>[2],
) {
  return registerAuthenticatedDomain<AuthenticatedWebUser>(
    app,
    (request, reply) => authenticateRequest(request, reply, auth),
    registerRoutes,
  )
}

function registerUserRoutes(app: FastifyInstance, options: WebUiOptions) {
  const auth = options.userAuth
  if (options.userAvatar) registerUserAvatarReadRoute(app, options.userAvatar)
  if (options.registrationCode) registerRegistrationCodeRoute(app, options.registrationCode)
  else {
    app.post('/api/v1/auth/registration-code', async (_request, reply) =>
      reply.code(503).send({ detail: '邮箱验证码注册当前不可用' }),
    )
  }
  if (options.registration) registerUserRoute(app, options.registration)
  else {
    // Keep the public route explicit while registration dependencies are not configured.
    // Returning a clear unavailable response is safer than Fastify's misleading 404.
    app.post('/api/v1/auth/register', async (_request, reply) =>
      reply.code(503).send({ detail: '注册服务暂不可用，请稍后重试' }),
    )
  }
  if (options.passwordReset) registerPasswordResetRoutes(app, options.passwordReset)
  else {
    const unavailable = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.code(503).send({ detail: '密码找回邮件当前不可用' })
    app.post('/api/v1/auth/forgot-password', unavailable)
    app.post('/api/v1/auth/reset-password', async (_request, reply) =>
      reply.code(503).send({ detail: '密码重置服务暂不可用' }),
    )
  }
  if (options.emailChange) registerEmailChangeVerifyRoute(app, options.emailChange)
  if (!auth) return
  registerLoginRoute(app, auth)
  registerProtectedDomain(app, auth, (routes, userFromRequest) => {
    registerCurrentUserRoute(routes, userFromRequest)
  })
  if (options.live) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerLiveRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        securityVersionFromRequest: (request) => userFromRequest(request).requestContext.identity.securityVersion,
        operations: options.live!,
      })
    })
  }
  if (options.emailChange) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerEmailChangeUserRoutes(routes, {
        ...options.emailChange!,
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
      })
    })
  }
  if (options.userAvatar) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerUserAvatarUploadRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.userAvatar!,
      })
    })
  }
  if (auth.getQuota) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerUserQuotaRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        get: auth.getQuota!,
      })
    })
  }
  if (auth.revokeUserSessions && auth.publishAuthStateChanged) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerLogoutRoute(routes, {
        async authenticate(request) {
          return { id: userFromRequest(request).id }
        },
        revokeUserSessions: auth.revokeUserSessions!,
        publishAuthStateChanged: auth.publishAuthStateChanged!,
      })
    })
  }
  if (options.profile) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerProfileRoute(routes, {
        ...options.profile!,
        authenticate: async (request) => ({ id: userFromRequest(request).id }),
      })
    })
  }
  if (options.preferences) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerPreferencesRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        userEmailFromRequest: (request) => userFromRequest(request).email,
        store: options.preferences!,
        emailChangeAvailable: options.emailChange?.systemEmailAvailable ?? false,
      })
    })
  }
  if (options.dataExportDownload) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataExportDownloadRoutes(routes, userFromRequest, options.dataExportDownload!))
  }
  if (options.secretPromptCancel) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerSecretPromptCancelRoute(routes, {
      ...options.secretPromptCancel!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.recoverDataImport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportRecoverRoute(routes, userFromRequest, options.recoverDataImport!))
  }
  if (options.rollbackDataImport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportRollbackRoute(routes, userFromRequest, options.rollbackDataImport!))
  }
  if (options.applyDataImport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportApplyRoute(routes, userFromRequest, options.applyDataImport!))
  }
  if (options.resumeDataImport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataImportResumeRoute(routes, userFromRequest, options.resumeDataImport!))
  }
  if (options.dataExportPreview) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataExportPreviewRoute(routes, {
      ...options.dataExportPreview!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.createDataExport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataExportCreateRoute(routes, userFromRequest, options.createDataExport!))
  }
  if (options.cancelDataExport) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataExportCancelRoute(routes, userFromRequest, options.cancelDataExport!))
  }
  if (options.portabilityJobs) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerPortabilityJobReadRoutes(routes, userFromRequest, options.portabilityJobs!))
  }
  if (options.userBotBindingCode) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotBindingCodeRoutes(routes, { ...options.userBotBindingCode!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.wechatConnect) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerWechatConnectRoutes(routes, {
      ...options.wechatConnect!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.feishuConnect) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerFeishuConnectRoutes(routes, {
      ...options.feishuConnect!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.qqConnect) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerQqConnectRoutes(routes, {
      ...options.qqConnect!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.userBotUpdate) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotUpdateRoute(routes, {
      ...options.userBotUpdate!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.userBotDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotDeleteRoute(routes, {
      ...options.userBotDelete!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.userBotCreate) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotCreateRoute(routes, {
      ...options.userBotCreate!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.userBotUnbind) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotUnbindRoute(routes, { ...options.userBotUnbind!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.mcpStatus) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerMcpStatusRoute(routes, { ...options.mcpStatus!, requireUser: async request => { void userFromRequest(request) } }))
  }
  if (options.attentionDefaults) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAttentionDefaultsRoute(routes, { ...options.attentionDefaults!, requireUser: async request => { void userFromRequest(request) } }))
  }
  if (options.loopScopeProxy) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerLoopScopeProxyRoutes(routes, { ...options.loopScopeProxy!, requireUser: async request => { void userFromRequest(request) } }))
  }
  if (options.attachmentDownload) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAttachmentDownloadRoute(routes, { ...options.attachmentDownload!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAttachmentThumbnailRoute(routes, { ...options.attachmentDownload!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.terminalDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTerminalDeleteRoute(routes, { ...options.terminalDelete!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.userBotsList) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerUserBotsListRoute(routes, { ...options.userBotsList!,
        requireUser: async request => { void userFromRequest(request) },
        ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId })
    })
  }
  if (options.embeddingRebuildStatus) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerEmbeddingRebuildStatusRoute(routes, { ...options.embeddingRebuildStatus!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.taskFilesystemAuthorization) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTaskFilesystemAuthorizationRoutes(routes, { ...options.taskFilesystemAuthorization!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.taskFilesystemRevoke) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTaskFilesystemRevokeRoute(routes, { ...options.taskFilesystemRevoke!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.credentialCreate) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerCredentialCreateRoute(routes, { ...options.credentialCreate!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.credentialList) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerCredentialListRoute(routes, { ...options.credentialList!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.credentialPatch) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerCredentialPatchRoute(routes, { ...options.credentialPatch!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.credentialModelsPreview) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerCredentialModelsPreviewRoute(routes, { ...options.credentialModelsPreview!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.credentialTestPreview) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerCredentialTestPreviewRoute(routes, { ...options.credentialTestPreview!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.credentialMediaProbe) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerByokMediaCapabilityProbeRoute(routes, {
      ...options.credentialMediaProbe!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.providerCapabilityPreview) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerProviderCapabilityPreviewRoute(routes, { ...options.providerCapabilityPreview!,
      requireUser: async request => { void userFromRequest(request) } }))
  }
  if (options.credentialDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerCredentialDeleteRoute(routes, { ...options.credentialDelete!,
        requireUser: async request => { void userFromRequest(request) },
        ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId })
    })
  }
  if (options.userSkillDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerUserSkillDeleteRoute(routes, { ...options.userSkillDelete!,
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId })
    })
  }
  if (options.userSkillList) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserSkillListRoute(routes, {
      ...options.userSkillList!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.onboarding) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerOnboardingResetGuideRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        store: options.onboarding!,
      })
      registerOnboardingRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        store: options.onboarding!,
      })
    })
  }
  if (options.listProjects || options.createProject || options.listProjectFileCounts || options.getProject
    || options.updateProject || options.deleteProject || options.restoreProject) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerProjectRoutes(routes, userFromRequest, options)
    })
  }
  if (options.clients)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerClientRoutes(routes, userFromRequest, options.clients!),
    )
  if (options.events)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerEventRoutes(routes, userFromRequest, options.events!),
    )
  if (options.mindNotes)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindNoteReadRoutes(
        routes,
        (request) => userFromRequest(request).requestContext.data.ownerId,
        options.mindNotes!,
      ),
    )
  if (options.mindCanvasReads)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasReadRoutes(
        routes,
        (request) => userFromRequest(request).requestContext.data.ownerId,
        options.mindCanvasReads!,
      ),
    )
  if (options.mindRefSuggest)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindRefSuggestRoute(routes, {
        ownerId: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.mindRefSuggest!,
      }),
    )
  if (options.mindCanvasMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasMutationRoutes(routes, userFromRequest, options.mindCanvasMutations!),
    )
  if (options.mindCanvasNoteMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasNoteMutationRoutes(routes, userFromRequest, options.mindCanvasNoteMutations!),
    )
  if (options.mindCanvasItemMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasItemMutationRoutes(routes, userFromRequest, options.mindCanvasItemMutations!),
    )
  if (options.mindCanvasRelationMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasRelationMutationRoutes(routes, userFromRequest, options.mindCanvasRelationMutations!),
    )
  if (options.mindRefNodeCreate)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindRefNodeCreateRoute(routes, userFromRequest, options.mindRefNodeCreate!),
    )
  if (options.mindNoteCreate)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindNoteCreateRoute(routes, userFromRequest, options.mindNoteCreate!),
    )
  if (options.mindNoteMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindNoteMutationRoutes(routes, userFromRequest, options.mindNoteMutations!),
    )
  if (options.undo)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerUndoRoutes(routes, userFromRequest, options.undo!),
    )
  if (options.deleteScheduledTask)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskDelete(routes, userFromRequest, options.deleteScheduledTask!),
    )
  if (options.listScheduledTasks)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskList(routes, userFromRequest, options.listScheduledTasks!),
    )
  if (options.scheduledTaskDeliveryTargets)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskDeliveryTargets(routes, userFromRequest, options.scheduledTaskDeliveryTargets!),
    )
  if (options.scheduledTaskWrites)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskWrites(routes, userFromRequest, options.scheduledTaskWrites!),
    )
  if (options.notifications)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerNotificationRoutes(routes, userFromRequest, options.notifications!),
    )
  if (options.track)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerTrackRoute(routes, userFromRequest, options.track!),
    )
  if (options.feedback)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerFeedbackRoute(routes, userFromRequest, options.feedback!),
    )
  if (options.createWorkspace || options.listWorkspaces || options.workspaceBindings
    || options.updateWorkspace || options.deleteWorkspace) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerWorkspaceRoutes(
        routes,
        userFromRequest,
        options.createWorkspace,
        options.workspaceBindings,
        options.updateWorkspace,
        options.listWorkspaces,
        options.deleteWorkspace,
      ),
    )
  }
  if (options.workspaceDirectories) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerWorkspaceDirectoryRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.workspaceDirectories!,
      }),
    )
  }
  if (options.agentChat || options.agentInteractionRespond || options.listAgentSessions || options.lookupAgentInteractionSession || options.refreshAgentSession
    || options.agentPendingQueueReads || options.agentPendingQueuePatch || options.agentPendingQueueReplace || options.agentPendingQueueClaims
    || options.renameAgentSession || options.listAgentMessages || options.locateAgentMessage
    || options.readAgentToolEventDetails || options.agentFilesystemAuthorization || options.agentMisc) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      {
        const requireUser = async (request: FastifyRequest) => { void userFromRequest(request) }
        const userIdFromRequest = (request: FastifyRequest) => userFromRequest(request).requestContext.data.ownerId
        if (options.agentChat) registerAgentChatRoutes(routes, { requireUser, userIdFromRequest, service: options.agentChat })
        if (options.agentInteractionRespond) registerAgentInteractionRespondRoute(routes, { requireUser, userIdFromRequest, service: options.agentInteractionRespond })
        if (options.agentFilesystemAuthorization) {
          registerAgentFilesystemAuthorizationRoutes(routes, {
            requireUser,
            userIdFromRequest,
            ...options.agentFilesystemAuthorization,
          })
        }
        if (options.listAgentSessions) {
          registerAgentSessionRoute(routes, {
            requireUser,
            userIdFromRequest,
            list: options.listAgentSessions,
          })
        }
        if (options.lookupAgentInteractionSession) {
          registerAgentInteractionSessionRoute(routes, {
            requireUser,
            userIdFromRequest,
            lookup: options.lookupAgentInteractionSession,
          })
        }
        if (options.refreshAgentSession) {
          registerAgentSessionRefreshRoute(routes, {
            requireUser,
            userIdFromRequest,
            refresh: options.refreshAgentSession,
          })
        }
        if (options.agentPendingQueueReads) {
          const queueOptions = {
            requireUser,
            userIdFromRequest,
            readQueue: options.agentPendingQueueReads.readQueue,
            readImportedDrafts: options.agentPendingQueueReads.readImportedDrafts,
            ...(options.agentPendingQueueReads.nowSeconds
              ? { nowSeconds: options.agentPendingQueueReads.nowSeconds }
              : {}),
          }
          registerAgentImportedDraftQueueRoute(routes, queueOptions)
          registerAgentPendingQueueReadRoute(routes, queueOptions)
        }
        if (options.agentPendingQueuePatch) {
          registerAgentPendingQueuePatchRoute(routes, {
            requireUser,
            userIdFromRequest,
            ...options.agentPendingQueuePatch,
          })
        }
        if (options.agentPendingQueueReplace) {
          registerAgentPendingQueueReplaceRoute(routes, {
            requireUser,
            userIdFromRequest,
            ...options.agentPendingQueueReplace,
          })
        }
        if (options.agentPendingQueueClaims) {
          registerAgentPendingQueueClaimRoutes(routes, {
            requireUser,
            userIdFromRequest,
            ...options.agentPendingQueueClaims,
          })
        }
        if (options.renameAgentSession) {
          registerAgentSessionRenameRoute(routes, {
            requireUser,
            userIdFromRequest,
            rename: options.renameAgentSession,
          })
        }
        if (options.listAgentMessages) {
          registerAgentMessageHistoryRoute(routes, {
            requireUser,
            userIdFromRequest,
            list: options.listAgentMessages,
          })
        }
        if (options.locateAgentMessage) {
          registerAgentMessageLocationRoute(routes, {
            requireUser,
            userIdFromRequest,
            locate: options.locateAgentMessage,
          })
        }
        if (options.readAgentToolEventDetails) {
          registerAgentToolEventDetailsRoute(routes, {
            requireUser,
            userIdFromRequest,
            readDetails: options.readAgentToolEventDetails,
          })
        }
        if (options.agentMisc) {
          registerAgentMiscRoutes(routes, {
            requireUser,
            ...options.agentMisc,
          })
        }
      },
    )
  }
  if (options.fileBrowser) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileBrowserRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileBrowser!,
      })
    })
  }
  if (options.folderWrites) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFolderWriteRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.folderWrites!,
      })
    })
  }
  if (options.folderCopy) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFolderCopyRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.folderCopy!,
      })
    })
  }
  if (options.fileReads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileReadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileReads!,
      })
      if (options.fileReads?.xlsxPreview && options.fileReads.xlsxPreviewImage) {
        registerXlsxPreviewRoutes(routes, {
          requireUser: async (request) => { void userFromRequest(request) },
          ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
          operations: {
            preview: (ownerId, fileId) => options.fileReads!.xlsxPreview!(ownerId, fileId),
            image: (ownerId, fileId, imageId) => options.fileReads!.xlsxPreviewImage!(ownerId, fileId, imageId),
          },
        })
      }
      registerFileThumbnailRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileReads!,
      })
    })
  }
  if (options.folderReads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFolderReadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.folderReads!,
      })
    })
  }
  if (options.fileUploads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileUploadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileUploads!,
      })
    })
  }
  if (options.fileDeletes) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileDeleteRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileDeletes!,
      })
    })
  }
  if (options.fileRestores) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileRestoreRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileRestores!,
      })
    })
  }
  if (options.trash) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerTrashRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.trash!,
      })
    })
  }
  if (options.fileContents) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileContentRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileContents!,
      })
    })
  }
  if (options.fileUpdates) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileUpdateRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileUpdates!,
      })
    })
  }
  if (options.fileCopies) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileCopyRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileCopies!,
      })
    })
  }
  if (options.fileConflicts) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileConflictRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileConflicts!,
      })
    })
  }
  if (options.fileBatchDownloads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileBatchDownloadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileBatchDownloads!,
      })
    })
  }
  if (options.fileArchives) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileArchiveRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.fileArchives!,
      })
    })
  }
  if (options.globalSearch) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerGlobalSearchRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.globalSearch!,
      })
    })
  }
  if (options.folderDownloads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFolderDownloadRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.folderDownloads!,
      })
    })
  }
}

export function createApp(options: WebUiOptions) {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  const jsonParser = app.getDefaultJsonParser('error', 'error')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const source = typeof body === 'string' ? body : body.toString('utf8')
    if (source.length === 0) {
      done(null, undefined)
      return
    }
    jsonParser(request, source, done)
  })
  installHttpErrorHandler(app)
  if (options.fileUploads || options.userAvatar || options.preferences?.textFiles) installFileUploadSupport(app)
  app.get('/health', async () => ({ status: 'ok', app: options.appName }))
  app.get('/health/ready', async (_request, reply) => {
    try {
      if (await options.isReady()) return { status: 'ok' }
    } catch {
      options.onReadinessError?.()
    }
    return reply.code(503).send({ status: 'not_ready' })
  })
  registerSiteConfigRoute(app, options.publicSiteConfig ?? DEFAULT_PUBLIC_SITE_CONFIG)
  registerUserRoutes(app, options)
  if (options.dataExportDownload) registerDataExportBrowserDownloadRoute(app, options.dataExportDownload)
  options.adminAuth?.registerRoutes(app)
  if (options.adminAuth && options.adminConfig) {
    registerAdminConfigRoutes(app, {
      ...options.adminConfig,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminVoiceTest) {
    registerAdminVoiceTestRoute(app, { ...options.adminVoiceTest, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminVoicePresetTest) {
    registerAdminVoicePresetTestRoute(app, { ...options.adminVoicePresetTest, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminSearchTest) {
    registerAdminSearchTestRoute(app, { ...options.adminSearchTest, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminLlmPresets) {
    registerAdminLlmPresetRoutes(app, { ...options.adminLlmPresets, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminStorageSnapshots) {
    registerAdminStorageSnapshotsRoute(app, {
      ...options.adminStorageSnapshots,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminUsers) {
    registerAdminUsersRoute(app, {
      ...options.adminUsers,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminUserStatus) {
    registerAdminUserStatusRoutes(app, {
      ...options.adminUserStatus,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminDebugLogs) {
    registerAdminDebugLogRoutes(app, {
      ...options.adminDebugLogs,
      requireAdmin: options.adminAuth.requireAdmin,
      verifyAdmin: options.adminAuth.verifyAdmin,
    })
  }
  if (options.adminAuth && options.adminSecurityEvents) {
    registerAdminSecurityEventRoutes(app, {
      ...options.adminSecurityEvents,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminFeedback) {
    registerAdminFeedbackRoute(app, options.adminAuth.requireAdmin, options.adminFeedback)
  }
  if (options.adminAuth && options.adminUserSecurityEvents) {
    registerAdminUserSecurityEventRoute(app, {
      ...options.adminUserSecurityEvents,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminUserRisk) {
    registerAdminUserRiskRoute(app, {
      ...options.adminUserRisk,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminAgentUsage) {
    registerAdminAgentUsageRoute(app, {
      ...options.adminAgentUsage,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.emailRecipientCount) registerEmailRecipientCountRoute(app, { ...options.emailRecipientCount, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.storageQuotaStatus) registerStorageQuotaStatusRoute(app, { ...options.storageQuotaStatus, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.serviceStatus) registerServiceStatusRoute(app, { ...options.serviceStatus, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminMaintenanceStatus) registerAdminMaintenanceStatusRoutes(app, { ...options.adminMaintenanceStatus, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.storageLiveTotals) registerStorageLiveTotalsRoute(app, { ...options.storageLiveTotals, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.safeEgressRead) registerSafeEgressReadRoute(app, { ...options.safeEgressRead, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.imMemorySummary) registerImMemorySummaryRoutes(app, { ...options.imMemorySummary, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminUserBan) registerAdminUserBanRoute(app, { ...options.adminUserBan, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmailPreview) registerAdminEmailPreviewRoute(app, { ...options.adminEmailPreview, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.smtpProbe) registerSmtpProbeRoute(app, { ...options.smtpProbe, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmailTest) registerAdminEmailTestRoute(app, { ...options.adminEmailTest, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.llmStrategy) registerLlmStrategyRoute(app, { ...options.llmStrategy, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.llmPresetSelection) registerLlmPresetSelectionRoutes(app, { ...options.llmPresetSelection, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.llmCapabilityOverrides) registerLlmCapabilityOverrideRoute(app, { ...options.llmCapabilityOverrides, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.llmPresetMutations) registerLlmPresetMutationRoutes(app, { ...options.llmPresetMutations, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.modelDirectory) registerModelDirectoryRoutes(app, { ...options.modelDirectory, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminRecentMisread) registerAdminRecentMisreadRoute(app, { ...options.adminRecentMisread, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminPerceptionExport) registerAdminPerceptionExportRoute(app, { ...options.adminPerceptionExport, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminMisreadExport) registerAdminMisreadExportRoute(app, { ...options.adminMisreadExport, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminPerceptionStats) registerAdminPerceptionStatsRoute(app, { ...options.adminPerceptionStats, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminOpsSummary) registerAdminOpsSummaryRoute(app, { ...options.adminOpsSummary, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminFileSyncRunRead) registerAdminFileSyncRunReadRoutes(app, { ...options.adminFileSyncRunRead, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminFileSyncRunCancel) registerAdminFileSyncRunCancelRoute(app, { ...options.adminFileSyncRunCancel, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminFileSyncDryRun) registerAdminFileSyncDryRunRoute(app, { ...options.adminFileSyncDryRun, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminFileSyncInitialize) registerAdminFileSyncInitializeRoute(app, { ...options.adminFileSyncInitialize, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.watcherCapacity) registerWatcherCapacityRoute(app, { ...options.watcherCapacity, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminFileSyncEvents) registerAdminFileSyncEventsRoute(app, { ...options.adminFileSyncEvents, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmbeddingProbe) registerEmbeddingProbeRoute(app, { ...options.adminEmbeddingProbe, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmbeddingRebuildStatus) registerAdminEmbeddingRebuildStatusRoute(app, { ...options.adminEmbeddingRebuildStatus, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.safeEgressUpdate) registerSafeEgressUpdateRoute(app, { ...options.safeEgressUpdate, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.safeEgressProbe) registerSafeEgressProbeRoute(app, { ...options.safeEgressProbe, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.voicePresetsMutate) registerVoicePresetMutationRoutes(app, { ...options.voicePresetsMutate, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.voicePresetsRead) registerVoicePresetsReadRoute(app, { ...options.voicePresetsRead, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminSystemLogs) registerSystemLogRoutes(app, { ...options.adminSystemLogs, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminAnalytics) registerAdminAnalyticsRoutes(app, { ...options.adminAnalytics, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminAuditLog) registerAdminAuditLogRoute(app, { ...options.adminAuditLog, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminUserSettings) registerAdminUserSettingsRoutes(app, { ...options.adminUserSettings, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.notificationBroadcast) registerNotificationBroadcastRoute(app, { ...options.notificationBroadcast, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.notificationAdminHistory) registerNotificationAdminHistoryRoutes(app, { ...options.notificationAdminHistory, requireAdmin: options.adminAuth.requireAdmin })
  if (options.staticRoot) registerStaticFrontend(app, options.staticRoot)
  return app
}
