import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import test from 'node:test'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { startServer } from '../../src/main.js'
import { createCalendarEvent } from '@gugu/core/calendar'
import { createPostgresRuntime } from '@gugu/core/data'
import { calendarCreateStore } from '../calendar/calendar-core-stores.js'
import { decryptSmtpPassword } from '../../src/domains/preferences/persistence/smtp-credentials.js'

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
  const calendarRuntime = await createPostgresRuntime({ url: databaseUrl!, schema })
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'gugu-project-main-vite-'))
  const storageRoot = join(temporaryRoot, 'users')
  const overridePath = join(temporaryRoot, 'config.override.json')
  const viteServers: Array<{ listen(): Promise<void>; close(): Promise<void> }> = []
  let viteApiTarget: string | undefined
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  let retentionTick: (() => void) | undefined
  let retentionTimer: ReturnType<typeof setTimeout> | undefined

  try {
    await writeFile(overridePath, '{}\n', 'utf8')
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY, username text NOT NULL, display_name text, email text NOT NULL,
        is_active boolean NOT NULL, account_status text, security_version integer,
        avatar text, created_at timestamptz, timezone text, email_subscribed boolean,
        is_developer boolean NOT NULL DEFAULT FALSE, last_active_at timestamptz,
        storage_limit_bytes bigint, hashed_password text,
        suspended_until timestamptz, suspended_reason text
      );
      CREATE TABLE user_bots (id integer, user_id uuid NOT NULL, platform text NOT NULL, enabled boolean NOT NULL, owner_platform_user_id text);
      CREATE TABLE conversation_sessions (id integer, user_id uuid, source text, chat_type text, chat_id text, title text, bot_id text);
      CREATE TABLE user_preferences (user_id uuid NOT NULL, data_json jsonb, updated_at timestamptz);
      CREATE TABLE user_smtp_configs (id serial PRIMARY KEY, user_id uuid NOT NULL UNIQUE,
        host varchar(255) NOT NULL, port integer NOT NULL, "user" varchar(300) NOT NULL,
        password text NOT NULL, from_addr varchar(300) NOT NULL, use_ssl boolean NOT NULL,
        enabled boolean NOT NULL, updated_at timestamptz NOT NULL);
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
        deleted_at timestamptz, idempotency_key varchar(64), idempotency_fingerprint varchar(64),
        UNIQUE(user_id,idempotency_key)
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
        reminder_lead_minutes integer, channels varchar(40) NOT NULL, delivery_targets jsonb,
        updated_at timestamptz, end_at timestamptz, last_run_at timestamptz,
        last_run_failed boolean, filesystem_authorization_grant_id integer, workspace_id integer,
        interval_minutes integer, authorized_tools jsonb, email_attachment_file_ids jsonb
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
      CREATE TABLE notification_reads (id serial PRIMARY KEY, user_id uuid, notification_id integer, read_at timestamptz, UNIQUE(user_id,notification_id));
      CREATE TABLE notification_dismissals (
        id serial PRIMARY KEY, user_id uuid, notification_id integer, dismissed_at timestamptz, UNIQUE(user_id,notification_id)
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
        description text NOT NULL, ip text, created_at timestamptz NOT NULL
      );
      CREATE TABLE security_events (id serial PRIMARY KEY, user_id uuid NOT NULL, occurred_at timestamptz NOT NULL);
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
         created_at, timezone, email_subscribed, hashed_password
       ) VALUES ($1, 'sample', '示例用户', 'sample@example.invalid', TRUE, 'active', 1, $2, 'UTC', FALSE, $3)`,
      [ownerId, stamp, await bcrypt.hash('synthetic-main-password', 4)],
    )
    const otherOwnerId = '00000000-0000-4000-8000-000000000073'
    await pool.query(
      `INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at)
       VALUES($1,'other','other@example.invalid',true,'active',1,$2)`, [otherOwnerId, stamp],
    )
    await pool.query(`INSERT INTO user_bots VALUES(10,$1,'qq',true,NULL)` , [ownerId])
    await pool.query(`INSERT INTO conversation_sessions VALUES
      (1,$1,'qq','group','group-a','合成群','10'),(2,$2,'qq','group','private-group','其他用户的群','20')`, [ownerId, otherOwnerId])
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
    const originalTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const timer = originalTimeout(callback, delay, ...args)
      if (delay === 3_600_000) { retentionTick = () => callback(...args); retentionTimer = timer }
      return timer
    }) as typeof setTimeout
    try {
      host = await startServer({
      GUGU_WEBUI_DATABASE_URL: scopedUrl.toString(),
      GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: overridePath,
      GUGU_WEBUI_HOST: '127.0.0.1',
      GUGU_WEBUI_PORT: String(port),
      ACCESS_TOKEN_EXPIRE_MINUTES: '2',
      ADMIN_USERNAME: 'synthetic-admin',
      ADMIN_PASSWORD: 'synthetic-admin-password',
      GUGU_WEBUI_REDIS_URL: '',
      STORAGE__LOCAL_PATH: storageRoot,
      })
    } finally { globalThis.setTimeout = originalTimeout }
    assert.ok(retentionTick && retentionTimer, '生产启动应注册安全事件清理定时器')

    const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sample', password: 'synthetic-main-password' }),
    })
    assert.equal(login.status, 200)
    const token = (await login.json() as { access_token: string }).access_token
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { exp: number }
    assert.ok(claims.exp >= Math.floor(Date.now() / 1000) + 118 && claims.exp <= Math.floor(Date.now() / 1000) + 120)
    const cookies = login.headers.getSetCookie()
    assert.equal(cookies.filter((cookie) => /Max-Age=120/.test(cookie)).length, 2)

    const previousTarget = process.env.VITE_API_PROXY_TARGET
    viteApiTarget = previousTarget
    process.env.VITE_API_PROXY_TARGET = `http://127.0.0.1:${port}`
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
      const headers = {
        authorization: `Bearer ${createUserToken(ownerId, 1, secret)}`,
        'content-type': 'application/json',
        'x-undo-context-id': 'main-composition-vite-tab',
        'x-client-id': 'main-composition-vite-client',
      }

      await pool.query(`INSERT INTO site_notifications(id,title,content,color,target,bubble,persist,bubble_expire_at,created_at) VALUES
        (101,'注册前','内容','#abc','all',TRUE,TRUE,NULL,'2026-11-13T23:59:59.999999Z'),
        (102,'边界通知','内容','#abc','all',TRUE,TRUE,NULL,'2026-11-14T00:00:00Z'),
        (103,'乙通知','内容','#abc',$1,TRUE,TRUE,NULL,'2026-11-14T00:00:01Z'),
        (104,'过期气泡','内容','#abc','all',TRUE,TRUE,'2026-01-01T00:00:00Z','2026-11-14T00:00:02Z'),
        (105,'临时气泡','内容','#abc',$2,TRUE,FALSE,NULL,'2026-11-14T00:00:03Z'),
        (106,'微秒通知','内容','#abc','all',FALSE,TRUE,NULL,'2026-11-14T00:00:04.123456Z')`, [otherOwnerId, ownerId])
      const notificationUrl = `${base}/api/v1/notifications`
      assert.equal((await fetch(notificationUrl)).status, 401)
      assert.equal((await fetch(`${notificationUrl}?limit=bad`, { headers })).status, 422)
      const notificationList = await fetch(notificationUrl, { headers })
      assert.equal(notificationList.status, 200)
      const notices = await notificationList.json() as Array<{ id: number; time: string; unread: boolean }>
      assert.deepEqual(notices.map(item => item.id), [106, 104, 102])
      assert.equal(notices[0]!.time, '2026-11-14T00:00:04.123456+00:00')
      assert.equal(notices[2]!.time, '2026-11-14T00:00:00+00:00')
      const notificationBubble = async () => (await (await fetch(`${notificationUrl}/bubble`, { headers })).json() as { bubble: { id: number } | null }).bubble?.id ?? null
      assert.equal(await notificationBubble(), 105)
      const mark = () => fetch(`${notificationUrl}/read`, { method: 'POST', headers, body: JSON.stringify({ ids: [105] }) })
      assert.deepEqual(await (await mark()).json(), { ok: true, marked: 1 })
      assert.deepEqual(await (await mark()).json(), { ok: true, marked: 0 })
      assert.equal(await notificationBubble(), 102)
      const clear = () => fetch(notificationUrl, { method: 'DELETE', headers })
      assert.deepEqual(await (await clear()).json(), { ok: true, dismissed: 3 })
      assert.deepEqual(await (await clear()).json(), { ok: true, dismissed: 0 })
      assert.deepEqual(await (await fetch(notificationUrl, { headers })).json(), [])
      const otherHeaders = { ...headers, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
      const otherNotices = await (await fetch(notificationUrl, { headers: otherHeaders })).json() as Array<{ id: number; unread: boolean }>
      assert.deepEqual(otherNotices.map(item => item.id), [106, 104, 103, 102])
      assert.ok(otherNotices.every(item => item.unread))
      assert.deepEqual(await (await fetch(`${notificationUrl}/read`, { method: 'POST', headers: otherHeaders, body: JSON.stringify({ ids: [] }) })).json(), { ok: true, marked: 4 })
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM site_notifications')).rows[0].count, 6)

      const smtpUrl = `${base}/api/v1/preferences/smtp`
      const smtpSecret = 'synthetic-mail-password'
      const smtpInput = { host: 'smtp.example.test', port: 465, user: 'mail@example.test', password: smtpSecret, useSsl: true }
      const otherSmtpHeaders = { ...headers, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
      assert.equal((await fetch(smtpUrl)).status, 401)
      assert.equal(await (await fetch(smtpUrl, { headers: otherSmtpHeaders })).json(), null)
      const saveSmtp = (body: unknown, requestHeaders = headers) => fetch(smtpUrl, { method: 'PUT', headers: requestHeaders, body: JSON.stringify(body) })
      const saved = await saveSmtp(smtpInput)
      assert.equal(saved.status, 200)
      const savedText = await saved.text()
      assert.equal(savedText.includes(smtpSecret), false)
      assert.equal(JSON.parse(savedText).host, smtpInput.host)
      const encrypted = (await pool.query<{ password: string }>('SELECT password FROM user_smtp_configs WHERE user_id=$1', [ownerId])).rows[0]!.password
      assert.notEqual(encrypted, smtpSecret)
      assert.equal(decryptSmtpPassword(secret, encrypted), smtpSecret)
      assert.equal(await (await fetch(smtpUrl, { headers: otherSmtpHeaders })).json(), null)
      const { password: _smtpPassword, ...smtpWithoutPassword } = smtpInput
      assert.equal((await saveSmtp(smtpWithoutPassword)).status, 200)
      assert.equal((await saveSmtp({ ...smtpWithoutPassword, password: null })).status, 200)
      assert.equal((await pool.query<{ password: string }>('SELECT password FROM user_smtp_configs WHERE user_id=$1', [ownerId])).rows[0]!.password, encrypted)
      const invalidSmtp = await saveSmtp({ ...smtpInput, port: 0 })
      assert.equal(invalidSmtp.status, 422)
      assert.equal((await invalidSmtp.text()).includes(smtpSecret), false)
      assert.equal((await saveSmtp({ ...smtpInput, password: '' })).status, 200)
      assert.equal((await pool.query<{ password: string }>('SELECT password FROM user_smtp_configs WHERE user_id=$1', [ownerId])).rows[0]!.password, '')
      assert.equal((await saveSmtp({ ...smtpInput, host: 'other.example.test' }, otherSmtpHeaders)).status, 200)
      const smtpRows = await pool.query<{ user_id: string; host: string }>('SELECT user_id::text,host FROM user_smtp_configs ORDER BY user_id')
      assert.deepEqual(smtpRows.rows, [{ user_id: ownerId, host: smtpInput.host }, { user_id: otherOwnerId, host: 'other.example.test' }])
      assert.equal((await (await fetch(smtpUrl, { headers })).text()).includes(smtpSecret), false)

      const readiness = await fetch(`http://127.0.0.1:${port}/health/ready`)
      assert.equal(readiness.status, 200)

      const createHeaders = { ...headers, 'x-undo-context-id': 'project-create-tab', 'idempotency-key': 'create-contract' }
      const createProject = () => fetch(`${base}/api/v1/projects`, {
        method: 'POST', headers: createHeaders, body: JSON.stringify({ name: '共用创建项目' }),
      })
      const firstProject = await createProject()
      assert.equal(firstProject.status, 201)
      const firstProjectId = (await firstProject.json() as { id: number }).id
      const replayProject = await createProject()
      assert.equal(replayProject.status, 201)
      assert.equal((await replayProject.json() as { id: number }).id, firstProjectId)
      const invalidProject = await fetch(`${base}/api/v1/projects`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'invalid-project' }, body: JSON.stringify({ name: '' }),
      })
      assert.equal(invalidProject.status, 422)
      const conflictingProject = await fetch(`${base}/api/v1/projects`, {
        method: 'POST', headers: createHeaders, body: JSON.stringify({ name: '不同创建内容' }),
      })
      assert.equal(conflictingProject.status, 409)
      const createdRows = await pool.query<{ projects: number; undos: number }>(
        `SELECT (SELECT count(*)::int FROM projects WHERE user_id=$1 AND name='共用创建项目') AS projects,
          (SELECT count(*)::int FROM undo_operations WHERE user_id=$1 AND undo_context_id='project-create-tab') AS undos`, [ownerId],
      )
      assert.deepEqual(createdRows.rows[0], { projects: 1, undos: 1 })

      const update = await fetch(`${base}/api/v1/projects/${projectId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ version: 1, name: '已更新项目' }),
      })
      assert.equal(update.status, 200)
      assert.equal((await update.json() as { version: number }).version, 2)
      assert.equal(await readFile(join(storageRoot, ...newProjectKey.split('/'), '关联文档.md'), 'utf8'), '合成项目文件')
      await assert.rejects(readFile(projectFilePath), { code: 'ENOENT' })

      const calendarInput = { title: '交付验收', date: '2099-11-14', type: 'deadline', projectId }
      const calendarHeaders = { ...headers, 'idempotency-key': 'calendar-create-contract' }
      const createCalendar = () => fetch(`${base}/api/v1/events`, {
        method: 'POST', headers: calendarHeaders, body: JSON.stringify(calendarInput),
      })
      const create = await createCalendar()
      assert.equal(create.status, 201)
      const created = await create.json() as { id: number }
      const replay = await createCalendar()
      assert.equal(replay.status, 201)
      assert.equal((await replay.json() as { id: number }).id, created.id)
      const conflict = await fetch(`${base}/api/v1/events`, {
        method: 'POST', headers: calendarHeaders, body: JSON.stringify({ ...calendarInput, title: '不同内容' }),
      })
      assert.equal(conflict.status, 409)

      // 生产 main 与独立 Core 连接竞争同一 owner 的索引任务。
      const otherProducer = calendarCreateStore(calendarRuntime, async () => undefined)
      const mixed = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
        const input = { title: `混合并发 ${index}`, date: '2026-11-15' }
        if (index % 2 === 0) {
          const response = await fetch(`${base}/api/v1/events`, {
            method: 'POST', headers: { ...headers, 'x-undo-context-id': 'mixed-calendar-tab' }, body: JSON.stringify(input),
          })
          assert.equal(response.status, 201)
          return (await response.json() as { id: number }).id
        }
        return (await createCalendarEvent(otherProducer, { ownerId, input, undoContextId: 'mixed-calendar-tab' })).event.id
      }))
      const calendarRows = await pool.query<{ events: number; undos: number; generation: number; pending_source_ids: string[] }>(
        `SELECT
          (SELECT count(*)::int FROM calendar_events WHERE user_id=$1) AS events,
          (SELECT count(*)::int FROM undo_operations WHERE user_id=$1 AND resource='calendar') AS undos,
          generation, pending_source_ids FROM rag_index_jobs WHERE user_id=$1 AND source_type='calendar'`, [ownerId],
      )
      assert.equal(calendarRows.rows[0]!.events, 9)
      assert.equal(calendarRows.rows[0]!.undos, 9)
      assert.equal(calendarRows.rows[0]!.generation, 9)
      assert.equal(calendarRows.rows[0]!.pending_source_ids.length, 9)
      assert.deepEqual(new Set(calendarRows.rows[0]!.pending_source_ids), new Set([created.id, ...mixed].map(String)))

      const preview = await fetch(`${base}/api/v1/undo/preview?context_id=main-composition-vite-tab`, { headers })
      assert.equal(preview.status, 200)
      const undoOperation = (await preview.json() as { undo: { operation_id: string; resource: string } }).undo
      assert.equal(undoOperation.resource, 'calendar')
      const otherUndo = await fetch(`${base}/api/v1/undo`, {
        method: 'POST', headers: { ...headers, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` },
        body: JSON.stringify({ operation_id: undoOperation.operation_id, context_id: 'main-composition-vite-tab' }),
      })
      assert.equal(otherUndo.status, 404)
      assert.equal((await otherUndo.json() as { detail: { code: string } }).detail.code, 'undo.not_found')
      const undoEvent = await fetch(`${base}/api/v1/undo`, {
        method: 'POST', headers,
        body: JSON.stringify({ operation_id: undoOperation.operation_id, context_id: 'main-composition-vite-tab' }),
      })
      assert.equal(undoEvent.status, 200)
      assert.ok((await undoEvent.json() as { events: Array<{ resource: string; operation: string }> }).events.some(event => event.resource === 'calendar' && event.operation === 'delete'))
      const repeatedUndo = await fetch(`${base}/api/v1/undo`, { method: 'POST', headers, body: JSON.stringify({ operation_id: undoOperation.operation_id, context_id: 'main-composition-vite-tab' }) })
      assert.equal((await repeatedUndo.json() as { idempotent: boolean }).idempotent, true)
      assert.ok((await pool.query('SELECT deleted_at FROM calendar_events WHERE id=$1', [created.id])).rows[0].deleted_at)
      const redoEvent = await fetch(`${base}/api/v1/undo/redo`, {
        method: 'POST', headers,
        body: JSON.stringify({ operation_id: undoOperation.operation_id, context_id: 'main-composition-vite-tab' }),
      })
      assert.equal(redoEvent.status, 200)
      assert.equal((await pool.query('SELECT deleted_at FROM calendar_events WHERE id=$1', [created.id])).rows[0].deleted_at, null)

      const reminder = await pool.query<{ id: number }>(
        `INSERT INTO scheduled_tasks(user_id,event_id,enabled,name,payload,cron,schedule_kind,start_at,reminder_lead_minutes,channels)
         VALUES($1,$2,true,'原提醒','原内容','@once:synthetic','once',$3,5,'web') RETURNING id`,
        [ownerId, created.id, new Date('2099-11-14T00:00:00Z')],
      )

      const foreignHeaders = { ...headers, authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` }
      assert.equal((await fetch(`${base}/api/v1/events/${created.id}`, {
        method: 'PATCH', headers: foreignHeaders, body: JSON.stringify({ version: 3, title: '越权' }),
      })).status, 404)
      assert.equal((await fetch(`${base}/api/v1/events/${created.id}?version=3`, { method: 'DELETE', headers: foreignHeaders })).status, 404)
      assert.equal((await fetch(`${base}/api/v1/events/${created.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ version: 1, title: '过期版本' }),
      })).status, 409)
      const updateEvent = await fetch(`${base}/api/v1/events/${created.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ version: 3, title: '复核验收', date: '2099-11-15', client: '小北' }),
      })
      assert.equal(updateEvent.status, 200)
      const updatePreview = await fetch(`${base}/api/v1/undo/preview?context_id=main-composition-vite-tab`, { headers })
      const updateOperation = (await updatePreview.json() as { undo: { operation_id: string } }).undo.operation_id
      for (const action of ['', '/redo']) {
        const response = await fetch(`${base}/api/v1/undo${action}`, {
          method: 'POST', headers,
          body: JSON.stringify({ operation_id: updateOperation, context_id: 'main-composition-vite-tab' }),
        })
        assert.equal(response.status, 200)
        const row = (await pool.query('SELECT title, contact_name FROM calendar_events WHERE id=$1', [created.id])).rows[0]
        assert.deepEqual(row, action ? { title: '复核验收', contact_name: '小北' } : { title: '交付验收', contact_name: null })
        const task = (await pool.query('SELECT name,payload,cron,enabled FROM scheduled_tasks WHERE id=$1', [reminder.rows[0]!.id])).rows[0]
        assert.deepEqual(task, action
          ? { name: '复核验收 提醒', payload: '提醒：复核验收（2099-11-15）', cron: '@once:2099-11-15T00:55:00+00:00', enabled: true }
          : { name: '原提醒', payload: '原内容', cron: '@once:synthetic', enabled: true })
      }

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
        event_version: 8, event_deleted: null, file_key: `${newProjectKey}/关联文档.md`, file_version: 3,
      })
      assert.equal(await readFile(join(storageRoot, ...newProjectKey.split('/'), '关联文档.md'), 'utf8'), '合成项目文件')
      const undo = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM undo_operations
         WHERE user_id=$1 AND undo_context_id='main-composition-vite-tab'`, [ownerId],
      )
      assert.equal(undo.rows[0]?.count, 4)
      const jobs = await pool.query<{ source_type: string }>(
        `SELECT source_type FROM rag_index_jobs WHERE user_id=$1 ORDER BY source_type`, [ownerId],
      )
      assert.deepEqual(jobs.rows.map((row) => row.source_type), ['calendar', 'project', 'scheduled_task'])
      const listPath = `${base}/api/v1/scheduled-tasks?event_id=${created.id}`
      assert.equal((await fetch(listPath)).status, 401)
      assert.equal((await fetch(`${base}/api/v1/scheduled-tasks?event_id=invalid`, { headers })).status, 422)
      const ownList = await fetch(listPath, { headers })
      assert.equal(ownList.status, 200)
      assert.deepEqual((await ownList.json() as { tasks: Array<{ id: number }> }).tasks.map(task => task.id), [reminder.rows[0]!.id])
      const foreignList = await fetch(listPath, { headers: { authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` } })
      assert.equal(foreignList.status, 200)
      assert.deepEqual((await foreignList.json() as { tasks: unknown[] }).tasks, [])
      const targetPath = `${base}/api/v1/scheduled-tasks/delivery-targets/qq`
      assert.equal((await fetch(targetPath)).status, 401)
      const targetList = await fetch(targetPath, { headers })
      assert.equal(targetList.status, 200)
      assert.deepEqual(await targetList.json(), { private_available: true, groups: [{ chat_id: 'group-a', title: '合成群' }] })
      const otherTargets = await fetch(`${base}/api/v1/scheduled-tasks/qq-targets`, { headers: { authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}` } })
      assert.deepEqual(await otherTargets.json(), { groups: [{ chat_id: 'private-group', title: '其他用户的群' }] })
      assert.equal((await fetch(`${base}/api/v1/scheduled-tasks/delivery-targets/wechat`, { headers })).status, 404)
      const eventVersion = (await pool.query<{ version: number }>('SELECT version FROM calendar_events WHERE id=$1', [created.id])).rows[0]!.version
      const deleteHeaders = { ...headers, 'x-undo-context-id': 'calendar-delete-tab' }
      assert.equal((await fetch(`${base}/api/v1/events/${created.id}?version=${eventVersion}`, { method: 'DELETE', headers: deleteHeaders })).status, 204)
      assert.equal((await pool.query('SELECT enabled FROM scheduled_tasks WHERE id=$1', [reminder.rows[0]!.id])).rows[0].enabled, false)
      const deletePreview = await fetch(`${base}/api/v1/undo/preview?context_id=calendar-delete-tab`, { headers: deleteHeaders })
      const deleteOperation = (await deletePreview.json() as { undo: { operation_id: string } }).undo.operation_id
      for (const action of ['', '/redo']) {
        const response = await fetch(`${base}/api/v1/undo${action}`, {
          method: 'POST', headers: deleteHeaders,
          body: JSON.stringify({ operation_id: deleteOperation, context_id: 'calendar-delete-tab' }),
        })
        assert.equal(response.status, 200)
        const event = (await pool.query('SELECT deleted_at FROM calendar_events WHERE id=$1', [created.id])).rows[0]
        const task = (await pool.query('SELECT enabled FROM scheduled_tasks WHERE id=$1', [reminder.rows[0]!.id])).rows[0]
        assert.equal(event.deleted_at !== null, !!action)
        assert.equal(task.enabled, !action)
      }
      const taskPath = `${base}/api/v1/scheduled-tasks/${reminder.rows[0]!.id}`
      assert.equal((await fetch(taskPath, { method: 'DELETE' })).status, 401)
      assert.equal((await fetch(taskPath, { method: 'DELETE', headers: {
        authorization: `Bearer ${createUserToken(otherOwnerId, 1, secret)}`,
      } })).status, 404)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM scheduled_tasks WHERE id=$1', [reminder.rows[0]!.id])).rows[0].n, 1)
      assert.equal((await fetch(taskPath, { method: 'DELETE', headers })).status, 204)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM scheduled_tasks WHERE id=$1', [reminder.rows[0]!.id])).rows[0].n, 0)
      const adminLogin = await fetch(`${base}/api/v1/admin/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'synthetic-admin', password: 'synthetic-admin-password' }),
      })
      assert.equal(adminLogin.status, 200)
      const adminToken = (await adminLogin.json() as { access_token: string }).access_token
      const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }
      const suspend = await fetch(`${base}/api/v1/admin/users/${ownerId}/suspend`, {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ confirm: true }),
      })
      assert.equal(suspend.status, 200)
      const risk = await fetch(`${base}/api/v1/admin/users/risk`, { headers: adminHeaders })
      assert.equal(risk.status, 200)
      assert.equal((await risk.json() as { items: Array<{ id: string }> }).items[0]?.id, ownerId)
      const unsuspend = await fetch(`${base}/api/v1/admin/users/${ownerId}/unsuspend`, {
        method: 'POST', headers: adminHeaders,
      })
      assert.equal(unsuspend.status, 200)
      const audits = await pool.query<{ action: string; created_at: Date }>(
        'SELECT action, created_at FROM audit_logs ORDER BY id',
      )
      assert.deepEqual(audits.rows.map((row) => row.action), ['login', 'user', 'user'])
      assert.ok(audits.rows.every((row) => row.created_at instanceof Date))
      await pool.query("ALTER TABLE security_events ADD COLUMN expires_at timestamptz")
      await pool.query("INSERT INTO security_events(user_id,occurred_at,expires_at) VALUES($1,now(),'2000-01-01T00:00:00Z'),($1,now(),'2200-01-01T00:00:00Z')", [ownerId])
      const blocker = await pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('LOCK TABLE security_events IN ACCESS EXCLUSIVE MODE')
        clearTimeout(retentionTimer!)
        retentionTick!()
        // 确认清理查询已经到达 PG 并阻塞，再关闭生产 Host。
        let blocked = false
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          const waiting = await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM security_events WHERE expires_at%') AS waiting")
          blocked = waiting.rows[0]!.waiting
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(blocked, true)
        const closing = host!.close()
        assert.equal(await Promise.race([closing.then(() => 'closed'), new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 30))]), 'waiting')
        await blocker.query('COMMIT')
        await closing
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM security_events')).rows[0].count, 1)
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined)
        blocker.release()
      }
    } finally {
      if (viteApiTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
      else process.env.VITE_API_PROXY_TARGET = viteApiTarget
    }
  } finally {
    await Promise.all(viteServers.map((vite) => vite.close()))
    await host?.close()
    await calendarRuntime.close()
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await adminPool.end()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
