import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserRepository } from '../../src/domains/auth/persistence/users.js'
import { createPostgresRegistrationOperations } from '../../src/domains/auth/persistence/registration.js'
import { createPostgresWorkspaceDirectoryOperations } from '../../src/domains/workspaces/persistence/workspace-directories.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-registration-vite-secret'

test('Vite→Node Host registers a user, restores the cookie session, and exposes the committed Local default workspace', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated registration HTTP integration',
}, async () => {
  const schema = `gugu_register_vite_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-register-vite-'))
  const userRepository = createUserRepository(pool)
  const registration = createPostgresRegistrationOperations(pool, {
    workspaceShellSupported: () => true,
    async prepareDefaultWorkspaceRoot(userId, directoryName) {
      await mkdir(join(storageRoot, userId, 'workspace', directoryName), { recursive: true })
    },
    registrationCodes: {
      async remainingTtlMs() { return 60_000 },
      async consume() { return false },
      async restore() {},
    },
    onCodeRestoreFailure() {},
  })
  const app = createApp({
    appName: 'Registration Vite integration',
    isReady: async () => true,
    userAuth: { secret, ...userRepository },
    registration: {
      secret,
      verificationRequired: false,
      rateLimit: async () => {},
      userExists: registration.userExists,
      verifyRegistrationCode: async () => false,
      registerUser: registration.registerUser,
      // Node 暂未迁移可选 onboarding.seed；该回调按 Python 的 best-effort 边界保持非阻塞。
      seedUser: async () => {},
    },
    workspaceDirectories: createPostgresWorkspaceDirectoryOperations(pool, {
      localPath: storageRoot,
      async prepareDirectoryAcl(directoryPath) { await mkdir(directoryPath, { recursive: true }) },
      async terminateActivePty() {},
    }),
  })
  let vite: { listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } } | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY, username varchar(100) NOT NULL UNIQUE, email varchar(300) NOT NULL UNIQUE,
        hashed_password varchar(200) NOT NULL, display_name varchar(100), is_active boolean NOT NULL,
        account_status varchar(16) NOT NULL, security_version integer NOT NULL, avatar varchar(500),
        is_developer boolean NOT NULL, created_at timestamptz NOT NULL, timezone varchar(64),
        email_subscribed boolean NOT NULL, last_active_at timestamptz
      );
      CREATE TABLE user_bots (
        id serial PRIMARY KEY, user_id uuid NOT NULL, platform varchar(20) NOT NULL, enabled boolean NOT NULL
      );
      CREATE TABLE user_preferences (
        id serial PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        data_json text NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE workspace_directories (
        id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name varchar(200) NOT NULL, directory_name varchar(200) NOT NULL,
        is_default boolean NOT NULL DEFAULT false, is_system boolean NOT NULL DEFAULT false,
        deleted_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX uq_workspace_directory_name
        ON workspace_directories(user_id, directory_name) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX uq_workspace_directory_display_name
        ON workspace_directories(user_id, name) WHERE deleted_at IS NULL;
      CREATE TABLE workspaces (
        id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name varchar(200) NOT NULL, kind varchar(20) NOT NULL, folder_id integer, project_id integer,
        directory_id integer REFERENCES workspace_directories(id) ON DELETE SET NULL,
        enabled boolean NOT NULL, is_default boolean NOT NULL, created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL, UNIQUE(user_id, directory_id)
      );
      CREATE TABLE files (
        id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_directory_id integer NOT NULL,
        space text NOT NULL, folder_id integer, deleted_at timestamptz, updated_at timestamptz
      );
      CREATE TABLE folders (
        id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_directory_id integer NOT NULL,
        parent_id integer, deleted_at timestamptz, updated_at timestamptz, version integer NOT NULL DEFAULT 1
      );
      CREATE TABLE conversation_sessions (id serial PRIMARY KEY, user_id uuid NOT NULL, workspace_id integer);
      CREATE TABLE scheduled_tasks (id serial PRIMARY KEY, user_id uuid, workspace_id integer, enabled boolean NOT NULL);
    `)

    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../frontend')
    const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
    const viteModule = requireFrontend('vite') as {
      createServer(options: Record<string, unknown>): Promise<{
        listen(): Promise<void>
        close(): Promise<void>
        httpServer?: { address(): string | { port: number } | null }
      }>
    }
    vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api/v1`

    const registrationResponse = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-transport': 'cookie', 'x-device-id': 'synthetic-device' },
      body: JSON.stringify({
        username: 'sample-user', email: 'Sample.User@example.test', password: 'Synthetic123!',
        emailSubscribed: true, locale: 'zh-CN',
      }),
    })
    assert.equal(registrationResponse.status, 201)
    const registered = await registrationResponse.json() as {
      access_token: string | null
      user: { id: string; username: string; email: string; email_subscribed: boolean; created_at: string }
    }
    assert.equal(registered.access_token, null)
    assert.equal(registered.user.username, 'sample-user')
    assert.equal(registered.user.email, 'sample.user@example.test')
    assert.equal(registered.user.email_subscribed, true)
    const cookies = registrationResponse.headers.getSetCookie()
    const accessCookie = cookies.find((cookie) => cookie.startsWith('gugu_user_access_token='))
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('gugu_user_csrf_token='))
    assert.ok(accessCookie)
    assert.ok(csrfCookie)
    assert.match(accessCookie, /HttpOnly/)

    const cookieHeader = [accessCookie, csrfCookie].map((cookie) => cookie.split(';', 1)[0]).join('; ')
    const currentUserResponse = await fetch(`${base}/auth/me`, { headers: { cookie: cookieHeader } })
    assert.equal(currentUserResponse.status, 200)
    const currentUser = await currentUserResponse.json() as {
      id: string
      username: string
      display_name: string
      email: string
      is_active: boolean
      avatar_url: string | null
      created_at: string
      im_channels: unknown[]
      timezone: string | null
      email_subscribed: boolean
    }
    assert.deepEqual(currentUser, {
      id: registered.user.id,
      username: 'sample-user',
      display_name: 'sample-user',
      email: 'sample.user@example.test',
      is_active: true,
      avatar_url: null,
      created_at: registered.user.created_at,
      im_channels: [],
      timezone: null,
      email_subscribed: true,
    })
    const workspaceResponse = await fetch(`${base}/workspace-directories`, { headers: { cookie: cookieHeader } })
    assert.equal(workspaceResponse.status, 200)
    const directories = await workspaceResponse.json() as Array<{ name: string; directoryName: string; isDefault: boolean; isSystem: boolean }>
    assert.deepEqual(directories.map(({ name, isDefault, isSystem }) => ({ name, isDefault, isSystem })), [
      { name: '默认工作区', isDefault: true, isSystem: true },
    ])
    await stat(join(storageRoot, registered.user.id, 'workspace', directories[0]!.directoryName))

    const persisted = await pool.query<{ email: string; locale: string; workspace_count: string }>(
      `SELECT users.email, user_preferences.data_json AS locale,
              (SELECT count(*)::text FROM workspaces WHERE workspaces.user_id=users.id) AS workspace_count
       FROM users JOIN user_preferences ON user_preferences.user_id=users.id WHERE users.id=$1`,
      [registered.user.id],
    )
    assert.equal(persisted.rows[0]?.email, 'sample.user@example.test')
    assert.deepEqual(JSON.parse(persisted.rows[0]!.locale), { locale: 'zh-CN' })
    assert.equal(persisted.rows[0]?.workspace_count, '1')
  } finally {
    if (vite) await vite.close()
    await app.close().catch(() => undefined)
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
