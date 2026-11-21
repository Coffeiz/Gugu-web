import type { DataExportPreviewOptions } from '../modules/data-portability/exports.js'
import type { createDataImportRecoverer } from '@gugu/core/data-portability/apply-import'
import type { createDataImportRollbackCreator } from '@gugu/core/data-portability/apply-import'
import type { createDataImportApplier } from '@gugu/core/data-portability/apply-import'
import type { createDataImportResumer } from '@gugu/core/data-portability/resume-import'
import { type SecretPromptCancelOptions } from '../modules/agent/interactions/secret-cancel.js'
import { type UserBotCreateOptions, registerUserBotDeleteRoute, registerUserBotUpdateRoute } from '../modules/im/routes.js'
import { type QqConnectRouteOptions } from '../modules/im/connect/platforms/qq/index.js'
import { type FeishuConnectRouteOptions } from '../modules/im/connect/platforms/feishu/index.js'
import { type WechatConnectRouteOptions } from '../modules/im/connect/platforms/wechat/index.js'
import { type TelegramConnectRouteOptions } from '../modules/im/connect/platforms/telegram/index.js'
import type { DataExportDownloadOptions } from '../modules/data-portability/download.js'
import type { createDataExportCreator } from '@gugu/core/data-portability/create-export'
import type { LlmPresetTestResult } from '@gugu/core/agent/config'
import { type TaskFilesystemAuthorizationOptions, type TaskFilesystemRevokeOptions } from '../modules/scheduled-tasks/access.js'
import { type VoicePresetMutationOptions } from '../modules/admin/voice.js'
import type { createDataExportDeleter } from '@gugu/core/data-portability/delete-export'
import type { createDataImportCanceler } from '@gugu/core/data-portability/cancel-import'
import type { DataImportPreflightRouteOptions } from '../modules/data-portability/imports.js'
import type { createDataImportDeleter } from '@gugu/core/data-portability/delete-import'
import type { createDataExportCanceler } from '@gugu/core/data-portability/cancel-export'
import {
  type TerminalDeleteOptions,
  type TerminalCreateRouteOptions,
  type TerminalReopenRouteOptions,
  type TerminalLifecycleRouteOptions,
  type TerminalMetricsOptions,
  type TerminalListOptions,
  type TerminalDetailOptions,
  type TerminalRenameOptions,
  type TerminalEventsOptions,
} from '../modules/terminals/routes.js'
import { type TerminalWebsocketOptions } from '../modules/terminals/pty/websocket.js'
import { type TerminalCommandRouteOptions } from '../modules/terminals/shell/command.js'
import { type VoicePresetsReadOptions } from '../modules/admin/voice.js'
import { type AdminVoicePresetTestOptions, type AdminVoiceTestOptions } from '../modules/admin/voice.js'
import { type AdminSearchTestOptions } from '../modules/admin/search.js'
import type { createAccountMemoryCleanupRuntime } from '../modules/admin/memory-cleanup.js'
import { type AdminUpdateMode } from '../modules/admin/runtime.js'
import { type AccountDeleteOptions } from '../modules/auth/account/delete.js'
import { type AdminUserDeleteOptions } from '../modules/admin/users.js'
import { type AgentCapabilityCatalog } from '../modules/admin/llm.js'
import { registerAgentStateLabelRoutes } from '../modules/admin/llm-strategy.js'
import type { createAdminMaintenanceStatus } from '@gugu/core/maintenance/admin-status'
import { type createServiceStatusReader } from '../modules/admin/runtime.js'
import { type ServiceRestartOperations } from '../modules/admin/runtime.js'
import { type AttachmentDownloadOptions } from '../modules/agent/attachments/download.js'
import { type AgentAttachmentUploadOperations } from '../modules/agent/attachments/upload.js'
import { type AttachmentDraftDeleteOptions } from '../modules/agent/attachments/delete.js'
import { type AttachmentDraftClearOptions } from '../modules/agent/attachments/clear.js'
import { type VoiceAvailabilityOptions } from '../modules/agent/voice.js'
import { type MemoryClearOptions } from '../modules/agent/memory.js'
import { type AgentSessionDeleteOperations } from '../modules/agent/sessions/delete.js'
import { type UserBotBindingCodeOptions } from '../modules/im/connect/code.js'
import { type LoopScopeProxyOptions } from '../modules/loopscope/proxy.js'
import { type StorageQuotaStatusOptions } from '../modules/admin/storage.js'
import type { NotificationBroadcastInput } from '@gugu/core/notifications/broadcast'
import { type McpStatusOptions } from '../modules/mcp/status.js'
import { type McpServerCreateRouteOptions, type McpServerRoutesOptions } from '../modules/mcp/servers.js'
import { type McpConnectionTestOptions } from '../modules/mcp/test-connection.js'
import { type McpServerListRouteOptions } from '../modules/mcp/server-list.js'
import { type McpRuntimeRouteOptions } from '../modules/mcp/runtime-routes.js'
import { type AttentionDefaultsOptions } from '../modules/im/settings.js'
import type { EmbeddingRebuildStatusOptions, EmbeddingRebuildRouteOptions } from '../modules/agent/memory/rebuild.js'
import { type AdminEmbeddingRebuildRouteOptions } from '../modules/admin/embedding.js'
import { type AdminIndexRebuildRouteOptions } from '../modules/admin/index-rebuild.js'
import { type UserBotUnbindOptions } from '../modules/im/connect/unbind.js'
import type { createPortabilityJobReader } from '@gugu/core/data-portability/read-jobs'
import type { UserBotsListOptions } from '../modules/im/routes.js'
import type { CredentialDeleteOptions, CredentialCreateOptions, CredentialListOptions, CredentialPatchRouteOptions, CredentialModelsPreviewRouteOptions, CredentialTestPreviewRouteOptions, ByokMediaProbeOptions, ProviderCapabilityPreviewOptions } from '../modules/byok/routes.js'
import { type UserSkillDeleteOptions, type UserSkillListOptions, type UserSkillWriteOptions } from '../modules/skills/routes.js'
import { type ImMemorySummaryOptions } from '../modules/admin/memory.js'
import { type AdminUserBanOptions } from '../modules/admin/users.js'
import { type AdminEmailPreviewOptions } from '../modules/admin/email.js'
import { registerSmtpProbeRoute } from '../modules/admin/smtp.js'
import { registerAdminEmailTestRoute } from '../modules/admin/email.js'
import { type AdminEmailPublishOperations } from '../modules/admin/email.js'
import { type AdminEmailTranslateOptions } from '../modules/admin/email.js'
import { type AdminPromptOptions } from '../modules/admin/prompts.js'
import { type LlmStrategyRouteOptions } from '../modules/admin/llm-strategy.js'
import { type LlmPresetSelectionOptions } from '../modules/admin/llm.js'
import { type LlmCapabilityOverrideOptions } from '../modules/admin/llm-probe.js'
import { type LlmPresetMutationOptions } from '../modules/admin/llm-settings.js'
import { type ModelDirectoryRouteOptions } from '../modules/admin/llm.js'
import { type AdminRecentMisreadOptions } from '../modules/admin/perception.js'
import { type AdminPerceptionExportOptions } from '../modules/admin/perception.js'
import { type AdminMisreadExportOptions } from '../modules/admin/perception.js'
import { type AdminPerceptionStatsOptions } from '../modules/admin/perception.js'
import { registerAdminOpsSummaryRoute } from '../modules/admin/runtime.js'
import { type createEmbeddingFileProbe } from '../modules/admin/embedding-probe.js'
import { type AdminMediaProbePreview } from '../modules/admin/llm-probe.js'
import { type AdminLlmPresetReadOptions } from '../modules/admin/llm.js'
import { type AdminEmbeddingRebuildStatusOptions } from '../modules/admin/embedding.js'
import { type SafeEgressUpdateOptions } from '../modules/admin/network-update.js'
import { registerSafeEgressProbeRoute } from '../modules/admin/network.js'
import { type SandboxEgressRouteOptions } from '../modules/admin/sandbox.js'
import { type SandboxStatusRouteOptions } from '../modules/admin/sandbox.js'
import { type SandboxEnableRouteOptions } from '../modules/admin/sandbox.js'
import { type SandboxDisableRouteOptions } from '../modules/admin/sandbox.js'
import type { SafeEgressReadSettings } from '@gugu/core/preferences/safe-egress'
import { type SystemLogOptions } from '../modules/admin/logs.js'
import { type AdminAnalyticsOptions } from '../modules/admin/analytics.js'
import { type AdminAuditLogOptions } from '../modules/admin/audit.js'
import { type AdminUserSettingsOptions } from '../modules/admin/users.js'
import { type NotificationAdminHistoryOptions } from '../modules/notifications/admin.js'
import { type FastifyRequest } from 'fastify'
import type { DesktopAgentDeepResearchOptions, DesktopAgentSimilarImageOptions } from '../modules/agent/tools/desktop-search-route.js'
import { requestContext } from '@gugu/core'
import type { RequestContext } from '@gugu/core'
import type { WorkspaceBindingOperations } from '../modules/workspaces/bindings.js'
import type { WorkspaceDirectoryOperations } from '../modules/workspaces/routes.js'
import { type PublicUserRecord } from '../modules/auth/session/token.js'
import type { UserAuthOptions } from '../modules/auth/contracts.js'
import { type PublicSiteConfig } from '../modules/site/config.js'
import { type RegisterUserRouteOptions } from '../modules/auth/registration/routes.js'
import { type PreferencesStore } from '../modules/preferences/preferences.js'
import type { OnboardingStore } from '@gugu/core/onboarding'
import { type RegistrationCodeRouteOptions } from '../modules/auth/registration/routes.js'
import { type ProfileRouteOptions } from '../modules/auth/account/profile.js'
import { type PasswordResetRouteOptions } from '../modules/auth/password-reset.js'
import { type EmailChangeOptions } from '../modules/auth/email-change.js'
import { type LiveStreamOperations } from '../modules/live/live.js'
import { type UserAvatarOperations } from '../modules/auth/account/avatar.js'
import { type MindNoteReadOperations, type MindNoteCreateOptions, type MindNoteMutationOptions } from '../modules/mind/notes.js'
import { type MindCanvasReadOperations, type MindCanvasMutationOptions } from '../modules/mind/canvas.js'
import { type MindReferenceSuggestOperations } from '../modules/mind/references.js'
import {
  type MindCanvasNoteMutationOptions,
  type MindCanvasItemMutationOptions,
  type MindRefNodeCreateOptions,
} from '../modules/mind/items.js'
import { type MindCanvasRelationMutationOptions } from '../modules/mind/relations.js'
import { type UndoOperations } from '../modules/undo/routes.js'
import type { createScheduledTaskDeleter } from '@gugu/core/scheduled-task-delete'
import { type ScheduledTaskList, type ScheduledTaskTestNotifier, type ScheduledTaskRunNow } from '../modules/scheduled-tasks/routes.js'
import { type createScheduledTaskDeliveryTargets } from '../modules/scheduled-tasks/delivery/targets.js'
import type { createPostgresTaskWrites } from '../modules/scheduled-tasks/store.js'
import { type AdminFeedbackOperations } from '../modules/feedback/feedback.js'
import { type FileBrowserOperations, type FileReadOperations, type FolderReadOperations } from '../modules/files/browse.js'
import { type FolderWriteOperations } from '../modules/files/folders/write.js'
import { type FolderCopyOperations } from '../modules/files/folders/copy.js'
import { type FolderDeleteOperations } from '../modules/files/folders/delete.js'
import { type FileDeleteOperations, type FileRestoreOperations, type TrashOperations } from '../modules/files/trash/service.js'
import { type FileContentOperations } from '../modules/files/content.js'
import { type FileUpdateOperations, type FileCopyOperations } from '../modules/files/store.js'
import { type FileConflictOperations, type FileUploadOperations } from '../modules/files/upload.js'
import { type FileBatchDownloadOperations, type FolderDownloadOperations } from '../modules/files/download.js'
import { type FileArchiveOperations } from '../modules/files/archive/service.js'
import type { GlobalSearchOperations } from '@gugu/core'
import type { AdminAuthAdapter } from '../modules/admin/auth.js'
import { type AdminUsersOptions, type AdminUserRiskOptions } from '../modules/admin/users.js'
import { type AdminUserStatusRouteOptions } from '../modules/admin/users.js'
import { type AdminDebugLogOptions } from '../modules/admin/logs.js'
import { type AdminStorageSnapshotOptions } from '../modules/admin/storage.js'
import { type AdminSecurityEventOptions } from '../modules/admin/audit.js'
import { type AdminUserSecurityEventOptions } from '../modules/admin/users.js'
import { type AgentUsageOptions } from '../modules/admin/usage.js'
import { type AdminConfigOptions } from '../modules/admin/config.js'
import { type AdminLlmPresetOptions } from '../modules/admin/llm.js'
import type { AgentMessagePageOptions } from '../modules/agent/chat/read.js'
import { type AgentInteractionRespondService } from '../modules/agent/interactions/respond.js'
import { type AgentSecretInteractionService } from '../modules/agent/interactions/secret.js'
import { type AgentChatService } from '../modules/agent/chat/routes.js'
import { type AgentImportedDraftQueueReadOptions, type AgentPendingQueueReadOptions } from '../modules/agent/chat/queue.js'
import { type AgentPendingQueueReplaceRouteOptions, type AgentPendingQueuePatchRouteOptions } from '../modules/agent/chat/patch.js'
import { type AgentPendingQueueClaimRouteOptions } from '../modules/agent/chat/claims.js'
import { type RenamedAgentSession } from '../modules/agent/sessions/update.js'
import { type AgentMiscRoutesOptions } from '../modules/agent/misc.js'
import { type AgentFilesystemAuthorizationRouteOptions } from '../modules/agent/sandbox/routes.js'

export type { UserAuthOptions } from '../modules/auth/contracts.js'

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
  mindRefSuggest?: MindReferenceSuggestOperations
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
  scheduledTaskTestNotify?: ScheduledTaskTestNotifier
  scheduledTaskWrites?: ReturnType<typeof createPostgresTaskWrites>
  scheduledTaskRunNow?: ScheduledTaskRunNow
  webPush?: ReturnType<typeof import('../modules/notifications/push.js').createWebPush>
  notifications?: NotificationOptions
  track?: TrackOptions
  feedback?: FeedbackOptions
  adminFeedback?: AdminFeedbackOperations
  profile?: Omit<ProfileRouteOptions, 'authenticate'>
  userAvatar?: UserAvatarOperations
  preferences?: PreferencesStore
  onboarding?: OnboardingStore
  onboardingReseed?: (ownerId: string) => Promise<unknown>
  createWorkspace?: (ownerId: string, input: unknown) => Promise<unknown>
  listWorkspaces?: (ownerId: string) => Promise<unknown>
  workspaceBindings?: WorkspaceBindingOperations
  updateWorkspace?: (ownerId: string, workspaceId: number, input: unknown) => Promise<unknown>
  deleteWorkspace?: (ownerId: string, workspaceId: number) => Promise<unknown>
  workspaceDirectories?: WorkspaceDirectoryOperations
  listAgentSessions?: (ownerId: string) => Promise<unknown[]>
  readAgentSessionState?: (ownerId: string, sessionId: number) => Promise<{ executionState: string; pendingMessageCount: number; active: boolean } | null>
  agentChat?: AgentChatService
  agentInteractionRespond?: AgentInteractionRespondService
  agentSecretInteraction?: AgentSecretInteractionService
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
  deleteAgentSession?: AgentSessionDeleteOperations
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
  folderDelete?: FolderDeleteOperations
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
  adminUpdateMode?: AdminUpdateMode
  adminConfig?: Omit<AdminConfigOptions, 'requireAdmin'>
  adminVoiceTest?: Omit<AdminVoiceTestOptions, 'requireAdmin'>
  adminVoicePresetTest?: Omit<AdminVoicePresetTestOptions, 'requireAdmin'>
  adminSearchTest?: Omit<AdminSearchTestOptions, 'requireAdmin'>
  adminLlmPresets?: Omit<AdminLlmPresetOptions, 'requireAdmin'>
  adminLlmPresetList?: Omit<AdminLlmPresetReadOptions, 'requireAdmin'>
  adminPrompts?: Omit<AdminPromptOptions, 'requireAdmin'>
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
  deleteDataExport?: ReturnType<typeof createDataExportDeleter>
  deleteDataImport?: ReturnType<typeof createDataImportDeleter>
  cancelDataImport?: ReturnType<typeof createDataImportCanceler>
  preflightDataImport?: DataImportPreflightRouteOptions['preflight']
  cleanupDataImportStaging?: (ownerId:string,jobId:string,stagingKey:string)=>Promise<void>
  portabilityJobs?: ReturnType<typeof createPortabilityJobReader>
  userBotBindingCode?: Omit<UserBotBindingCodeOptions, 'requireUser' | 'ownerIdFromRequest'>
  userBotUnbind?: Omit<UserBotUnbindOptions, 'requireUser' | 'ownerIdFromRequest'>
  userBotCreate?: Omit<UserBotCreateOptions, 'requireUser' | 'ownerIdFromRequest'>
  userBotDelete?: Omit<Parameters<typeof registerUserBotDeleteRoute>[1], 'requireUser' | 'ownerIdFromRequest'>
  userBotUpdate?: Omit<Parameters<typeof registerUserBotUpdateRoute>[1], 'requireUser' | 'ownerIdFromRequest'>
  qqConnect?: Omit<QqConnectRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  feishuConnect?: Omit<FeishuConnectRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  wechatConnect?: Omit<WechatConnectRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  telegramConnect?: Omit<TelegramConnectRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  mcpStatus?: Omit<McpStatusOptions, 'requireUser'>
  mcpServerCreate?: Omit<McpServerCreateRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  mcpServerConfig?: Omit<McpServerRoutesOptions, 'requireUser' | 'ownerIdFromRequest'>
  mcpConnectionTest?: Omit<McpConnectionTestOptions, 'requireUser' | 'ownerIdFromRequest'>
  mcpServerList?: Omit<McpServerListRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  mcpRuntime?: Omit<McpRuntimeRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  attentionDefaults?: Omit<AttentionDefaultsOptions, 'requireUser'>
  loopScopeProxy?: Pick<LoopScopeProxyOptions, 'endpoint' | 'transport'>
  attachmentDownload?: Omit<AttachmentDownloadOptions, 'requireUser' | 'ownerIdFromRequest'>
  attachmentUpload?: { operations: AgentAttachmentUploadOperations }
  attachmentDelete?: Omit<AttachmentDraftDeleteOptions, 'requireUser' | 'ownerIdFromRequest'>
  attachmentClear?: Omit<AttachmentDraftClearOptions, 'requireUser' | 'ownerIdFromRequest'>
  voiceAvailability?: Omit<VoiceAvailabilityOptions, 'requireUser' | 'ownerIdFromRequest'>
  clearAgentMemory?: { clear: MemoryClearOptions['clear'] }
  terminalDelete?: Omit<TerminalDeleteOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalCreate?: Omit<TerminalCreateRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalReopen?: Omit<TerminalReopenRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalLifecycle?: Omit<TerminalLifecycleRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalWebsocket?: Omit<TerminalWebsocketOptions, 'auth'>
  terminalMetrics?: Omit<TerminalMetricsOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalList?: Omit<TerminalListOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalDetail?: Omit<TerminalDetailOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalRename?: Omit<TerminalRenameOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalEvents?: Omit<TerminalEventsOptions, 'requireUser' | 'ownerIdFromRequest'>
  terminalCommand?: Omit<TerminalCommandRouteOptions, 'requireUser' | 'ownerIdFromRequest'> & { close?(): Promise<void> }
  userBotsList?: Omit<UserBotsListOptions, 'requireUser' | 'ownerIdFromRequest'>
  embeddingRebuildStatus?: Omit<EmbeddingRebuildStatusOptions, 'requireUser' | 'ownerIdFromRequest'>
  embeddingRebuild?: Omit<EmbeddingRebuildRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  taskFilesystemAuthorization?: Omit<TaskFilesystemAuthorizationOptions, 'requireUser' | 'ownerIdFromRequest'>
  taskFilesystemRevoke?: Omit<TaskFilesystemRevokeOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialDelete?: Omit<CredentialDeleteOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialCreate?: Omit<CredentialCreateOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialPatch?: Omit<CredentialPatchRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialModelsPreview?: Omit<CredentialModelsPreviewRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialTestPreview?: Omit<CredentialTestPreviewRouteOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialMediaProbe?: Omit<ByokMediaProbeOptions, 'requireUser' | 'ownerIdFromRequest'>
  credentialList?: Omit<CredentialListOptions, 'requireUser' | 'ownerIdFromRequest'>
  providerCapabilityPreview?: Omit<ProviderCapabilityPreviewOptions, 'requireUser'>
  desktopAgentDeepResearch?: DesktopAgentDeepResearchOptions
  desktopAgentSimilarImageSearch?: DesktopAgentSimilarImageOptions
  userSkillDelete?: Omit<UserSkillDeleteOptions, 'requireUser' | 'ownerIdFromRequest'>
  userSkillList?: Omit<UserSkillListOptions, 'requireUser' | 'ownerIdFromRequest'>
  userSkillWrite?: Omit<UserSkillWriteOptions, 'requireUser' | 'ownerIdFromRequest'>
  accountDelete?: Omit<AccountDeleteOptions, 'requireUser' | 'ownerIdFromRequest'>
  secretPromptCancel?: Omit<SecretPromptCancelOptions, 'requireUser' | 'ownerIdFromRequest'>
  safeEgressRead?: { readSettings(): SafeEgressReadSettings }
  imMemorySummary?: Omit<ImMemorySummaryOptions, 'requireAdmin'>
  imMemoryMaintenanceApply?: { apply(confirm: unknown): Promise<{ ok: true; applied: number; queued: number }> }
  imMemoryMaintenancePreview?: { start(): Promise<{ ok: true; total: number } | { ok: false; message: string; status: unknown }> }
  adminUserBan?: Omit<AdminUserBanOptions, 'requireAdmin'>
  adminEmailPreview?: Omit<AdminEmailPreviewOptions, 'requireAdmin'>
  smtpProbe?: Omit<Parameters<typeof registerSmtpProbeRoute>[1], 'requireAdmin'>
  adminEmailTest?: Omit<Parameters<typeof registerAdminEmailTestRoute>[1], 'requireAdmin'>
  adminEmailPublish?: AdminEmailPublishOperations
  adminEmailTranslate?: Omit<AdminEmailTranslateOptions, 'requireAdmin'>
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
  adminEmbeddingProbe?: { probe: ReturnType<typeof createEmbeddingFileProbe> }
  adminMediaProbePreview?: { probe: AdminMediaProbePreview }
  adminLlmPresetTest?: { test(id: string): Promise<LlmPresetTestResult> }
  adminLlmPresetMediaProbe?: { probe(id: string, dim?: 'image' | 'video' | 'audio'): Promise<unknown> }
  adminLlmCapabilityProbe?: { probe(id: string): Promise<unknown> }
  adminEmbeddingRebuildStatus?: Omit<AdminEmbeddingRebuildStatusOptions, 'requireAdmin'>
  adminEmbeddingRebuild?: Omit<AdminEmbeddingRebuildRouteOptions, 'requireAdmin'>
  adminIndexRebuild?: Omit<AdminIndexRebuildRouteOptions, 'requireAdmin'>
  safeEgressUpdate?: Omit<SafeEgressUpdateOptions, 'requireAdmin'>
  safeEgressProbe?: Omit<Parameters<typeof registerSafeEgressProbeRoute>[1], 'requireAdmin'>
  sandboxEgress?: Omit<SandboxEgressRouteOptions, 'requireAdmin'>
  sandboxStatus?: Omit<SandboxStatusRouteOptions, 'requireAdmin'>
  sandboxEnable?: Omit<SandboxEnableRouteOptions, 'requireAdmin'>
  sandboxDisable?: Omit<SandboxDisableRouteOptions, 'requireAdmin'>
  emailRecipientCount?: { read(): Promise<{ count: number; locale_counts: Record<string, number> }> }
  storageQuotaStatus?: Omit<StorageQuotaStatusOptions, 'requireAdmin'>
  serviceStatus?: { read: ReturnType<typeof createServiceStatusReader> }
  serviceRestart?: ServiceRestartOperations
  adminMaintenanceStatus?: { available(): boolean; read: ReturnType<typeof createAdminMaintenanceStatus> }
  accountMemoryCleanup?: ReturnType<typeof createAccountMemoryCleanupRuntime>
  storageLiveTotals?: { read(): Promise<{ categories: Record<string, { object_count: number; total_bytes: number }> }> }
  voicePresetsMutate?: Omit<VoicePresetMutationOptions, 'requireAdmin'>
  voicePresetsRead?: Omit<VoicePresetsReadOptions, 'requireAdmin'>
  adminSystemLogs?: Omit<SystemLogOptions, 'requireAdmin'>
  adminAnalytics?: Omit<AdminAnalyticsOptions, 'requireAdmin'>
  adminAuditLog?: Omit<AdminAuditLogOptions, 'requireAdmin'>
  adminUserSettings?: Omit<AdminUserSettingsOptions, 'requireAdmin'>
  adminUserDelete?: Omit<AdminUserDeleteOptions, 'requireAdmin'>
  adminAgentCapabilities?: { read(): Promise<AgentCapabilityCatalog> }
  adminAgentStateLabels?: Omit<Parameters<typeof registerAgentStateLabelRoutes>[1], 'requireAdmin'>
  notificationBroadcast?: { broadcast(input: NotificationBroadcastInput): Promise<{ ok: true; id: number }> }
  notificationAdminHistory?: Omit<NotificationAdminHistoryOptions, 'requireAdmin'>
  adminAgentUsage?: Omit<AgentUsageOptions, 'requireAdmin'>
}
