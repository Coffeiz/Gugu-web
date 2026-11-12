import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresRuntime, type SqlDataRuntime } from '@gugu/core/data'
import { createApp } from '../src/app.js'
import { createProjectListing } from '../src/projects.js'
import { createUserRepository } from '../src/users.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-postgres-integration-secret'

function userToken(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    role: 'user',
    sv: 4,
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url')
  const content = `${header}.${payload}`
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`
}

test('Node /auth/me reads an isolated PostgreSQL user and updates activity after authentication', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_webui_test_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  let core: SqlDataRuntime | undefined
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: { secret, ...createUserRepository(pool) },
    listProjects: async () => [],
  })

  try {
    const namespace = await pool.query<{ schema: string }>('SELECT current_schema() AS schema')
    assert.equal(namespace.rows[0]?.schema, schema)
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        username varchar(100) NOT NULL,
        display_name varchar(100),
        email varchar(300) NOT NULL,
        is_active boolean NOT NULL,
        account_status varchar(16),
        security_version integer,
        avatar varchar(500),
        created_at timestamptz,
        timezone varchar(64),
        email_subscribed boolean,
        last_active_at timestamptz
      )
    `)
    await pool.query(`
      CREATE TABLE user_bots (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id),
        platform varchar(20) NOT NULL,
        enabled boolean NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE projects (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        summary varchar(200),
        contact_name varchar(200),
        status varchar(20) NOT NULL,
        start_date varchar(10),
        deadline varchar(10),
        color varchar(300) NOT NULL,
        progress integer NOT NULL,
        stages_json text NOT NULL,
        current_stage varchar(100),
        priority varchar(20),
        version integer NOT NULL,
        archived boolean NOT NULL,
        done_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        deleted_at timestamptz,
        idempotency_key varchar(64),
        idempotency_fingerprint varchar(64)
      )
    `)
    await pool.query(`
      CREATE TABLE project_file_counts (
        project_id integer PRIMARY KEY,
        file_count bigint NOT NULL CHECK (file_count > 0)
      )
    `)
    const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
    await pool.query(
      `INSERT INTO users
        (id, username, display_name, email, is_active, account_status, security_version,
         created_at, timezone, email_subscribed)
       VALUES ($1, $2, $3, $4, TRUE, 'active', 4, $5, $6, FALSE)`,
      [userId, 'integration-user', '合成集成用户', 'integration@example.test', '2026-11-02T00:00:00Z', 'Asia/Shanghai'],
    )
    await pool.query(
      'INSERT INTO user_bots (user_id, platform, enabled) VALUES ($1, $2, TRUE)',
      [userId, 'qq'],
    )

    const otherUserId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'
    const insertProject = async (owner: string, name: string, archived: boolean) => {
      const result = await pool.query<{ id: number }>(
        `INSERT INTO projects
          (user_id, name, summary, contact_name, status, start_date, deadline, color,
           progress, stages_json, current_stage, priority, version, archived, done_at,
           created_at, updated_at, deleted_at, idempotency_key, idempotency_fingerprint)
         VALUES ($1, $2, NULL, NULL, 'pending', NULL, NULL, '#000000', 0, '[]', NULL,
                 NULL, 1, $3, NULL, '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z',
                 NULL, NULL, NULL)
         RETURNING id`,
        [owner, name, archived],
      )
      return result.rows[0]!.id
    }
    const activeProjectId = await insertProject(userId, 'Active owned project', false)
    const archivedProjectId = await insertProject(userId, 'Archived owned project', true)
    const otherProjectId = await insertProject(otherUserId, 'Other owner project', false)
    await pool.query(
      'INSERT INTO project_file_counts (project_id, file_count) VALUES ($1, 2), ($2, 99)',
      [activeProjectId, otherProjectId],
    )
    core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 2 })
    const projectApp = createApp({
      appName: 'Gugu',
      isReady: async () => true,
      userAuth: { secret, ...createUserRepository(pool) },
      listProjects: createProjectListing(core, pool),
    })

    try {
      const activeResponse = await projectApp.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { authorization: `Bearer ${userToken(userId)}` },
      })
      assert.equal(activeResponse.statusCode, 200)
      assert.deepEqual(activeResponse.json(), [{
        id: activeProjectId,
        name: 'Active owned project',
        client: null,
        status: 'pending',
        startDate: null,
        deadline: null,
        color: '#000000',
        progress: 0,
        stages: [],
        currentStage: null,
        archived: false,
        priority: null,
        version: 1,
        doneAt: null,
        updatedAt: '2026-11-02 00:00:00+00:00',
        deletedAt: null,
        createdAt: '2026-11-02',
        fileCount: 2,
      }])
      const archivedResponse = await projectApp.inject({
        method: 'GET',
        url: '/api/v1/projects?archived=true',
        headers: { authorization: `Bearer ${userToken(userId)}` },
      })
      assert.equal(archivedResponse.statusCode, 200)
      assert.deepEqual(archivedResponse.json().map((project: { id: number }) => project.id), [archivedProjectId])
    } finally {
      await projectApp.close()
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${userToken(userId)}` },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      id: userId,
      username: 'integration-user',
      display_name: '合成集成用户',
      email: 'integration@example.test',
      is_active: true,
      avatar_url: null,
      created_at: '2026-11-02',
      im_channels: ['qq'],
      timezone: 'Asia/Shanghai',
      email_subscribed: false,
    })
    const stored = await pool.query<{ last_active_at: Date | null }>(
      'SELECT last_active_at FROM users WHERE id = $1',
      [userId],
    )
    assert.ok(stored.rows[0]?.last_active_at instanceof Date)
  } finally {
    await app.close()
    await core?.close()
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
})
