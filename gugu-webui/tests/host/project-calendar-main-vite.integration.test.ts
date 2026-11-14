import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { startServer } from '../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '00000000-0000-4000-8000-000000000072'
const secret = 'synthetic-main-composition-secret'

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose())
  })
  return address.port
}

test('Vite→生产 main.ts→Node Host→隔离 PostgreSQL 完成项目与日历写入', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL 集成',
}, async () => {
  const schema = `gugu_project_main_http_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)

  const scopedUrl = new URL(databaseUrl!)
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scopedUrl.toString(), max: 4 })
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'gugu-project-main-vite-'))
  const storageRoot = join(temporaryRoot, 'users')
  const overridePath = join(temporaryRoot, 'config.override.json')
  const viteServers: Array<{ listen(): Promise<void>; close(): Promise<void> }> = []
  let viteApiTarget: string | undefined
  let host: Awaited<ReturnType<typeof startServer>> | undefined

  try {
    await writeFile(overridePath, '{}\n', 'utf8')
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY, username text NOT NULL, display_name text, email text NOT NULL,
        is_active boolean NOT NULL, account_status text, security_version integer,
        avatar text, created_at timestamptz, timezone text, email_subscribed boolean,
        is_developer boolean NOT NULL DEFAULT FALSE, last_active_at timestamptz,
        storage_limit_bytes bigint, hashed_password text
      );
      CREATE TABLE user_bots (user_id uuid NOT NULL, platform text NOT NULL, enabled boolean NOT NULL);
      CREATE TABLE user_preferences (user_id uuid NOT NULL, data_json jsonb, updated_at timestamptz);
      CREATE TABLE agent_usage (id serial PRIMARY KEY, user_id uuid, tokens_in bigint, tokens_out bigint,
        created_at timestamptz, is_byok boolean);
      CREATE TABLE storage_quota_ledgers (user_id uuid, category text, used_bytes bigint);
      CREATE TABLE projects (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL,
        summary varchar(200), contact_name varchar(200), status varchar(20) NOT NULL,
        start_date varchar(10), deadline varchar(10), color varchar(300) NOT NULL,
        progress integer NOT NULL, stages_json text NOT NULL, current_stage varchar(100),
        priority varchar(20), version integer NOT NULL, archived boolean NOT NULL,
        done_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        deleted_at timestamptz, idempotency_key varchar(64), idempotency_fingerprint varchar(64)
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
      CREATE TABLE clients (
        id serial PRIMARY KEY, user_id uuid NOT NULL, name varchar(200) NOT NULL,
        contact varchar(200), email varchar(300), phone varchar(100), notes text NOT NULL,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE site_notifications (
        id serial PRIMARY KEY, title text, content text, color text, target text,
        bubble boolean, persist boolean, bubble_expire_at timestamptz, created_at timestamptz
      );
      CREATE TABLE notification_reads (id serial PRIMARY KEY, user_id uuid, notification_id integer, read_at timestamptz);
      CREATE TABLE notification_dismissals (
        id serial PRIMARY KEY, user_id uuid, notification_id integer, dismissed_at timestamptz
      );
      CREATE TABLE frontend_events (
        id serial PRIMARY KEY, user_id uuid, event text, properties jsonb, created_at timestamptz
      );
      CREATE TABLE workspaces (
        id serial PRIMARY KEY, user_id uuid, name text, kind text, folder_id integer,
        project_id integer, directory_id integer, enabled boolean, is_default boolean,
        created_at timestamptz, updated_at timestamptz
      );
      CREATE TABLE workspace_directories (
        id serial PRIMARY KEY, user_id uuid, name text, directory_name text,
        is_default boolean, is_system boolean, deleted_at timestamptz,
        created_at timestamptz, updated_at timestamptz
      );
      CREATE TABLE audit_logs (
        id serial PRIMARY KEY, user_id uuid, username text, action text,
        description text, ip text, created_at timestamptz
      );
      CREATE TABLE storage_category_snapshots (
        category text, taken_at timestamptz, object_count bigint, total_bytes bigint
      );
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

    const stamp = new Date('2026-11-14T00:00:00.000Z')
    await pool.query(
      `INSERT INTO users (
         id, username, display_name, email, is_active, account_status, security_version,
         created_at, timezone, email_subscribed
       ) VALUES ($1, 'sample', '示例用户', 'sample@example.invalid', TRUE, 'active', 1, $2, 'UTC', FALSE)`,
      [ownerId, stamp],
    )
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO projects (
         user_id,name,status,start_date,color,progress,stages_json,version,archived,created_at,updated_at
       ) VALUES ($1,'旧项目','pending','2026-11-01','lavender',0,'[]',1,FALSE,$2,$2) RETURNING id`,
      [ownerId, stamp],
    )
    const projectId = inserted.rows[0]!.id
    const oldProjectKey = `${ownerId}/项目文件/2026/11/旧项目 #${projectId}`
    const newProjectKey = `${ownerId}/项目文件/2026/11/已更新项目 #${projectId}`
    const projectFileKey = `${oldProjectKey}/关联文档.md`
    const projectFilePath = join(storageRoot, ...projectFileKey.split('/'))
    await mkdir(dirname(projectFilePath), { recursive: true })
    await writeFile(projectFilePath, '合成项目文件')
    await pool.query(
      `INSERT INTO files (
         user_id,display_name,ext,space,project_id,stage_name,storage_key,version,
         size,size_bytes,mime_type,created_at,updated_at
       ) VALUES ($1,'关联文档','md','project',$2,'',$3,1,'18 B',18,'text/markdown',$4,$4)`,
      [ownerId, projectId, projectFileKey, stamp],
    )

    const port = await freePort()
    host = await startServer({
      GUGU_WEBUI_DATABASE_URL: scopedUrl.toString(),
      GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: overridePath,
      GUGU_WEBUI_HOST: '127.0.0.1',
      GUGU_WEBUI_PORT: String(port),
      GUGU_WEBUI_REDIS_URL: '',
      STORAGE__LOCAL_PATH: storageRoot,
    })

    const previousTarget = process.env.VITE_API_PROXY_TARGET
    viteApiTarget = previousTarget
    process.env.VITE_API_PROXY_TARGET = `http://127.0.0.1:${port}`
    try {
      const frontendRoot = resolve(process.cwd(), '../frontend')
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
      const headers = {
        authorization: `Bearer ${createUserToken(ownerId, 1, secret)}`,
        'content-type': 'application/json',
        'x-undo-context-id': 'main-composition-vite-tab',
        'x-client-id': 'main-composition-vite-client',
      }

      const readiness = await fetch(`http://127.0.0.1:${port}/health/ready`)
      assert.equal(readiness.status, 200)

      const update = await fetch(`${base}/api/v1/projects/${projectId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ version: 1, name: '已更新项目' }),
      })
      assert.equal(update.status, 200)
      assert.equal((await update.json() as { version: number }).version, 2)
      assert.equal(await readFile(join(storageRoot, ...newProjectKey.split('/'), '关联文档.md'), 'utf8'), '合成项目文件')
      await assert.rejects(readFile(projectFilePath), { code: 'ENOENT' })

      const create = await fetch(`${base}/api/v1/events`, {
        method: 'POST', headers,
        body: JSON.stringify({ title: '交付验收', date: '2026-11-14', type: 'deadline', projectId }),
      })
      assert.equal(create.status, 201)
      const created = await create.json() as { id: number }

      const deletion = await fetch(`${base}/api/v1/projects/${projectId}`, { method: 'DELETE', headers })
      assert.equal(deletion.status, 204)
      const restore = await fetch(`${base}/api/v1/projects/${projectId}/restore`, { method: 'POST', headers })
      assert.equal(restore.status, 200)

      const persisted = await pool.query<{
        project_name: string; project_version: number; project_deleted: Date | null;
        event_version: number; event_deleted: Date | null; file_key: string; file_version: number;
      }>(
        `SELECT project.name AS project_name, project.version AS project_version,
                project.deleted_at AS project_deleted, event.version AS event_version,
                event.deleted_at AS event_deleted, file.storage_key AS file_key,
                file.version AS file_version
         FROM projects AS project
         JOIN calendar_events AS event ON event.project_id=project.id
         JOIN files AS file ON file.project_id=project.id
         WHERE project.id=$1 AND event.id=$2 AND file.user_id=$3`,
        [projectId, created.id, ownerId],
      )
      assert.deepEqual(persisted.rows[0], {
        project_name: '已更新项目', project_version: 4, project_deleted: null,
        event_version: 3, event_deleted: null, file_key: `${newProjectKey}/关联文档.md`, file_version: 3,
      })
      assert.equal(await readFile(join(storageRoot, ...newProjectKey.split('/'), '关联文档.md'), 'utf8'), '合成项目文件')
      const undo = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM undo_operations
         WHERE user_id=$1 AND undo_context_id='main-composition-vite-tab'`, [ownerId],
      )
      assert.equal(undo.rows[0]?.count, 3)
      const jobs = await pool.query<{ source_type: string }>(
        `SELECT source_type FROM rag_index_jobs WHERE user_id=$1 ORDER BY source_type`, [ownerId],
      )
      assert.deepEqual(jobs.rows.map((row) => row.source_type), ['calendar', 'project'])
    } finally {
      if (viteApiTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
      else process.env.VITE_API_PROXY_TARGET = viteApiTarget
    }
  } finally {
    await Promise.all(viteServers.map((vite) => vite.close()))
    await host?.close()
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await adminPool.end()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
