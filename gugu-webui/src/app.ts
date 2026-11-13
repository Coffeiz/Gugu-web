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
import {
  registerRegistrationCodeRoute,
  type RegistrationCodeRouteOptions,
} from './domains/auth/routes/auth-registration-code.js'
import { registerProfileRoute, type ProfileRouteOptions } from './domains/auth/routes/auth-profile.js'
import { registerSiteConfigRoute } from './domains/site/routes/site-config.js'
import { installHttpErrorHandler } from './http/errors.js'
import { registerAuthenticatedDomain } from './http/authenticated-domain.js'
import { registerProjectRoutes } from './domains/projects/routes/projects.js'
import { registerClientRoutes } from './domains/clients/routes/clients.js'
import { registerEventRoutes } from './domains/calendar/routes/events.js'
import { registerNotificationRoutes } from './domains/notifications/routes/notifications.js'
import { registerTrackRoute } from './domains/site/routes/track.js'
import { registerWorkspaceRoutes } from './domains/workspaces/routes/workspaces.js'
import { registerWorkspaceDirectoryRoutes } from './domains/workspaces/workspace-directories.js'
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

export interface WebUiOptions {
  appName: string
  publicSiteConfig?: PublicSiteConfig
  staticRoot?: string
  isReady: () => Promise<boolean>
  onReadinessError?: () => void
  userAuth?: UserAuthOptions
  registration?: RegisterUserRouteOptions
  registrationCode?: RegistrationCodeRouteOptions
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
  notifications?: NotificationOptions
  track?: TrackOptions
  profile?: Omit<ProfileRouteOptions, 'authenticate'>
  createWorkspace?: (ownerId: string, input: unknown) => Promise<unknown>
  listWorkspaces?: (ownerId: string) => Promise<unknown>
  workspaceBindings?: WorkspaceBindingOperations
  updateWorkspace?: (ownerId: string, workspaceId: number, input: unknown) => Promise<unknown>
  deleteWorkspace?: (ownerId: string, workspaceId: number) => Promise<unknown>
  workspaceDirectories?: WorkspaceDirectoryOperations
  adminAuth?: AdminAuthAdapter
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
  if (!auth) return
  registerLoginRoute(app, auth)
  registerProtectedDomain(app, auth, (routes, userFromRequest) => {
    registerCurrentUserRoute(routes, userFromRequest)
  })
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
  if (options.notifications)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerNotificationRoutes(routes, userFromRequest, options.notifications!),
    )
  if (options.track)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerTrackRoute(routes, userFromRequest, options.track!),
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
}

export function createApp(options: WebUiOptions) {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  installHttpErrorHandler(app)
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
