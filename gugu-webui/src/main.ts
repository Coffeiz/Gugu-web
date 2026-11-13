import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Pool } from 'pg'
import { createPostgresRuntime, type SqlDataRuntime } from '@gugu/core/data'
import type { Fields, RequestContext } from '@gugu/core'
import { createApp, type WriteRequestMetadata } from './app.js'
import type { UserAuthOptions } from './domains/auth/contracts.js'
import { loadConfig, type WebUiConfig } from './config.js'
import { checkDatabaseReadiness } from './database.js'
import { createUserRepository } from './domains/auth/persistence/users.js'
import { createRedisRegistrationCodeStore } from './domains/auth/persistence/registration-codes.js'
import { projectResponse, createProjectFileCountListing, createProjectGetter, createProjectListing } from './domains/projects/persistence/projects.js'
import { createClientOperations } from './domains/clients/persistence/clients.js'
import { createEventOperations } from './domains/calendar/persistence/events.js'
import { createNotificationOperations } from './domains/notifications/persistence/notifications.js'
import { createTrackOperations } from './domains/site/persistence/track.js'
import { revokeUserSessions } from './domains/auth/persistence/auth-revocation.js'
import { createPostgresProjectCreateRuntime } from './domains/projects/persistence/project-create-postgres.js'
import { createProjectCreator } from './domains/projects/application/project-create.js'
import { createPostgresProjectUpdateRuntime } from './domains/projects/persistence/project-update-postgres.js'
import { createLocalProjectDirectoryRenamer } from './domains/projects/persistence/project-directory-storage.js'
import { createProjectUpdater } from './domains/projects/application/project-update.js'
import { createProjectTrashService } from './domains/projects/application/project-trash.js'
import { createPostgresProjectTrashRuntime } from './domains/projects/persistence/project-trash-postgres.js'
import {
  createLocalProjectTrashStorage,
  createOssProjectTrashStorage,
  createProjectTrashOriginalStorageKeyResolver,
} from './domains/projects/persistence/project-trash-storage.js'
import { createPostgresProjectTrashPathMetadataReader } from './domains/projects/persistence/project-trash-path-metadata-postgres.js'
import { createProjectPostCommitPublisher } from './domains/projects/persistence/project-post-commit-postgres.js'
import { createCalendarEvent } from './domains/calendar/application/event-create.js'
import { createCalendarEventPostCommitPublisher } from './domains/calendar/persistence/calendar-create-post-commit-postgres.js'
import { createPostgresEventCreateStore } from './domains/calendar/persistence/event-create-postgres.js'
import { deleteCalendarEvent } from './domains/calendar/application/event-delete.js'
import { createPostgresEventDeleteStore } from './domains/calendar/persistence/event-delete-postgres.js'
import { createPostgresEventUpdateStore } from './domains/calendar/persistence/event-update-postgres.js'
import { createCalendarMutationPostCommitPublisher } from './domains/calendar/persistence/calendar-mutation-post-commit-postgres.js'
import { updateCalendarEvent } from './domains/calendar/application/event-update.js'
import { createPostgresWorkspaceCreator } from './domains/workspaces/persistence/workspace-create.js'
import { createPostgresWorkspaceUpdater } from './domains/workspaces/persistence/workspace-update.js'
import { createPostgresWorkspaceBindingOperations } from './domains/workspaces/persistence/workspace-bindings.js'
import { createPostgresWorkspaceLister } from './domains/workspaces/persistence/workspace-list.js'
import { createPostgresWorkspaceDeleter } from './domains/workspaces/persistence/workspace-delete.js'
import { createPostgresWorkspaceDirectoryOperations } from './domains/workspaces/persistence/workspace-directories.js'
import { prepareWorkspaceDirectoryAcl } from './adapters/workspace-directory-acl.js'
import { createSandboxdWorkspacePtyTerminator } from './adapters/sandboxd-pty.js'
import {
  createRedisAdminAuthVersionStore,
  createRedisEventPublisher,
  createRedisRateLimitCommands,
  createRedisRegistrationCodeCommands,
  type RedisEventPublisher,
} from './adapters/redis-events.js'
import { createRedisRateLimiter, RateLimitError } from './domains/auth/rate-limit.js'
import { AdminAuthError, createAdminAuthAdapter } from './domains/admin/admin-auth.js'
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

const noRedisEvents: RedisEventPublisher = {
  async publishAuthStateChanged() { return false },
  async bumpContextRevision() { return false },
  async publishResourceChanged() { return false },
}

function createUserAuth(
  pool: Pool,
  secret: string,
  redisEvents?: RedisEventPublisher,
  rateLimit = createRedisRateLimiter(null),
): UserAuthOptions {
  return {
    secret,
    ...createUserRepository(pool),
    async revokeUserSessions(userId) {
      await revokeUserSessions(pool, userId)
    },
    publishAuthStateChanged: (userId: string) => (redisEvents ?? noRedisEvents).publishAuthStateChanged(userId),
    rateLimit,
  }
}

function createAdminAuth(pool: Pool, config: WebUiConfig) {
  const versions = createRedisAdminAuthVersionStore(config.redisUrl)
  const limiter = createRedisRateLimiter(
    config.redisUrl ? createRedisRateLimitCommands(config.redisUrl) : null,
  )
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
        'INSERT INTO audit_logs (username, action, description, ip) VALUES ($1, $2, $3, $4)',
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
) {
  const publisher = redisEvents ?? noRedisEvents
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
  const projectCreate = createProjectCreator(createPostgresProjectCreateRuntime(pool, publishProjectMutation))
  const projectUpdate = config.storageBackend === 'local'
    ? createProjectUpdater(createPostgresProjectUpdateRuntime(
      pool,
      createLocalProjectDirectoryRenamer(config.storageLocalPath),
      publishProjectMutation,
    ))
    : undefined
  const projectTrash = createProjectTrashService(
    createPostgresProjectTrashRuntime(pool, publishProjectMutation),
    config.storageBackend === 'local'
      ? createLocalProjectTrashStorage(
        config.storageLocalPath,
        createProjectTrashOriginalStorageKeyResolver(createPostgresProjectTrashPathMetadataReader(pool)),
      )
      : createOssProjectTrashStorage(
        createProjectTrashOriginalStorageKeyResolver(createPostgresProjectTrashPathMetadataReader(pool)),
      ),
  )
  const eventStore = createPostgresEventCreateStore(pool, createCalendarEventPostCommitPublisher(pool, {
    bumpContextRevision: (ownerId) => publisher.bumpContextRevision(ownerId, 'calendar'),
    publishResourceChanged: (event) => publisher.publishResourceChanged(event),
  }))
  const publishCalendarMutation = createCalendarMutationPostCommitPublisher(pool, {
    bumpContextRevision: (ownerId) => publisher.bumpContextRevision(ownerId, 'calendar'),
    publishResourceChanged: (publication) => publisher.publishResourceChanged(publication),
  })
  const eventDeleteStore = createPostgresEventDeleteStore(pool, publishCalendarMutation)
  const eventUpdateStore = createPostgresEventUpdateStore(pool, publishCalendarMutation)
  const eventCreate = (context: RequestContext, input: unknown, metadata: WriteRequestMetadata) =>
    createCalendarEvent(eventStore, {
      ownerId: context.data.ownerId,
      input,
      idempotencyKey: metadata.idempotencyKey,
      undoContextId: metadata.undoContextId,
      clientId: metadata.clientId,
    })
  const workspaceRuntime = {
    workspaceShellSupported: () => config.storageBackend === 'local',
  }
  const workspaceCreate = createPostgresWorkspaceCreator(pool, workspaceRuntime)
  const workspaceUpdate = createPostgresWorkspaceUpdater(pool, workspaceRuntime)
  const workspaceBindings = createPostgresWorkspaceBindingOperations(pool, workspaceRuntime)
  const workspaceDelete = createPostgresWorkspaceDeleter(pool, workspaceRuntime)
  const workspaceDirectories = createPostgresWorkspaceDirectoryOperations(pool, {
    storageBackend: config.storageBackend,
    localPath: config.storageLocalPath,
    prepareDirectoryAcl: prepareWorkspaceDirectoryAcl,
    terminateActivePty: createSandboxdWorkspacePtyTerminator(pool, config.sandboxdSocket),
  })
  const workspaceList = createPostgresWorkspaceLister(pool, {
    readRuntimeSettings: () => ({
      ...config.workspaceRuntimeSettings,
      storageBackend: config.storageBackend,
      // Node's Host has no sandbox daemon readiness probe yet; keep shell/PTY capability off.
      sandboxReady: false,
    }),
  })
  const userRepository = createUserRepository(pool)
  const rateLimit = createRedisRateLimiter(
    config.redisUrl ? createRedisRateLimitCommands(config.redisUrl) : null,
  )
  const registrationCodeStore = config.redisUrl
    ? createRedisRegistrationCodeStore(
      createRedisRegistrationCodeCommands(config.redisUrl),
      config.secretKey,
    )
    : undefined
  const logsDirectory = config.logFile
    ? dirname(config.logFile)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../backend/logs')
  const logPath = (name: string) => resolve(logsDirectory, `gugu-${name}.log`)
  return createApp({
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
      redisEvents,
      rateLimit,
    ),
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
      // No Node SMTP sender is wired yet; omission makes the route return an explicit 503.
    },
    profile: {
      pool,
      secret: config.secretKey,
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
      ...createEventOperations(pool),
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
    createWorkspace: (ownerId, input) => workspaceCreate(ownerId, input as Fields),
    workspaceBindings,
    updateWorkspace: (ownerId, workspaceId, input) => workspaceUpdate(ownerId, workspaceId, input as Fields),
    deleteWorkspace: workspaceDelete,
    listWorkspaces: workspaceList,
    workspaceDirectories,
    adminAuth: createAdminAuth(pool, config),
    adminStorageSnapshots: {
      query: createPostgresAdminStorageSnapshotQuery(pool),
      diskUsage: () => diskUsageForStorage({
        backend: config.storageBackend,
        localPath: config.storageLocalPath,
      }),
    },
    adminUsers: {
      query: createPostgresAdminUsersQuery(pool),
      storageBackend: config.storageBackend,
    },
    adminUserRisk: {
      query: createPostgresAdminUserRiskQuery(pool),
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
          'INSERT INTO audit_logs (username, action, description, ip) VALUES ($1, $2, $3, $4)',
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
    notifications: createNotificationOperations(pool),
    track: createTrackOperations(pool),
  })
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
  const config = loadConfig(env)
  const pool = createPool(config)
  const redisEvents = config.redisUrl ? createRedisEventPublisher(config.redisUrl) : undefined
  let core: SqlDataRuntime
  try {
    core = await createPostgresRuntime({ url: config.databaseUrl, maxConnections: config.postgresPoolMax })
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw error
  }
  const app = createWebUiApp(config, pool, core, redisEvents)
  try {
    await listen(app, config.host, config.port)
  } catch (error) {
    await core.close().catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw error
  }

  let closePromise: Promise<void> | undefined
  return {
    app,
    pool,
    close() {
      closePromise ??= (async () => {
        await app.close()
        await core.close()
        await pool.end()
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
