import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Pool } from 'pg'
import { after, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createPostgresFileContentOperations } from '../../src/domains/files/file-content-postgres.js'
import { createPostgresFileDeleteOperations } from '../../src/domains/files/file-delete-postgres.js'
import { createProjectUpdater } from '../../src/domains/projects/application/project-update.js'
import { createProjectTrashService } from '../../src/domains/projects/application/project-trash.js'
import {
  createLocalProjectTrashStorage,
  createProjectTrashOriginalStorageKeyResolver,
} from '../../src/domains/projects/persistence/project-trash-storage.js'
import { createPostgresProjectTrashPathMetadataReader } from '../../src/domains/projects/persistence/project-trash-path-metadata-postgres.js'
import { createPostgresProjectTrashRuntime } from '../../src/domains/projects/persistence/project-trash-postgres.js'
import { createPostgresProjectUpdateRuntime } from '../../src/domains/projects/persistence/project-update-postgres.js'
import { createCalendarEvent } from '../../src/domains/calendar/application/event-create.js'
import { createPostgresEventCreateStore } from '../../src/domains/calendar/persistence/event-create-postgres.js'
import { createCalendarEventPostCommitPublisher } from '../../src/domains/calendar/persistence/calendar-create-post-commit-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000071'
const secret = 'synthetic-project-calendar-vite-secret'
const apps: Array<{ close(): Promise<void> }> = []
const viteServers: Array<{ close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } }> = []
const pools: Pool[] = []
const storageRoots: string[] = []
let adminPool: Pool | undefined
let schema: string | undefined

after(async () => {
  await Promise.all(viteServers.splice(0).map((server) => server.close()))
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(pools.splice(0).map((pool) => pool.end()))
  await Promise.all(storageRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  if (adminPool && schema) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
  await adminPool?.end()
})

test('Vite→Node Host→随机 PostgreSQL schema 完成项目、日历与正文保存主链路', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL HTTP 集成',
}, async () => {
  schema = `gugu_project_calendar_http_${randomUUID().replaceAll('-', '')}`
  adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  pools.push(pool)

  await pool.query(`
    CREATE TABLE projects (
      id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL,
      summary varchar(200), contact_name varchar(200), status varchar(20) NOT NULL,
      start_date varchar(10), deadline varchar(10), color varchar(300) NOT NULL,
      progress integer NOT NULL, stages_json text NOT NULL, current_stage varchar(100),
      priority varchar(20), version integer NOT NULL, archived boolean NOT NULL,
      done_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      deleted_at timestamptz
    );
    CREATE TABLE files (
      id serial PRIMARY KEY, user_id uuid NOT NULL, display_name varchar(300) NOT NULL,
      ext varchar(20) NOT NULL, space varchar(20) NOT NULL, project_id integer, folder_id integer,
      workspace_directory_id integer, stage_name varchar(100), mind_map_id integer,
      storage_key varchar(500) NOT NULL, version integer NOT NULL, size varchar(50),
      size_bytes bigint NOT NULL, mime_type varchar(200), img_width integer, img_height integer,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz
    );
    CREATE TABLE folders (
      id serial PRIMARY KEY, user_id uuid NOT NULL, project_id integer, workspace_directory_id integer,
      parent_id integer, name varchar(200) NOT NULL, version integer NOT NULL, deleted_at timestamptz
    );
    CREATE TABLE calendar_events (
      id serial PRIMARY KEY, user_id uuid NOT NULL, title varchar(300) NOT NULL,
      date varchar(10) NOT NULL, time varchar(5), end_time varchar(5), type varchar(50) NOT NULL,
      contact_name varchar(200), project_id integer, description text, version integer NOT NULL,
      created_at timestamptz NOT NULL, deleted_at timestamptz,
      idempotency_key varchar(64), idempotency_fingerprint varchar(64),
      CONSTRAINT uq_calendar_events_user_idempotency_key UNIQUE(user_id, idempotency_key)
    );
    CREATE TABLE scheduled_tasks (
      id serial PRIMARY KEY, user_id uuid, event_id integer, enabled boolean NOT NULL,
      name varchar(100) NOT NULL, payload text NOT NULL, cron varchar(60) NOT NULL,
      schedule_kind varchar(16) NOT NULL, start_at timestamptz,
      reminder_lead_minutes integer, channels varchar(40) NOT NULL, delivery_targets jsonb
    );
    CREATE TABLE project_file_counts (project_id integer PRIMARY KEY, file_count bigint NOT NULL);
    CREATE TABLE undo_operations (
      id varchar(80) PRIMARY KEY, user_id uuid NOT NULL, undo_context_id varchar(128) NOT NULL,
      group_id varchar(80) NOT NULL, resource varchar(32) NOT NULL, action varchar(32) NOT NULL,
      target_refs json NOT NULL, before_state json NOT NULL, after_state json NOT NULL,
      base_versions json NOT NULL, artifact_refs json NOT NULL, actor_type varchar(32) NOT NULL,
      status varchar(24) NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
      undone_at timestamptz, failure_code varchar(80)
    );
    CREATE TABLE rag_index_jobs (
      id serial PRIMARY KEY, user_id uuid NOT NULL, source_type varchar(32) NOT NULL,
      source_id varchar(255) NOT NULL DEFAULT '', version varchar(64) NOT NULL DEFAULT '',
      operation varchar(24) NOT NULL DEFAULT 'upsert', status varchar(16) NOT NULL DEFAULT 'queued',
      generation integer NOT NULL DEFAULT 1, completed_generation integer NOT NULL DEFAULT 0,
      attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz, lease_until timestamptz,
      last_started_at timestamptz, last_succeeded_at timestamptz, last_error_code varchar(64),
      pending_source_ids json, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      CONSTRAINT uq_rag_index_job_user_source UNIQUE(user_id, source_type)
    );
  `)

  const stamp = new Date().toISOString()
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO projects (
      user_id,name,status,start_date,color,progress,stages_json,version,archived,created_at,updated_at
    ) VALUES ($1,'旧项目','pending','2026-11-01','lavender',0,'[]',1,FALSE,$2,$2) RETURNING id`,
    [ownerId, stamp],
  )
  const projectId = inserted.rows[0]!.id
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-project-calendar-vite-'))
  storageRoots.push(storageRoot)
  const fileKey = `${ownerId}/个人文件/vite.md`
  const fileOnDisk = join(storageRoot, fileKey)
  await mkdir(join(storageRoot, ownerId, '个人文件'), { recursive: true })
  await writeFile(fileOnDisk, '旧正文')
  const fileInserted = await pool.query<{ id: number }>(
    `INSERT INTO files (user_id,display_name,ext,space,stage_name,storage_key,version,size,size_bytes,
       mime_type,created_at,updated_at)
     VALUES ($1,'Vite 文档','md','personal','',$2,1,'6 B',6,'text/markdown',$3,$3) RETURNING id`,
    [ownerId, fileKey, stamp],
  )
  const fileId = fileInserted.rows[0]!.id

  const projectEvents: string[] = []
  const updateRuntime = createPostgresProjectUpdateRuntime(
    pool,
    async () => {},
    async (event) => {
      const committed = await pool.query('SELECT version FROM projects WHERE id=$1', [projectId])
      assert.equal(committed.rows[0]?.version, 2, '项目事件只能在 PATCH 事务提交后发布')
      projectEvents.push(event.operation)
    },
  )
  const trashRuntime = createPostgresProjectTrashRuntime(pool, async (event) => {
    projectEvents.push(`${event.resource}:${event.operation}`)
  })
  const trashStorage = createLocalProjectTrashStorage(
    storageRoot,
    createProjectTrashOriginalStorageKeyResolver(createPostgresProjectTrashPathMetadataReader(pool)),
  )
  const trash = createProjectTrashService(trashRuntime, trashStorage)
  const postCommit = createCalendarEventPostCommitPublisher({
    async bumpContextRevision(id) { assert.equal(id, ownerId) },
    async publishResourceChanged(event) {
      const job = await pool.query(
        `SELECT source_id FROM rag_index_jobs WHERE user_id=$1 AND source_type='calendar'`, [ownerId],
      )
      assert.equal(job.rows[0]?.source_id, String(event.entityId), 'RAG job 必须在提交后 live event 前可见')
    },
  }, (operation) => { throw new Error(`post-commit effect failed: ${operation}`) })
  const eventStore = createPostgresEventCreateStore(pool, postCommit)
  const fileEvents: number[] = []
  const fileDeleteEvents: number[] = []
  const app = createApp({
    appName: '合成集成测试 Host',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    updateProject: createProjectUpdater(updateRuntime),
    deleteProject: (owner, id, metadata) => trash.deleteProject(owner, id, metadata),
    restoreProject: (owner, id, metadata) => trash.restoreProject(owner, id, metadata),
    fileDeletes: createPostgresFileDeleteOperations(pool, {
      storageRoot,
      async publishChanged(event) {
        const committed = await pool.query<{ storage_key: string; deleted_at: Date | null; version: number }>(
          'SELECT storage_key,deleted_at,version FROM files WHERE id=$1 AND user_id=$2', [event.entityId, event.ownerId],
        )
        assert.equal(committed.rows[0]?.storage_key, `${ownerId}/trash/Vite 文档.md`)
        assert.ok(committed.rows[0]?.deleted_at)
        assert.equal(committed.rows[0]?.version, 3, '删除事件只能在版本提交后发布')
        fileDeleteEvents.push(event.entityId)
      },
    }),
    fileContents: createPostgresFileContentOperations(pool, {
      storageRoot,
      fileSyncEnabled: false,
      async publishChanged(event) {
        const committed = await pool.query('SELECT version FROM files WHERE id=$1 AND user_id=$2', [event.entityId, event.ownerId])
        assert.equal(committed.rows[0]?.version, 2, '正文事件只能在文件事务提交后发布')
        fileEvents.push(event.entityId)
      },
    }),
    events: {
      async list() { return [] },
      async get() { return null },
      async create(context, input, metadata) {
        const result = await createCalendarEvent(eventStore, {
          ownerId: context.data.ownerId,
          input,
          idempotencyKey: metadata.idempotencyKey,
          undoContextId: metadata.undoContextId,
          clientId: metadata.clientId,
        })
        return result.event
      },
    },
  })
  apps.push(app)
  const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
  const previousTarget = process.env.VITE_API_PROXY_TARGET
  process.env.VITE_API_PROXY_TARGET = hostAddress

  try {
    const frontendRoot = resolve(process.cwd(), '../web')
    const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
    const viteModule = requireFrontend('vite') as {
      createServer(options: Record<string, unknown>): Promise<{
        listen(): Promise<void>
        close(): Promise<void>
        httpServer?: { address(): string | { port: number } | null }
      }>
    }
    const vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    viteServers.push(vite)
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const token = createUserToken(ownerId, 1, secret)
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-undo-context-id': 'vite-integration-tab',
      'x-client-id': 'vite-integration-client',
    }

    const unauthenticated = await fetch(`${base}/api/v1/projects/${projectId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, name: '未认证写入' }),
    })
    assert.equal(unauthenticated.status, 401)

    const update = await fetch(`${base}/api/v1/projects/${projectId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ version: 1, name: '已更新项目' }),
    })
    assert.equal(update.status, 200)
    assert.equal((await update.json() as { version: number }).version, 2)

    const projectFileKey = `${ownerId}/项目文件/2026/11/已更新项目 #${projectId}/关联文档.md`
    const projectFilePath = join(storageRoot, ...projectFileKey.split('/'))
    await mkdir(dirname(projectFilePath), { recursive: true })
    await writeFile(projectFilePath, '项目关联正文')
    const projectFileInserted = await pool.query<{ id: number }>(
      `INSERT INTO files (
         user_id,display_name,ext,space,project_id,stage_name,storage_key,version,
         size,size_bytes,mime_type,created_at,updated_at
       ) VALUES ($1,'关联文档','md','project',$2,'',$3,1,'18 B',18,'text/markdown',$4,$4)
       RETURNING id`,
      [ownerId, projectId, projectFileKey, stamp],
    )
    const projectFileId = projectFileInserted.rows[0]!.id

    const unauthenticatedFileWrite = await fetch(`${base}/api/v1/files/${fileId}/content`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '未认证正文', version: 1 }),
    })
    assert.equal(unauthenticatedFileWrite.status, 401)
    const fileWrite = await fetch(`${base}/api/v1/files/${fileId}/content`, {
      method: 'PUT', headers, body: JSON.stringify({ content: '更新正文', version: 1 }),
    })
    assert.equal(fileWrite.status, 200)
    assert.equal((await fileWrite.json() as { version: number }).version, 2)
    const persistedFile = await pool.query<{ version: number; size_bytes: number }>(
      'SELECT version,size_bytes::int FROM files WHERE id=$1 AND user_id=$2', [fileId, ownerId],
    )
    assert.deepEqual(persistedFile.rows[0], { version: 2, size_bytes: Buffer.byteLength('更新正文') })
    assert.equal(await readFile(fileOnDisk, 'utf8'), '更新正文')
    assert.deepEqual(fileEvents, [fileId])

    const unauthenticatedFileDelete = await fetch(`${base}/api/v1/files/${fileId}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
    })
    assert.equal(unauthenticatedFileDelete.status, 401)
    const fileDelete = await fetch(`${base}/api/v1/files/${fileId}`, { method: 'DELETE', headers })
    assert.equal(fileDelete.status, 204)
    const deletedFile = await pool.query<{ storage_key: string; version: number; deleted_at: Date | null }>(
      'SELECT storage_key,version,deleted_at FROM files WHERE id=$1 AND user_id=$2', [fileId, ownerId],
    )
    assert.equal(deletedFile.rows[0]?.storage_key, `${ownerId}/trash/Vite 文档.md`)
    assert.equal(deletedFile.rows[0]?.version, 3)
    assert.ok(deletedFile.rows[0]?.deleted_at)
    assert.equal(await readFile(join(storageRoot, ownerId, 'trash', 'Vite 文档.md'), 'utf8'), '更新正文')
    const fileUndo = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM undo_operations
       WHERE user_id=$1 AND undo_context_id='vite-integration-tab' AND resource='files' AND action='delete'`, [ownerId],
    )
    assert.equal(fileUndo.rows[0]?.count, 1)
    assert.deepEqual(fileDeleteEvents, [fileId])

    const create = await fetch(`${base}/api/v1/events`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: '项目交付', date: '2026-11-14', type: 'deadline', projectId }),
    })
    assert.equal(create.status, 201)
    const created = await create.json() as { id: number }

    const deletion = await fetch(`${base}/api/v1/projects/${projectId}`, {
      method: 'DELETE', headers,
    })
    assert.equal(deletion.status, 204)
    const deletedProjectFile = await pool.query<{
      storage_key: string; version: number; deleted_at: Date | null
    }>('SELECT storage_key,version,deleted_at FROM files WHERE id=$1 AND user_id=$2', [projectFileId, ownerId])
    const projectFileTrashKey = `${ownerId}/trash/2026/11/已更新项目 #${projectId}/关联文档.md`
    assert.equal(deletedProjectFile.rows[0]?.storage_key, projectFileTrashKey)
    assert.equal(deletedProjectFile.rows[0]?.version, 2)
    assert.ok(deletedProjectFile.rows[0]?.deleted_at)
    assert.equal(await readFile(join(storageRoot, ...projectFileTrashKey.split('/')), 'utf8'), '项目关联正文')
    await assert.rejects(readFile(projectFilePath), { code: 'ENOENT' })
    const deleted = await pool.query<{ project_deleted: Date | null; event_deleted: Date | null }>(
      `SELECT project.deleted_at AS project_deleted, event.deleted_at AS event_deleted
       FROM projects project JOIN calendar_events event ON event.project_id=project.id
       WHERE project.id=$1 AND event.id=$2`, [projectId, created.id],
    )
    assert.ok(deleted.rows[0]?.project_deleted)
    assert.ok(deleted.rows[0]?.event_deleted)

    const restore = await fetch(`${base}/api/v1/projects/${projectId}/restore`, {
      method: 'POST', headers,
    })
    assert.equal(restore.status, 200)
    const active = await pool.query<{ project_version: number; project_deleted: Date | null; event_version: number; event_deleted: Date | null }>(
      `SELECT project.version AS project_version, project.deleted_at AS project_deleted,
              event.version AS event_version, event.deleted_at AS event_deleted
       FROM projects project JOIN calendar_events event ON event.project_id=project.id
       WHERE project.id=$1 AND event.id=$2`, [projectId, created.id],
    )
    assert.deepEqual(active.rows[0], {
      project_version: 4, project_deleted: null, event_version: 3, event_deleted: null,
    })
    const restoredProjectFile = await pool.query<{
      storage_key: string; version: number; deleted_at: Date | null
    }>('SELECT storage_key,version,deleted_at FROM files WHERE id=$1 AND user_id=$2', [projectFileId, ownerId])
    assert.deepEqual(restoredProjectFile.rows[0], {
      storage_key: projectFileKey, version: 3, deleted_at: null,
    })
    assert.equal(await readFile(projectFilePath, 'utf8'), '项目关联正文')
    await assert.rejects(readFile(join(storageRoot, ...projectFileTrashKey.split('/'))), { code: 'ENOENT' })
    assert.deepEqual(projectEvents, [
      'update', 'projects:delete', 'files:delete', 'calendar:delete',
      'projects:create', 'files:create', 'calendar:create',
    ])
    const undo = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM undo_operations WHERE user_id=$1 AND undo_context_id='vite-integration-tab'`,
      [ownerId],
    )
    assert.equal(undo.rows[0]?.count, 5)
  } finally {
    if (previousTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousTarget
  }
})
