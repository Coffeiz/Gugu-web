import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Pool, type PoolClient } from 'pg'
import test from 'node:test'
import { RegistrationRequestError } from '../../src/domains/auth/routes/auth-register.js'
import { createPostgresRegistrationOperations } from '../../src/domains/auth/persistence/registration.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

async function createFixture(options: {
  failWorkspaceRoot?: boolean
  failCommit?: boolean
  consumeCode?: boolean
} = {}) {
  const schema = `gugu_registration_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-register-'))
  await pool.query(`CREATE TABLE users (
    id uuid PRIMARY KEY, username varchar(100) NOT NULL UNIQUE, email varchar(300) NOT NULL UNIQUE,
    hashed_password varchar(200) NOT NULL, display_name varchar(100), is_active boolean NOT NULL,
    account_status varchar(16) NOT NULL, security_version integer NOT NULL, avatar varchar(500),
    is_developer boolean NOT NULL,
    created_at timestamptz NOT NULL, timezone varchar(64), email_subscribed boolean NOT NULL
  )`)
  await pool.query(`CREATE TABLE user_preferences (
    id serial PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    data_json text NOT NULL, updated_at timestamptz NOT NULL
  )`)
  await pool.query(`CREATE TABLE workspace_directories (
    id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name varchar(200) NOT NULL, directory_name varchar(200) NOT NULL,
    is_default boolean NOT NULL DEFAULT false, is_system boolean NOT NULL DEFAULT false,
    deleted_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
  )`)
  await pool.query(`CREATE UNIQUE INDEX uq_test_workspace_directory_name
    ON workspace_directories(user_id, directory_name) WHERE deleted_at IS NULL`)
  await pool.query(`CREATE UNIQUE INDEX uq_test_workspace_directory_display_name
    ON workspace_directories(user_id, name) WHERE deleted_at IS NULL`)
  await pool.query(`CREATE TABLE workspaces (
    id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name varchar(200) NOT NULL, kind varchar(20) NOT NULL, folder_id integer,
    project_id integer, directory_id integer REFERENCES workspace_directories(id) ON DELETE SET NULL,
    enabled boolean NOT NULL, is_default boolean NOT NULL,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    UNIQUE(user_id, directory_id)
  )`)

  const calls: string[] = []
  const restorationTtls: number[] = []
  const failedPool = options.failCommit ? wrapFailingCommit(pool) : pool
  const operations = createPostgresRegistrationOperations(failedPool, {
    workspaceShellSupported: () => true,
    async prepareDefaultWorkspaceRoot(userId, directoryName) {
      calls.push('prepareWorkspaceRoot')
      if (options.failWorkspaceRoot) throw new Error('synthetic workspace root failure')
      await mkdir(join(root, userId, 'workspace', directoryName), { recursive: true })
    },
    registrationCodes: {
      async remainingTtlMs(email) {
        calls.push(`ttl:${email}`)
        return 60_000
      },
      async consume(email, code) {
        calls.push(`consume:${email}:${code}`)
        return options.consumeCode ?? true
      },
      async restore(email, code, ttlMs) {
        calls.push(`restore:${email}:${code}`)
        restorationTtls.push(ttlMs)
      },
    },
    onCodeRestoreFailure(error) {
      calls.push(`restoreError:${error instanceof Error ? error.name : 'unknown'}`)
    },
  })

  return {
    schema, pool, adminPool, root, calls, restorationTtls, operations,
    async qualifiedCount(table: 'users' | 'user_preferences' | 'workspace_directories' | 'workspaces') {
      const result = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${schema}"."${table}"`)
      return Number(result.rows[0]?.count ?? 0)
    },
    async seedUser(username: string, email: string) {
      await pool.query(`INSERT INTO users
        (id, username, email, hashed_password, display_name, is_active, account_status,
         security_version, created_at, email_subscribed, is_developer)
        VALUES ($1, $2, $3, 'synthetic-hash', $2, true, 'active', 1, CURRENT_TIMESTAMP, false, false)`,
      [randomUUID(), username, email])
    },
    async close() {
      await pool.end()
      await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
      await adminPool.end()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function wrapFailingCommit(pool: Pool) {
  return {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect()
      let failed = false
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return (...args: Parameters<PoolClient['query']>) => {
              const command = typeof args[0] === 'string' ? args[0].trim().toUpperCase() : ''
              if (command === 'COMMIT' && !failed) {
                failed = true
                return Promise.reject(new Error('synthetic commit failure'))
              }
              return Reflect.apply(target.query, target, args)
            }
          }
          const value = Reflect.get(target, property, target) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
}

const input = {
  username: '合成新用户',
  email: 'new@example.test',
  hashedPassword: 'synthetic-bcrypt-hash',
  displayName: '合成新用户',
  emailSubscribed: true,
  locale: 'zh-CN' as const,
}

test('PostgreSQL registration atomically creates user, locale preference and default workspace rows', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL registration integration',
}, async () => {
  const fixture = await createFixture()
  try {
    assert.equal(await fixture.operations.userExists(input.username, input.email), false)
    assert.equal(await fixture.operations.emailIsOccupied(input.email), false)
    const user = await fixture.operations.registerUser(input, { email: input.email, code: '123456' })

    assert.equal(user.username, input.username)
    assert.equal(user.email, input.email)
    assert.equal(user.displayName, input.username)
    assert.equal(user.isActive, true)
    assert.equal(user.securityVersion, 1)
    assert.equal(user.emailSubscribed, true)
    assert.equal((await fixture.pool.query<{ is_developer: boolean }>(
      'SELECT is_developer FROM users WHERE id = $1', [user.id],
    )).rows[0]?.is_developer, false)
    assert.equal(user.createdAt instanceof Date || typeof user.createdAt === 'string', true)
    assert.equal((await stat(join(fixture.root, user.id, 'workspace', 'default'))).isDirectory(), true)
    assert.deepEqual(fixture.calls, [
      'prepareWorkspaceRoot',
      `ttl:${input.email}`,
      `consume:${input.email}:123456`,
    ])
    assert.deepEqual(fixture.restorationTtls, [])
    assert.equal(await fixture.operations.userExists(input.username, input.email), true)
    assert.equal(await fixture.operations.emailIsOccupied(input.email.toUpperCase()), true)
    assert.equal(await fixture.qualifiedCount('users'), 1)
    assert.equal(await fixture.qualifiedCount('user_preferences'), 1)
    assert.equal(await fixture.qualifiedCount('workspace_directories'), 1)
    assert.equal(await fixture.qualifiedCount('workspaces'), 1)

    const prefs = await fixture.pool.query<{ data_json: string }>(
      'SELECT data_json FROM user_preferences WHERE user_id = $1', [user.id],
    )
    assert.deepEqual(JSON.parse(prefs.rows[0]!.data_json), { locale: 'zh-CN' })
    const directory = await fixture.pool.query<{ name: string; directory_name: string; is_default: boolean; is_system: boolean }>(
      'SELECT name, directory_name, is_default, is_system FROM workspace_directories WHERE user_id = $1', [user.id],
    )
    assert.deepEqual(directory.rows[0], {
      name: '默认工作区', directory_name: 'default', is_default: true, is_system: true,
    })
    const binding = await fixture.pool.query<{ name: string; kind: string; directory_id: number; enabled: boolean; is_default: boolean }>(
      'SELECT name, kind, directory_id, enabled, is_default FROM workspaces WHERE user_id = $1', [user.id],
    )
    assert.deepEqual(binding.rows[0], {
      name: '默认工作区', kind: 'directory', directory_id: directory.rows[0] && (await fixture.pool.query<{ id: number }>(
        'SELECT id FROM workspace_directories WHERE user_id = $1', [user.id],
      )).rows[0]!.id, enabled: true, is_default: false,
    })
    assert.equal(await fixture.operations.userExists('别名', input.email.toUpperCase()), true)
  } finally {
    await fixture.close()
  }
})

test('registration root-preparation failure rolls back all PostgreSQL registration rows', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL registration integration',
}, async () => {
  const fixture = await createFixture({ failWorkspaceRoot: true })
  try {
    await assert.rejects(fixture.operations.registerUser(input, null), /synthetic workspace root failure/)
    assert.deepEqual(fixture.calls, ['prepareWorkspaceRoot'])
    assert.equal(await fixture.qualifiedCount('users'), 0)
    assert.equal(await fixture.qualifiedCount('user_preferences'), 0)
    assert.equal(await fixture.qualifiedCount('workspace_directories'), 0)
    assert.equal(await fixture.qualifiedCount('workspaces'), 0)
  } finally {
    await fixture.close()
  }
})

test('a concurrent or replaced verification code aborts the PostgreSQL registration transaction', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL registration integration',
}, async () => {
  const fixture = await createFixture({ consumeCode: false })
  try {
    await assert.rejects(
      fixture.operations.registerUser(input, { email: input.email, code: '123456' }),
      (error: unknown) => error instanceof RegistrationRequestError
        && error.statusCode === 400 && error.message === '验证码错误或已过期',
    )
    assert.equal(await fixture.qualifiedCount('users'), 0)
    assert.equal(await fixture.qualifiedCount('user_preferences'), 0)
    assert.equal(await fixture.qualifiedCount('workspace_directories'), 0)
    assert.equal(await fixture.qualifiedCount('workspaces'), 0)
  } finally {
    await fixture.close()
  }
})

test('a PostgreSQL commit failure rolls back rows and restores only the remaining verification TTL', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL registration integration',
}, async () => {
  const fixture = await createFixture({ failCommit: true })
  try {
    await assert.rejects(
      fixture.operations.registerUser(input, { email: input.email, code: '123456' }),
      /synthetic commit failure/,
    )
    assert.equal(await fixture.qualifiedCount('users'), 0)
    assert.equal(await fixture.qualifiedCount('user_preferences'), 0)
    assert.equal(await fixture.qualifiedCount('workspace_directories'), 0)
    assert.equal(await fixture.qualifiedCount('workspaces'), 0)
    assert.equal(fixture.restorationTtls.length, 1)
    assert.ok(fixture.restorationTtls[0]! > 0 && fixture.restorationTtls[0]! <= 60_000)
    assert.deepEqual(fixture.calls.slice(0, 2), ['prepareWorkspaceRoot', `ttl:${input.email}`])
    assert.deepEqual(fixture.calls.slice(-2), [
      `consume:${input.email}:123456`, `restore:${input.email}:123456`,
    ])
  } finally {
    await fixture.close()
  }
})
