import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { createPostgresRuntime, type SqlDataRuntime } from '@gugu/core/data'
import type { Fields, RequestContext } from '@gugu/core'
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
import { createPostgresOnboardingStore } from './domains/onboarding/persistence/postgres.js'
import { createRegistrationSeeder } from './domains/onboarding/registration-seed.js'
import { createPostgresRegistrationSeedOperations } from './domains/onboarding/persistence/registration-seed-postgres.js'
import { createOnboardingSurpriseMp3Reader } from './domains/onboarding/surprise-asset.js'
import { createRedisRegistrationCodeStore } from './domains/auth/persistence/registration-codes.js'
import { createPostgresRegistrationOperations } from './domains/auth/persistence/registration.js'
import { createPostgresPasswordResetStore } from './domains/auth/password-reset.js'
import { createPostgresEmailChangeStore } from './domains/auth/email-change.js'
import { createAuthEmailSender } from './domains/auth/smtp-email.js'
import { projectResponse, createProjectFileCountListing, createProjectGetter, createProjectListing } from './domains/projects/persistence/projects.js'
import { createClientOperations } from './domains/clients/persistence/clients.js'
import { createEventOperations } from './domains/calendar/persistence/events.js'
import { createPostgresMindNoteReader } from './domains/mind/mind-notes-read.js'
import { createPostgresMindCanvasReader } from './domains/mind/mind-canvas-read.js'
import { createPostgresMindRefSuggestOperations } from './domains/mind/persistence/mind-ref-suggest-postgres.js'
import { createMindCanvasMutations } from './domains/mind/application/mind-canvas-mutations.js'
import { createPostgresMindCanvasMutationRuntime } from './domains/mind/persistence/mind-canvas-mutations-postgres.js'
import { createMindCanvasNoteMutations } from './domains/mind/application/mind-canvas-note-mutations.js'
import { createPostgresMindCanvasNoteMutationRuntime } from './domains/mind/persistence/mind-canvas-note-mutations-postgres.js'
import { createMindCanvasItemMutations } from './domains/mind/application/mind-canvas-item-mutations.js'
import { createPostgresMindCanvasItemMutationRuntime } from './domains/mind/persistence/mind-canvas-item-mutations-postgres.js'
import { createMindCanvasRelationMutations } from './domains/mind/application/mind-canvas-relation-mutations.js'
import { createPostgresMindCanvasRelationMutationRuntime } from './domains/mind/persistence/mind-canvas-relation-mutations-postgres.js'
import { createMindRefNodeCreator } from './domains/mind/application/mind-ref-node-create.js'
import { createPostgresMindRefNodeCreateRuntime } from './domains/mind/persistence/mind-ref-node-create-postgres.js'
import { createMindNoteCreator } from './domains/mind/application/mind-note-create.js'
import { createPostgresMindNoteInserter } from './domains/mind/persistence/mind-note-create-postgres.js'
import { createMindNoteMutations } from './domains/mind/application/mind-note-mutations.js'
import { createPostgresMindNoteMutator } from './domains/mind/persistence/mind-note-mutations-postgres.js'
import { createNotificationOperations } from './domains/notifications/persistence/notifications.js'
import { createTrackOperations } from './domains/site/persistence/track.js'
import { createPostgresFeedbackOperations } from './domains/feedback/persistence/postgres.js'
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
import { createPostgresAgentInteractionHistory } from './domains/agent-sessions/persistence/agent-interaction-history.js'
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
import { agentCommandMenu, DEFAULT_AGENT_STATE_LABELS } from './domains/agent-sessions/agent-misc.js'
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
import { createPostgresGlobalSearchOperations } from './domains/search/search-postgres.js'
import { createPostgresFolderReadOperations } from './domains/files/folder-reads-postgres.js'
import { capturePostgresFolderPathMirrorDirectoryKeys, createPostgresFolderPathMirrorPlanner } from './domains/files/folder-path-planner.js'
import { createLocalPathMirrorMutation } from './domains/files/local-path-mirror.js'
import { createPostgresFolderWriteOperations, type FolderUndoRecord } from './domains/files/folder-writes-postgres.js'
import { prepareWorkspaceDirectoryAcl } from './adapters/workspace-directory-acl.js'
import { createSandboxdWorkspacePtyTerminator } from './adapters/sandboxd-pty.js'
import {
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
  redisEvents?: RedisEventPublisher,
  rateLimit = createRedisRateLimiter(null),
  quotaSettings?: UserQuotaSettings,
): UserAuthOptions {
  return {
    secret,
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
  const versions = createInMemoryAdminAuthVersionStore()
  const limiter = createRedisRateLimiter(createInMemoryRateLimitCommands())
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
  env: NodeJS.ProcessEnv = process.env,
) {
  const publisher = redisEvents ?? noRedisEvents
  const createMindNote = createMindNoteCreator({
    insert: createPostgresMindNoteInserter(pool),
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
    ...createPostgresMindNoteMutator(pool),
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
  const mindCanvasMutations = createMindCanvasMutations(createPostgresMindCanvasMutationRuntime(
    pool,
    async ({ ownerId, operation, entityId, origin, entity }) => {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation,
        entityId,
        origin,
        payload: { kind: 'canvas', entity },
      })
    },
    (operation) => {
      console.error(`gugu-webui ${operation} failed`)
    },
  ))
  const mindCanvasNoteMutations = createMindCanvasNoteMutations(createPostgresMindCanvasNoteMutationRuntime(
    pool,
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
  const mindCanvasItemMutations = createMindCanvasItemMutations(createPostgresMindCanvasItemMutationRuntime(
    pool,
    async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation,
        entityId,
        origin,
        mutationId,
        payload: { kind: 'canvas_item', entity },
      })
    },
    (operation) => {
      console.error(`gugu-webui ${operation} failed`)
    },
  ))
  const mindCanvasRelationMutations = createMindCanvasRelationMutations(createPostgresMindCanvasRelationMutationRuntime(
    pool,
    async ({ ownerId, operation, entityId, origin, mutationId, entity }) => {
      await publisher.publishResourceChanged({
        ownerId,
        resource: 'mind',
        operation,
        entityId,
        origin,
        mutationId,
        payload: { kind: 'relation', entity },
      })
    },
    (operation) => {
      console.error(`gugu-webui ${operation} failed`)
    },
  ))
  const mindRefNodeCreator = createMindRefNodeCreator(createPostgresMindRefNodeCreateRuntime(
    pool,
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
  const globalSearch = createPostgresGlobalSearchOperations(pool)
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
  const projectCreate = createProjectCreator(createPostgresProjectCreateRuntime(pool, publishProjectMutation))
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
  const eventStore = createPostgresEventCreateStore(pool, createCalendarEventPostCommitPublisher({
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
    listInteractions: createPostgresAgentInteractionHistory(pool).list,
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
      resolve(dirname(fileURLToPath(import.meta.url)), '../../backend/onboarding/assets'),
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
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../backend/logs')
  const logPath = (name: string) => resolve(logsDirectory, `gugu-${name}.log`)
  const feedback = createPostgresFeedbackOperations(pool)
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
      storageRoot: config.storageLocalPath,
      secretKey: config.secretKey,
      personalityPreferenceAvailable: config.personalityPreferenceEnabled,
      bumpContextRevision: (ownerId, resource) => publisher.bumpContextRevision(ownerId, resource),
    }),
    onboarding: createPostgresOnboardingStore(pool),
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
    mindNotes: createPostgresMindNoteReader(pool),
    mindCanvasReads: createPostgresMindCanvasReader(pool),
    mindRefSuggest,
    mindCanvasMutations: {
      create: (ownerId, input, metadata) => mindCanvasMutations.create(ownerId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      }),
      update: (ownerId, canvasId, input, metadata) => mindCanvasMutations.update(ownerId, canvasId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
      }),
      delete: (ownerId, canvasId, metadata) => mindCanvasMutations.delete(ownerId, canvasId, {
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
      add: (ownerId, canvasId, input, metadata) => mindCanvasItemMutations.add(ownerId, canvasId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      update: (ownerId, canvasId, itemId, input, metadata) => mindCanvasItemMutations.update(ownerId, canvasId, itemId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      bringToFront: (ownerId, canvasId, itemId, input, metadata) => mindCanvasItemMutations.bringToFront(ownerId, canvasId, itemId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      remove: (ownerId, canvasId, itemId, metadata) => mindCanvasItemMutations.remove(ownerId, canvasId, itemId, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
    },
    mindCanvasRelationMutations: {
      create: (ownerId, input, metadata) => mindCanvasRelationMutations.create(ownerId, input, {
        undoContextId: metadata.undoContextId,
        clientId: metadata.clientId,
        mutationId: metadata.mutationId,
      }),
      delete: (ownerId, canvasId, relationId, metadata) => mindCanvasRelationMutations.delete(
        ownerId, canvasId, relationId, {
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
          mutationId: metadata.mutationId,
        },
      ),
      deleteGlobal: (ownerId, relationId, metadata) => mindCanvasRelationMutations.deleteGlobal(
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
      stateLabelOverrides() {
        if (!config.configOverridePath) return {}
        const stateLabels = readConfigOverride(config.configOverridePath).state_labels
        if (!stateLabels || typeof stateLabels !== 'object' || Array.isArray(stateLabels)) return {}
        const rawOverrides = (stateLabels as Record<string, unknown>).overrides
        if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) return {}
        return Object.fromEntries(Object.entries(rawOverrides)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      },
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
