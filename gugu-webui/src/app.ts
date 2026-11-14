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
import { DEFAULT_PUBLIC_SITE_CONFIG, type PublicSiteConfig } from './domains/site/site-config.js'
import { registerStaticFrontend } from './static.js'
import { registerCurrentUserRoute, registerLoginRoute } from './domains/auth/routes/auth.js'
import { registerLogoutRoute } from './domains/auth/routes/auth-logout.js'
import { registerUserRoute, type RegisterUserRouteOptions } from './domains/auth/routes/auth-register.js'
import { registerPreferencesRoutes, type PreferencesStore } from './domains/preferences/preferences.js'
import { registerOnboardingRoutes, type OnboardingStore } from './domains/onboarding/onboarding.js'
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
import { registerLiveRoutes, type LiveStreamOperations } from './domains/live/live.js'
import {
  registerUserAvatarReadRoute,
  registerUserAvatarUploadRoute,
  type UserAvatarOperations,
} from './domains/auth/avatar.js'
import { registerSiteConfigRoute } from './domains/site/routes/site-config.js'
import { installHttpErrorHandler } from './http/errors.js'
import { registerAuthenticatedDomain } from './http/authenticated-domain.js'
import { registerProjectRoutes } from './domains/projects/routes/projects.js'
import { registerClientRoutes } from './domains/clients/routes/clients.js'
import { registerEventRoutes } from './domains/calendar/routes/events.js'
import { registerMindNoteReadRoutes, type MindNoteReadOperations } from './domains/mind/mind-notes-read.js'
import { registerMindCanvasReadRoutes, type MindCanvasReadOperations } from './domains/mind/mind-canvas-read.js'
import { registerMindCanvasMutationRoutes, type MindCanvasMutationOptions } from './domains/mind/routes/mind-canvas-mutations.js'
import { registerMindNoteCreateRoute, type MindNoteCreateOptions } from './domains/mind/routes/mind-note-create.js'
import { registerMindNoteMutationRoutes, type MindNoteMutationOptions } from './domains/mind/routes/mind-note-mutations.js'
import { registerNotificationRoutes } from './domains/notifications/routes/notifications.js'
import { registerTrackRoute } from './domains/site/routes/track.js'
import { registerAdminFeedbackRoute, registerFeedbackRoute, type AdminFeedbackOperations } from './domains/feedback/feedback.js'
import { registerWorkspaceRoutes } from './domains/workspaces/routes/workspaces.js'
import { registerWorkspaceDirectoryRoutes } from './domains/workspaces/workspace-directories.js'
import { registerFileBrowserRoutes, type FileBrowserOperations } from './domains/files/browser.js'
import { registerFolderWriteRoutes, type FolderWriteOperations } from './domains/files/folder-writes.js'
import { registerFileReadRoutes, type FileReadOperations } from './domains/files/file-reads.js'
import { registerFileDeleteRoutes, type FileDeleteOperations } from './domains/files/file-delete.js'
import { registerFileRestoreRoutes, type FileRestoreOperations } from './domains/files/file-restore.js'
import { registerTrashRoutes, type TrashOperations } from './domains/files/trash.js'
import { registerFileContentRoutes, type FileContentOperations } from './domains/files/file-content.js'
import { registerFileUpdateRoutes, type FileUpdateOperations } from './domains/files/file-update.js'
import { registerFileCopyRoutes, type FileCopyOperations } from './domains/files/file-copy.js'
import { registerFileConflictRoutes, type FileConflictOperations } from './domains/files/file-conflicts.js'
import { registerFileBatchDownloadRoutes, type FileBatchDownloadOperations } from './domains/files/file-batch-download.js'
import { registerFileArchiveRoutes, type FileArchiveOperations } from './domains/files/file-archive.js'
import { registerGlobalSearchRoute, type GlobalSearchOperations } from './domains/search/search.js'
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
import { registerAdminConfigRoutes, type AdminConfigOptions } from './domains/admin/admin-config.js'
import { registerAgentMessageLocationRoute } from './domains/agent-sessions/agent-message-location.js'
import { registerAgentMessageHistoryRoute } from './domains/agent-sessions/agent-message-history-route.js'
import type { AgentMessagePageOptions } from './domains/agent-sessions/persistence/agent-message-history.js'
import { registerAgentInteractionSessionRoute } from './domains/agent-sessions/agent-interaction-session-route.js'
import { registerAgentSessionRoute } from './domains/agent-sessions/agent-sessions.js'
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
  mindCanvasMutations?: MindCanvasMutationOptions
  mindNoteCreate?: MindNoteCreateOptions
  mindNoteMutations?: MindNoteMutationOptions
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
  agentMisc?: Omit<AgentMiscRoutesOptions, 'requireUser'>
  fileBrowser?: FileBrowserOperations
  folderWrites?: FolderWriteOperations
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
  adminStorageSnapshots?: Omit<AdminStorageSnapshotOptions, 'requireAdmin'>
  adminUsers?: Omit<AdminUsersOptions, 'requireAdmin'>
  adminUserStatus?: Omit<AdminUserStatusRouteOptions, 'requireAdmin'>
  adminDebugLogs?: Omit<AdminDebugLogOptions, 'requireAdmin' | 'verifyAdmin'>
  adminSecurityEvents?: Omit<AdminSecurityEventOptions, 'requireAdmin'>
  adminUserSecurityEvents?: Omit<AdminUserSecurityEventOptions, 'requireAdmin'>
  adminUserRisk?: Omit<AdminUserRiskOptions, 'requireAdmin'>
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
  if (options.onboarding) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
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
  if (options.mindCanvasMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindCanvasMutationRoutes(routes, userFromRequest, options.mindCanvasMutations!),
    )
  if (options.mindNoteCreate)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindNoteCreateRoute(routes, userFromRequest, options.mindNoteCreate!),
    )
  if (options.mindNoteMutations)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerMindNoteMutationRoutes(routes, userFromRequest, options.mindNoteMutations!),
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
  if (options.listAgentSessions || options.lookupAgentInteractionSession || options.refreshAgentSession
    || options.agentPendingQueueReads || options.agentPendingQueuePatch || options.agentPendingQueueReplace || options.agentPendingQueueClaims
    || options.renameAgentSession || options.listAgentMessages || options.locateAgentMessage
    || options.readAgentToolEventDetails || options.agentMisc) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      {
        const requireUser = async (request: FastifyRequest) => { void userFromRequest(request) }
        const userIdFromRequest = (request: FastifyRequest) => userFromRequest(request).requestContext.data.ownerId
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
  if (options.fileReads) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerFileReadRoutes(routes, {
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
  options.adminAuth?.registerRoutes(app)
  if (options.adminAuth && options.adminConfig) {
    registerAdminConfigRoutes(app, {
      ...options.adminConfig,
      requireAdmin: options.adminAuth.requireAdmin,
    })
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
  if (options.staticRoot) registerStaticFrontend(app, options.staticRoot)
  return app
}
