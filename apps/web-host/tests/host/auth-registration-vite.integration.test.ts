import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserRepository } from '../../src/domains/auth/persistence/users.js'
import { createPostgresRegistrationOperations } from '../../src/domains/auth/persistence/registration.js'
import { createPostgresWorkspaceDirectoryOperations } from '../../src/domains/workspaces/persistence/workspace-directories.js'
import { createRegistrationSeeder } from '@gugu/core/onboarding'
import { createPostgresRegistrationSeedOperations } from '../../src/modules/onboarding/persistence/registration-seed-postgres.js'

import { applyAgentBaseMigration } from '../../src/migrations/agent-base-migrate.js'
import { applyWebDomainMigration } from '../../src/migrations/web-domain-migrate.js'
import { checkDatabaseReadiness } from '../../src/database.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-registration-vite-secret'

test('Vite→Node Host registers a user and seeds the Local onboarding flow with a quota ledger', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated registration HTTP integration',
}, async () => {
  const schema = `gugu_register_vite_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-register-vite-'))
  const userRepository = createUserRepository(pool)
  const seedFailures: unknown[] = []
  const seedRegistration = createRegistrationSeeder({
    applySeed: createPostgresRegistrationSeedOperations(pool, { storageRoot, defaultLimitBytes: 1024 * 1024 }),
    async surpriseMp3() { return null },
    onFailure(error) { seedFailures.push(error) },
  }, { now: () => new Date('2026-11-14T00:00:00.000Z'), random: () => 0 })
  const registration = createPostgresRegistrationOperations(pool, {
    defaultStorageLimitBytes: 1024 * 1024,
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
    async isReady() {
      await checkDatabaseReadiness(statement => pool.query(statement))
      return true
    },
    userAuth: { secret, ...userRepository },
    registration: {
      secret,
      verificationRequired: false,
      rateLimit: async () => {},
      userExists: registration.userExists,
      verifyRegistrationCode: async () => false,
      registerUser: registration.registerUser,
      seedUser(user, locale) { return seedRegistration(user.id, locale) },
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
    await applyAgentBaseMigration(pool)
    await applyWebDomainMigration(pool)

    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    const readiness = await fetch(`${hostAddress}/health/ready`)
    assert.equal(readiness.status, 200)
    assert.deepEqual(await readiness.json(), { status: 'ok' })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../web')
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
    assert.deepEqual(seedFailures, [])

    const seeded = await pool.query<{
      project_id: number
      project_name: string
      event_count: string
      file_count: string
      file_bytes: string
      quota_used_bytes: string
      quota_limit_bytes: string
      state: { seed: { seeded: boolean; project_id: number; project_name: string }; guide: { enabled: boolean } }
      quota_events: string[]
    }>(
      `SELECT projects.id AS project_id, projects.name AS project_name,
              (SELECT count(*)::text FROM calendar_events WHERE user_id=$1) AS event_count,
              (SELECT count(*)::text FROM files WHERE user_id=$1) AS file_count,
              (SELECT sum(size_bytes)::text FROM files WHERE user_id=$1) AS file_bytes,
              ledger.used_bytes::text AS quota_used_bytes, ledger.limit_bytes::text AS quota_limit_bytes,
              onboarding.state,
              (SELECT array_agg(operation ORDER BY operation) FROM storage_quota_events WHERE user_id=$1) AS quota_events
       FROM projects
       JOIN onboarding_state onboarding ON onboarding.user_id=projects.user_id
       JOIN storage_quota_ledgers ledger ON ledger.user_id=projects.user_id AND ledger.category='file_library'
       WHERE projects.user_id=$1`,
      [registered.user.id],
    )
    const seedResult = seeded.rows[0]
    assert.ok(seedResult)
    assert.equal(seedResult.project_name, '从这里开始')
    assert.equal(seedResult.event_count, '1')
    assert.equal(seedResult.file_count, '2')
    assert.ok(Number(seedResult.file_bytes) > 0)
    assert.equal(seedResult.quota_used_bytes, seedResult.file_bytes)
    assert.equal(seedResult.quota_limit_bytes, String(1024 * 1024))
    assert.deepEqual(seedResult.state.seed, {
      seeded: true, project_id: seedResult.project_id, project_name: '从这里开始',
    })
    assert.equal(seedResult.state.guide.enabled, true)
    assert.deepEqual(seedResult.quota_events, ['initialize', 'onboarding_seed', 'onboarding_seed'])
    const seededFiles = await pool.query<{ storage_key: string }>(
      'SELECT storage_key FROM files WHERE user_id=$1 ORDER BY id', [registered.user.id],
    )
    const contents = await Promise.all(seededFiles.rows.map(file => readFile(join(storageRoot, ...file.storage_key.split('/')), 'utf8')))
    assert.match(contents[0]!, /^# 给未来的自己\n/)
    assert.match(contents[1]!, /^# 可以删掉我\n/)

    await pool.query('ALTER TABLE files ADD CONSTRAINT synthetic_reject_new_files CHECK (size_bytes < 0) NOT VALID')
    const failedSeedRegistration = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': 'synthetic-seed-failure' },
      body: JSON.stringify({
        username: 'sample-seed-failure', email: 'second@example.test', password: 'Synthetic123!', locale: 'zh-CN',
      }),
    })
    assert.equal(failedSeedRegistration.status, 201)
    const second = await failedSeedRegistration.json() as { user: { id: string } }
    assert.equal(seedFailures.length, 1)
    assert.equal((seedFailures[0] as { code?: string }).code, '23514')
    const secondQuota = await pool.query(`SELECT used_bytes::integer,limit_bytes::integer,
        (SELECT count(*)::integer FROM files WHERE user_id=$1) AS files,
        (SELECT count(*)::integer FROM projects WHERE user_id=$1) AS projects,
        (SELECT count(*)::integer FROM rag_index_jobs WHERE user_id=$1) AS jobs,
        (SELECT array_agg(operation) FROM storage_quota_events WHERE user_id=$1) AS quota_events
      FROM storage_quota_ledgers WHERE user_id=$1 AND category='file_library'`, [second.user.id])
    assert.deepEqual(secondQuota.rows, [{
      used_bytes: 0, limit_bytes: 1024 * 1024, files: 0, projects: 0, jobs: 0, quota_events: ['initialize'],
    }])
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
